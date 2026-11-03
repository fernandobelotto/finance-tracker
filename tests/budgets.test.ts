// @vitest-environment node
// Required: TanStack Start's import protection mocks server modules in jsdom (client) environment.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "../src/db/index.ts";
import {
  checkBudgetAlerts,
  createBudgetWithinLimit,
  getBudgetsWithSpending,
  runBudgetAlertCheck,
  utcMonthRange,
} from "../src/server/budgets.server.ts";
import { env } from "../src/server/env.ts";
import * as email from "../src/server/email.ts";

// Wrap the real sender so individual tests can make it fail.
vi.mock("../src/server/email.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/server/email.ts")>();
  return { ...actual, sendEmail: vi.fn(actual.sendEmail) };
});

const NOW = new Date("2026-11-15T12:00:00Z");

let seq = 0;

/** A fresh user with a PLN and a EUR account and a Food > Groceries tree. */
async function seedUser(
  opts: { verified?: boolean; email?: boolean } = {},
) {
  const userId = `budget-user-${Date.now()}-${seq++}`;
  await db.insert(schema.users).values({
    id: userId,
    username: userId,
    email: opts.email === false ? null : `${userId}@example.com`,
    email_verified_at: opts.verified === false ? null : new Date(),
    password_hash: "x",
  });
  await db.insert(schema.accounts).values([
    { id: `${userId}-pln`, user_id: userId, name: "PLN", currency: "PLN" },
    { id: `${userId}-eur`, user_id: userId, name: "EUR", currency: "EUR" },
  ]);
  await db.insert(schema.categories).values([
    { id: `${userId}-food`, user_id: userId, name: "Food" },
    {
      id: `${userId}-groceries`,
      user_id: userId,
      name: "Groceries",
      parent_id: `${userId}-food`,
    },
    {
      id: `${userId}-fruit`,
      user_id: userId,
      name: "Fruit",
      parent_id: `${userId}-groceries`,
    },
    { id: `${userId}-fun`, user_id: userId, name: "Fun" },
  ]);
  return {
    userId,
    email: `${userId}@example.com`,
    pln: `${userId}-pln`,
    eur: `${userId}-eur`,
    food: `${userId}-food`,
    groceries: `${userId}-groceries`,
    fruit: `${userId}-fruit`,
    fun: `${userId}-fun`,
  };
}

async function addTxn(
  userId: string,
  accountId: string,
  categoryId: string | null,
  amountMinor: number,
  date = "2026-11-10",
) {
  await db.insert(schema.transactions).values({
    id: crypto.randomUUID(),
    user_id: userId,
    account_id: accountId,
    category_id: categoryId,
    amount_minor: amountMinor,
    date,
  });
}

async function addBudget(
  userId: string,
  categoryId: string,
  limitMinor: number,
  currency = "PLN",
) {
  const id = crypto.randomUUID();
  await db.insert(schema.budgets).values({
    id,
    user_id: userId,
    category_id: categoryId,
    currency,
    limit_minor: limitMinor,
  });
  return id;
}

const emailsTo = (to: string) => email.getCapturedEmails(to);

describe("utcMonthRange", () => {
  it("uses the UTC calendar month", () => {
    expect(utcMonthRange(new Date("2026-11-15T12:00:00Z"))).toEqual({
      month: "2026-11",
      from: "2026-11-01",
      to: "2026-11-30",
    });
    // 22:30 on Oct 31 in UTC-3 is already November in UTC.
    expect(utcMonthRange(new Date("2026-11-01T01:30:00Z")).month).toBe(
      "2026-11",
    );
    expect(utcMonthRange(new Date("2028-02-10T00:00:00Z")).to).toBe(
      "2028-02-29",
    );
    expect(utcMonthRange(new Date("2026-12-31T23:59:59Z")).to).toBe(
      "2026-12-31",
    );
  });
});

describe("budget spending", () => {
  it("includes all descendant categories", async () => {
    const u = await seedUser();
    await addBudget(u.userId, u.food, 100_00);
    await addTxn(u.userId, u.pln, u.food, -10_00);
    await addTxn(u.userId, u.pln, u.groceries, -20_00);
    await addTxn(u.userId, u.pln, u.fruit, -5_00);
    await addTxn(u.userId, u.pln, u.fun, -99_00);

    const [budget] = await getBudgetsWithSpending(u.userId, NOW);
    expect(budget.spentMinor).toBe(35_00);
    expect(budget.leftMinor).toBe(65_00);
    expect(budget.isOver).toBe(false);
  });

  it("a subcategory budget doesn't include its parent's spending", async () => {
    const u = await seedUser();
    await addBudget(u.userId, u.groceries, 100_00);
    await addTxn(u.userId, u.pln, u.food, -10_00);
    await addTxn(u.userId, u.pln, u.fruit, -5_00);

    const [budget] = await getBudgetsWithSpending(u.userId, NOW);
    expect(budget.spentMinor).toBe(5_00);
  });

  it("only counts accounts in the budget's currency", async () => {
    const u = await seedUser();
    await addBudget(u.userId, u.food, 100_00, "PLN");
    await addBudget(u.userId, u.fun, 100_00, "EUR");
    await addTxn(u.userId, u.pln, u.food, -10_00);
    await addTxn(u.userId, u.eur, u.food, -40_00);
    await addTxn(u.userId, u.eur, u.fun, -7_00);
    await addTxn(u.userId, u.pln, u.fun, -3_00);

    const byCategory = new Map(
      (await getBudgetsWithSpending(u.userId, NOW)).map((b) => [
        b.categoryId,
        b,
      ]),
    );
    expect(byCategory.get(u.food)?.spentMinor).toBe(10_00);
    expect(byCategory.get(u.fun)?.spentMinor).toBe(7_00);
  });

  it("ignores income and refunds, and uncategorized spending", async () => {
    const u = await seedUser();
    await addBudget(u.userId, u.food, 100_00);
    await addTxn(u.userId, u.pln, u.food, -50_00);
    await addTxn(u.userId, u.pln, u.food, 50_00); // refund
    await addTxn(u.userId, u.pln, null, -30_00);

    const [budget] = await getBudgetsWithSpending(u.userId, NOW);
    expect(budget.spentMinor).toBe(50_00);
  });

  it("only counts the current UTC month", async () => {
    const u = await seedUser();
    await addBudget(u.userId, u.food, 100_00);
    await addTxn(u.userId, u.pln, u.food, -1_00, "2026-10-31");
    await addTxn(u.userId, u.pln, u.food, -2_00, "2026-11-01");
    await addTxn(u.userId, u.pln, u.food, -4_00, "2026-11-30");
    await addTxn(u.userId, u.pln, u.food, -8_00, "2026-12-01");

    const [budget] = await getBudgetsWithSpending(u.userId, NOW);
    expect(budget.spentMinor).toBe(6_00);

    // Next month starts from zero with the same limit.
    const [december] = await getBudgetsWithSpending(
      u.userId,
      new Date("2026-12-05T00:00:00Z"),
    );
    expect(december.spentMinor).toBe(8_00);
    expect(december.limitMinor).toBe(100_00);
  });

  it("is over only when spent is strictly above the limit", async () => {
    const u = await seedUser();
    await addBudget(u.userId, u.food, 50_00);
    await addTxn(u.userId, u.pln, u.food, -50_00);

    let [budget] = await getBudgetsWithSpending(u.userId, NOW);
    expect(budget.leftMinor).toBe(0);
    expect(budget.isOver).toBe(false);

    await addTxn(u.userId, u.pln, u.food, -1);
    [budget] = await getBudgetsWithSpending(u.userId, NOW);
    expect(budget.leftMinor).toBe(-1);
    expect(budget.isOver).toBe(true);
  });

  it("never returns another user's budgets or spending", async () => {
    const a = await seedUser();
    const b = await seedUser();
    await addBudget(a.userId, a.food, 100_00);
    await addTxn(b.userId, b.pln, b.food, -10_00);

    expect(await getBudgetsWithSpending(b.userId, NOW)).toEqual([]);
    const [budget] = await getBudgetsWithSpending(a.userId, NOW);
    expect(budget.spentMinor).toBe(0);
  });
});

describe("budget alerts", () => {
  beforeEach(() => {
    vi.mocked(email.sendEmail).mockClear();
  });

  it("sends one alert when a budget goes over", async () => {
    const u = await seedUser();
    await addBudget(u.userId, u.food, 10_00);
    await addTxn(u.userId, u.pln, u.groceries, -10_00);
    expect(await checkBudgetAlerts(u.userId, NOW)).toBe(0);

    await addTxn(u.userId, u.pln, u.groceries, -5_00);
    expect(await checkBudgetAlerts(u.userId, NOW)).toBe(1);

    const sent = emailsTo(u.email);
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toContain("Food");
    expect(sent[0].text).toContain("November 2026");
    expect(sent[0].text).toContain("15.00 PLN");
    expect(sent[0].text).toContain("5.00 PLN");
  });

  it("sends at most one alert per category per month", async () => {
    const u = await seedUser();
    const budgetId = await addBudget(u.userId, u.food, 10_00);
    await addTxn(u.userId, u.pln, u.food, -20_00);
    await checkBudgetAlerts(u.userId, NOW);

    // More spending: no new alert.
    await addTxn(u.userId, u.pln, u.food, -20_00);
    expect(await checkBudgetAlerts(u.userId, NOW)).toBe(0);

    // Raise the limit, then go over again: still no new alert.
    await db
      .update(schema.budgets)
      .set({ limit_minor: 50_00 })
      .where(eq(schema.budgets.id, budgetId));
    await addTxn(u.userId, u.pln, u.food, -20_00);
    expect(await checkBudgetAlerts(u.userId, NOW)).toBe(0);

    // Delete and re-create the budget: still no new alert.
    await db.delete(schema.budgets).where(eq(schema.budgets.id, budgetId));
    await addBudget(u.userId, u.food, 10_00);
    expect(await checkBudgetAlerts(u.userId, NOW)).toBe(0);

    expect(emailsTo(u.email)).toHaveLength(1);
  });

  it("alerts again in a new month", async () => {
    const u = await seedUser();
    await addBudget(u.userId, u.food, 10_00);
    await addTxn(u.userId, u.pln, u.food, -20_00, "2026-11-10");
    await addTxn(u.userId, u.pln, u.food, -20_00, "2026-12-10");

    expect(await checkBudgetAlerts(u.userId, NOW)).toBe(1);
    expect(
      await checkBudgetAlerts(u.userId, new Date("2026-12-15T00:00:00Z")),
    ).toBe(1);
    expect(emailsTo(u.email)).toHaveLength(2);
  });

  it("sends separate alerts for separate budgets", async () => {
    const u = await seedUser();
    await addBudget(u.userId, u.food, 10_00);
    await addBudget(u.userId, u.groceries, 5_00);
    await addTxn(u.userId, u.pln, u.groceries, -20_00);

    expect(await checkBudgetAlerts(u.userId, NOW)).toBe(2);
  });

  it("doesn't email unverified users, users without email, or users pending deletion", async () => {
    const unverified = await seedUser({ verified: false });
    const noEmail = await seedUser({ email: false });
    const deleting = await seedUser();
    await db
      .update(schema.users)
      .set({ deletion_requested_at: new Date() })
      .where(eq(schema.users.id, deleting.userId));

    for (const u of [unverified, noEmail, deleting]) {
      await addBudget(u.userId, u.food, 10_00);
      await addTxn(u.userId, u.pln, u.food, -20_00);
      expect(await checkBudgetAlerts(u.userId, NOW)).toBe(0);
    }
    expect(email.sendEmail).not.toHaveBeenCalled();

    // Verifying later in the month still produces the alert.
    await db
      .update(schema.users)
      .set({ email_verified_at: new Date() })
      .where(eq(schema.users.id, unverified.userId));
    expect(await checkBudgetAlerts(unverified.userId, NOW)).toBe(1);
  });

  it("doesn't retry a failed send (no duplicates)", async () => {
    const u = await seedUser();
    await addBudget(u.userId, u.food, 10_00);
    await addTxn(u.userId, u.pln, u.food, -20_00);

    vi.mocked(email.sendEmail).mockRejectedValueOnce(new Error("smtp down"));
    await expect(checkBudgetAlerts(u.userId, NOW)).resolves.toBe(1);
    expect(await checkBudgetAlerts(u.userId, NOW)).toBe(0);
    expect(email.sendEmail).toHaveBeenCalledTimes(1);
    expect(emailsTo(u.email)).toHaveLength(0);
  });

  it("runBudgetAlertCheck never throws", async () => {
    const u = await seedUser();
    await addBudget(u.userId, u.food, 10_00);
    await addTxn(
      u.userId,
      u.pln,
      u.food,
      -20_00,
      utcMonthRange().from,
    );
    vi.mocked(email.sendEmail).mockRejectedValueOnce(new Error("smtp down"));
    await expect(runBudgetAlertCheck(u.userId)).resolves.toBeUndefined();
    await expect(runBudgetAlertCheck("no-such-user")).resolves.toBeUndefined();
  });
});

describe("budget plan limit", () => {
  const setPlan = (userId: string, plan: "free" | "pro") =>
    db
      .insert(schema.subscriptions)
      .values({ user_id: userId, plan, status: "active" })
      .onConflictDoUpdate({
        target: schema.subscriptions.user_id,
        set: { plan, status: "active" },
      });

  const extraCategories = async (userId: string, n: number) => {
    const rows = Array.from({ length: n }, (_, i) => ({
      id: `${userId}-extra-${i}`,
      user_id: userId,
      name: `Extra ${i}`,
    }));
    await db.insert(schema.categories).values(rows);
    return rows.map((r) => r.id);
  };
  const create = (userId: string, categoryId: string) =>
    createBudgetWithinLimit(userId, {
      categoryId,
      currency: "PLN",
      limitMinor: 10_00,
    });

  it("free plan is blocked at the limit; pro is unlimited", async () => {
    const u = await seedUser();
    const limit = env.billing.freeMaxBudgets;
    const ids = await extraCategories(u.userId, limit + 3);

    for (const id of ids.slice(0, limit)) {
      expect(await create(u.userId, id)).toMatchObject({ ok: true });
    }
    expect(await create(u.userId, ids[limit])).toEqual({
      ok: false,
      code: "budget_limit_reached",
      limit,
    });

    await setPlan(u.userId, "pro");
    expect(await create(u.userId, ids[limit])).toMatchObject({ ok: true });
    expect(await create(u.userId, ids[limit + 1])).toMatchObject({ ok: true });

    // Downgrade: existing budgets stay and keep tracking; creating is blocked.
    await setPlan(u.userId, "free");
    expect(await create(u.userId, ids[limit + 2])).toMatchObject({
      ok: false,
      code: "budget_limit_reached",
    });
    expect(await getBudgetsWithSpending(u.userId, NOW)).toHaveLength(limit + 2);
  });

  it("rejects a second budget for the same category", async () => {
    const u = await seedUser();
    expect(await create(u.userId, u.food)).toMatchObject({ ok: true });
    expect(await create(u.userId, u.food)).toEqual({
      ok: false,
      code: "budget_exists",
    });
  });

  it("concurrent creates can't exceed the free limit", async () => {
    const u = await seedUser();
    const limit = env.billing.freeMaxBudgets;
    const ids = await extraCategories(u.userId, limit + 4);
    for (const id of ids.slice(0, limit - 1)) await create(u.userId, id);

    // One slot left, five requests at once.
    const results = await Promise.all(
      ids.slice(limit - 1).map((id) => create(u.userId, id)),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(
      (await getBudgetsWithSpending(u.userId, NOW)).length,
    ).toBe(limit);
  });
});

// @vitest-environment node
// Required: TanStack Start's import protection mocks server modules in jsdom (client) environment.

import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "../src/db/index.ts";
import { deleteCategoryForUser } from "../src/server/categories.server.ts";

let seq = 0;

/** A user with Food > Groceries > Fruit and Fun, a transaction in each of
 * Groceries and Fruit, a rule and receipt item on Groceries, and a budget
 * (with this month's alert) on Groceries. */
async function seedUser() {
  const u = `catdel-${Date.now()}-${seq++}`;
  const id = (name: string) => `${u}-${name}`;
  await db.insert(schema.users).values({
    id: u,
    username: u,
    password_hash: "x",
  });
  await db
    .insert(schema.accounts)
    .values({ id: id("acc"), user_id: u, name: "Main", currency: "PLN" });
  await db.insert(schema.categories).values([
    { id: id("food"), user_id: u, name: "Food" },
    {
      id: id("groceries"),
      user_id: u,
      name: "Groceries",
      parent_id: id("food"),
    },
    {
      id: id("fruit"),
      user_id: u,
      name: "Fruit",
      parent_id: id("groceries"),
    },
    { id: id("fun"), user_id: u, name: "Fun" },
  ]);
  await db.insert(schema.transactions).values([
    {
      id: id("t-groceries"),
      user_id: u,
      account_id: id("acc"),
      date: "2026-11-02",
      amount_minor: -1000,
      category_id: id("groceries"),
    },
    {
      id: id("t-fruit"),
      user_id: u,
      account_id: id("acc"),
      date: "2026-11-02",
      amount_minor: -500,
      category_id: id("fruit"),
    },
  ]);
  await db.insert(schema.categorization_rules).values({
    id: id("rule"),
    user_id: u,
    pattern: "LIDL",
    category_id: id("groceries"),
  });
  await db
    .insert(schema.receipts)
    .values({ id: id("receipt"), user_id: u });
  await db.insert(schema.receipt_items).values({
    id: id("item"),
    receipt_id: id("receipt"),
    name: "Apples",
    total_price_minor: 500,
    category_id: id("groceries"),
  });
  await db.insert(schema.budgets).values({
    id: id("budget"),
    user_id: u,
    category_id: id("groceries"),
    currency: "PLN",
    limit_minor: 100,
  });
  await db.insert(schema.budget_alerts).values({
    id: id("alert"),
    user_id: u,
    category_id: id("groceries"),
    month: "2026-11",
  });
  return { userId: u, id };
}

async function snapshot(userId: string) {
  const [categories, transactions, rules, items, budgets, alerts] =
    await Promise.all([
      db
        .select({ id: schema.categories.id })
        .from(schema.categories)
        .where(eq(schema.categories.user_id, userId)),
      db
        .select({
          id: schema.transactions.id,
          category_id: schema.transactions.category_id,
        })
        .from(schema.transactions)
        .where(eq(schema.transactions.user_id, userId)),
      db
        .select({ id: schema.categorization_rules.id })
        .from(schema.categorization_rules)
        .where(eq(schema.categorization_rules.user_id, userId)),
      db
        .select({
          id: schema.receipt_items.id,
          category_id: schema.receipt_items.category_id,
        })
        .from(schema.receipt_items)
        .where(eq(schema.receipt_items.receipt_id, `${userId}-receipt`)),
      db
        .select({ id: schema.budgets.id })
        .from(schema.budgets)
        .where(eq(schema.budgets.user_id, userId)),
      db
        .select({ id: schema.budget_alerts.id })
        .from(schema.budget_alerts)
        .where(eq(schema.budget_alerts.user_id, userId)),
    ]);
  const sort = <T extends { id: string }>(rows: T[]) =>
    rows.sort((a, b) => a.id.localeCompare(b.id));
  return {
    categories: sort(categories),
    transactions: sort(transactions),
    rules,
    items,
    budgets,
    alerts,
  };
}

describe("deleteCategoryForUser", () => {
  it("deletes the subtree, its rules, budgets and alerts, and reassigns transactions", async () => {
    const { userId, id } = await seedUser();

    const result = await deleteCategoryForUser(userId, {
      id: id("groceries"),
      reassignToCategoryId: id("fun"),
      confirmedBudgetCategoryIds: [id("groceries")],
    });

    expect(result).toEqual({ success: true });
    const after = await snapshot(userId);
    expect(after.categories.map((c) => c.id)).toEqual(
      [id("food"), id("fun")].sort(),
    );
    expect(after.transactions.map((t) => t.category_id)).toEqual([
      id("fun"),
      id("fun"),
    ]);
    expect(after.rules).toEqual([]);
    expect(after.items).toEqual([{ id: id("item"), category_id: null }]);
    expect(after.budgets).toEqual([]);
    expect(after.alerts).toEqual([]);
  });

  it("treats another user's category as missing and changes none of their data", async () => {
    const victim = await seedUser();
    const attacker = await seedUser();
    const before = await snapshot(victim.userId);

    for (const target of ["groceries", "fun"]) {
      const result = await deleteCategoryForUser(attacker.userId, {
        id: victim.id(target),
        confirmedBudgetCategoryIds: [],
      });
      expect(result).toMatchObject({ code: "category_not_found" });
    }

    expect(await snapshot(victim.userId)).toEqual(before);
  });

  it("refuses to move transactions into a category being deleted", async () => {
    const { userId, id } = await seedUser();
    const before = await snapshot(userId);

    for (const target of ["groceries", "fruit"]) {
      const result = await deleteCategoryForUser(userId, {
        id: id("groceries"),
        reassignToCategoryId: id(target),
        confirmedBudgetCategoryIds: [id("groceries")],
      });
      expect(result).toMatchObject({ code: "reassign_target_invalid" });
    }

    expect(await snapshot(userId)).toEqual(before);
  });

  it("refuses to move transactions into another user's category", async () => {
    const { userId, id } = await seedUser();
    const other = await seedUser();

    const result = await deleteCategoryForUser(userId, {
      id: id("groceries"),
      reassignToCategoryId: other.id("fun"),
      confirmedBudgetCategoryIds: [id("groceries")],
    });

    expect(result).toMatchObject({ code: "reassign_target_invalid" });
  });

  it("deletes nothing when the budgets don't match what the user was warned about", async () => {
    const { userId, id } = await seedUser();
    const before = await snapshot(userId);

    // Warned about no budgets (e.g. the budget was added in another tab).
    expect(
      await deleteCategoryForUser(userId, { id: id("food") }),
    ).toMatchObject({ code: "budgets_changed" });
    // Warned about a budget that isn't there any more.
    expect(
      await deleteCategoryForUser(userId, {
        id: id("food"),
        confirmedBudgetCategoryIds: [id("groceries"), id("fruit")],
      }),
    ).toMatchObject({ code: "budgets_changed" });

    expect(await snapshot(userId)).toEqual(before);
  });

  it("deletes a category without budgets when none were confirmed", async () => {
    const { userId, id } = await seedUser();

    const result = await deleteCategoryForUser(userId, {
      id: id("fun"),
      confirmedBudgetCategoryIds: [],
    });

    expect(result).toEqual({ success: true });
    const after = await snapshot(userId);
    expect(after.categories.map((c) => c.id)).not.toContain(id("fun"));
    expect(after.budgets).toHaveLength(1);
  });
});

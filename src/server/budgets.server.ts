import { and, asc, count, eq, gte, lt, lte, sql } from "drizzle-orm";
import { db, schema } from "#/db";
import { formatMoney } from "#/lib/money";
import { formatMonth } from "#/lib/month";
import { m } from "#/paraglide/messages";
import { getEntitlements } from "#/server/billing.server";
import { sendEmail } from "#/server/email";
import { env } from "#/server/env";
import { getLogger } from "#/server/logger";

//
// Monthly category budgets (see docs/budgets-spec.md). Spending is derived
// from transactions on every read — there is no stored running total, so
// "resetting every month" is just the query's date range moving forward.
//
// Rules, by spec id:
//   A1 only transactions from accounts in the budget's currency count
//   A2 the period is the calendar month in UTC
//   A5 a budget covers its category and every descendant category
//   A6 the transaction's own category is used (receipt items are ignored)
//   A7 only spending (amount < 0) counts; income/refunds never reduce it
//   A8 over budget means spent strictly greater than the limit

export interface MonthRange {
  /** "YYYY-MM" — the alert ledger key. */
  month: string;
  /** Inclusive calendar-date bounds, "YYYY-MM-DD". */
  from: string;
  to: string;
}

export interface BudgetWithSpending {
  id: string;
  categoryId: string;
  categoryName: string;
  categoryColor: string | null;
  currency: string;
  /** All amounts are integer minor units (grosze/cents). */
  limitMinor: number;
  spentMinor: number;
  /** Negative when over budget. */
  leftMinor: number;
  isOver: boolean;
}

// Accounts created before currencies were required fall back to the
// column default.
const DEFAULT_CURRENCY = "PLN";

const pad2 = (n: number) => String(n).padStart(2, "0");

export function utcMonthRange(now: Date = new Date()): MonthRange {
  const year = now.getUTCFullYear();
  const monthIndex = now.getUTCMonth();
  const lastDay = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  const month = `${year}-${pad2(monthIndex + 1)}`;
  return { month, from: `${month}-01`, to: `${month}-${pad2(lastDay)}` };
}

/** Category id → the ids of the category itself and all its descendants.
 * Guards against cycles, which the server already prevents on update. */
function descendantSets(
  categories: Array<{ id: string; parent_id: string | null }>,
): (rootId: string) => string[] {
  const children = new Map<string, string[]>();
  for (const c of categories) {
    if (!c.parent_id) continue;
    const list = children.get(c.parent_id) ?? [];
    list.push(c.id);
    children.set(c.parent_id, list);
  }
  return (rootId) => {
    const seen = new Set<string>();
    const stack = [rootId];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      stack.push(...(children.get(id) ?? []));
    }
    return [...seen];
  };
}

export async function getBudgetsWithSpending(
  userId: string,
  now: Date = new Date(),
): Promise<BudgetWithSpending[]> {
  const budgets = await db
    .select({
      id: schema.budgets.id,
      categoryId: schema.budgets.category_id,
      categoryName: schema.categories.name,
      categoryColor: schema.categories.color,
      currency: schema.budgets.currency,
      limitMinor: schema.budgets.limit_minor,
    })
    .from(schema.budgets)
    .innerJoin(
      schema.categories,
      eq(schema.budgets.category_id, schema.categories.id),
    )
    .where(eq(schema.budgets.user_id, userId))
    .orderBy(asc(schema.categories.name));
  if (budgets.length === 0) return [];

  const categories = await db
    .select({
      id: schema.categories.id,
      parent_id: schema.categories.parent_id,
    })
    .from(schema.categories)
    .where(eq(schema.categories.user_id, userId));
  const descendantsOf = descendantSets(categories);

  // One aggregate for the whole month: spending per (category, currency).
  const { from, to } = utcMonthRange(now);
  const spendingRows = await db
    .select({
      categoryId: schema.transactions.category_id,
      currency: schema.accounts.currency,
      // SUM over integers is bigint in Postgres (returned as a string).
      spent: sql<number>`COALESCE(SUM(-${schema.transactions.amount_minor}), 0)`.mapWith(Number),
    })
    .from(schema.transactions)
    .innerJoin(
      schema.accounts,
      eq(schema.transactions.account_id, schema.accounts.id),
    )
    .where(
      and(
        eq(schema.transactions.user_id, userId),
        gte(schema.transactions.date, from),
        lte(schema.transactions.date, to),
        lt(schema.transactions.amount_minor, 0),
        sql`${schema.transactions.category_id} IS NOT NULL`,
      ),
    )
    .groupBy(schema.transactions.category_id, schema.accounts.currency);

  const spentBy = new Map<string, number>();
  for (const row of spendingRows) {
    const key = `${row.categoryId}|${row.currency ?? DEFAULT_CURRENCY}`;
    spentBy.set(key, (spentBy.get(key) ?? 0) + row.spent);
  }

  return budgets.map((b) => {
    const spentMinor = descendantsOf(b.categoryId).reduce(
      (sum, id) => sum + (spentBy.get(`${id}|${b.currency}`) ?? 0),
      0,
    );
    return {
      ...b,
      spentMinor,
      leftMinor: b.limitMinor - spentMinor,
      isOver: spentMinor > b.limitMinor,
    };
  });
}

export type CreateBudgetResult =
  | { ok: true; id: string }
  | {
      ok: false;
      code: "budget_limit_reached";
      /** Echoed to the client so the UI can localize the message. */
      limit: number;
    }
  | { ok: false; code: "budget_exists" };

/**
 * Create a budget, enforcing the free-plan limit atomically. Counting and
 * inserting run in one transaction that first locks the user's row, so two
 * concurrent requests can't both pass the count. Budgets above the limit
 * (e.g. after a downgrade) keep working — only creating new ones is blocked.
 */
export async function createBudgetWithinLimit(
  userId: string,
  values: { categoryId: string; currency: string; limitMinor: number },
): Promise<CreateBudgetResult> {
  const { maxBudgets } = await getEntitlements(userId);
  return db.transaction(async (tx) => {
    await tx
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .for("update");

    if (maxBudgets !== null) {
      const rows = await tx
        .select({ count: count() })
        .from(schema.budgets)
        .where(eq(schema.budgets.user_id, userId));
      if ((rows[0]?.count ?? 0) >= maxBudgets) {
        return {
          ok: false as const,
          code: "budget_limit_reached" as const,
          limit: maxBudgets,
        };
      }
    }

    const id = crypto.randomUUID();
    const inserted = await tx
      .insert(schema.budgets)
      .values({
        id,
        user_id: userId,
        category_id: values.categoryId,
        currency: values.currency,
        limit_minor: values.limitMinor,
      })
      .onConflictDoNothing()
      .returning({ id: schema.budgets.id });
    if (inserted.length === 0) {
      return { ok: false as const, code: "budget_exists" as const };
    }
    return { ok: true as const, id };
  });
}

export async function countBudgets(userId: string): Promise<number> {
  const rows = await db
    .select({ count: count() })
    .from(schema.budgets)
    .where(eq(schema.budgets.user_id, userId));
  return rows[0]?.count ?? 0;
}

/**
 * Send an over-budget email for every budget that is over this month and
 * hasn't been alerted yet. Returns the number of alerts claimed.
 *
 * Only verified addresses of accounts not pending deletion receive alerts;
 * ineligible users claim nothing, so verifying later in the month still
 * gets them an alert on the next change. The ledger row is claimed before
 * sending: a failed send is logged and never retried, so no duplicate can
 * ever go out.
 */
export async function checkBudgetAlerts(
  userId: string,
  now: Date = new Date(),
): Promise<number> {
  const over = (await getBudgetsWithSpending(userId, now)).filter(
    (b) => b.isOver,
  );
  if (over.length === 0) return 0;

  const users = await db
    .select({
      email: schema.users.email,
      email_verified_at: schema.users.email_verified_at,
      deletion_requested_at: schema.users.deletion_requested_at,
    })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  const user = users[0];
  if (
    !user?.email ||
    !user.email_verified_at ||
    user.deletion_requested_at
  ) {
    return 0;
  }

  const { month } = utcMonthRange(now);
  let claimed = 0;
  for (const budget of over) {
    const inserted = await db
      .insert(schema.budget_alerts)
      .values({
        id: crypto.randomUUID(),
        user_id: userId,
        category_id: budget.categoryId,
        month,
      })
      .onConflictDoNothing()
      .returning({ id: schema.budget_alerts.id });
    if (inserted.length === 0) continue;
    claimed++;

    try {
      await sendEmail({
        to: user.email,
        subject: m.email_budget_exceeded_subject({
          category: budget.categoryName,
        }),
        text: m.email_budget_exceeded_body({
          category: budget.categoryName,
          month: formatMonth(month),
          limit: formatMoney(budget.limitMinor, budget.currency),
          spent: formatMoney(budget.spentMinor, budget.currency),
          over: formatMoney(-budget.leftMinor, budget.currency),
          link: `${env.email.baseUrl}/budgets`,
        }),
      });
    } catch (error) {
      getLogger().error(
        { err: error, budgetId: budget.id, month },
        "failed to send budget alert email (not retried)",
      );
    }
  }
  return claimed;
}

/** Entry point for every mutation that can raise this month's spending.
 * Never throws: an alert problem must not fail the user's action. */
export async function runBudgetAlertCheck(userId: string): Promise<void> {
  try {
    await checkBudgetAlerts(userId);
  } catch (error) {
    getLogger().error({ err: error }, "budget alert check failed");
  }
}

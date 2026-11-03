import { createServerFn } from "@tanstack/react-start";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "#/db";
import { getEntitlements } from "#/server/billing.server";
import {
  createBudgetWithinLimit,
  getBudgetsWithSpending,
  runBudgetAlertCheck,
  utcMonthRange,
} from "#/server/budgets.server";
import { ownedEntityExists } from "#/server/ownership.server";
import { requireUserId } from "#/server/session";

//
// Client-callable budgets surface. Spending math, plan gating and alerts
// live in budgets.server.ts; rules are documented in docs/budgets-spec.md.

const currencyRegex = /^[A-Z]{3}$/;

const limitMinorSchema = z
  .number()
  .int()
  .positive("Limit must be greater than zero")
  // 10,000,000.00 — well inside the Postgres integer column.
  .max(1_000_000_000);

const createBudgetSchema = z.object({
  categoryId: z.string().min(1),
  currency: z.string().regex(currencyRegex, "Currency must be a 3-letter ISO code"),
  limitMinor: limitMinorSchema,
});

const updateBudgetSchema = z.object({
  id: z.string().min(1),
  currency: z.string().regex(currencyRegex, "Currency must be a 3-letter ISO code"),
  limitMinor: limitMinorSchema,
});

const deleteBudgetSchema = z.object({
  id: z.string().min(1),
});

export const getBudgets = createServerFn({ method: "GET" }).handler(
  async () => {
    const userId = await requireUserId();
    const [budgets, entitlements] = await Promise.all([
      getBudgetsWithSpending(userId),
      getEntitlements(userId),
    ]);
    return {
      month: utcMonthRange().month,
      budgets,
      plan: entitlements.plan,
      usage: { used: budgets.length, limit: entitlements.maxBudgets },
    };
  },
);

export const createBudget = createServerFn({ method: "POST" })
  .inputValidator(createBudgetSchema)
  .handler(async ({ data }) => {
    const userId = await requireUserId();

    if (!(await ownedEntityExists("category", userId, data.categoryId))) {
      return {
        error: "Category does not exist",
        code: "category_not_found" as const,
      };
    }

    const created = await createBudgetWithinLimit(userId, data);
    if (!created.ok) {
      return created.code === "budget_limit_reached"
        ? {
            error: `Free plan is limited to ${created.limit} budgets. Upgrade to Pro for unlimited budgets.`,
            code: created.code,
            limit: created.limit,
          }
        : { error: "This category already has a budget", code: created.code };
    }

    // A new budget can already be over for this month.
    await runBudgetAlertCheck(userId);
    return { success: true, id: created.id };
  });

export const updateBudget = createServerFn({ method: "POST" })
  .inputValidator(updateBudgetSchema)
  .handler(async ({ data }) => {
    const userId = await requireUserId();
    const updated = await db
      .update(schema.budgets)
      .set({
        currency: data.currency,
        limit_minor: data.limitMinor,
        updated_at: new Date(),
      })
      .where(
        and(eq(schema.budgets.id, data.id), eq(schema.budgets.user_id, userId)),
      )
      .returning({ id: schema.budgets.id });
    if (updated.length === 0) {
      return { error: "Budget not found", code: "budget_not_found" as const };
    }

    // Lowering the limit below this month's spending is "going over".
    await runBudgetAlertCheck(userId);
    return { success: true };
  });

export const deleteBudget = createServerFn({ method: "POST" })
  .inputValidator(deleteBudgetSchema)
  .handler(async ({ data }) => {
    const userId = await requireUserId();
    const deleted = await db
      .delete(schema.budgets)
      .where(
        and(eq(schema.budgets.id, data.id), eq(schema.budgets.user_id, userId)),
      )
      .returning({ id: schema.budgets.id });
    if (deleted.length === 0) {
      return { error: "Budget not found", code: "budget_not_found" as const };
    }
    return { success: true };
  });

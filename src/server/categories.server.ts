import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "#/db";

//
// Category deletion. Everything a delete touches is scoped to the signed-in
// user and runs in one transaction, so a failed step can't leave half the
// subtree's rules, budgets or receipt items changed.

export interface DeleteCategoryInput {
  id: string;
  reassignToCategoryId?: string | null;
  /** Category ids whose budgets the user was warned about (and so agreed to
   * delete). Must match the budgets actually in the subtree. */
  confirmedBudgetCategoryIds?: string[];
}

export type DeleteCategoryResult =
  | { success: true }
  | {
      error: string;
      code: "category_not_found" | "reassign_target_invalid" | "budgets_changed";
    };

export async function deleteCategoryForUser(
  userId: string,
  input: DeleteCategoryInput,
): Promise<DeleteCategoryResult> {
  return db.transaction(async (tx) => {
    const categories = await tx
      .select({
        id: schema.categories.id,
        parent_id: schema.categories.parent_id,
      })
      .from(schema.categories)
      .where(eq(schema.categories.user_id, userId));

    // Another user's (or a since-deleted) category looks exactly like a
    // missing one.
    if (!categories.some((c) => c.id === input.id)) {
      return {
        error: "Category not found",
        code: "category_not_found" as const,
      };
    }

    // The category and all its descendants (children, grandchildren, ...).
    const idsToDelete: string[] = [];
    const pending = [input.id];
    while (pending.length > 0) {
      const id = pending.pop()!;
      if (idsToDelete.includes(id)) continue;
      idsToDelete.push(id);
      for (const c of categories) {
        if (c.parent_id === id) pending.push(c.id);
      }
    }

    const reassignTo = input.reassignToCategoryId || null;
    if (
      reassignTo &&
      (idsToDelete.includes(reassignTo) ||
        !categories.some((c) => c.id === reassignTo))
    ) {
      return {
        error: "Transactions can't be moved to a category that is being deleted",
        code: "reassign_target_invalid" as const,
      };
    }

    // The UI warns which budgets go with the category. If that list is out
    // of date, delete nothing and let the user confirm again.
    const budgets = await tx
      .select({ category_id: schema.budgets.category_id })
      .from(schema.budgets)
      .where(
        and(
          eq(schema.budgets.user_id, userId),
          inArray(schema.budgets.category_id, idsToDelete),
        ),
      );
    const confirmed = new Set(input.confirmedBudgetCategoryIds ?? []);
    if (
      budgets.length !== confirmed.size ||
      budgets.some((b) => !confirmed.has(b.category_id))
    ) {
      return {
        error: "Budgets changed since this was opened. Review and try again.",
        code: "budgets_changed" as const,
      };
    }

    await tx
      .update(schema.transactions)
      .set({ category_id: reassignTo })
      .where(
        and(
          eq(schema.transactions.user_id, userId),
          inArray(schema.transactions.category_id, idsToDelete),
        ),
      );

    await tx
      .update(schema.receipt_items)
      .set({ category_id: null })
      .where(
        and(
          inArray(schema.receipt_items.category_id, idsToDelete),
          inArray(
            schema.receipt_items.receipt_id,
            tx
              .select({ id: schema.receipts.id })
              .from(schema.receipts)
              .where(eq(schema.receipts.user_id, userId)),
          ),
        ),
      );

    await tx
      .delete(schema.categorization_rules)
      .where(
        and(
          eq(schema.categorization_rules.user_id, userId),
          inArray(schema.categorization_rules.category_id, idsToDelete),
        ),
      );

    // Budgets (and their alert ledger) reference the categories, so they go
    // before the categories themselves.
    await tx
      .delete(schema.budgets)
      .where(
        and(
          eq(schema.budgets.user_id, userId),
          inArray(schema.budgets.category_id, idsToDelete),
        ),
      );
    await tx
      .delete(schema.budget_alerts)
      .where(
        and(
          eq(schema.budget_alerts.user_id, userId),
          inArray(schema.budget_alerts.category_id, idsToDelete),
        ),
      );

    await tx
      .delete(schema.categories)
      .where(
        and(
          eq(schema.categories.user_id, userId),
          inArray(schema.categories.id, idsToDelete),
        ),
      );

    return { success: true as const };
  });
}

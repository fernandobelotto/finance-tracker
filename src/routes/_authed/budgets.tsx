import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useEffect } from "react";
import { m } from "#/paraglide/messages";
import { EditButton, DeleteButton } from "#/components/ui/action-buttons";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { Select, SelectItem } from "#/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "#/components/ui/alert-dialog";
import {
  formatMoney,
  minorToInputValue,
  parseAmountToMinor,
} from "#/lib/money";
import { MAX_BUDGET_LIMIT_MINOR } from "#/lib/budget-limit";
import { formatMonth } from "#/lib/month";
import { cn } from "#/lib/utils";
import { getAccounts } from "#/server/accounts.functions";
import {
  getBudgets,
  createBudget,
  updateBudget,
  deleteBudget,
} from "#/server/budgets.functions";
import { getCategories } from "#/server/categories.functions";

export const Route = createFileRoute("/_authed/budgets")({
  component: BudgetsPage,
});

type BudgetsData = Awaited<ReturnType<typeof getBudgets>>;
type BudgetRow = BudgetsData["budgets"][number];
type CategoryRow = Awaited<ReturnType<typeof getCategories>>[number];

const BUDGETS_QUERY_KEY = ["budgets"] as const;
const CATEGORIES_QUERY_KEY = ["categories"] as const;
const ACCOUNTS_QUERY_KEY = ["accounts"] as const;

const FALLBACK_CURRENCY = "PLN";

// Categories carry no income/expense flag; the default category tree puts
// income under a top-level "Income" category. Budgets only count spending,
// so a budget there could never show anything — keep that tree out of the
// picker (A7).
const INCOME_ROOT_NAME = "income";

function rootCategory(
  id: string,
  byId: Map<string, CategoryRow>,
): CategoryRow | undefined {
  const seen = new Set<string>();
  let cursor = byId.get(id);
  while (cursor?.parent_id && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    const parent = byId.get(cursor.parent_id);
    if (!parent) break;
    cursor = parent;
  }
  return cursor;
}

/** Category label with its parent chain, e.g. "Food › Groceries". */
function categoryPath(id: string, byId: Map<string, CategoryRow>): string {
  const parts: string[] = [];
  const seen = new Set<string>();
  let cursor = byId.get(id);
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    parts.unshift(cursor.name);
    cursor = cursor.parent_id ? byId.get(cursor.parent_id) : undefined;
  }
  return parts.join(" › ");
}

function errorMessage(result: {
  error?: string;
  code?: string;
  limit?: number;
}): string {
  switch (result.code) {
    case "budget_limit_reached":
      return m.budget_limit_reached({ limit: result.limit ?? 0 });
    case "budget_exists":
      return m.budget_exists();
    case "category_not_found":
      return m.budget_category_not_found();
    case "budget_not_found":
      return m.budget_not_found();
    default:
      return result.error ?? m.budget_save_failed();
  }
}

// --- Budget Row ---

function BudgetItem({
  budget,
  categoryLabel,
  hasSubcategories,
  onEdit,
  onDelete,
}: {
  budget: BudgetRow;
  categoryLabel: string;
  hasSubcategories: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const percent =
    budget.limitMinor > 0
      ? Math.min(100, (budget.spentMinor / budget.limitMinor) * 100)
      : 0;

  return (
    <div
      className="px-4 py-3.5 space-y-2"
      role="listitem"
      aria-label={categoryLabel}
      data-testid="budget-row"
    >
      <div className="flex items-center gap-3">
        <span
          className="size-3.5 shrink-0 rounded-full border border-border/50"
          style={{ backgroundColor: budget.categoryColor ?? "#6b7280" }}
          aria-hidden="true"
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium truncate">
              {categoryLabel}
            </span>
            <span className="text-xs text-muted-foreground">
              {budget.currency}
            </span>
            {budget.isOver && (
              <Badge variant="destructive" data-testid="budget-over-badge">
                {m.budget_over_badge()}
              </Badge>
            )}
          </div>
          {hasSubcategories && (
            <p className="text-xs text-muted-foreground">
              {m.budget_includes_subcategories()}
            </p>
          )}
        </div>
        <div className="flex items-center gap-1">
          <EditButton onClick={onEdit} data-testid="edit-budget" />
          <DeleteButton onClick={onDelete} data-testid="delete-budget" />
        </div>
      </div>

      <div
        className="h-2 rounded-full bg-muted overflow-hidden"
        role="progressbar"
        aria-label={categoryLabel}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(percent)}
      >
        <div
          className={cn(
            "h-full rounded-full",
            budget.isOver
              ? "bg-destructive"
              : percent >= 80
                ? "bg-amber-500"
                : "bg-primary",
          )}
          style={{ width: `${percent}%` }}
        />
      </div>

      <dl className="grid grid-cols-3 gap-2 text-xs">
        <div>
          <dt className="text-muted-foreground">{m.budget_limit_column()}</dt>
          <dd className="font-medium tabular-nums" data-testid="budget-limit">
            {formatMoney(budget.limitMinor, budget.currency)}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{m.budget_spent_column()}</dt>
          <dd className="font-medium tabular-nums" data-testid="budget-spent">
            {formatMoney(budget.spentMinor, budget.currency)}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{m.budget_left_column()}</dt>
          <dd
            className={cn(
              "font-medium tabular-nums",
              budget.isOver && "text-destructive",
            )}
            data-testid="budget-left"
          >
            {budget.isOver
              ? m.budget_over_by({
                  amount: formatMoney(-budget.leftMinor, budget.currency),
                })
              : formatMoney(budget.leftMinor, budget.currency)}
          </dd>
        </div>
      </dl>
    </div>
  );
}

// --- Budget Form Modal ---

interface BudgetFormData {
  categoryId: string;
  currency: string;
  limitMinor: number;
}

function BudgetForm({
  isOpen,
  editingBudget,
  categoryOptions,
  currencyOptions,
  categoryLabel,
  onClose,
  onSubmit,
  error,
}: {
  isOpen: boolean;
  editingBudget: BudgetRow | null;
  categoryOptions: Array<{ id: string; label: string }>;
  currencyOptions: string[];
  categoryLabel: (id: string) => string;
  onClose: () => void;
  onSubmit: (data: BudgetFormData) => Promise<void>;
  error: string | null;
}) {
  const [categoryId, setCategoryId] = useState("");
  const [currency, setCurrency] = useState(FALLBACK_CURRENCY);
  const [limit, setLimit] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Reset only when the dialog opens. Depend on primitives: an array prop is
  // a new object on every parent render, and a background refetch would
  // otherwise wipe what the user is typing.
  const defaultCurrency = currencyOptions[0] ?? FALLBACK_CURRENCY;
  useEffect(() => {
    if (isOpen) {
      if (editingBudget) {
        setCategoryId(editingBudget.categoryId);
        setCurrency(editingBudget.currency);
        setLimit(String(minorToInputValue(editingBudget.limitMinor)));
      } else {
        setCategoryId("");
        setCurrency(defaultCurrency);
        setLimit("");
      }
      setValidationError(null);
      setSubmitting(false);
    }
  }, [isOpen, editingBudget?.id, defaultCurrency]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingBudget && !categoryId) {
      setValidationError(m.budget_category_required());
      return;
    }
    const limitMinor = parseAmountToMinor(limit);
    if (limitMinor === null || limitMinor <= 0) {
      setValidationError(m.budget_limit_invalid());
      return;
    }
    if (limitMinor > MAX_BUDGET_LIMIT_MINOR) {
      setValidationError(
        m.budget_limit_too_large({
          max: formatMoney(MAX_BUDGET_LIMIT_MINOR, currency),
        }),
      );
      return;
    }
    setValidationError(null);
    setSubmitting(true);
    try {
      await onSubmit({ categoryId, currency, limitMinor });
    } finally {
      setSubmitting(false);
    }
  };

  // Keep the budget's own currency selectable even if no account uses it
  // any more.
  const currencies =
    editingBudget && !currencyOptions.includes(editingBudget.currency)
      ? [editingBudget.currency, ...currencyOptions]
      : currencyOptions;

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {editingBudget ? m.budgets_edit_title() : m.budgets_add_title()}
          </DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Category — fixed once the budget exists */}
          <div>
            <Label htmlFor="budget-category" className="mb-1">
              {m.budget_category_label()}
            </Label>
            {editingBudget ? (
              <Input
                id="budget-category"
                value={categoryLabel(editingBudget.categoryId)}
                disabled
                readOnly
              />
            ) : categoryOptions.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {m.budget_no_categories_available()}
              </p>
            ) : (
              <Select
                id="budget-category"
                value={categoryId}
                onChange={(e) => setCategoryId(e.target.value)}
              >
                <SelectItem value="">—</SelectItem>
                {categoryOptions.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.label}
                  </SelectItem>
                ))}
              </Select>
            )}
          </div>

          {/* Currency */}
          <div>
            <Label htmlFor="budget-currency" className="mb-1">
              {m.budget_currency_label()}
            </Label>
            <Select
              id="budget-currency"
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
            >
              {currencies.map((c) => (
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </Select>
          </div>

          {/* Limit */}
          <div>
            <Label htmlFor="budget-limit" className="mb-1">
              {m.budget_limit_label()}
            </Label>
            <Input
              id="budget-limit"
              type="text"
              inputMode="decimal"
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
              placeholder="500.00"
              autoFocus={!!editingBudget}
            />
          </div>

          {(validationError || error) && (
            <div className="text-destructive text-sm" role="alert">
              {validationError ?? error}
            </div>
          )}

          <DialogFooter className="pt-2">
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={submitting}
            >
              {m.cancel()}
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting
                ? editingBudget
                  ? m.saving()
                  : m.creating()
                : editingBudget
                  ? m.save_changes()
                  : m.budgets_add()}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// --- Main Page ---

function BudgetsPage() {
  const queryClient = useQueryClient();
  const getBudgetsFn = useServerFn(getBudgets);
  const getCategoriesFn = useServerFn(getCategories);
  const getAccountsFn = useServerFn(getAccounts);
  const createBudgetFn = useServerFn(createBudget);
  const updateBudgetFn = useServerFn(updateBudget);
  const deleteBudgetFn = useServerFn(deleteBudget);

  // Spending changes on other pages (transactions, import, ...), so always
  // refetch when the page is opened.
  const { data, isLoading } = useQuery({
    queryKey: BUDGETS_QUERY_KEY,
    queryFn: () => getBudgetsFn(),
    refetchOnMount: true,
    staleTime: 0,
  });
  const { data: categories = [] } = useQuery({
    queryKey: CATEGORIES_QUERY_KEY,
    queryFn: () => getCategoriesFn(),
  });
  const { data: accounts = [] } = useQuery({
    queryKey: ACCOUNTS_QUERY_KEY,
    queryFn: () => getAccountsFn(),
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: BUDGETS_QUERY_KEY });
    // Categories carry has_budget for the delete warning.
    queryClient.invalidateQueries({ queryKey: CATEGORIES_QUERY_KEY });
    queryClient.invalidateQueries({ queryKey: ["billing"] });
  };

  const createMutation = useMutation({
    mutationFn: (input: BudgetFormData) => createBudgetFn({ data: input }),
    onSuccess: invalidate,
  });
  const updateMutation = useMutation({
    mutationFn: (input: { id: string; currency: string; limitMinor: number }) =>
      updateBudgetFn({ data: input }),
    onSuccess: invalidate,
  });
  const deleteMutation = useMutation({
    mutationFn: (input: { id: string }) => deleteBudgetFn({ data: input }),
    onSuccess: invalidate,
  });

  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingBudget, setEditingBudget] = useState<BudgetRow | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<BudgetRow | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const budgets = data?.budgets ?? [];
  const usage = data?.usage;
  const atLimit = usage?.limit != null && usage.used >= usage.limit;

  const categoriesById = new Map(categories.map((c) => [c.id, c]));
  const labelFor = (id: string) =>
    categoryPath(id, categoriesById) ||
    budgets.find((b) => b.categoryId === id)?.categoryName ||
    "";
  const parentIds = new Set(
    categories.map((c) => c.parent_id).filter((id): id is string => !!id),
  );
  const budgetedIds = new Set(budgets.map((b) => b.categoryId));
  const categoryOptions = categories
    .filter((c) => !budgetedIds.has(c.id))
    .filter(
      (c) =>
        rootCategory(c.id, categoriesById)?.name.trim().toLowerCase() !==
        INCOME_ROOT_NAME,
    )
    .map((c) => ({ id: c.id, label: categoryPath(c.id, categoriesById) }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const currencyOptions = [
    ...new Set(accounts.map((a) => a.currency ?? FALLBACK_CURRENCY)),
  ];

  const handleAdd = () => {
    setEditingBudget(null);
    setFormError(null);
    setIsFormOpen(true);
  };

  const handleEdit = (budget: BudgetRow) => {
    setEditingBudget(budget);
    setFormError(null);
    setIsFormOpen(true);
  };

  const closeForm = () => {
    setIsFormOpen(false);
    setEditingBudget(null);
    setFormError(null);
  };

  // The page was out of date (budget or category removed elsewhere): there is
  // nothing left to retry in the dialog, so close it and show fresh data.
  const isStale = (code?: string) =>
    code === "budget_not_found" || code === "category_not_found";

  const handleFormSubmit = async (input: BudgetFormData) => {
    setFormError(null);
    setNotice(null);
    try {
      const result = editingBudget
        ? await updateMutation.mutateAsync({
            id: editingBudget.id,
            currency: input.currency,
            limitMinor: input.limitMinor,
          })
        : await createMutation.mutateAsync(input);
      if (result && "error" in result) {
        // Errors mean the page's view was wrong (count, categories, ...).
        invalidate();
        if (isStale(result.code)) {
          closeForm();
          setNotice(m.budget_gone_notice());
          return;
        }
        setFormError(errorMessage(result));
        return;
      }
      closeForm();
    } catch {
      setFormError(m.budget_save_failed());
    }
  };

  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return;
    setDeleteError(null);
    try {
      const result = await deleteMutation.mutateAsync({ id: deleteTarget.id });
      if (result && "error" in result) {
        invalidate();
        if (isStale(result.code)) {
          setDeleteTarget(null);
          setNotice(m.budget_gone_notice());
          return;
        }
        setDeleteError(errorMessage(result));
        return;
      }
      setDeleteTarget(null);
    } catch {
      setDeleteError(m.budget_save_failed());
    }
  };

  return (
    <div className="min-h-screen">
      {/* Header */}
      <header className="border-b border-line/50 bg-header-bg/80 backdrop-blur-sm">
        <div className="page-wrap py-4 flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-xl font-bold display-title">
              {m.budgets_title()}
            </h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              {m.budgets_subtitle()}
              {data && (
                <>
                  {" "}
                  <span
                    className="font-medium text-foreground"
                    data-testid="budgets-month"
                  >
                    {m.budgets_current_month({
                      month: formatMonth(data.month),
                    })}
                  </span>
                </>
              )}
            </p>
          </div>
          {data && !atLimit && (
            <Button onClick={handleAdd}>
              <svg
                className="size-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M12 4v16m8-8H4"
                />
              </svg>
              {m.budgets_add()}
            </Button>
          )}
        </div>
      </header>

      <main className="page-wrap py-8 space-y-4">
        {notice && (
          <div
            className="p-3 rounded-md bg-muted text-sm"
            role="status"
            data-testid="budgets-notice"
          >
            {notice}
          </div>
        )}

        {/* Free-plan usage and upsell */}
        {usage?.limit != null && (
          <div
            className={cn(
              "flex items-center justify-between gap-3 flex-wrap rounded-lg border p-3 text-sm",
              atLimit
                ? "border-amber-500/40 bg-amber-500/10"
                : "border-line bg-card",
            )}
            data-testid="budgets-usage"
          >
            <span>
              {atLimit
                ? m.budgets_usage_at_limit({
                    used: usage.used,
                    limit: usage.limit,
                  })
                : m.budgets_usage_free({
                    used: usage.used,
                    limit: usage.limit,
                  })}
            </span>
            <Link
              to="/billing"
              className="font-medium text-primary underline-offset-4 hover:underline"
            >
              {m.budgets_upgrade_cta()}
            </Link>
          </div>
        )}

        {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <div className="flex flex-col items-center gap-3">
              <div className="size-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
              <span className="text-sm text-muted-foreground">
                {m.loading()}
              </span>
            </div>
          </div>
        ) : budgets.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <h3 className="text-base font-medium mb-1">
              {m.budgets_empty_title()}
            </h3>
            <p className="text-sm text-muted-foreground mb-4 max-w-sm">
              {m.budgets_empty_body()}
            </p>
          </div>
        ) : (
          <div
            className="island-shell rounded-xl overflow-hidden divide-y divide-line/30"
            role="list"
            aria-label={m.budgets_title()}
          >
            {budgets.map((budget) => (
              <BudgetItem
                key={budget.id}
                budget={budget}
                categoryLabel={labelFor(budget.categoryId)}
                hasSubcategories={parentIds.has(budget.categoryId)}
                onEdit={() => handleEdit(budget)}
                onDelete={() => {
                  setDeleteError(null);
                  setDeleteTarget(budget);
                }}
              />
            ))}
          </div>
        )}

        <p className="text-xs text-muted-foreground">
          {m.budgets_refunds_note()}
        </p>
      </main>

      <BudgetForm
        isOpen={isFormOpen}
        editingBudget={editingBudget}
        categoryOptions={categoryOptions}
        currencyOptions={
          currencyOptions.length > 0 ? currencyOptions : [FALLBACK_CURRENCY]
        }
        categoryLabel={labelFor}
        onClose={closeForm}
        onSubmit={handleFormSubmit}
        error={formError}
      />

      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <AlertDialogContent className="sm:max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle>{m.budget_delete_title()}</AlertDialogTitle>
            <AlertDialogDescription>
              {m.budget_delete_confirm({
                category: deleteTarget ? labelFor(deleteTarget.categoryId) : "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteError && (
            <div
              className="text-destructive text-sm p-3 rounded-md bg-destructive/10"
              role="alert"
            >
              {deleteError}
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setDeleteTarget(null)}>
              {m.cancel()}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={(e) => {
                e.preventDefault();
                void handleDeleteConfirm();
              }}
            >
              {m.delete()}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

# Monthly category budgets — implementation plan

Implements [budgets-spec.md](budgets-spec.md) (decision ids A1–A20, scenarios
S1–S12). Follows the conventions in CLAUDE.md: routes import only
`*.functions.ts`; DB logic lives in `*.server.ts`; TanStack Query on the
client; all UI text via Paraglide; E2E for every user-facing flow.

## 1. Database — yes, one additive migration

New migration `drizzle/0004_*.sql`, generated with `pnpm db:generate` from
`src/db/schema.ts`. Only `CREATE TABLE` / `CREATE INDEX` — no changes to
existing tables, no backfill. Migrations already run automatically at startup
(`src/db/migrate.ts`), for local PGlite, test in-memory DBs and Postgres alike.

**`budgets`**

| column | type | notes |
|---|---|---|
| `id` | text PK | uuid, like other tables |
| `user_id` | text, FK → users | ownership |
| `category_id` | text, FK → categories | |
| `currency` | text not null | 3-letter ISO (A1) |
| `limit_minor` | integer not null | minor units, > 0 (A9) |
| `created_at`, `updated_at` | timestamptz | |

Unique index on `(user_id, category_id)` — one budget per category (A4),
enforced by the DB rather than only by app code.

**`budget_alerts`** — the "already alerted" ledger (A12, A13)

| column | type | notes |
|---|---|---|
| `id` | text PK | |
| `user_id` | text, FK → users | |
| `category_id` | text, FK → categories | keyed on category, not budget id (A12) |
| `month` | text | `"YYYY-MM"`, UTC (A2) |
| `created_at` | timestamptz | when the alert was claimed |

Unique index on `(user_id, category_id, month)`. Same idempotency pattern as
`stripe_events`: `INSERT … ON CONFLICT DO NOTHING RETURNING` — only the
caller whose insert succeeded sends the email.

## 2. Server changes

### New: `src/server/budgets.server.ts` (server-only, unit-tested directly)
- `utcMonth(now)` → `{ month: "2026-11", from: "2026-11-01", to: "2026-11-30" }` (A2).
- `getBudgetsWithSpending(userId, now)`:
  1. load the user's budgets and categories;
  2. build each budgeted category's descendant set in memory (A5);
  3. **one** aggregate query: `SUM(-amount_minor)` for `amount_minor < 0`
     (A7) in the month, grouped by `category_id` and `accounts.currency`
     (join on account) (A1, A6);
  4. roll up per budget → `{ spentMinor, leftMinor, isOver: spent > limit }` (A8).
- `checkBudgetAlerts(userId, now)`: for each over budget, claim the
  `budget_alerts` row; if claimed and the user has a verified email and no
  pending deletion (A11), `sendEmail()`. Send failures are logged, not
  retried (A13).
- `runBudgetAlertCheck(userId)`: wrapper that catches and logs everything —
  the only thing other modules call, so a failing alert check never fails the
  user's action (A14).
- `checkBudgetLimit(userId)`: same shape as `checkAccountLimit`; blocks
  creating when count ≥ free limit (A15, A16).

### New: `src/server/budgets.functions.ts`
`getBudgets` (budgets with spending, current month, `{ used, limit }`, plan),
`createBudget`, `updateBudget` (limit and currency), `deleteBudget`. zod
`inputValidator`s; ownership checked in the same query; errors returned as
`{ error, code }` with codes `budget_limit_reached`, `budget_exists`,
`category_not_found` so the UI can show localized text. Create/update run the
alert check (S4).

### Changes to existing server modules
| file | change | spec |
|---|---|---|
| `src/db/schema.ts` | two tables above | — |
| `src/server/env.ts` | `BILLING_FREE_MAX_BUDGETS` (default 3) next to `BILLING_FREE_MAX_ACCOUNTS` | A15 |
| `src/server/billing.server.ts` | `maxBudgets` in `Entitlements` (`null` = unlimited for Pro) | A15 |
| `src/server/billing.functions.ts` | `getBillingStatus` returns budget usage/limit | A17 |
| `src/server/ownership.server.ts` | add `budget` to `OWNED_TABLES` | A19 |
| `src/server/categories.functions.ts` | `deleteCategory`: delete `budgets` + `budget_alerts` for the deleted ids before deleting categories. `getCategories`: add `has_budget` so the dialog can warn. `updateCategory`: run alert check (moving a category changes parent totals) | A18, A10 |
| `src/server/compliance.server.ts` | export: `budgets` in `export.json` + `budgets.csv`; `hardDeleteUser`: delete `budget_alerts`, `budgets` before categories/users | A19 |
| alert-check call sites | `runBudgetAlertCheck(userId)` after the write in: `createTransaction`, `updateTransaction` (`transactions.functions.ts`); `confirmImport` after the insert (`imports.functions.ts`); `applyRuleToExisting`, `reCategorizeTransactions` (`categorization.functions.ts`); `saveReceiptAndLink` (`receipts.functions.ts`); `updateAccount` (currency change) (`accounts.functions.ts`) | A10 |

Not hooked, on purpose: deletes (`deleteTransaction`, `deleteImportBatch`,
`deleteReceipt`) only reduce spending; the MCP endpoint doesn't touch
transactions.

## 3. UI changes

| file | change |
|---|---|
| `src/routes/_authed/budgets.tsx` (new) | Page with header (title + current month, formatted in UTC), plan usage ("2 of 3 budgets") and Add button / upgrade prompt linking to `/billing` at the limit (A17). List of budgets: category (colour dot), currency, limit, spent, left, progress bar, "Over budget" badge with overspend (S2, S3). Add/Edit dialog: category (categories that already have a budget are excluded), currency (from the user's accounts' currencies, first account's as default), limit (parsed with `src/lib/money.ts`). Delete confirmation. Empty and loading states. Pattern copied from `categories.tsx`: `useServerFn` + `useQuery(["budgets"])` + `useMutation` with invalidation, `refetchOnMount` so spending is fresh after edits elsewhere. |
| `src/components/sidebar.tsx` | "Budgets" nav item after Categories |
| `src/routes/_authed/categories.tsx` | delete dialog shows a warning when the category or any subcategory has a budget; also invalidates `["budgets"]` |
| `src/routes/_authed/billing.tsx` | budgets usage line next to accounts |
| `messages/en.json` → `pnpm i18n:compile` | all new strings |
| `src/routeTree.gen.ts` | regenerated by the router plugin |

Email (plain text, like existing ones): subject "Budget exceeded: Groceries",
body with month, limit, spent, overspend and a link to `/budgets`.

## 4. Testing

**Unit — `tests/budgets.test.ts`** (vitest, in-memory PGlite, calls
`budgets.server.ts` with an injected `now`):
- spending: subcategories included; other currencies excluded; refunds and
  income ignored; uncategorized ignored; only the current UTC month
  (transactions on the last day of the previous month and first of the next);
  `spent == limit` not over, `spent > limit` over.
- alerts: one per category per month; no second email after raising the limit
  or deleting and re-creating the budget; new month alerts again; unverified /
  no-email / deletion-pending users get none; a throwing `sendEmail` doesn't
  propagate and isn't retried.
- limits: free blocks the 4th; Pro unlimited; downgraded user with 5 keeps
  them and is blocked from creating.
- data lifecycle: `deleteCategory` removes budgets and alerts (incl.
  subcategories'); `hardDeleteUser` removes them; export contains them.
- `env.test.ts`: validation of `BILLING_FREE_MAX_BUDGETS`.

**E2E — `tests/e2e/budgets.spec.ts`** (unique user per test via the
`signedInUser` fixture; transactions dated in the current UTC month):
- nav link opens the page; empty state.
- create → shows limit / spent / left; edit limit → recalculates; delete.
- spending in a subcategory counts toward the parent's budget; a refund
  doesn't reduce it; an EUR account's spending doesn't count toward a PLN
  budget.
- going over shows the over state and sends exactly one email (checked via
  `/test-emails`), a second expense doesn't send another; unverified user
  (`?verified=false`) gets none.
- validation: zero limit; category that already has a budget isn't offered.
- free plan: 3 budgets, then the upgrade prompt; Pro (`/test-set-plan`) can
  add more; downgrade keeps existing ones and blocks adding.
- deleting a budgeted category shows the warning and removes the budget.
- billing page shows budget usage.

**Then:** `pnpm run check`, and a manual pass in the browser on the dev server.

## 5. Where we could break existing behaviour

| risk | why | mitigation |
|---|---|---|
| **Category deletion fails** | the new FK from `budgets`/`budget_alerts` to `categories` makes the existing delete violate the constraint if budgets aren't removed first | delete them first in `deleteCategory`; unit + E2E test deleting a budgeted parent with subcategories |
| **Account deletion fails** | `hardDeleteUser` deletes categories and users; FKs block it if budgets remain | delete budget tables first; covered by the existing compliance tests plus a budgets case |
| **Existing writes become slower or fail** | alert checks are added to 8 mutation paths | single wrapper that catches everything; one aggregate query per call; one call per import, not per row |
| **Import stream breaks** | `confirmImport` is a streaming generator — an exception before the final `complete` event would break the progress UI | check runs after the insert inside the safe wrapper, before the `complete` yield; existing import E2E suite covers it |
| **`getCategories` consumers** | adding `has_budget` changes the shape used by transactions, import, categorization and receipts pages | additive field only; typecheck catches misuse |
| **Billing page / entitlements** | `Entitlements` gains a field; billing E2E asserts usage text | additive; run billing spec |
| **Startup on existing local data** | new migration must apply to `./data/pg` | additive migration, auto-applied; startup refuses to run on an outdated schema, so a missed migration fails loudly |
| **Test isolation** | captured emails are global in the test server | filter `/test-emails?to=` by the test's unique user email |
| **Month-boundary flakiness** | E2E creates "this month" transactions; a run crossing UTC midnight on the 1st could flip months | E2E uses the server's UTC date; boundary cases live in unit tests with a fixed `now` |

## 6. Existing issues found, not fixed by this plan

- **Receipt-created transactions are stored as positive amounts.**
  `saveReceiptAndLink` inserts `amount_minor: data.totalMinor` (positive)
  while the matching search uses `-editedTotal`. Positive = income, so
  purchases created from a scanned receipt won't count toward budgets (and
  show as income on the dashboard). Worth confirming and fixing separately.
- **Transaction dates display a day early** behind UTC (`formatTxDate`), which
  also fails one existing E2E locally (`transactions-list.spec.ts`).
  `pnpm run check` will keep failing on that test on this machine until it's
  fixed.

## 7. Order of work

1. Schema + migration + env/entitlements.
2. `budgets.server.ts` + unit tests.
3. `budgets.functions.ts`, ownership, category-delete and compliance changes.
4. Alert hooks in existing mutations.
5. Budgets page, sidebar, categories warning, billing line, messages.
6. E2E spec; `pnpm run check`; manual browser pass.

# Monthly category budgets — spec

Status: implemented · Source: [TASK.md](../TASK.md) · Plan: [budgets-plan.md](budgets-plan.md)

## 1. Original requirements

From TASK.md, verbatim in substance:

1. New "Budgets" page in the main navigation.
2. User can add a budget for a category with a monthly limit, change the
   limit, and remove the budget.
3. Each budget shows the limit, amount spent this month, what's left, and
   clearly shows when the user is over budget.
4. A budget on a parent category includes spending in its subcategories.
5. Only spending counts — income/refunds don't reduce the spent amount.
6. Budgets reset every month.
7. User gets an email when they go over a budget. Max one email per budget
   per month.
8. Free plan: up to 3 budgets. Pro: unlimited.
9. Must not break existing functionality.
10. Budgets are user data — same compliance requirements as the rest.

## 2. Assumptions and decisions

| # | Topic | Decision |
|---|---|---|
| A1 | Currency | Each budget has a currency (3-letter ISO code, as on accounts). Only transactions from accounts in that currency count toward it. No conversion. |
| A2 | Monthly period | Calendar month in **UTC**. "This month" is computed on the server; the page shows which month it is (e.g. "November 2026"). |
| A3 | Reset | The limit stays the same every month; spending starts from zero each month. Nothing carries over (no rollover of unused or overspent amounts). Only the current month is shown — no history. |
| A4 | One per category | At most one budget per category (whatever the currency). |
| A5 | Subcategories | A budget includes spending in the category and **all** its descendants. |
| A6 | Spending source | The transaction's own category. Receipt line-item categories are ignored for budgets (matches the dashboard's top categories). |
| A7 | What counts as spending | Only negative amounts (`amount_minor < 0`). Positive amounts (income, refunds) are ignored — a refund does **not** reduce "spent". Uncategorized transactions count toward no budget. |
| A8 | Over budget | Over = spent **strictly greater** than the limit. Spent equal to the limit shows 0 left and is not over. "Left" can be negative (shown as an overspend). |
| A9 | Limit values | Limit must be a positive amount (> 0). Changing the limit applies to the current month immediately. |
| A10 | Alert trigger | Alerts are checked right after changes that can affect the current month's spending or limits: creating/editing transactions, CSV import, re-categorization and applying rules, linking a receipt, moving a category, changing an account's currency, and creating/editing a budget. No background job. |
| A11 | Alert recipient | Sent only to users with a **verified** email. Accounts without an email, unverified, or with deletion requested get no alert. |
| A12 | Alert dedup | At most one alert per category per calendar month (UTC). Deleting and re-creating a budget for the same category in the same month does not trigger a second alert; raising the limit and going over again in the same month doesn't either. |
| A13 | Delivery vs duplicates | Duplicates are avoided over guaranteed delivery: the "alert sent" record is written **before** sending. If sending fails, the alert is not retried that month. Failures are logged. |
| A14 | Alert failures don't block | An alert check or send failing never fails the user's action (e.g. saving a transaction still succeeds). |
| A15 | Plan limits | Free: 3 budgets (configurable via env, like the account limit). Pro: unlimited. Plan comes from the existing entitlements. |
| A16 | Downgrade | Existing budgets are kept and keep working (including alerts). Creating a new budget is blocked while the user has as many budgets as the free limit or more. Editing and deleting stay allowed. |
| A17 | Upsell | On the free plan the page shows usage ("2 of 3 budgets") and, at the limit, an upgrade prompt linking to Billing instead of allowing a new budget. The billing page lists budgets among the plan limits. |
| A18 | Category deletion | If the category being deleted (or any of its subcategories) has a budget, the delete confirmation warns about it. Confirming deletes those budgets too. |
| A19 | Compliance | Budgets and alert records are user data: included in the data export, deleted on account deletion, and every read/write is scoped to the owner. |
| A20 | Scope | Only the Budgets page. No dashboard widget, no budget indicators elsewhere. Email text is plain English, like the existing emails; all UI text goes through Paraglide. |

## 3. User scenarios

**S1 — Create a budget.** On Budgets, the user clicks "Add budget", picks a
category, a currency (defaults to their first account's currency) and a
monthly limit, and saves. The budget appears with limit, spent this month,
and left. A category that already has a budget can't be picked again.

**S2 — See progress.** For each budget the user sees the category, the
limit, spent this month (including subcategories, only that currency, only
spending), what's left, and a progress bar. The page header shows the
current month. Empty state when there are no budgets yet.

**S3 — Go over budget.** A new expense pushes spending above the limit. The
budget is clearly marked "Over budget" with the overspent amount. If the
user's email is verified, they get one email naming the budget, the limit
and the amount spent. Further expenses that month don't send more emails.

**S4 — Change the limit.** The user edits a budget's limit. Spent and left
recalculate immediately for this month. Lowering the limit below current
spending marks it over and sends the alert if one hasn't gone out this
month.

**S5 — Remove a budget.** The user deletes a budget after confirming. It
disappears; transactions are unaffected.

**S6 — New month.** On the 1st (UTC), every budget starts at zero spent with
the same limit. The month label updates. Alerts can be sent again.

**S7 — Refund.** A positive transaction (refund) in a budgeted category does
not change "spent".

**S8 — Free plan limit.** A free user with 3 budgets sees "3 of 3 budgets"
and an upgrade prompt instead of being able to add a 4th. Trying anyway
(e.g. via a stale page) returns a clear error. A Pro user has no limit.

**S9 — Downgrade.** A Pro user with 5 budgets drops to free. All 5 stay
visible and keep tracking; they can edit or delete them, but can't add
another until they're below 3.

**S10 — Delete a budgeted category.** Deleting a category that has a budget
(directly or through a subcategory) shows a warning in the confirmation
dialog. Confirming removes the category and its budget.

**S11 — Multi-currency.** A user with a PLN and a EUR account creates a PLN
budget on Groceries. EUR grocery spending doesn't count toward it. They can't
add a second Groceries budget in EUR (A4).

**S12 — Data export / deletion.** The user's data export includes their
budgets; deleting the account removes them.

## 4. Out of scope

- Dashboard widget or budget indicators on other pages.
- Past months / budget history, rollover.
- Currency conversion.
- Budgets based on receipt line items.
- Retrying failed alert emails; alert preferences or unsubscribe.
- Weekly/yearly periods or user time zones.

## 5. Known related issues (outside this feature)

- Transaction dates display one day early in time zones behind UTC
  (`formatTxDate` in `src/routes/_authed/transactions.tsx`). Being fixed in a
  separate pull request. Until then, a transaction on the 1st can look like
  it's in the previous month in the list while counting toward the new
  month's budget (A2).
- Transactions created from a scanned receipt are stored with a positive
  amount (`saveReceiptAndLink`), so they count as income and not toward
  budgets (A7).

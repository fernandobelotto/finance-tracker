//
// Largest monthly budget limit, in minor units: 10,000,000.00 — well inside
// the Postgres integer column. Shared so the form can explain the cap
// instead of the server rejecting it with a generic error.
export const MAX_BUDGET_LIMIT_MINOR = 1_000_000_000;

//
// Budget months are "YYYY-MM" keys of the UTC calendar month. Formatting
// pins the time zone to UTC so the viewer's offset can never shift the month
// shown (shared by the Budgets page and the over-budget email).

/** "2026-11" → "November 2026". */
export function formatMonth(month: string): string {
  const [year, monthNumber] = month.split("-").map(Number);
  return new Date(Date.UTC(year, monthNumber - 1, 1)).toLocaleDateString(
    "en",
    { month: "long", year: "numeric", timeZone: "UTC" },
  );
}

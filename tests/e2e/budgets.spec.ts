import { test, expect, type Page } from "./fixtures";

// Monthly category budgets (docs/budgets-spec.md). Every test gets a fresh
// user with the default categories and a "Main (PLN)" account; transactions
// are dated today (UTC) so they fall in the current budget month.

const today = () => new Date().toISOString().slice(0, 10);

async function goToBudgets(page: Page) {
  await page.getByRole("link", { name: "Budgets" }).click();
  await expect(page).toHaveURL("/budgets");
  await expect(page.getByTestId("budgets-month")).toBeVisible();
}

async function addBudget(
  page: Page,
  opts: { category: string; limit: string; currency?: string },
) {
  await page.getByRole("button", { name: "Add budget" }).click();
  const dialog = page.getByRole("dialog", { name: "Add budget" });
  await dialog.getByLabel("Category").selectOption({ label: opts.category });
  if (opts.currency) {
    await dialog.getByLabel("Currency").selectOption(opts.currency);
  }
  await dialog.getByLabel("Monthly limit").fill(opts.limit);
  await dialog.getByRole("button", { name: "Add budget" }).click();
  await expect(dialog).toBeHidden();
}

function budgetRow(page: Page, label: string) {
  return page.getByRole("listitem", { name: label, exact: true });
}

async function expectBudget(
  page: Page,
  label: string,
  values: { limit: string; spent: string; left: string },
) {
  const row = budgetRow(page, label);
  await expect(row.getByTestId("budget-limit")).toHaveText(values.limit);
  await expect(row.getByTestId("budget-spent")).toHaveText(values.spent);
  await expect(row.getByTestId("budget-left")).toHaveText(values.left);
}

async function addTransaction(
  page: Page,
  opts: {
    amount: string;
    category: string;
    account?: string;
    income?: boolean;
    description?: string;
  },
) {
  await page.getByRole("link", { name: "Transactions" }).click();
  await page
    .getByRole("banner")
    .getByRole("button", { name: "Add Transaction" })
    .click();
  const modal = page.getByRole("dialog", { name: "New Transaction" });
  // Midday keeps the calendar date stable whatever the browser's offset.
  await modal.getByLabel("Date").fill(`${today()}T12:00`);
  await modal
    .getByLabel("Description")
    .fill(opts.description ?? `Txn ${opts.amount}`);
  await modal
    .getByRole("spinbutton", { name: "Amount", exact: true })
    .fill(opts.amount);
  await modal.getByLabel("Account").selectOption(opts.account ?? "Main (PLN)");
  await modal.getByLabel("Category").selectOption({ label: opts.category });
  if (opts.income) {
    await modal.getByLabel("Income").check();
  }
  await modal.getByRole("button", { name: "Create Transaction" }).click();
  await expect(modal).toBeHidden();
}

async function emailsFor(page: Page, to: string) {
  const res = await page.request.get(
    `/test-emails?to=${encodeURIComponent(to)}`,
  );
  const { emails } = (await res.json()) as {
    emails: Array<{ subject: string; text: string }>;
  };
  return emails.filter((e) => e.subject.startsWith("Budget exceeded"));
}

test.describe("Budgets", () => {
  test.beforeEach(async ({ page, signedInUser: _signedInUser }) => {
    await page.goto("/dashboard");
  });

  test("is in the main navigation and shows an empty state", async ({
    page,
  }) => {
    await goToBudgets(page);
    await expect(
      page.getByRole("heading", { name: "Budgets", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "No budgets yet" }),
    ).toBeVisible();
    await expect(page.getByTestId("budgets-month")).toContainText("UTC");
    await expect(page.getByTestId("budgets-usage")).toHaveText(
      /0 of 3 budgets on the free plan/,
    );
  });

  test("adds, edits and removes a budget", async ({ page }) => {
    await goToBudgets(page);
    await addBudget(page, { category: "Transport", limit: "300" });
    await expectBudget(page, "Transport", {
      limit: "300.00 PLN",
      spent: "0.00 PLN",
      left: "300.00 PLN",
    });

    await addTransaction(page, { amount: "120.50", category: "— Fuel" });
    await goToBudgets(page);
    await expectBudget(page, "Transport", {
      limit: "300.00 PLN",
      spent: "120.50 PLN",
      left: "179.50 PLN",
    });

    await budgetRow(page, "Transport").getByTestId("edit-budget").click();
    const dialog = page.getByRole("dialog", { name: "Edit budget" });
    await expect(dialog.getByLabel("Category")).toHaveValue("Transport");
    await dialog.getByLabel("Monthly limit").fill("150");
    await dialog.getByRole("button", { name: "Save Changes" }).click();
    await expect(dialog).toBeHidden();
    await expectBudget(page, "Transport", {
      limit: "150.00 PLN",
      spent: "120.50 PLN",
      left: "29.50 PLN",
    });

    await budgetRow(page, "Transport").getByTestId("delete-budget").click();
    const confirm = page.getByRole("alertdialog", { name: "Delete budget" });
    await confirm.getByRole("button", { name: "Delete" }).click();
    await expect(confirm).toBeHidden();
    await expect(budgetRow(page, "Transport")).toBeHidden();
    await expect(
      page.getByRole("heading", { name: "No budgets yet" }),
    ).toBeVisible();
  });

  test("counts subcategories and ignores refunds", async ({ page }) => {
    await goToBudgets(page);
    await addBudget(page, { category: "Groceries", limit: "100" });

    await addTransaction(page, { amount: "30", category: "Groceries" });
    await addTransaction(page, { amount: "20", category: "— Vegetables" });
    await addTransaction(page, {
      amount: "25",
      category: "— Fruits",
      income: true,
      description: "Refund",
    });
    await addTransaction(page, { amount: "40", category: "Transport" });

    await goToBudgets(page);
    await expect(
      budgetRow(page, "Groceries").getByText("Includes subcategories"),
    ).toBeVisible();
    await expectBudget(page, "Groceries", {
      limit: "100.00 PLN",
      spent: "50.00 PLN",
      left: "50.00 PLN",
    });
  });

  test("only counts accounts in the budget's currency", async ({ page }) => {
    await page.getByRole("link", { name: "Accounts" }).click();
    await page.getByRole("button", { name: "Add Account" }).click();
    await page.getByLabel("Account Name").fill("Travel");
    await page.getByLabel("Currency").fill("EUR");
    await page.getByRole("button", { name: "Create Account" }).click();
    await expect(page.getByText("Travel")).toBeVisible();

    await goToBudgets(page);
    await addBudget(page, { category: "Health", limit: "100", currency: "EUR" });
    await addTransaction(page, { amount: "60", category: "Health" });
    await addTransaction(page, {
      amount: "15",
      category: "Health",
      account: "Travel (EUR)",
    });

    await goToBudgets(page);
    await expectBudget(page, "Health", {
      limit: "100.00 EUR",
      spent: "15.00 EUR",
      left: "85.00 EUR",
    });
  });

  test("going over budget is shown and emails once a month", async ({
    page,
    signedInUser,
  }) => {
    const email = `${signedInUser.username}@example.com`;
    await goToBudgets(page);
    await addBudget(page, { category: "Entertainment", limit: "50" });

    // Exactly at the limit is not over.
    await addTransaction(page, { amount: "50", category: "— Dining Out" });
    await goToBudgets(page);
    const row = budgetRow(page, "Entertainment");
    await expect(row.getByTestId("budget-left")).toHaveText("0.00 PLN");
    await expect(row.getByTestId("budget-over-badge")).toBeHidden();
    expect(await emailsFor(page, email)).toHaveLength(0);

    await addTransaction(page, { amount: "10", category: "— Hobbies" });
    await goToBudgets(page);
    await expect(row.getByTestId("budget-over-badge")).toHaveText(
      "Over budget",
    );
    await expect(row.getByTestId("budget-left")).toHaveText("10.00 PLN over");

    const alerts = await emailsFor(page, email);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].subject).toContain("Entertainment");
    expect(alerts[0].text).toContain("Spent: 60.00 PLN");
    expect(alerts[0].text).toContain("Over by: 10.00 PLN");

    // Further spending the same month doesn't send another email.
    await addTransaction(page, { amount: "5", category: "Entertainment" });
    await goToBudgets(page);
    await expect(row.getByTestId("budget-spent")).toHaveText("65.00 PLN");
    expect(await emailsFor(page, email)).toHaveLength(1);
  });

  test("lowering the limit below spending counts as going over", async ({
    page,
    signedInUser,
  }) => {
    await goToBudgets(page);
    await addBudget(page, { category: "Shopping", limit: "500" });
    await addTransaction(page, { amount: "80", category: "— Clothing" });
    await goToBudgets(page);

    await budgetRow(page, "Shopping").getByTestId("edit-budget").click();
    const dialog = page.getByRole("dialog", { name: "Edit budget" });
    await dialog.getByLabel("Monthly limit").fill("50");
    await dialog.getByRole("button", { name: "Save Changes" }).click();

    await expect(
      budgetRow(page, "Shopping").getByTestId("budget-over-badge"),
    ).toBeVisible();
    expect(
      await emailsFor(page, `${signedInUser.username}@example.com`),
    ).toHaveLength(1);
  });

  test("validates the limit and offers each category once", async ({
    page,
  }) => {
    await goToBudgets(page);
    await page.getByRole("button", { name: "Add budget" }).click();
    const dialog = page.getByRole("dialog", { name: "Add budget" });

    await dialog.getByRole("button", { name: "Add budget" }).click();
    await expect(dialog.getByRole("alert")).toHaveText("Choose a category.");

    await dialog.getByLabel("Category").selectOption({ label: "Housing" });
    await dialog.getByLabel("Monthly limit").fill("0");
    await dialog.getByRole("button", { name: "Add budget" }).click();
    await expect(dialog.getByRole("alert")).toHaveText(
      "Enter a monthly limit greater than zero.",
    );

    await dialog.getByLabel("Monthly limit").fill("abc");
    await dialog.getByRole("button", { name: "Add budget" }).click();
    await expect(dialog.getByRole("alert")).toHaveText(
      "Enter a monthly limit greater than zero.",
    );

    await dialog.getByLabel("Monthly limit").fill("1200");
    await dialog.getByRole("button", { name: "Add budget" }).click();
    await expect(dialog).toBeHidden();

    await page.getByRole("button", { name: "Add budget" }).click();
    const options = page
      .getByRole("dialog", { name: "Add budget" })
      .getByLabel("Category")
      .locator("option");
    await expect(options.filter({ hasText: /^Housing$/ })).toHaveCount(0);
    // Income never counts as spending, so its tree isn't offered.
    await expect(options.filter({ hasText: /^Income/ })).toHaveCount(0);
    await expect(options.filter({ hasText: "Housing › Utilities" })).toHaveCount(
      1,
    );
  });
});

test.describe("Budgets: unverified email", () => {
  test("no alert email for an unverified address", async ({ page }) => {
    const res = await page.request.post(
      "/test-create-user?seed=defaults&verified=false",
    );
    const { email } = (await res.json()) as { email: string };
    await page.goto("/budgets");

    await addBudget(page, { category: "Health", limit: "10" });
    await addTransaction(page, { amount: "20", category: "— Pharmacy" });
    await goToBudgets(page);
    await expect(
      budgetRow(page, "Health").getByTestId("budget-over-badge"),
    ).toBeVisible();
    expect(await emailsFor(page, email)).toHaveLength(0);
  });
});

test.describe("Budgets: plan limits", () => {
  test.beforeEach(async ({ page, signedInUser: _signedInUser }) => {
    await page.goto("/budgets");
  });

  test("free plan allows 3 budgets, pro is unlimited, downgrade keeps them", async ({
    page,
  }) => {
    await addBudget(page, { category: "Housing", limit: "100" });
    await addBudget(page, { category: "Transport", limit: "100" });
    await expect(page.getByTestId("budgets-usage")).toHaveText(
      /2 of 3 budgets on the free plan/,
    );
    await addBudget(page, { category: "Health", limit: "100" });

    const usage = page.getByTestId("budgets-usage");
    await expect(usage).toContainText("3 of 3 budgets used.");
    await expect(usage).toContainText(
      "The free plan is limited to 3 budgets.",
    );
    await expect(usage.getByRole("link", { name: "Upgrade to Pro" })).toHaveAttribute(
      "href",
      "/billing",
    );
    await expect(page.getByRole("button", { name: "Add budget" })).toBeHidden();

    await page.request.post("/test-set-plan?plan=pro");
    await page.reload();
    await expect(page.getByTestId("budgets-usage")).toBeHidden();
    await addBudget(page, { category: "Shopping", limit: "100" });
    await expect(page.getByTestId("budget-row")).toHaveCount(4);

    // Downgrade: all four stay, adding is blocked.
    await page.request.post("/test-set-plan?plan=free");
    await page.reload();
    await expect(page.getByTestId("budget-row")).toHaveCount(4);
    await expect(page.getByTestId("budgets-usage")).toContainText(
      "4 of 3 budgets used.",
    );
    await expect(page.getByRole("button", { name: "Add budget" })).toBeHidden();

    // Editing still works while above the limit.
    await budgetRow(page, "Shopping").getByTestId("edit-budget").click();
    const dialog = page.getByRole("dialog", { name: "Edit budget" });
    await dialog.getByLabel("Monthly limit").fill("75");
    await dialog.getByRole("button", { name: "Save Changes" }).click();
    await expect(
      budgetRow(page, "Shopping").getByTestId("budget-limit"),
    ).toHaveText("75.00 PLN");

    await page.getByRole("link", { name: "Billing" }).click();
    await expect(page.getByTestId("billing-budgets-usage")).toHaveText(
      "4 of 3 budgets",
    );
  });

  test("the server rejects a budget above the free limit", async ({ page }) => {
    await addBudget(page, { category: "Housing", limit: "100" });
    await addBudget(page, { category: "Transport", limit: "100" });

    // Open the form while still under the limit, then fill the last slot
    // from "another tab" — the stale form must get a clear error.
    await page.getByRole("button", { name: "Add budget" }).click();
    const dialog = page.getByRole("dialog", { name: "Add budget" });
    await dialog.getByLabel("Category").selectOption({ label: "Shopping" });
    await dialog.getByLabel("Monthly limit").fill("100");

    const other = await page.context().newPage();
    await other.goto("/budgets");
    await addBudget(other, { category: "Health", limit: "100" });
    await other.close();

    await dialog.getByRole("button", { name: "Add budget" }).click();
    await expect(dialog.getByRole("alert")).toHaveText(
      "The free plan is limited to 3 budgets. Upgrade to Pro for unlimited budgets.",
    );
  });
});

test.describe("Budgets: category deletion", () => {
  test("warns and removes the budget when its category is deleted", async ({
    page,
    signedInUser: _signedInUser,
  }) => {
    await page.goto("/budgets");
    await addBudget(page, { category: "Groceries › Fruits", limit: "40" });
    await addBudget(page, { category: "Health", limit: "40" });

    await page.getByRole("link", { name: "Categories" }).click();
    // Deleting the parent removes Fruits (and its budget) too.
    const groceries = page
      .getByTestId("category-row")
      .filter({ hasText: /^Groceries/ });
    await groceries.getByTestId("delete-category").click();
    const confirm = page.getByRole("alertdialog");
    await expect(
      confirm.getByTestId("delete-category-budget-warning"),
    ).toHaveText(
      "Deleting this category also deletes the budget for: Fruits.",
    );
    await confirm.getByRole("button", { name: "Delete" }).click();
    await expect(confirm).toBeHidden();
    await expect(groceries).toHaveCount(0);

    // A category without a budget shows no warning. Start from a fresh page
    // so the click can't land while the list re-renders after the delete.
    await page.reload();
    const transport = page
      .getByTestId("category-row")
      .filter({ hasText: /^Transport/ });
    await transport.getByTestId("delete-category").click();
    const transportConfirm = page.getByRole("alertdialog", {
      name: "Delete Category",
    });
    // Wait for the dialog before asserting an absence inside it.
    await expect(transportConfirm).toBeVisible();
    await expect(
      transportConfirm.getByTestId("delete-category-budget-warning"),
    ).toBeHidden();
    await transportConfirm.getByRole("button", { name: "Cancel" }).click();
    await expect(transportConfirm).toBeHidden();

    await goToBudgets(page);
    await expect(page.getByTestId("budget-row")).toHaveCount(1);
    await expect(budgetRow(page, "Health")).toBeVisible();
  });
});

test.describe("Budgets: switching users", () => {
  test("the next user never sees the previous user's budgets", async ({
    page,
  }) => {
    // User A, signed in, with a budget on screen.
    await page.request.post("/test-create-user?seed=defaults");
    await page.goto("/budgets");
    await addBudget(page, { category: "Transport", limit: "123" });
    await expect(budgetRow(page, "Transport")).toBeVisible();

    // A signs out; B signs in from the login form in the same tab — no
    // full page load in between, so any client cache survives.
    const res = await page.request.post(
      "/test-create-user?seed=defaults&signIn=false",
    );
    const b = (await res.json()) as { username: string; password: string };
    await page.getByRole("link", { name: "Sign out" }).first().click();
    await expect(page).toHaveURL("/login");
    await page.getByLabel("Email or username").fill(b.username);
    await page.getByLabel("Password").fill(b.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL("/dashboard");

    // Record every budget row rendered while B opens Budgets.
    await page.evaluate(() => {
      const seen: string[] = [];
      (window as unknown as { __seenBudgets: string[] }).__seenBudgets = seen;
      new MutationObserver(() => {
        document
          .querySelectorAll("[data-testid=budget-row]")
          .forEach((row) => seen.push(row.getAttribute("aria-label") ?? ""));
      }).observe(document.body, { childList: true, subtree: true });
    });
    await page.getByRole("link", { name: "Budgets" }).click();
    await expect(
      page.getByRole("heading", { name: "No budgets yet" }),
    ).toBeVisible();
    const seen = await page.evaluate(
      () => (window as unknown as { __seenBudgets: string[] }).__seenBudgets,
    );
    expect(seen).toEqual([]);
  });
});

test.describe("Budgets: stale page", () => {
  test("editing a budget removed in another tab refreshes the page", async ({
    page,
    signedInUser: _signedInUser,
  }) => {
    await page.goto("/budgets");
    await addBudget(page, { category: "Transport", limit: "100" });
    await addBudget(page, { category: "Housing", limit: "100" });

    const other = await page.context().newPage();
    await other.goto("/budgets");
    await budgetRow(other, "Transport").getByTestId("delete-budget").click();
    await other
      .getByRole("alertdialog", { name: "Delete budget" })
      .getByRole("button", { name: "Delete" })
      .click();
    await expect(budgetRow(other, "Transport")).toBeHidden();
    await other.close();

    // The first tab still shows Transport.
    await budgetRow(page, "Transport").getByTestId("edit-budget").click();
    const dialog = page.getByRole("dialog", { name: "Edit budget" });
    await dialog.getByLabel("Monthly limit").fill("50");
    await dialog.getByRole("button", { name: "Save Changes" }).click();

    await expect(dialog).toBeHidden();
    await expect(page.getByTestId("budgets-notice")).toContainText(
      "That budget no longer exists",
    );
    await expect(budgetRow(page, "Transport")).toBeHidden();
    await expect(budgetRow(page, "Housing")).toBeVisible();
  });
});

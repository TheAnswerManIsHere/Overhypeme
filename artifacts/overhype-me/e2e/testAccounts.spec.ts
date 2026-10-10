/**
 * The ordinary E2E accounts sign in through the real login form, and each is
 * the tier its seed says: free stays `registered`, paid is `legendary` through
 * its admin grant (Launch Phase 2, increment 2; #631).
 *
 * Precondition: `scripts/seed-e2e-test-accounts.ts` has run against this
 * stack's database (the CI E2E job runs it before the suites).
 */
import { expect, test } from "@playwright/test";

import { FREE_ACCOUNT, PAID_ACCOUNT, TEST_ACCOUNT_PASSWORD, currentUser, signInThroughForm } from "./helpers/testAccounts";

for (const [label, account, tier] of [
  ["free", FREE_ACCOUNT, "registered"],
  ["paid", PAID_ACCOUNT, "legendary"],
] as const) {
  test(`the ${label} account signs in through the login form as ${tier}`, async ({ page }) => {
    await signInThroughForm(page, account.email, TEST_ACCOUNT_PASSWORD);
    const user = await currentUser(page);
    expect(user, "signed in").not.toBeNull();
    expect(user?.["email"]).toBe(account.email);
    expect(user?.["membershipTier"]).toBe(tier);
  });
}

test("a wrong password is refused and leaves no session", async ({ page }) => {
  await page.goto("/login");
  await page.getByPlaceholder("your@email.com").fill(FREE_ACCOUNT.email);
  await page.getByPlaceholder("Enter your password").fill(`${TEST_ACCOUNT_PASSWORD}-wrong`);
  await page.getByRole("button", { name: /sign in/i }).and(page.locator('[type="submit"]')).click();
  await expect(page.getByText(/invalid|incorrect/i)).toBeVisible();
  expect(await currentUser(page)).toBeNull();
});

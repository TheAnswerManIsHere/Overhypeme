/**
 * The ordinary E2E accounts sign in through the real login form, and each is
 * the tier its seed says: free stays `registered`, paid is `legendary` through
 * its admin grant (Launch Phase 2, increment 2; #631).
 *
 * Precondition: `scripts/seed-e2e-test-accounts.ts` has run against this
 * stack's database (the CI E2E job runs it before the suites).
 */
import { expect, test } from "@playwright/test";

import {
  FREE_ACCOUNT,
  PAID_ACCOUNT,
  TEST_ACCOUNT_PASSWORD,
  currentUser,
  signInThroughForm,
  submitLoginForm,
} from "./helpers/testAccounts";

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

    // PR287 step 22: the account's own Profile names that tier — the Legendary
    // badge for the paid account, the Go Legendary upsell for the free one,
    // never both. Read in this same session: every extra form sign-in spends
    // the per-IP login budget the whole E2E job shares.
    await page.goto("/profile");
    await expect(page.getByRole("heading", { name: account.displayName }).filter({ visible: true })).toBeVisible();
    const badge = page.getByText("Legendary", { exact: true }).filter({ visible: true });
    const upsell = page.getByRole("button", { name: "Go Legendary" }).filter({ visible: true });
    if (tier === "legendary") {
      await expect(badge, "PR287 step 22: the paid account's Profile should show the Legendary badge").toHaveCount(1);
      await expect(upsell, "PR287 step 22: ...and no Go Legendary upsell").toHaveCount(0);
    } else {
      await expect(upsell.first(), "PR287 step 22: the free account's Profile should offer Go Legendary").toBeVisible();
      await expect(badge, "PR287 step 22: ...and no Legendary badge").toHaveCount(0);
    }
  });
}

test("a wrong password is refused and leaves no session", async ({ page }) => {
  await submitLoginForm(page, FREE_ACCOUNT.email, `${TEST_ACCOUNT_PASSWORD}-wrong`);
  await expect(page.getByText("Invalid email or password")).toBeVisible();
  // PR292 R5: the error is shown where the visitor is, and they stay there.
  await expect(page, "PR292 R5: after a wrong password the visitor should still be on /login").toHaveURL(/\/login\/?(\?.*)?$/);
  expect(await currentUser(page)).toBeNull();
});


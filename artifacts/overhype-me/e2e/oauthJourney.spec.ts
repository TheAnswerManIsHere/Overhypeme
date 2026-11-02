/**
 * Google and Apple sign-up journeys in production mode (launch Phase 5, plan T6,
 * Increment 3b, #795): each provider through the fake sign-in page the
 * production-mode launcher serves when given E2E_FAKE_OAUTH_PORT
 * (artifacts/api-server/src/testing/fakeOAuthIssuer.ts). The server's real
 * callback, account upsert, session and redirect code run; only the provider is
 * fake.
 *
 * @purpose Proves in a browser that a Google sign-up the provider vouches for goes straight to the one set-up screen (a reload brings the draft back) and can then act; that one it does not vouch for is refused until the emailed link verifies it, then sets up and acts; that Apple's string-valued claim works the same; and that an unvouched claim matching an existing account is refused with the way back in named.
 * @subsystem accounts-auth
 */
import { expect, test, type Page } from "@playwright/test";

import { mailSinkDir, waitForEmailLink } from "./helpers/mailSink";

async function currentUser(page: Page): Promise<Record<string, unknown> | null> {
  const res = await page.request.get("/api/auth/user");
  return ((await res.json()) as { user: Record<string, unknown> | null }).user;
}

async function patchPronouns(page: Page, pronouns: string): Promise<{ status: number; code?: string }> {
  return page.evaluate(async (value) => {
    const csrf = document.cookie.split("; ").find((c) => c.startsWith("csrf_token="))?.slice("csrf_token=".length);
    const res = await fetch("/api/users/me", {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json", ...(csrf ? { "X-CSRF-Token": csrf } : {}) },
      body: JSON.stringify({ pronouns: value }),
    });
    return { status: res.status, code: ((await res.json().catch(() => ({}))) as { code?: string }).code };
  }, pronouns);
}

/** Starts a provider sign-in from the login page and approves it on the fake provider's page. */
async function signInWith(page: Page, provider: "Google" | "Apple", email: string, vouched: "yes" | "no", expectClose = true): Promise<Page> {
  await page.goto("/login");
  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("button", { name: new RegExp(`continue with ${provider}`, "i") }).click();
  const popup = await popupPromise;
  await popup.waitForLoadState("domcontentloaded");
  await expect(popup.getByRole("heading", { name: new RegExp(`fake ${provider}`, "i") })).toBeVisible();
  await popup.getByLabel("Email", { exact: true }).fill(email);
  await popup.getByLabel("Provider vouches for the email").selectOption({ label: vouched });
  await popup.getByRole("button", { name: "Approve" }).click();
  // On success the callback page sends the opener on and closes the popup; a
  // refusal is a redirect, so it lands in the popup itself.
  if (expectClose) await popup.waitForEvent("close", { timeout: 30_000 });
  return popup;
}

async function finishSetUp(page: Page): Promise<void> {
  await expect(page.getByRole("heading", { name: /one quick set-up/i })).toBeVisible({ timeout: 30_000 });
  // A Google or Apple account starts with no display name (identity-flow
  // Phase 2): the name field is required, and this browser holds none.
  const name = page.getByRole("textbox", { name: "Your name" });
  if (!(await name.inputValue())) await name.fill("Oauth Tester");
  await page.getByRole("button", { name: "they/them" }).click();
  await page.getByLabel("Month").fill("3");
  await page.getByLabel("Day").fill("9");
  await page.getByLabel("Year").fill("1988");
  await page.waitForResponse((r) => r.url().endsWith("/api/users/me/onboarding/draft") && r.request().method() === "PUT");
  await page.reload();
  await expect(page.getByLabel("Year"), "the draft survives a reload").toHaveValue("1988", { timeout: 30_000 });
  const finish = page.getByRole("button", { name: "Finish set-up" });
  await expect(finish).toBeEnabled({ timeout: 30_000 });
  await finish.click();
  await page.getByRole("button", { name: "Skip for now" }).click();
}

test.describe.configure({ mode: "serial" });

const run = Date.now();
const vouchedGoogle = `oauth-google+${run}@example.test`;

test.beforeAll(() => {
  mailSinkDir(); // fail fast, with the reason, when not given the production-mode stack
});

test("Google, email vouched for: straight to set-up, then the account acts", async ({ page }) => {
  await signInWith(page, "Google", vouchedGoogle, "yes");
  await page.waitForURL(/\/onboard/, { timeout: 30_000 });
  expect((await currentUser(page))?.["eligibility"]).toBe("unonboarded");
  expect((await patchPronouns(page, "she/her")).code, "nothing writes before set-up").toBe("ONBOARDING_REQUIRED");
  await finishSetUp(page);
  await expect.poll(async () => (await currentUser(page))?.["eligibility"]).toBe("eligible");
  expect((await patchPronouns(page, "she/her")).status, "after set-up a write lands").toBe(200);
});

test("Google, email not vouched for: refused until the emailed link verifies it, then set-up, then acts", async ({ page }) => {
  const email = `oauth-unvouched+${run}@example.test`;
  await signInWith(page, "Google", email, "no");
  await page.waitForURL(/\/check-email/, { timeout: 30_000 });
  expect((await currentUser(page))?.["eligibility"]).toBe("unverified");
  expect((await patchPronouns(page, "she/her")).code).toBe("EMAIL_VERIFICATION_REQUIRED");
  const askedAt = new Date();
  await page.getByRole("button", { name: "Send the link again" }).click();
  await expect(page.getByText(/sent\. check your inbox/i)).toBeVisible();
  await page.goto(await waitForEmailLink({ to: email, linkPath: "/verify-email", since: askedAt }));
  await finishSetUp(page);
  await expect.poll(async () => (await currentUser(page))?.["eligibility"]).toBe("eligible");
  expect((await patchPronouns(page, "she/her")).status).toBe(200);
});

test("Apple, email vouched for (Apple's string claim): straight to set-up, then the account acts", async ({ page }) => {
  await signInWith(page, "Apple", `oauth-apple+${run}@example.test`, "yes");
  await page.waitForURL(/\/onboard/, { timeout: 30_000 });
  await finishSetUp(page);
  await expect.poll(async () => (await currentUser(page))?.["eligibility"]).toBe("eligible");
  expect((await patchPronouns(page, "he/him")).status).toBe(200);
});

test("an unvouched claim on an existing account is refused, naming the way back in", async ({ page }) => {
  const popup = await signInWith(page, "Google", vouchedGoogle, "no", false);
  // The refusal is a redirect, so it shows in the sign-in window itself.
  await popup.waitForURL(/\/login\?error=unverified_provider_email/, { timeout: 30_000 });
  await expect(popup.getByText(/didn't confirm your email address/i)).toBeVisible();
  expect(await currentUser(page)).toBeNull();
});

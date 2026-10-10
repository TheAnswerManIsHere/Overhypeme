/**
 * Baseline journey 1 — the production-configuration account (Launch Phase 2,
 * increment 2; #631).
 *
 * Runs against a server booted in production mode by
 * `artifacts/api-server/src/testing/productionModeLauncher.ts`, with one thing
 * replaced: the email transport, which writes to `E2E_MAIL_SINK_DIR` instead of
 * sending. Everything else is the production path — the secure, SameSite=None
 * session cookie, the queued email delivery, the absent dev-admin login.
 *
 * It is an invariant, not a scenario, so it runs in the per-PR E2E job. It
 * never runs against the dev stack: the mail helper refuses without
 * `E2E_MAIL_SINK_DIR`, so a run that was not given the production-mode stack
 * fails rather than skipping.
 */
import { expect, test, type Page } from "@playwright/test";

import { currentUser } from "./helpers/testAccounts";
import { mailSinkDir, waitForEmailLink } from "./helpers/mailSink";

const FIRST_PASSWORD = "journey-first-password-1";
const SECOND_PASSWORD = "journey-second-password-2";

/** A same-origin request from the page itself — the browser's cookies, Origin and CSRF header, as the SPA sends them. */
async function pageFetch(page: Page, method: string, url: string, body?: unknown): Promise<number> {
  return page.evaluate(
    async ({ method, url, body }) => {
      const csrf = document.cookie
        .split("; ")
        .find((c) => c.startsWith("csrf_token="))
        ?.slice("csrf_token=".length);
      const response = await fetch(url, {
        method,
        credentials: "include",
        headers: { "Content-Type": "application/json", ...(csrf ? { "X-CSRF-Token": csrf } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return response.status;
    },
    { method, url, body },
  );
}

async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto("/login");
  await page.getByPlaceholder("your@email.com").fill(email);
  await page.getByPlaceholder("Enter your password").fill(password);
  await page.getByRole("button", { name: /sign in/i }).and(page.locator('[type="submit"]')).click();
}

test("a production-mode account: register, verify, act, sign out, recover the password", async ({ page, context }) => {
  mailSinkDir(); // fail fast, with the reason, when not given the production-mode stack
  const email = `journey+${Date.now()}@example.test`;

  // The dev-admin backdoor does not exist in production mode. The stack seeds
  // the bootstrap admin (scripts/seed-e2e-test-accounts.ts), so an enabled
  // backdoor would sign in; "Admin user not found" would mean the precondition
  // is missing, not that the backdoor is off — only "Not found" proves it.
  const devAdmin = await page.request.get("/api/auth/dev-admin-login");
  expect(devAdmin.status()).toBe(404);
  expect(await devAdmin.json()).toEqual({ error: "Not found" });
  expect(await currentUser(page)).toBeNull();

  // Register through the real form.
  const registeredAt = new Date();
  await page.goto("/login");
  await page.getByRole("button", { name: "Sign up" }).click();
  await page.getByPlaceholder("your@email.com").fill(email);
  await page.getByPlaceholder(/How facts will address you/).fill("Journey Tester");
  await page.getByPlaceholder("First").fill("Journey");
  await page.getByPlaceholder("Last").fill("Tester");
  await page.getByRole("button", { name: "they/them" }).click();
  await page.getByPlaceholder("Min 8 characters").fill(FIRST_PASSWORD);
  await page.getByRole("button", { name: /create account/i }).click();
  await expect(page.getByRole("heading", { name: "CHECK YOUR EMAIL" })).toBeVisible();
  expect(new URL(page.url()).pathname, "registering shows the notice in place, with no redirect").toBe("/login");

  // The production session cookie — Secure, SameSite=None, HttpOnly — is kept on a local origin.
  const sid = (await context.cookies()).find((c) => c.name === "sid");
  expect(sid, "the session cookie was kept").toBeDefined();
  expect(sid).toMatchObject({ secure: true, sameSite: "None", httpOnly: true });
  expect((await currentUser(page))?.["email"]).toBe(email);

  // Verify through the link in the captured email.
  const verifyLink = await waitForEmailLink({ to: email, linkPath: "/verify-email", since: registeredAt });
  await page.goto(verifyLink);
  // A signed-in account lands on its profile with the confirmation; a signed-out
  // one would see the standalone "Email Verified!" page. Either way the server
  // must have accepted the token, which the next assertion checks directly.
  await expect(page.getByText(/verified successfully/i)).toBeVisible();
  const profile = await page.request.get("/api/users/me");
  expect(profile.status()).toBe(200);
  expect((await profile.json()).emailVerified).toBe(true);

  // A protected action, through the browser's own cookie and CSRF token, from
  // a settled page (the verification flow navigates on its own).
  await page.goto("/profile");
  await expect(page.getByRole("heading", { name: "Journey Tester" })).toBeVisible();
  expect(await pageFetch(page, "PATCH", "/api/users/me", { pronouns: "she/her" })).toBe(200);
  expect((await currentUser(page))?.["pronouns"]).toBe("she/her");

  // Sign out from the profile page; the session is gone and the action is refused.
  await page.getByRole("button", { name: /sign out/i }).first().click();
  await expect.poll(() => currentUser(page)).toBeNull();
  await page.waitForURL((url) => url.pathname === "/"); // sign-out returns home on its own
  await page.waitForLoadState("load");
  expect(await pageFetch(page, "PATCH", "/api/users/me", { pronouns: "he/him" })).toBe(401);

  // Recover the password through the captured reset link.
  const resetRequestedAt = new Date();
  await page.goto("/forgot-password");
  await page.getByPlaceholder("your@email.com").fill(email);
  await page.locator('button[type="submit"]').click();
  await expect(page.getByText("Check your inbox")).toBeVisible();
  const resetLink = await waitForEmailLink({ to: email, linkPath: "/reset-password", since: resetRequestedAt });
  await page.goto(resetLink);
  await page.getByPlaceholder("Min 8 characters").fill(SECOND_PASSWORD);
  await page.getByPlaceholder("Repeat your new password").fill(SECOND_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(/\/login\?reset=success/);

  // The old password is refused; the new one signs in.
  await signIn(page, email, FIRST_PASSWORD);
  await expect(page.getByText("Invalid email or password")).toBeVisible();
  expect(await currentUser(page)).toBeNull();

  await signIn(page, email, SECOND_PASSWORD);
  await page.waitForURL((url) => url.pathname !== "/login");
  expect((await currentUser(page))?.["email"]).toBe(email);
});

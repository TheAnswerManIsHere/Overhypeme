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

import { currentUser, submitLoginForm } from "./helpers/testAccounts";
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

test("a production-mode account: register, verify, act, sign out, recover the password, schedule its deletion and keep it", async ({ page, context }) => {
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

  // Refused until verified (launch Phase 5): signed in, but no write lands.
  const refused = await page.evaluate(async () => {
    const csrf = document.cookie.split("; ").find((c) => c.startsWith("csrf_token="))?.slice("csrf_token=".length);
    const res = await fetch("/api/users/me", {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json", ...(csrf ? { "X-CSRF-Token": csrf } : {}) },
      body: JSON.stringify({ pronouns: "she/her" }),
    });
    return { status: res.status, code: ((await res.json()) as { code?: string }).code };
  });
  expect(refused, "an unverified account cannot write").toEqual({ status: 403, code: "EMAIL_VERIFICATION_REQUIRED" });

  // Verify through the link in the captured email.
  const verifyLink = await waitForEmailLink({ to: email, linkPath: "/verify-email", since: registeredAt });
  await page.goto(verifyLink);

  // The link lands on the one onboarding screen (launch Phase 5). The pronouns
  // chosen at sign-up come back for confirmation; a reload part-way through
  // brings the saved draft back.
  await expect(page.getByRole("heading", { name: /one quick set-up/i })).toBeVisible({ timeout: 30_000 });
  await page.getByLabel("Month").fill("6");
  await page.getByLabel("Day").fill("15");
  await page.getByLabel("Year").fill("1990");
  await page.waitForResponse((r) => r.url().endsWith("/api/users/me/onboarding/draft") && r.request().method() === "PUT");
  await page.reload();
  await expect(page.getByLabel("Year"), "the draft survives a reload").toHaveValue("1990", { timeout: 30_000 });
  await expect(page.getByLabel("Month")).toHaveValue("6");
  // Cloudflare's always-pass test keys: the widget solves itself.
  const finish = page.getByRole("button", { name: "Finish set-up" });
  await expect(finish).toBeEnabled({ timeout: 30_000 });
  await finish.click();
  // An adult is offered the optional photo; skipping it lands on the profile.
  await page.getByRole("button", { name: "Skip for now" }).click();
  // The profile carries the verification confirmation; the server must have
  // accepted the token, which the next assertion checks directly.
  await expect(page.getByText(/verified successfully/i)).toBeVisible();
  expect((await currentUser(page))?.["pronouns"], "the sign-up choice was kept through onboarding").toBe("they/them");
  expect((await currentUser(page))?.["eligibility"]).toBe("eligible");
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
  await submitLoginForm(page, email, FIRST_PASSWORD);
  await expect(page.getByText("Invalid email or password")).toBeVisible();
  expect(await currentUser(page)).toBeNull();

  await submitLoginForm(page, email, SECOND_PASSWORD);
  await page.waitForURL((url) => url.pathname !== "/login");
  expect((await currentUser(page))?.["email"]).toBe(email);

  // Delete the account from the profile (launch Phase 5, increment 5b): the
  // password is asked for, every session ends, and the confirmation names the date.
  const deletionRequestedAt = new Date();
  await page.goto("/profile");
  await page.getByRole("button", { name: /Delete my account…/ }).click();
  await page.getByRole("checkbox", { name: /can't be undone/ }).check();
  await page.getByLabel("Your password").fill(SECOND_PASSWORD);
  await page.getByRole("button", { name: /^Delete my account$/ }).click();
  await page.waitForURL((url) => url.pathname === "/account/deletion" && url.searchParams.has("scheduled"));
  await expect(page.getByRole("heading", { name: /scheduled for deletion/i })).toBeVisible();
  await expect.poll(() => currentUser(page), { message: "signed out everywhere" }).toBeNull();
  const keepLink = await waitForEmailLink({ to: email, linkPath: "/account/deletion", since: deletionRequestedAt, tokenless: true });
  expect(new URL(keepLink).pathname).toBe("/account/deletion");

  // Signing in during the window lands on Keep my account, and keeping it
  // gives the account back.
  await submitLoginForm(page, email, SECOND_PASSWORD);
  await page.waitForURL((url) => url.pathname === "/account/deletion");
  await page.getByRole("button", { name: "Keep my account" }).click();
  await expect(page.getByRole("heading", { name: /staying/i })).toBeVisible();
  await expect.poll(async () => (await currentUser(page))?.["eligibility"]).toBe("eligible");
  expect(await pageFetch(page, "PATCH", "/api/users/me", { pronouns: "they/them" }), "the account can act again").toBe(200);
});

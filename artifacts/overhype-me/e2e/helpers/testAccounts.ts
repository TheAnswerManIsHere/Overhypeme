/**
 * The ordinary E2E accounts (one free, one paid) and the real sign-in path.
 *
 * Accounts are defined once, in `artifacts/api-server/scripts/e2e-test-accounts.json`,
 * and seeded by `scripts/seed-e2e-test-accounts.ts` (paid through an admin
 * grant, never by setting the tier). This helper reads the same file, so the
 * spec and the seed cannot drift.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page } from "@playwright/test";

export interface TestAccount {
  email: string;
  displayName: string;
  firstName: string;
  lastName: string;
  pronouns: string;
}

const definitionsPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../api-server/scripts/e2e-test-accounts.json",
);
const definitions = JSON.parse(fs.readFileSync(definitionsPath, "utf8")) as {
  password: string;
  free: TestAccount;
  paid: TestAccount;
};

export const TEST_ACCOUNT_PASSWORD = definitions.password;
export const FREE_ACCOUNT = definitions.free;
export const PAID_ACCOUNT = definitions.paid;

/** Fill and submit the real login form, without waiting for the outcome (a refusal stays on /login). */
export async function submitLoginForm(page: Page, email: string, password: string): Promise<void> {
  await page.goto("/login");
  await page.getByPlaceholder("your@email.com").fill(email);
  await page.getByPlaceholder("Enter your password").fill(password);
  await page.getByRole("button", { name: /sign in/i }).and(page.locator('[type="submit"]')).click();
}

/** Sign in through the real login form and wait until the session is live. */
export async function signInThroughForm(page: Page, email: string, password: string): Promise<void> {
  await submitLoginForm(page, email, password);
  await page.waitForURL((url) => url.pathname !== "/login");
}

/** The signed-in user as the server sees it, read through the page's own cookies. */
export async function currentUser(page: Page): Promise<Record<string, unknown> | null> {
  const response = await page.request.get("/api/auth/user");
  expect(response.ok(), `GET /api/auth/user → ${response.status()}`).toBeTruthy();
  const body = (await response.json()) as { user?: Record<string, unknown> | null };
  return body.user ?? null;
}

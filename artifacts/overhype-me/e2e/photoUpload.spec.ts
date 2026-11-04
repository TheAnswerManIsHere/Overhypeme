/**
 * Baseline journey 7 (Launch Phase 2, increment 3; #631): an ordinary user
 * uploads a photo; it is stored, readable by its owner, and not readable by
 * another user or by a signed-out visitor.
 *
 * Runs against a dev stack whose API was started with the local storage double
 * (`STORAGE_BACKEND=local-double`, `STORAGE_DOUBLE_DIR=<dir>`), so nothing
 * reaches the real bucket, and the recorded AI double (`AI_BACKEND=recorded-double`),
 * so the upload's NSFW classification is answered from a recording instead
 * of being skipped or reaching fal. The image is the committed baseline
 * fixture (`artifacts/api-server/scripts/fixtures/ai-baseline/photo.jpg`): the
 * recording was made from those exact bytes, so the replayed request matches.
 * Upload goes through the same endpoint and the same browser credentials the
 * meme builder uses; reads go through the real access layer (`objectAccess.ts`).
 *
 * An acceptance journey: it does not run in the per-PR gate (plan, *Must Not
 * Change*); increment 6 adds it to the on-demand acceptance run.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

import { FREE_ACCOUNT, PAID_ACCOUNT, TEST_ACCOUNT_PASSWORD, csrfToken, signInThroughForm } from "./helpers/testAccounts";

const FIXTURE_PHOTO = fs
  .readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../api-server/scripts/fixtures/ai-baseline/photo.jpg"),
  )
  .toString("base64");

/** Upload the baseline fixture photo from the page, as the meme builder does. */
async function uploadFixturePhoto(page: Page): Promise<{ status: number; body: Record<string, unknown> }> {
  const csrf = await csrfToken(page);
  return page.evaluate(
    async ({ csrf, photo }) => {
      const bytes = Uint8Array.from(atob(photo), (c) => c.charCodeAt(0));
      const response = await fetch("/api/storage/upload-meme", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "image/jpeg", "X-CSRF-Token": csrf },
        body: new Blob([bytes], { type: "image/jpeg" }),
      });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    },
    { csrf, photo: FIXTURE_PHOTO },
  );
}

test("a user's uploaded photo is stored, readable by its owner, and by nobody else", async ({ page, browser }) => {
  await signInThroughForm(page, FREE_ACCOUNT.email, TEST_ACCOUNT_PASSWORD);

  const upload = await uploadFixturePhoto(page);
  expect(upload.status, JSON.stringify(upload.body)).toBe(200);
  const objectPath = upload.body["objectPath"] as string;
  expect(objectPath).toMatch(/^\/objects\/uploads\//);
  const url = `/api/storage${objectPath}`;

  // The owner reads back exactly what was stored.
  const own = await page.request.get(url);
  expect(own.status()).toBe(200);
  expect(own.headers()["content-type"]).toBe("image/jpeg");
  expect((await own.body()).length).toBe(upload.body["fileSizeBytes"]);

  // Another ordinary user is refused.
  const other = await browser.newContext();
  const otherPage = await other.newPage();
  await signInThroughForm(otherPage, PAID_ACCOUNT.email, TEST_ACCOUNT_PASSWORD);
  expect((await otherPage.request.get(url)).status()).toBe(403);
  await other.close();

  // A signed-out visitor is refused.
  const anonymous = await browser.newContext();
  expect((await anonymous.request.get(new URL(url, page.url()).toString())).status()).toBe(401);
  await anonymous.close();
});

// #848: a free account that sets an uploaded photo as its profile photo (the
// onboarding photo step's call) is not asked for one again on Profile, and
// keeps its generated avatar as its picture, since a photo avatar is
// Legendary's (custom_avatar).
test("a free account's profile photo stops Profile asking for one, and its picture stays generated", async ({ page }) => {
  await signInThroughForm(page, FREE_ACCOUNT.email, TEST_ACCOUNT_PASSWORD);

  const upload = await uploadFixturePhoto(page);
  expect(upload.status, JSON.stringify(upload.body)).toBe(200);
  const objectPath = upload.body["objectPath"] as string;

  const csrf = await csrfToken(page);
  const set = await page.evaluate(
    async ({ csrf, objectPath }) => {
      const response = await fetch("/api/users/me/profile-image", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
        body: JSON.stringify({ objectPath }),
      });
      return response.status;
    },
    { csrf, objectPath },
  );
  expect(set).toBe(200);

  const me = (await (await page.request.get("/api/users/me")).json()) as Record<string, unknown>;
  expect(me["profileImageUrl"]).toBe(`/api/storage${objectPath}`);
  expect(me["avatarSource"]).toBe("avatar");

  await page.goto("/profile");
  // The banner renders in the same pass as the loaded profile's heading.
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Add a real photo of you")).toHaveCount(0);
});

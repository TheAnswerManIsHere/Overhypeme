/**
 * Baseline journey 7 (Launch Phase 2, increment 3; #631): an ordinary user
 * uploads a photo; it is stored, readable by its owner, and not readable by
 * another user or by a signed-out visitor.
 *
 * Runs against a dev stack whose API was started with the local storage double
 * (`STORAGE_BACKEND=local-double`, `STORAGE_DOUBLE_DIR=<dir>`), so nothing
 * reaches the real bucket. The image is synthetic, drawn in the page. Upload
 * goes through the same endpoint and the same browser credentials the meme
 * builder uses; reads go through the real access layer (`objectAccess.ts`).
 *
 * An acceptance journey: it does not run in the per-PR gate (plan, *Must Not
 * Change*); increment 6 adds it to the on-demand acceptance run.
 */
import { expect, test, type Page } from "@playwright/test";

import { FREE_ACCOUNT, PAID_ACCOUNT, TEST_ACCOUNT_PASSWORD, signInThroughForm } from "./helpers/testAccounts";

/** Draw a synthetic JPEG in the page and upload it as the meme builder does. */
async function uploadSyntheticPhoto(page: Page): Promise<{ status: number; body: Record<string, unknown> }> {
  return page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 480;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#3a6";
    ctx.fillRect(0, 0, 640, 480);
    ctx.fillStyle = "#fff";
    ctx.font = "48px sans-serif";
    ctx.fillText("journey 7", 160, 250);
    const blob: Blob = await new Promise((resolve) => canvas.toBlob((b) => resolve(b!), "image/jpeg", 0.9));
    const csrf = document.cookie
      .split("; ")
      .find((c) => c.startsWith("csrf_token="))
      ?.slice("csrf_token=".length);
    const response = await fetch("/api/storage/upload-meme", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "image/jpeg", ...(csrf ? { "X-CSRF-Token": csrf } : {}) },
      body: blob,
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  });
}

test("a user's uploaded photo is stored, readable by its owner, and by nobody else", async ({ page, browser }) => {
  await signInThroughForm(page, FREE_ACCOUNT.email, TEST_ACCOUNT_PASSWORD);

  const upload = await uploadSyntheticPhoto(page);
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

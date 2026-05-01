/**
 * End-to-end UI test for the admin Billing page Stripe-sync flow.
 *
 * What this guards (Task #355):
 *   1. The "Plans from Stripe" section header shows the correct LIVE/TEST badge
 *      reflecting the current Stripe mode.
 *   2. Clicking "Sync Stripe data" opens the per-resource progress panel and
 *      drives the three rows (Products / Prices / Plans) through the full
 *      pending → running → complete lifecycle.
 *   3. After the run finishes, a green "Sync complete —" summary banner appears
 *      AND the "Last synced X ago" stamp shows up in the Plans header.
 *   4. Failure path: when one resource ends in the error state, that row
 *      flips to a red error icon and the summary banner shows "Sync failed:
 *      <Resource> — <error message>".
 *
 * Why this shape:
 *   - The success path drives the real `POST /api/admin/stripe/sync` against
 *     the test-mode Stripe account so it covers the full real flow exactly
 *     as a human admin sees it.
 *   - The failure path uses a small dev-only injection endpoint
 *     (`POST /api/admin/stripe/sync/_test/simulate`) that drives the same
 *     in-process `runScopedSync` machinery with a stub driver. This lets us
 *     deterministically trigger a per-resource error icon + failure banner
 *     without depending on the live Stripe account being misconfigured.
 *     The endpoint short-circuits to 404 when `NODE_ENV === "production"`.
 *   - Auth bypass: this app does NOT use Replit Auth or Clerk. We use the
 *     existing `POST /api/auth/dev-admin-login` endpoint, which sets the
 *     `sid` session cookie for the admin user (no OAuth, no key required).
 *
 * Prereqs to run locally:
 *   1. Both dev workflows must be up:
 *        - artifacts/api-server: API Server   (port 8080, proxied via /api)
 *        - artifacts/overhype-me: web          (Vite dev server)
 *   2. Chromium installed once: `pnpm exec playwright install chromium`
 *   3. Run: `pnpm --filter @workspace/overhype-me run e2e`
 */

import { expect, test, type Page } from "@playwright/test";

const RESOURCE_LABELS = ["Products", "Prices", "Plans"] as const;
type ResourceLabel = (typeof RESOURCE_LABELS)[number];

/**
 * Locate one of the three rows inside the per-resource progress panel by its
 * leading label. Each row in the panel has the unique class signature
 * `flex items-center gap-2 text-xs flex-wrap` and contains a label span
 * (`span.font-medium.w-20`) plus a status text span. We anchor on the label
 * span's exact text to find the row, then read the row's full innerText.
 */
function progressRow(page: Page, label: ResourceLabel) {
  return page
    .locator("div.flex.items-center.gap-2.text-xs.flex-wrap")
    .filter({
      has: page.locator("span.font-medium.w-20", { hasText: new RegExp(`^${label}$`) }),
    });
}

async function statusTextFor(page: Page, label: ResourceLabel): Promise<string> {
  const row = progressRow(page, label);
  if ((await row.count()) === 0) return "";
  // The row's full innerText is "<Label>\n<status text>" once rendered.
  const text = (await row.first().innerText()).trim();
  return text.replace(new RegExp(`^${label}\\s*`), "").trim();
}

async function waitForResourceComplete(page: Page, label: ResourceLabel, timeoutMs: number) {
  await expect
    .poll(async () => statusTextFor(page, label), {
      timeout: timeoutMs,
      message: `${label} row should reach the "complete" state`,
    })
    .toMatch(/synced\s*·/);
}

async function waitForResourceError(page: Page, label: ResourceLabel, timeoutMs: number) {
  await expect
    .poll(async () => statusTextFor(page, label), {
      timeout: timeoutMs,
      message: `${label} row should reach the "error" state`,
    })
    .toMatch(/^error\s*·/);
}

async function waitForResourceRunning(page: Page, label: ResourceLabel, timeoutMs: number) {
  await expect
    .poll(async () => statusTextFor(page, label), {
      timeout: timeoutMs,
      intervals: [200, 300, 500, 750],
      message: `${label} row should enter the "syncing…" (running) state`,
    })
    .toMatch(/^syncing/);
}

async function expectResourcePending(page: Page, label: ResourceLabel) {
  expect(
    await statusTextFor(page, label),
    `${label} row should be in "pending" state right now`,
  ).toBe("pending");
}

test.describe("Admin Billing — Stripe sync progress UI", () => {
  test("renders per-resource progress and final banner for both success and failure", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();

    // 1. Authenticate as admin via the dev-only login route. This sets the
    //    `sid` session cookie on the browser context so subsequent navigation
    //    is authenticated.
    const loginRes = await context.request.post("/api/auth/dev-admin-login");
    expect(loginRes.ok(), `dev-admin-login should be 200, got ${loginRes.status()}`).toBe(true);
    const loginBody = (await loginRes.json()) as { user?: { email?: string } };
    expect(loginBody.user?.email, "dev-admin-login should return the admin user").toBeTruthy();

    // 2. Navigate to the admin Billing page.
    const navResp = await page.goto("/admin/billing", { waitUntil: "domcontentloaded" });
    expect(navResp?.ok() ?? false, `/admin/billing should load 200, got ${navResp?.status()}`).toBe(true);

    // The Plans section is collapsible — make sure it's open so its header,
    // sync button, and progress panel are visible. The CollapsibleSection
    // component shows its content under the trigger; clicking the trigger
    // toggles. We just ensure the "Sync Stripe data" button is visible by
    // expanding if needed.
    const syncButton = page.getByRole("button", { name: /Sync Stripe data|Syncing…/ });
    if (!(await syncButton.isVisible().catch(() => false))) {
      await page.getByRole("button", { name: /Plans from Stripe/i }).first().click();
    }
    await expect(syncButton, "Sync Stripe data button should be visible").toBeVisible({ timeout: 10_000 });

    // 3. Verify the LIVE/TEST badge inside the Plans section header. The dev
    //    environment is configured for test mode by default, so we expect TEST.
    //    There are TWO badges with this text (top "Stripe Mode" panel + Plans
    //    header). We scope to the precise inner row that holds the badge AND
    //    the Sync button (Plans section only).
    const plansHeaderRow = page
      .locator("div.flex.items-center.justify-between.mb-3.flex-wrap")
      .filter({ has: syncButton });
    await expect(plansHeaderRow, "Plans section header row should be present").toHaveCount(1);
    await expect(plansHeaderRow.getByText(/^TEST$/), "Plans header should show TEST badge").toBeVisible();
    await expect(plansHeaderRow.getByText(/^LIVE$/)).toHaveCount(0);

    // ──────────────── SUCCESS PATH ────────────────

    await test.step("success path: real test-mode sync drives all rows to complete", async () => {
      await syncButton.click();

      // The button label flips to "Syncing…" while the run is in flight.
      await expect(syncButton).toHaveText(/Syncing…/, { timeout: 5_000 });

      // The progress panel renders three rows. They might already be in the
      // complete state by the time we look (the test-mode account is tiny —
      // each resource finishes in ~150ms — so don't strictly require the
      // intermediate "running" state). The terminal state is what matters.
      for (const label of RESOURCE_LABELS) {
        await waitForResourceComplete(page, label, 30_000);
      }

      // Button label flips back from "Syncing…" → "Sync Stripe data".
      await expect(syncButton).toHaveText(/Sync Stripe data/, { timeout: 10_000 });

      // Green summary banner with "Sync complete —" prefix.
      await expect(
        page.getByText(/^Sync complete —/),
        "green Sync complete banner should appear",
      ).toBeVisible({ timeout: 5_000 });

      // "Last synced: <X> ago" appears in the Plans header next to the badge.
      await expect(
        plansHeaderRow.getByText(/Last synced:/),
        '"Last synced" stamp should appear in Plans header',
      ).toBeVisible({ timeout: 5_000 });
    });

    // ─────── INTERMEDIATE TRANSITIONS (deterministic via simulate) ───────
    //
    // The previous "real" run is too fast (~150ms per resource) to reliably
    // observe pending → running transitions on a 1s polling cycle. Use the
    // simulate endpoint with a 1500ms per-resource delay so each resource
    // spends ~1.5s in the running state — long enough for at least one
    // browser-side poll tick to capture the spinner + "syncing…" text and
    // assert the per-resource ordering (products → prices → plans).

    await test.step("intermediate transitions: rows progress pending → syncing… → complete in order", async () => {
      const simRes = await context.request.post("/api/admin/stripe/sync/_test/simulate", {
        data: { delayMs: 1500 },
      });
      expect(simRes.ok(), `simulate (no-fail) should be 200, got ${simRes.status()}`).toBe(true);

      // Click Sync to start client-side polling. Server already running
      // returns 409 alreadyRunning — the page handles that by surfacing the
      // conflict banner and starting its 1s status poll, which is exactly
      // what we want here.
      await syncButton.click();
      await expect(syncButton).toHaveText(/Syncing…/, { timeout: 5_000 });

      // While Products is running, Prices and Plans must still be pending
      // (the runner is strictly sequential).
      await waitForResourceRunning(page, "Products", 8_000);
      await expectResourcePending(page, "Prices");
      await expectResourcePending(page, "Plans");

      // Then Products completes, Prices starts running, Plans still pending.
      await waitForResourceRunning(page, "Prices", 8_000);
      expect(await statusTextFor(page, "Products")).toMatch(/synced\s*·/);
      await expectResourcePending(page, "Plans");

      // Finally Prices completes, Plans starts running, Products still complete.
      await waitForResourceRunning(page, "Plans", 8_000);
      expect(await statusTextFor(page, "Products")).toMatch(/synced\s*·/);
      expect(await statusTextFor(page, "Prices")).toMatch(/synced\s*·/);

      // All three terminal.
      await waitForResourceComplete(page, "Plans", 8_000);
      await expect(syncButton).toHaveText(/Sync Stripe data/, { timeout: 10_000 });
      await expect(
        page.getByText(/^Sync complete —/),
        "green Sync complete banner should appear after deterministic run",
      ).toBeVisible({ timeout: 5_000 });
    });

    // ──────────────── FAILURE PATH ────────────────

    await test.step("failure path: simulated error on plans surfaces error icon + failure banner", async () => {
      // Kick off a background simulated sync that ends with `plans` in error.
      // The endpoint returns immediately; the actual run takes ~delayMs * 3
      // (sequential per resource).
      const simRes = await context.request.post("/api/admin/stripe/sync/_test/simulate", {
        data: { failResource: "plans", delayMs: 800 },
      });
      expect(
        simRes.ok(),
        `simulate endpoint should return 200, got ${simRes.status()}: ${await simRes.text().catch(() => "")}`,
      ).toBe(true);

      // Immediately click the Sync button. The server is already mid-run, so
      // this POST gets 409 alreadyRunning — but the page still surfaces the
      // conflict message AND starts polling the status endpoint, which is
      // what we want so the panel updates as the simulated run progresses.
      await syncButton.click();

      // Wait for the Plans row to reach the error state.
      await waitForResourceError(page, "Plans", 30_000);

      // The other two resources should reach complete in the same run.
      await waitForResourceComplete(page, "Products", 5_000);
      await waitForResourceComplete(page, "Prices", 5_000);

      // The summary banner reflects the failure with the resource name +
      // simulated error message. Match the full banner text so we don't
      // collide with the "error · Simulated failure for testing" status text
      // on the Plans row itself.
      await expect(
        page.getByText(/^Sync failed:\s*Plans\s*—\s*Simulated failure for testing/),
        '"Sync failed: Plans — Simulated failure for testing" banner should appear',
      ).toBeVisible({ timeout: 5_000 });

      // Sync button is enabled again.
      await expect(syncButton).toHaveText(/Sync Stripe data/, { timeout: 10_000 });
      await expect(syncButton).toBeEnabled();
    });

    await context.close();
  });
});

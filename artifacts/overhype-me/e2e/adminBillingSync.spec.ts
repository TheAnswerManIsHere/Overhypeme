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
 *   - The success path drives the real `POST /api/admin/stripe/sync` through the
 *     real sync library and mirror. In CI that runs against the fake Stripe
 *     driver (`STRIPE_BACKEND=fake-double`, #566), which needs no credential;
 *     locally it can run against either driver. It asserts the request and the
 *     run's terminal states, never the transient "Syncing…" label: against a
 *     fast backend the whole run can finish between two renders, and the label
 *     was the race this spec carried until #566.
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

import { expect, test, type BrowserContext, type Page } from "@playwright/test";

const RESOURCE_LABELS = ["Products", "Prices", "Plans"] as const;
type ResourceLabel = (typeof RESOURCE_LABELS)[number];

/** Map the human label back to the resource key used in `data-testid`. */
const RESOURCE_KEYS: Record<ResourceLabel, string> = {
  Products: "products",
  Prices: "prices",
  Plans: "plans",
};

/**
 * Locate one of the rows inside the per-resource progress panel.
 *
 * These used to anchor on Tailwind class signatures — `div.flex.items-center
 * .gap-2.text-xs.flex-wrap` containing a `span.font-medium.w-20`. That was
 * brittle by construction and had already silently rotted: the label span is
 * `w-32` in the page, so the `w-20` filter matched nothing and
 * `statusTextFor` fell through to its empty-string branch rather than
 * failing. Anchoring on `data-testid` makes the coupling explicit and makes a
 * broken locator a hard failure instead of a quiet "".
 */
function progressRow(page: Page, label: ResourceLabel) {
  return page.getByTestId(`sync-row-${RESOURCE_KEYS[label]}`);
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

/** All eight tracked resources, in the panel's display order. */
const ALL_RESOURCES = [
  ["products", "Products"],
  ["prices", "Prices"],
  ["plans", "Plans"],
  ["customers", "Customers"],
  ["subscriptions", "Subscriptions"],
  ["invoices", "Invoices"],
  ["charges", "Charges"],
  ["payment_methods", "Payment Methods"],
] as const;

interface SyncStatusBody {
  inProgress: boolean;
  resources: Array<{ resource: string; status: string; lastSyncedAt: string | null }>;
}

function stampOf(status: SyncStatusBody | null, resource: string): number {
  const stamp = status?.resources.find(r => r.resource === resource)?.lastSyncedAt;
  return stamp ? new Date(stamp).getTime() : 0;
}

/**
 * Keep the most recent sync status the PAGE itself read. Asserting on what the
 * page received, rather than on a side request, ties a row's state to the run
 * the page is showing.
 */
function watchPageSyncStatus(page: Page): { latest: SyncStatusBody | null } {
  const seen: { latest: SyncStatusBody | null } = { latest: null };
  page.on("response", async r => {
    if (!r.url().endsWith("/api/admin/stripe/sync/status") || !r.ok()) return;
    try {
      seen.latest = (await r.json()) as SyncStatusBody;
    } catch {
      // A response discarded by a navigation has no body; the next poll replaces it.
    }
  });
  return seen;
}

async function loginAsDevAdmin(context: BrowserContext): Promise<string> {
  const loginRes = await context.request.post("/api/auth/dev-admin-login");
  expect(loginRes.ok(), `dev-admin-login should be 200, got ${loginRes.status()}`).toBe(true);
  const csrfToken = (await context.cookies()).find(cookie => cookie.name === "csrf_token")?.value;
  expect(csrfToken, "dev-admin-login should issue a CSRF cookie").toBeTruthy();
  return csrfToken!;
}

test.describe("Admin Billing — Stripe sync progress UI", () => {
  test("renders per-resource progress and final banner for both success and failure", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const pageStatus = watchPageSyncStatus(page);

    // 1. Authenticate as admin via the dev-only login route. This sets the
    //    `sid` session cookie on the browser context so subsequent navigation
    //    is authenticated.
    const loginRes = await context.request.post("/api/auth/dev-admin-login");
    expect(loginRes.ok(), `dev-admin-login should be 200, got ${loginRes.status()}`).toBe(true);
    const loginBody = (await loginRes.json()) as { user?: { email?: string } };
    expect(loginBody.user?.email, "dev-admin-login should return the admin user").toBeTruthy();
    const csrfToken = (await context.cookies()).find(cookie => cookie.name === "csrf_token")?.value;
    expect(csrfToken, "dev-admin-login should issue a CSRF cookie").toBeTruthy();

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

    // PR276 step 1: the status panel is present on an ordinary page load, not
    // only while a run is in flight.
    await expect(
      page.getByTestId("sync-progress-panel"),
      "the sync status panel should render on load",
    ).toBeVisible({ timeout: 15_000 });

    // PR276 step 1, before any click: every one of the eight resources has its
    // own row and state, and a coloured summary line heads the panel.
    for (const [key, label] of ALL_RESOURCES) {
      const row = page.getByTestId(`sync-row-${key}`);
      await expect(row, `PR276 step 1: the ${label} row should be shown on load`).toContainText(label);
      await expect(row, `PR276 step 1: the ${label} row should carry its own state`).toHaveAttribute(
        "data-status",
        /^(idle|pending|running|complete|error)$/,
      );
    }
    const loadSummary = page.getByTestId("sync-summary");
    await expect(loadSummary, "PR276 step 1: the summary line should carry a tone").toHaveAttribute(
      "data-tone",
      /^(ok|error|running|never)$/,
    );
    await expect(loadSummary, "PR276 step 1: the summary line should be coloured").toHaveClass(
      /text-(green-400|destructive|amber-400|blue-400)/,
    );
    expect(
      await page.getByTestId("sync-progress-panel").evaluate(el => el.firstElementChild?.getAttribute("data-testid")),
      "PR276 step 1: the summary line should sit at the top of the panel",
    ).toBe("sync-summary");

    // Under the fake driver, the page says so and shows the fixture catalog —
    // proof the chain fake → sync library → mirror → catalog API → page holds.
    const summaryRes = await context.request.get("/api/admin/stripe/summary");
    expect(summaryRes.ok(), `summary should be 200, got ${summaryRes.status()}`).toBe(true);
    const summaryBody = (await summaryRes.json()) as { stripeDriver?: string };
    // CI runs this suite on the fake driver only, so there the fixture-gated
    // assertions below must run rather than skip.
    if (process.env["CI"]) expect(summaryBody.stripeDriver, "CI runs the Billing suite on the fake Stripe driver").toBe("fake");
    if (summaryBody.stripeDriver === "fake") {
      await expect(page.getByTestId("stripe-fake-notice")).toBeVisible();
      // The test-webhook action needs payment flows the fake refuses, so it is
      // not offered; a one-line note says why (#671 round 1).
      await expect(page.getByTestId("stripe-fake-test-event-note")).toBeVisible();
      await expect(page.getByText("Send Test Webhook Event", { exact: true })).toHaveCount(0);
      await expect(page.getByText("Legendary (fake)").first(), "the fake fixture product should be listed").toBeVisible({
        timeout: 10_000,
      });
    }

    // 3. Verify the LIVE/TEST badge inside the Plans section header. The dev
    //    environment is configured for test mode by default, so we expect TEST.
    //    There are TWO badges with this text (top "Stripe Mode" panel + Plans
    //    header). We scope to the precise inner row that holds the badge AND
    //    the Sync button (Plans section only).
    const plansHeaderRow = page.getByTestId("plans-header");
    await expect(plansHeaderRow, "Plans section header row should be present").toHaveCount(1);
    await expect(plansHeaderRow.getByText(/^TEST$/), "Plans header should show TEST badge").toBeVisible();
    await expect(plansHeaderRow.getByText(/^LIVE$/)).toHaveCount(0);

    // ──────────────── SUCCESS PATH ────────────────

    await test.step("success path: a real sync drives all rows to complete", async () => {
      // Stamps before the click, so the rows below can be tied to THIS run
      // rather than to rows the boot backfill already completed.
      const before = (await (await context.request.get("/api/admin/stripe/sync/status")).json()) as SyncStatusBody;

      // The request is what proves a sync started; the transient button label
      // does not, and asserting it here raced a fast backend (#566).
      const syncResponse = page.waitForResponse(
        (r) => r.url().endsWith("/api/admin/stripe/sync") && r.request().method() === "POST",
      );
      await syncButton.click();
      expect((await syncResponse).ok(), "POST /api/admin/stripe/sync should succeed").toBe(true);

      await expect
        .poll(
          () => {
            const s = pageStatus.latest;
            if (!s || s.inProgress) return false;
            return (
              stampOf(s, "products") > stampOf(before, "products") &&
              stampOf(s, "prices") > stampOf(before, "prices")
            );
          },
          { timeout: 30_000, message: "PR577 R2: the page should read Products and Prices stamps from the run the click started" },
        )
        .toBe(true);

      // The terminal state is what matters; intermediate states are asserted
      // only in the controlled scenario below.
      for (const label of RESOURCE_LABELS) {
        await waitForResourceComplete(page, label, 30_000);
      }
      await expect(progressRow(page, "Plans"), "PR577 R2: the Plans row should reach complete").toHaveAttribute(
        "data-status",
        "complete",
      );
      for (const label of ["Products", "Prices"] as const) {
        await expect(
          page.getByTestId(`sync-row-${RESOURCE_KEYS[label]}-detail`),
          `PR577 R2: the ${label} row should report this run's sync`,
        ).toHaveText(/synced · just now$/);
      }

      // Button label flips back from "Syncing…" → "Sync Stripe data".
      await expect(syncButton).toHaveText(/Sync Stripe data/, { timeout: 10_000 });

      // PR276 step 2: the green line names what synced and how long it took.
      const completeLine = page.getByText(/^Sync complete —/);
      await expect(completeLine, "green Sync complete banner should appear").toBeVisible({ timeout: 5_000 });
      await expect(completeLine, "PR276 step 2: Sync complete should name the counts and the duration").toHaveText(
        /^Sync complete — \d+ products, \d+ prices, \d+ plans(, \d+ [a-z ]+)* synced in \d+\.\ds$/,
      );
      await expect(completeLine.locator(".."), "PR276 step 2: the Sync complete line should be green").toHaveClass(
        /text-green-400/,
      );

      // "Last synced: <X> ago" appears in the Plans header next to the badge.
      await expect(
        plansHeaderRow.getByText(/Last synced:/),
        '"Last synced" stamp should appear in Plans header',
      ).toBeVisible({ timeout: 5_000 });
      await expect(
        page.getByTestId("plans-last-synced"),
        "PR276 step 2: the Plans header should read Last synced: just now",
      ).toHaveText("· Last synced: just now");

      // PR276 R4/R5: the count and the product list match the fake fixture's
      // one product and its three prices. Gated like the fixture check above:
      // a local run against the real driver lists that account's own catalog.
      if (summaryBody.stripeDriver === "fake") {
        await expect(page.getByTestId("plans-count"), "PR276 R4: the product count should be accurate").toHaveText(
          "1 product found",
        );
        const productCard = page.getByText("Legendary (fake)", { exact: true }).locator("xpath=..");
        await expect(
          productCard.getByText("Fake Legendary membership", { exact: false }),
          "PR276 R5: the product's description should render",
        ).toBeVisible();
        for (const price of ["$4.99/month", "$49.00/year", "$99.00 one-time"]) {
          await expect(
            productCard.getByText(price, { exact: true }),
            `PR276 R5: the price ${price} should render`,
          ).toBeVisible();
        }
      }
    });

    await test.step("a successful sync's summary survives a reload", async () => {
      await page.reload();
      const summary = page.getByTestId("sync-summary");
      await expect(summary, "PR276 step 3: the summary line should still be there after a reload").toBeVisible({
        timeout: 15_000,
      });
      await expect(summary, "PR276 step 3: it should not revert to a bare product count").not.toContainText(
        /products? found/,
      );
      await expect(summary, "PR276 step 3: the reloaded summary should say it synced").toHaveAttribute("data-tone", "ok");
      await expect(summary, "PR276 step 3: the reloaded summary should be green").toHaveClass(/text-green-400/);
      await expect(summary, "PR276 step 3: the reloaded summary should say it synced").toHaveText(
        /^Last sync completed(?: — \d of 8 resources reported\.| successfully\.) Last synced (just now|\d+s ago)\.$/,
      );
    });

    await test.step("Full sync drives all eight resources to complete", async () => {
      const before = (await (await context.request.get("/api/admin/stripe/sync/status")).json()) as SyncStatusBody;
      const fullSyncResponse = page.waitForResponse(
        r => r.url().endsWith("/api/admin/stripe/full-sync") && r.request().method() === "POST",
      );
      await page.getByRole("button", { name: "Full sync" }).click();
      expect((await fullSyncResponse).ok(), "POST /api/admin/stripe/full-sync should succeed").toBe(true);

      // Payment Methods is touched only by a full run, so a newer stamp on it
      // is what proves the panel shows the run Full sync started.
      await expect
        .poll(
          () => {
            const s = pageStatus.latest;
            return !!s && !s.inProgress && stampOf(s, "payment_methods") > stampOf(before, "payment_methods");
          },
          { timeout: 30_000, message: "PR276 R2: the page should read the full run's Payment Methods stamp" },
        )
        .toBe(true);
      for (const [key, label] of ALL_RESOURCES) {
        await expect(
          page.getByTestId(`sync-row-${key}`),
          `PR276 R2: Full sync should drive the ${label} row to complete`,
        ).toHaveAttribute("data-status", "complete");
      }
      await expect(syncButton).toHaveText(/Sync Stripe data/, { timeout: 10_000 });
      await expect(syncButton).toBeEnabled();
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
        headers: { "x-csrf-token": csrfToken! },
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
      await expect(syncButton, "PR276 R1: the Sync button should be disabled while the run is in flight").toBeDisabled();
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
        headers: { "x-csrf-token": csrfToken! },
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
      await expect(
        progressRow(page, "Plans").locator("svg").first(),
        "PR276 step 5: the failed Plans row should show a red ✗",
      ).toHaveClass(/lucide-(circle-x|x-circle)\b.*\btext-destructive\b/);

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

    // ──────────────── THE REGRESSION THIS PR EXISTS FOR ────────────────

    await test.step("a failed sync is still visible after a full page reload", async () => {
      // The original defect: the panel rendered only while a run was in
      // flight (`syncing || syncFinalMessage || inProgress`). After a reload
      // all three are false, so the persisted error was fetched from
      // /admin/stripe/sync/status and then discarded unrendered — leaving
      // "N products found · Last synced: …", which reads like success. That
      // is how a broken Stripe sync stayed hidden through four rounds of
      // investigation. Reload is the whole point of this assertion; do not
      // relax it to a re-render.
      await page.reload();

      const panel = page.getByTestId("sync-progress-panel");
      await expect(panel, "progress panel must render on load, not only during a run").toBeVisible({
        timeout: 15_000,
      });

      // The per-resource row still reports the error, with its message.
      await expect(progressRow(page, "Plans")).toHaveAttribute("data-status", "error", {
        timeout: 10_000,
      });
      await expect(page.getByTestId("sync-row-plans-detail")).toContainText(
        /Simulated failure for testing/,
      );
      await expect(
        progressRow(page, "Plans").locator("svg").first(),
        "PR276 step 6: the Plans row's red ✗ should survive the reload",
      ).toHaveClass(/lucide-(circle-x|x-circle)\b.*\btext-destructive\b/);

      // And the aggregate line says failed rather than staying quiet.
      const summary = page.getByTestId("sync-summary");
      await expect(summary).toHaveAttribute("data-tone", "error");
      await expect(summary, "PR276 steps 4, 6, 8: the failed summary line should be red").toHaveClass(
        /text-destructive/,
      );
      await expect(summary).toContainText(/Last sync failed/i);
      await expect(summary).toContainText(/plans/i);
      await expect(summary, "PR276 step 4: the summary should say what did not complete and why").toContainText(
        "plans did not complete: Simulated failure for testing.",
      );
      await expect(summary, "PR276 step 4: the failure sentence should end Catalog data may be stale.").toContainText(
        /Simulated failure for testing\. Catalog data may be stale\./,
      );
      // Partial failure: Products and Prices completed in this run, and the
      // red line still carries the stamp — both facts, never rounded up.
      await expect(progressRow(page, "Products")).toHaveAttribute("data-status", "complete");
      await expect(progressRow(page, "Prices")).toHaveAttribute("data-status", "complete");
      await expect(summary, "PR276 step 8: the Last synced stamp should still appear on the red summary").toContainText(
        /Catalog data may be stale\. Last synced (just now|\d+[smhd] ago)\./,
      );
    });

    await test.step("an all-idle status still renders, as the never-synced state", async () => {
      // readSyncStatus maps over SYNC_RESOURCES and defaults every absent row
      // to `idle`, so a fresh install returns eight idle resources and no
      // non-idle one. A gate keyed on "has a non-idle resource" would hide
      // exactly the state the operator most needs to see.
      await page.route("**/api/admin/stripe/sync/status", route =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            inProgress: false,
            startedAt: null,
            finishedAt: null,
            durationMs: null,
            resources: RESOURCE_LABELS.map(label => ({
              resource: RESOURCE_KEYS[label],
              status: "idle",
              lastSyncedAt: null,
              errorMessage: null,
              syncedCount: null,
            })),
          }),
        }),
      );
      await page.reload();

      await expect(page.getByTestId("sync-progress-panel")).toBeVisible({ timeout: 15_000 });
      const summary = page.getByTestId("sync-summary");
      await expect(summary).toHaveAttribute("data-tone", "never");
      await expect(summary).toContainText(/never synced/i);
      await expect(summary, "PR276 step 9: the never-synced line should be amber").toHaveClass(/text-amber-400/);
      await expect(summary, "PR276 step 9: the never-synced line should say what to do").toContainText(
        "Never synced — run a full sync to populate the catalog.",
      );
      await page.unroute("**/api/admin/stripe/sync/status");
    });

    await test.step("the Plans header stamp survives a server restart", async () => {
      // After a restart the in-process lock is gone, so startedAt / finishedAt
      // are null while every resource row keeps its own lastSyncedAt. That
      // response cannot be produced on a running stack without a restart, so
      // it is stubbed; what is asserted is how the page presents it.
      const threeMinutesAgo = new Date(Date.now() - 3 * 60_000).toISOString();
      await page.route("**/api/admin/stripe/sync/status", route =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            inProgress: false,
            startedAt: null,
            finishedAt: null,
            durationMs: null,
            resources: ALL_RESOURCES.map(([resource]) => ({
              resource,
              status: "complete",
              lastSyncedAt: threeMinutesAgo,
              errorMessage: null,
              syncedCount: 1,
            })),
          }),
        }),
      );
      await page.reload();
      await expect(
        page.getByTestId("plans-last-synced"),
        "PR276 step 10: the Plans header stamp should come from the resources' own lastSyncedAt",
      ).toHaveText("· Last synced: 3m ago", { timeout: 15_000 });
      await page.unroute("**/api/admin/stripe/sync/status");
    });

    await context.close();
  });

  test("mode panel, verification, subscriber counts and setup checklist", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await loginAsDevAdmin(context);
    const summaryRes = await context.request.get("/api/admin/stripe/summary");
    expect(summaryRes.ok(), `summary should be 200, got ${summaryRes.status()}`).toBe(true);
    const counts = (await summaryRes.json()) as { activeSubscribers: number; registeredMembers: number };

    await page.goto("/admin/billing", { waitUntil: "domcontentloaded" });
    const modeChip = page.locator("p").filter({ hasText: /^Stripe Mode/ }).locator("span");
    const modeToggle = page.getByRole("button", { name: /Switch to (Live|Test) Mode/ });
    const modePanel = modeToggle.locator("xpath=ancestor::div[contains(@class, 'bg-card')][1]");
    const verification = page.getByTestId("stripe-verification");

    await test.step("on load: the counts, the mode chip and the verification box", async () => {
      // A card's number is the <p> under its label; the label's grandparent is the card.
      const activeCard = page.getByText("Active Subscribers", { exact: true }).locator("xpath=../..");
      const registeredCard = page.getByText("Registered", { exact: true }).locator("xpath=../..");
      for (const [card, name] of [[activeCard, "active-subscriber"], [registeredCard, "registered-member"]] as const) {
        await expect(card.getByText(/^\d+$/), `PR577 R3: the ${name} number should show`).toBeVisible({
          timeout: 15_000,
        });
        await expect(card.locator(".animate-pulse"), `PR577 R3: no ${name} spinner should be left`).toHaveCount(0);
      }
      // The seeded paid account is an active subscriber and the free one a
      // registered member, so neither count can honestly be zero here.
      expect(counts.activeSubscribers, "the seeded paid account should count as active").toBeGreaterThan(0);
      expect(counts.registeredMembers, "the seeded free account should count as registered").toBeGreaterThan(0);
      await expect(
        activeCard.getByText(/^\d+$/),
        "PR287 step 24: Active Subscribers should show the summary's legendary count",
      ).toHaveText(String(counts.activeSubscribers));
      await expect(
        registeredCard.getByText(/^\d+$/),
        "PR287 step 24: Registered should show the summary's registered count",
      ).toHaveText(String(counts.registeredMembers));

      await expect(modeChip, "PR577 step 3: the Stripe Mode chip should read TEST").toHaveText("TEST");
      await expect(verification, "PR577 step 3: the box on the same panel should report verified").toHaveAttribute(
        "data-state",
        "verified",
      );
      await expect(verification, "PR577 step 1: the box should read Payments verified").toContainText(
        "Payments verified",
      );
      await expect(verification, "PR577 step 1: the Payments verified box should be green").toHaveClass(
        /text-green-400/,
      );
      await expect(
        modePanel.getByTestId("stripe-verification"),
        "PR577 step 1: the box should sit in the Stripe Mode panel with the toggle",
      ).toBeVisible();
      const toggleBox = (await modeToggle.boundingBox())!;
      const verificationBox = (await verification.boundingBox())!;
      expect(
        verificationBox.y,
        "PR577 step 1: the box should sit beneath the mode toggle",
      ).toBeGreaterThanOrEqual(toggleBox.y + toggleBox.height);
    });

    await test.step("toggling to live flips the chip, and a live load shows LIVE", async () => {
      // The fake Stripe is test-mode only, so a successful switch cannot happen
      // on this stack. The PATCH is stubbed to succeed, and from then on the
      // config and the guard's sample report live, as the server would after a
      // real switch; what is asserted is how the page presents that.
      let switched = false;
      await page.route("**/api/admin/config/stripe_live_mode", async route => {
        if (route.request().method() !== "PATCH") return route.fallback();
        switched = true;
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ key: "stripe_live_mode", value: "true" }) });
      });
      await page.route("**/api/admin/config", async route => {
        const res = await route.fetch();
        const rows = (await res.json()) as Array<{ key: string; value: string }>;
        if (switched) rows.forEach(r => { if (r.key === "stripe_live_mode") r.value = "true"; });
        await route.fulfill({ response: res, json: rows });
      });
      await page.route("**/api/admin/stripe/summary", async route => {
        const res = await route.fetch();
        const body = (await res.json()) as { verification?: { mode: string } };
        if (switched && body.verification) body.verification.mode = "live";
        await route.fulfill({ response: res, json: body });
      });

      await expect(modeToggle).toHaveText(/Switch to Live Mode/);
      await modeToggle.click();
      await expect(modeChip, "PR276 R7: toggling should flip the Stripe Mode chip to LIVE").toHaveText("LIVE");
      await expect(modeToggle, "PR276 R7: the button should now offer Switch to Test Mode").toHaveText(
        /Switch to Test Mode/,
      );

      // PR276 R3: a page loaded in live mode badges the Plans header LIVE.
      await page.reload();
      const plansButton = page.getByRole("button", { name: /Plans from Stripe/i }).first();
      if (!(await page.getByTestId("plans-header").isVisible().catch(() => false))) await plansButton.click();
      await expect(page.getByTestId("plans-mode-badge"), "PR276 R3: in live mode the badge should read LIVE").toHaveText(
        "LIVE",
      );
      await expect(page.getByTestId("plans-header").getByText(/^TEST$/)).toHaveCount(0);
      await page.unrouteAll({ behavior: "wait" });
    });

    await test.step("a refused switch to live keeps TEST and shows the server's reason", async () => {
      await page.reload();
      await expect(modeChip).toHaveText("TEST", { timeout: 15_000 });
      // Every text the chip shows from here on, so a LIVE flash between the
      // click and the error counts even if it is gone by the time we look.
      await modeChip.evaluate(el => {
        const seen: string[] = [el.textContent ?? ""];
        (window as unknown as { __chipSeen: string[] }).__chipSeen = seen;
        new MutationObserver(() => seen.push(el.textContent ?? "")).observe(el, {
          childList: true,
          characterData: true,
          subtree: true,
        });
      });
      const patchResponse = page.waitForResponse(
        r => r.url().endsWith("/api/admin/config/stripe_live_mode") && r.request().method() === "PATCH",
      );
      await modeToggle.click();
      const patch = await patchResponse;
      expect(patch.ok(), "the fake Stripe should refuse a switch to live").toBe(false);
      const reason = ((await patch.json()) as { error?: string }).error ?? "";
      expect(reason, "the refusal should carry a reason").not.toBe("");

      const errorLine = page.getByText(reason);
      await expect(errorLine, "PR577 step 4: a red error should show the server's reason").toBeVisible();
      await expect(errorLine, "PR577 step 4: the refusal message should be red").toHaveClass(/text-destructive/);
      await expect(modeChip, "PR577 step 4: the chip should stay on TEST").toHaveText("TEST");
      await expect(page.getByText(/Failed to update/), "PR577 step 4: never the bare words Failed to update").toHaveCount(0);
      expect(
        await page.evaluate(() => (window as unknown as { __chipSeen: string[] }).__chipSeen),
        "PR577 step 4: the chip should never flip to LIVE while a failure is reported",
      ).not.toContain("LIVE");
    });

    await test.step("the Setup Checklist's environment-variable rows render with no errors", async () => {
      // The fake driver replaces the six per-mode rows with a one-line note, so
      // the summary is reported as the real driver's to render them; the
      // presence flags stay the server's own.
      await page.route("**/api/admin/stripe/summary", async route => {
        const res = await route.fetch();
        const body = (await res.json()) as { stripeDriver?: string };
        body.stripeDriver = "real";
        await route.fulfill({ response: res, json: body });
      });
      const pageErrors: string[] = [];
      const failedApiCalls: string[] = [];
      page.on("pageerror", err => pageErrors.push(err.message));
      page.on("response", r => {
        if (r.url().includes("/api/") && r.status() >= 400) failedApiCalls.push(`${r.status()} ${r.url()}`);
      });
      await page.reload();
      const checklistBody = page.getByText("Per-mode environment variables", { exact: true });
      if (!(await checklistBody.isVisible().catch(() => false))) {
        await page.getByRole("button", { name: /Setup Checklist/ }).click();
      }
      await expect(checklistBody, "PR577 R1: the Setup Checklist should open").toBeVisible({ timeout: 15_000 });
      for (const variable of [
        "STRIPE_SECRET_KEY_TEST",
        "STRIPE_SECRET_KEY_LIVE",
        "STRIPE_PUBLISHABLE_KEY_TEST",
        "STRIPE_PUBLISHABLE_KEY_LIVE",
        "STRIPE_WEBHOOK_SECRET_TEST",
        "STRIPE_WEBHOOK_SECRET_LIVE",
      ]) {
        const label = page.getByText(variable, { exact: true }).and(page.locator("span"));
        await expect(label, `PR577 R1: the ${variable} row should render`).toBeVisible();
        await expect(
          label.locator("xpath=preceding-sibling::span[1]/*[name()='svg']"),
          `PR577 R1: the ${variable} row should carry its checkmark`,
        ).toHaveCount(1);
      }
      expect(pageErrors, "PR577 R1: opening the checklist should raise no page error").toEqual([]);
      expect(failedApiCalls, "PR577 R1: opening the checklist should fail no API call").toEqual([]);
      await page.unrouteAll({ behavior: "wait" });
    });

    await test.step("the Setup Checklist's four rows, ticked for the fake catalog", async () => {
      await page.reload();
      const ticks = [
        ["Stripe credentials reachable (publishable key found)", null],
        ["Stripe products configured in dashboard", true],
        ["Membership prices available (monthly, annual, or legendary for life)", true],
        ["Webhook signing secret available (one of the per-mode env vars below)", null],
      ] as const;
      for (const [text, ticked] of ticks) {
        const label = page.getByText(text, { exact: true });
        await expect(label, `PR276 R6: the Setup Checklist row "${text}" should render`).toBeVisible({ timeout: 15_000 });
        if (ticked) {
          await expect(
            label.locator("xpath=preceding-sibling::span[1]"),
            `PR276 R6: "${text}" should be ticked for the fake catalog`,
          ).toHaveClass(/text-green-400/);
        }
      }
    });

    await context.close();
  });
});

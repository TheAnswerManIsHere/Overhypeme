/**
 * Queue Health dashboard — the admin-visible surface.
 *
 * Drained out of PR288's UAT document, where these were clicks. The backend
 * derivation behind this page is already unit-tested (queueHealth.test.ts);
 * what was never covered is whether any of it reaches the screen, which is
 * why the document still listed them for a human. Everything asserted here
 * needs only the app and a database — no Stripe, no object storage.
 *
 * Deliberately NOT asserted: exact ages ("last fire 2s ago") and timestamps,
 * which are wall-clock dependent, and any counts above zero, which would
 * make this depend on other tests' leavings. The shapes are asserted instead.
 */

import { expect, test, type Page } from "@playwright/test";

/** Every lane `runAsyncJobsWorker` registers (asyncJobs.ts ALL_LANES). */
const LANES = ["fast", "render", "bulk", "pexels", "ai_meme_backfill"] as const;

/**
 * Queues that exist by registration rather than by having run. PR288 step 6
 * is precisely that a never-run queue is listed rather than omitted, so these
 * are the rows that prove it on a fresh database.
 */
const NEVER_RUN_QUEUES = ["projection_repair", "fact_send_back", "image_generation"] as const;

async function gotoQueueHealth(page: Page) {
  const resp = await page.goto("/admin/queue-health", { waitUntil: "domcontentloaded" });
  expect(resp?.ok() ?? false, `/admin/queue-health should load 200, got ${resp?.status()}`).toBe(true);
  // The page fetches on mount; wait for the lanes section rather than a sleep.
  await expect(page.getByRole("heading", { name: /Worker lanes/i })).toBeVisible({ timeout: 30_000 });
}

test.describe("Admin · Queue Health", () => {
  test.beforeEach(async ({ context }) => {
    const login = await context.request.post("/api/auth/dev-admin-login");
    expect(login.ok(), `dev-admin-login should be 200, got ${login.status()}`).toBe(true);
  });

  // PR288 steps 1 and 2.
  test("shows one card per worker lane, each with its own liveness verdict", async ({ page }) => {
    await gotoQueueHealth(page);

    // Each lane is named once, in its own card.
    for (const lane of LANES) {
      await expect(
        page.getByText(lane, { exact: true }),
        `lane "${lane}" should be named on the page`,
      ).toBeVisible();
    }

    // Counted at page level rather than traversed from each card: the verdict
    // and the detail line are siblings inside the card, so a card-scoped
    // locator has to guess which ancestor is "the card". Counting proves the
    // same thing -- one verdict and one detail line per lane, no more -- and
    // does not depend on the markup's nesting.
    await expect(
      page.getByText(/^(Scheduling|Not scheduling)$/),
      "every lane should state whether it is being scheduled",
    ).toHaveCount(LANES.length);
    await expect(
      page.getByText(/live instances? · last fire .* ago · \d+ in flight/),
      "every lane should report instances, last fire and in-flight count",
    ).toHaveCount(LANES.length);
  });

  // PR288 step 3. The summary exists so a stalled lane is called out in words
  // rather than by colour alone; on a healthy stack it is the all-clear form.
  test("summarises lane liveness in words above the cards", async ({ page }) => {
    await gotoQueueHealth(page);
    await expect(page.getByText(/All five lanes are being scheduled\. Last checked /)).toBeVisible();
    await expect(page.getByText(/not being scheduled by any live worker/)).toHaveCount(0);
  });

  // PR288 steps 5 and 6.
  test("lists every registered queue, including ones that have never run", async ({ page }) => {
    await gotoQueueHealth(page);
    await expect(page.getByRole("heading", { name: /^Queues$/i })).toBeVisible();
    for (const queue of NEVER_RUN_QUEUES) {
      await expect(
        page.getByText(queue, { exact: true }),
        `queue "${queue}" should be listed even though it has never run`,
      ).toBeVisible();
    }
  });

  // PR288 R5 has route-level auth tests; this is the UI half — the console
  // reaches the page at all rather than the layout's Access Denied gate.
  test("renders inside the admin console for an admin", async ({ page }) => {
    await gotoQueueHealth(page);
    await expect(page.getByText(/Access Denied/i)).toHaveCount(0);
    await expect(page.getByRole("link", { name: /Queue Health/i }).first()).toBeVisible();
  });
});

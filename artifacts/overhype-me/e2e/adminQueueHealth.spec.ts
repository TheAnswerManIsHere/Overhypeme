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
 * EVERY queue the worker registers, not a sample. PR288 step 5 is that the
 * page lists every registered queue and step 6 that a never-run one still
 * appears -- and a spot-check of three cannot fail when a fourth silently
 * stops being rendered, which is the failure those steps exist to catch.
 *
 * Asserted as an exact set, so adding a queue breaks this test on purpose:
 * a new entry in the registry is a deliberate change and should require a
 * deliberate line here. (Codex, #563 round 5.)
 */
const REGISTERED_QUEUES = [
  "email",
  "enrichment",
  "fact_ai_meme_backfill",
  "fact_enrichment_backfill",
  "fact_pexels",
  "fact_send_back",
  "fact_visual_concepts",
  "image_generation",
  "image_prompt_generation",
  "projection_repair",
  "review_render_scenarios_prepare",
] as const;

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

    // Scoped to each lane's own card, NOT counted at page level. Page-level
    // totals of five verdicts and five detail lines stay five if one card
    // loses its verdict while another renders two -- which is exactly the
    // per-card invariant this test claims to check. (Codex, #563 round 5.)
    for (const lane of LANES) {
      const card = page
        .locator("div.bg-card")
        .filter({ has: page.getByText(lane, { exact: true }) });
      await expect(card, `lane "${lane}" should have exactly one card`).toHaveCount(1);
      // The HEALTHY verdict specifically, not "either verdict". Accepting both
      // meant an inverted card-level status passed while the aggregate summary
      // -- rendered independently, on another page load -- still read all-clear,
      // which is exactly the disagreement these two tests exist to catch.
      // (Codex, #563 round 6.)
      await expect(
        card.getByText(/^Scheduling$/),
        `lane "${lane}" should report Scheduling on a healthy stack`,
      ).toHaveCount(1);
      await expect(
        card.getByText(/^Not scheduling$/),
        `lane "${lane}" should not also carry the stalled verdict`,
      ).toHaveCount(0);
      // Anchored, and the instance count is part of the shape: the unanchored
      // form matched a substring and never checked that a number preceded
      // "live instance" at all.
      await expect(
        card.getByText(/^\d+ live instances? · last fire .+ ago · \d+ in flight$/),
        `lane "${lane}" should carry exactly one detail line`,
      ).toHaveCount(1);
    }
  });

  // PR288 step 3. The summary exists so a stalled lane is called out in words
  // rather than by colour alone; on a healthy stack it is the all-clear form.
  test("summarises lane liveness in words above the cards", async ({ page }) => {
    await gotoQueueHealth(page);
    const summary = page.getByText(/All five lanes are being scheduled\. Last checked .+/);
    await expect(summary).toBeVisible();
    await expect(page.getByText(/not being scheduled by any live worker/)).toHaveCount(0);

    // "Above the cards" is half the point -- the summary exists so the state is
    // readable before scanning five cards -- and the name claimed it while
    // nothing checked it. Asserted as real layout order.
    const firstCard = page
      .locator("div.bg-card")
      .filter({ has: page.getByText(LANES[0], { exact: true }) });
    const summaryBox = await summary.boundingBox();
    const cardBox = await firstCard.boundingBox();
    expect(summaryBox, "the summary should have a layout box").not.toBeNull();
    expect(cardBox, "the lane cards should have a layout box").not.toBeNull();
    expect(
      summaryBox!.y,
      `the summary (y=${summaryBox!.y}) should sit above the lane cards (y=${cardBox!.y})`,
    ).toBeLessThan(cardBox!.y);
  });

  // PR288 steps 5 and 6.
  test("lists every registered queue, including ones that have never run", async ({ page }) => {
    await gotoQueueHealth(page);
    await expect(page.getByRole("heading", { name: /^Queues$/i })).toBeVisible();

    // Every registered queue, and NOTHING BUT those: the count catches a row
    // disappearing, the names catch the wrong one disappearing. Each queue is
    // an expandable row, which is the only aria-expanded control on the page.
    const rows = page.locator("button[aria-expanded]");
    await expect(rows, "one row per registered queue, no more").toHaveCount(REGISTERED_QUEUES.length);
    for (const queue of REGISTERED_QUEUES) {
      // Scoped to the rows, and matched exactly. A page-level search would be
      // satisfied by the name appearing anywhere -- and "enrichment" is a
      // substring of "fact_enrichment_backfill", so a loose match would let one
      // row stand in for two.
      await expect(
        rows.filter({ has: page.getByText(queue, { exact: true }) }),
        `queue "${queue}" should have exactly one row`,
      ).toHaveCount(1);
    }

    // The "including ones that have never run" half of the name (PR288 step 6),
    // which nothing checked: a never-run queue is one whose counters are all
    // zero, and it must still be rendered rather than filtered out as empty.
    await expect(
      rows.filter({ hasText: /0 queued · 0 working · 0 done · 0 failed · 24h: 0 done \/ 0 failed/ }),
      "a queue that has never run should still be listed",
    ).not.toHaveCount(0);
  });

  // PR288 R5 has route-level auth tests; this is the UI half — the console
  // reaches the page at all rather than the layout's Access Denied gate.
  test("renders inside the admin console for an admin", async ({ page }) => {
    await gotoQueueHealth(page);
    await expect(page.getByText(/Access Denied/i)).toHaveCount(0);
    // Both halves: the console rail around it, AND the page's own heading. The
    // rail alone would still render if the page content failed entirely.
    await expect(page.getByRole("link", { name: /Queue Health/i }).first()).toBeVisible();
    await expect(page.getByRole("heading", { name: /^Queue Health$/i })).toBeVisible();
  });
});

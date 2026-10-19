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

import { expect, test, type Locator, type Page, type Route } from "@playwright/test";

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

const HEALTH_URL = /\/api\/admin\/queue-health(\?.*)?$/;
const JOBS_URL = /\/api\/admin\/queue-health\/jobs(\?.*)?$/;

/** A colour as the screen paints it, via a 1x1 canvas -- so oklch() and rgb() compare alike. */
async function paintedRgb(target: Locator, prop: "color" | "backgroundColor"): Promise<{ r: number; g: number; b: number }> {
  return target.evaluate((el, p) => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = getComputedStyle(el)[p];
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return { r, g, b };
  }, prop);
}

/** The clock time the page itself would print for a payload timestamp, in the browser's own locale. */
async function pageClockTime(page: Page, iso: string): Promise<string> {
  return page.evaluate((ts) => new Date(ts).toLocaleTimeString(), iso);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The sidebar as it stood before PR288, plus Queue Health directly after Email Queue. */
const SIDEBAR: [string, string][] = [
  ["Dashboard", "/admin"],
  ["Facts", "/admin/facts"],
  ["Users", "/admin/users"],
  ["Moderation", "/admin/moderation"],
  ["Eval", "/admin/eval"],
  ["Billing", "/admin/billing"],
  ["Refunds & Disputes", "/admin/refunds-disputes"],
  ["Affiliate", "/admin/affiliate"],
  ["Video Styles", "/admin/video-styles"],
  ["Engines", "/admin/engines"],
  ["Taxonomy Health", "/admin/taxonomy-health"],
  ["Email Queue", "/admin/email-queue"],
  ["Queue Health", "/admin/queue-health"],
  ["Features", "/admin/features"],
  ["Configuration", "/admin/config"],
  ["Help", "/admin/help"],
];

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

    // PR288 step 6 -- "including ones that have never run" -- is carried by the
    // inventory assertion above, not by a separate check. A page that derived
    // its rows from the jobs table rather than the registry would OMIT a queue
    // that has never run, and both the named row and the count of exactly
    // eleven would fail. So step 6 is already encoded.
    //
    // An earlier version of this test asserted a row with all-zero counters
    // directly. That added no coverage and one false-failure mode: it fails
    // CLOSED on any stack with retained jobs -- which TESTING.md:158-169
    // explicitly tells developers to run this suite against -- and it
    // contradicted this file's own header rule about not depending on other
    // tests' leavings. (Codex, #563 round 7.)
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

  // PR288 steps 1-6 and R4, then PR472 step 10 -- one visit on real server
  // state. The poll interval is measured while the other checks run.
  test("lanes, clock, polling, queue rows and sidebar, then the ? lands on chapter 12", async ({ page }) => {
    const polls: { at: number; ts: string }[] = [];
    page.on("response", async (res) => {
      if (new URL(res.url()).pathname !== "/api/admin/queue-health" || !res.ok()) return;
      const at = Date.now();
      polls.push({ at, ts: ((await res.json()) as { ts: string }).ts });
    });
    await gotoQueueHealth(page);
    await page.evaluate(() => { (window as unknown as { __e2eSameDocument?: boolean }).__e2eSameDocument = true; });
    const lanes = page.locator("section").filter({ has: page.getByRole("heading", { name: /Worker lanes/i }) });

    // Step 1: exactly five lane cards.
    await expect(lanes.locator("div.bg-card"), "PR288 step 1: Worker lanes should hold exactly five cards").toHaveCount(LANES.length);

    // Step 2: "Scheduling" is green -- painted, not just classed.
    const verdicts = lanes.getByText(/^Scheduling$/);
    await expect(verdicts).toHaveCount(LANES.length);
    for (let i = 0; i < LANES.length; i++) {
      const { r, g, b } = await paintedRgb(verdicts.nth(i), "color");
      expect(g > r + 40 && g > b + 40, `PR288 step 2: a Scheduling label should be green, painted rgb(${r},${g},${b})`).toBe(true);
    }

    // Step 3: "Last checked" is a clock time, not any text after it.
    const summary = lanes.getByText(/^All five lanes are being scheduled\./);
    await expect(summary, "PR288 step 3: Last checked should read as a clock time HH:MM:SS").toHaveText(
      /^All five lanes are being scheduled\. Last checked \d{1,2}:\d{2}:\d{2}( [AP]M)?\.$/,
    );

    // R4: every pre-existing item with its route, Queue Health right after Email Queue.
    const sidebar = await page.locator("aside nav").first().locator("a").evaluateAll((as) =>
      as.map((a) => [a.querySelector("span.flex-1")?.textContent ?? "", a.getAttribute("href") ?? ""]),
    );
    expect(sidebar, "PR288 R4: every sidebar item should be present with its route, Queue Health after Email Queue").toEqual(SIDEBAR);

    // Steps 5 and 6, row by row.
    const rows = await page.locator("button[aria-expanded]").evaluateAll((bs) =>
      bs.map((b) => ({
        queue: b.querySelector("span.font-mono")?.textContent ?? "",
        summary: (b.querySelector("span.text-muted-foreground")?.textContent ?? "").replace(/\s+/g, " ").trim(),
      })),
    );
    // A queue that has never run: the jobs endpoint holds nothing for it. The
    // e2e suite never drives most queues, so a fresh CI database always has some.
    const neverRun: string[] = [];
    for (const queue of REGISTERED_QUEUES) {
      const res = await page.request.get(`/api/admin/queue-health/jobs?queue=${queue}&limit=1`);
      if (((await res.json()) as { rows: unknown[] }).rows.length === 0) neverRun.push(queue);
    }
    expect(neverRun.length, "this database should hold at least one queue that has never run").toBeGreaterThan(0);
    for (const queue of neverRun) {
      expect(rows.map((r) => r.queue), `PR288 step 6: never-run queue "${queue}" should still appear in the list`).toContain(queue);
    }
    for (const row of rows) {
      expect(row.summary, `PR288 step 5: ${row.queue} should read N queued · N working · N done · N failed`).toMatch(
        /^\d+ queued · \d+ working · \d+ done · \d+ failed( · |$)/,
      );
      expect(row.summary, `PR288 step 5: ${row.queue} should end 24h: N done / N failed`).toMatch(/ · 24h: \d+ done \/ \d+ failed$/);
    }
    for (const queue of neverRun) {
      const summary = rows.find((r) => r.queue === queue)!.summary;
      expect(summary.match(/\S+ (queued|working|done|failed)/g), `PR288 step 6: never-run queue "${queue}" should show zeros`).toEqual(
        ["0 queued", "0 working", "0 done", "0 failed", "0 done", "0 failed"],
      );
    }

    // Step 4: a second fetch about five seconds after the first, and the
    // timestamp on screen moves with it -- all without a reload.
    // The mount can fetch twice in quick succession (React's dev double-effect),
    // so the interval is read from the first pair of fetches a second or more apart.
    const pollPair = () => {
      for (let i = 1; i < polls.length; i++) if (polls[i].at - polls[i - 1].at > 1_000) return [polls[i - 1], polls[i]];
      return null;
    };
    await expect
      .poll(() => pollPair() !== null, { message: "PR288 step 4: the page should poll again on its own", timeout: 9_000 })
      .toBe(true);
    const [prev, next] = pollPair()!;
    const gap = next.at - prev.at;
    expect(gap, `PR288 step 4: the poll should come about every 5 seconds (gap ${gap}ms)`).toBeGreaterThan(4_000);
    expect(gap, `PR288 step 4: the poll should come about every 5 seconds (gap ${gap}ms)`).toBeLessThan(7_000);
    const [first, second] = [await pageClockTime(page, prev.ts), await pageClockTime(page, next.ts)];
    expect(second, "PR288 step 4: the two polls should carry different times").not.toBe(first);
    await expect(summary, "PR288 step 4: Last checked should advance to the new poll's time").toHaveText(
      new RegExp(`Last checked ${escapeRegExp(second)}\\.$`),
    );
    expect(
      await page.evaluate(() => (window as unknown as { __e2eSameDocument?: boolean }).__e2eSameDocument === true),
      "PR288 step 4: the timestamp should advance with no page reload",
    ).toBe(true);

    // PR472 step 10: the ? beside View Site.
    const header = page.locator("main header");
    const help = header.getByTestId("admin-help-link");
    await expect(help, "PR472 step 10: the ? should sit in the top bar").toBeVisible();
    expect((await help.boundingBox())!.x, "PR472 step 10: the ? should sit beside View Site").toBeLessThan(
      (await header.getByText("View Site", { exact: true }).boundingBox())!.x,
    );
    await help.click();
    await expect
      .poll(() => new URL(page.url()).pathname, { message: "PR472 step 10: the ? on Queue Health should open chapter 12" })
      .toBe("/admin/help/12-background-work");
    const heading = page.locator("main article").getByRole("heading", { name: "Worker liveness and the Queue Health surface" });
    await expect(heading, "PR472 step 10: chapter 12 should render its Worker liveness heading").toBeVisible({ timeout: 30_000 });
    const parked = async () =>
      heading.evaluate((el) => {
        for (let n = el.parentElement; n; n = n.parentElement) {
          const style = getComputedStyle(n);
          if (/(auto|scroll)/.test(style.overflowY) && n.scrollHeight > n.clientHeight + 4) {
            return { scrollTop: n.scrollTop, offset: el.getBoundingClientRect().top - n.getBoundingClientRect().top };
          }
        }
        return { scrollTop: window.scrollY, offset: el.getBoundingClientRect().top };
      });
    await expect
      .poll(async () => (await parked()).scrollTop, { message: "PR472 step 10: chapter 12 should be scrolled to the heading, not at its top" })
      .toBeGreaterThan(0);
    await expect
      .poll(async () => (await parked()).offset, { message: "PR472 step 10: the Worker liveness heading should be parked at the top" })
      .toBeLessThan(64);
  });

  // PR288 steps 5 (the conditional counts) and 7-9. Stubbed: a job in every
  // state -- one mid-run, one skipped, one given up on -- cannot be produced
  // on demand on a stack with no AI and no failing vendor. The queue summary is
  // the server's own payload with one row's counts raised; the jobs are a fixed list.
  test("a queue row shows its conditional counts, expands to labelled jobs, and collapses again", async ({ page }) => {
    const QUEUE = "image_generation";
    await page.route(HEALTH_URL, async (route: Route) => {
      if (new URL(route.request().url()).pathname !== "/api/admin/queue-health") return route.continue();
      const res = await route.fetch();
      const body = (await res.json()) as { queues: Record<string, unknown>[] };
      for (const q of body.queues) {
        if (q.queue === QUEUE) Object.assign(q, { pending: 1, skipped: 2, abandonedNoRetry: 1, oldestPendingAgeSeconds: 125 });
      }
      await route.fulfill({ response: res, json: body });
    });
    const job = (id: number, displayStatus: string, extra: Record<string, unknown> = {}) => ({
      id, queue: QUEUE, status: displayStatus, displayStatus, skipReason: null, attempts: 1, effectiveMaxAttempts: 3,
      lastError: null, nextAttemptAt: "2026-10-01T12:00:00.000Z", createdAt: "2026-10-01T12:00:00.000Z",
      updatedAt: "2026-10-01T12:00:00.000Z", ...extra,
    });
    const JOBS = [
      job(9001, "pending", { attempts: 0 }),
      job(9002, "processing"),
      job(9003, "done"),
      job(9004, "failed", { attempts: 2, lastError: "upstream timed out" }),
      job(9005, "skipped", { skipReason: "fact inactive" }),
      job(9006, "abandoned_no_retry", { attempts: 3, lastError: "content policy refusal" }),
    ];
    await page.route(JOBS_URL, (route) => route.fulfill({ json: { rows: JOBS } }));

    await gotoQueueHealth(page);
    const row = page.locator("button[aria-expanded]").filter({ has: page.getByText(QUEUE, { exact: true }) });

    // Step 5: skipped, no-more-retries and oldest age when they apply...
    await expect(row, "PR288 step 5: skipped, no-more-retries and oldest age should show when they apply").toContainText(
      " · 2 skipped · 1 no more retries · oldest 2m · 24h: ",
    );
    // ...and not when they do not.
    await expect(
      page.locator("button[aria-expanded]").filter({ hasText: /skipped|no more retries|oldest/ }),
      "PR288 step 5: rows with none of them should not show them",
    ).toHaveCount(1);

    // Step 7: expand to individual jobs -- id, state, attempts, error.
    await row.click();
    await expect(row, "PR288 step 7: the row should expand").toHaveAttribute("aria-expanded", "true");
    const panel = row.locator("xpath=following-sibling::div[1]");
    const failed = panel.locator("div").filter({ hasText: "#9004" });
    await expect(failed.getByText("#9004", { exact: true }), "PR288 step 7: a job should show its id").toBeVisible();
    await expect(failed.getByText("2/3", { exact: true }), "PR288 step 7: a job should show its attempt count").toBeVisible();
    await expect(failed.getByText("upstream timed out"), "PR288 step 7: a job should show its error").toBeVisible();
    await expect(failed.getByText(/^Failed$/), "PR288 step 7: a job should show its state").toBeVisible();

    // Step 9: every state is a word, Working spins, Skipped carries its reason.
    const badges = panel.locator("span.inline-flex");
    await expect(badges, "PR288 step 9: each job state should be a labelled badge").toHaveText([
      "Queued", "Working", "Done", "Failed", "Skipped(fact inactive)", "Failed — no more retries",
    ]);
    const spin = await badges.nth(1).locator("svg").evaluate((el) => getComputedStyle(el).animationName);
    expect(spin, "PR288 step 9: the Working badge should spin").not.toBe("none");

    // Step 8: a second click collapses it.
    await row.click();
    await expect(row, "PR288 step 8: a second click should collapse the row").toHaveAttribute("aria-expanded", "false");
    await expect(page.getByText("#9004", { exact: true }), "PR288 step 8: the collapsed row should hide its jobs").toHaveCount(0);
  });

  // PR288 steps 12 and 10. The first response is held, to see the loading
  // state, then answered with a failure -- the API being down is not something
  // this stack can do to itself while still serving the page.
  test("first load shows skeleton bars, then a failure says so in words", async ({ page }) => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    await page.route(HEALTH_URL, async (route) => {
      if (new URL(route.request().url()).pathname !== "/api/admin/queue-health") return route.continue();
      await held;
      await route.fulfill({ status: 503, json: { error: "Service Unavailable" } });
    });
    const resp = await page.goto("/admin/queue-health", { waitUntil: "domcontentloaded" });
    expect(resp?.ok() ?? false).toBe(true);

    // Step 12: five grey bars, no spinner.
    const bars = page.locator('main [aria-busy="true"] > div');
    await expect(bars, "PR288 step 12: the first load should show five skeleton bars").toHaveCount(5, { timeout: 30_000 });
    for (let i = 0; i < 5; i++) {
      const { r, g, b } = await paintedRgb(bars.nth(i), "backgroundColor");
      expect(Math.max(r, g, b) - Math.min(r, g, b), `PR288 step 12: skeleton bar ${i + 1} should be grey, painted rgb(${r},${g},${b})`).toBeLessThan(20);
    }
    await expect(page.locator("main .animate-spin"), "PR288 step 12: the loading state should not be a spinner").toHaveCount(0);

    release();
    await expect(page.locator('main [aria-busy="true"]'), "the first load should settle").toHaveCount(0, { timeout: 30_000 });

    // Step 10: nothing that reads as healthy...
    await expect(page.getByText(/^Scheduling$/), "PR288 step 10: no green Scheduling cards on a failed load").toHaveCount(0);
    await expect(page.getByText(/All five lanes are being scheduled|No queue has pending/), "PR288 step 10: no all-healthy text on a failed load").toHaveCount(0);
    await expect(page.getByRole("heading", { name: /Worker lanes/i }), "PR288 step 10: no empty lanes section on a failed load").toHaveCount(0);
    // ...and the explicit failure in its place.
    await expect(page.getByText("Could not load queue health"), "PR288 step 10: the red panel should say Could not load queue health").toBeVisible();
    await expect(
      page.getByText(/This is not the same as the queues being healthy — we were unable to ask\./),
      "PR288 step 10: the panel should say this is not the same as healthy",
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Retry" }), "PR288 step 10: the panel should offer Retry").toBeVisible();
    const { r, g, b } = await paintedRgb(page.getByText("Could not load queue health"), "color");
    expect(r > g + 40 && r > b + 40, `PR288 step 10: the failure should be red, painted rgb(${r},${g},${b})`).toBe(true);
  });

  // PR288 step 11. A fake clock drives the 5 s poll; the failures are stubbed
  // for the same reason as above, the recovery is the real server again.
  test("a failed poll keeps the data on screen, says it is stale, and recovers on its own", async ({ page }) => {
    await page.clock.install();
    let failing = false;
    let failedPolls = 0;
    let loadedTs = "";
    await page.route(HEALTH_URL, async (route) => {
      if (new URL(route.request().url()).pathname !== "/api/admin/queue-health") return route.continue();
      if (failing) {
        failedPolls++;
        return route.fulfill({ status: 503, json: { error: "Service Unavailable" } });
      }
      const res = await route.fetch();
      loadedTs = ((await res.json()) as { ts: string }).ts;
      return route.fulfill({ response: res });
    });
    await gotoQueueHealth(page);
    await page.evaluate(() => { (window as unknown as { __e2eSameDocument?: boolean }).__e2eSameDocument = true; });
    const queueRows = page.locator("button[aria-expanded]");
    await expect(queueRows).toHaveCount(REGISTERED_QUEUES.length);
    const shownTs = loadedTs;

    failing = true;
    await page.clock.runFor(5_000);
    const banner = page.getByText(/the last refresh failed and we are still retrying/);
    // Settle on whichever the page did with the failure, then check each half.
    await expect(banner.or(page.getByText("Could not load queue health"))).toBeVisible();
    // The numbers stay.
    await expect(queueRows, "PR288 step 11: the queue rows should stay on screen after a failed poll").toHaveCount(REGISTERED_QUEUES.length);
    await expect(page.locator("div.bg-card").filter({ hasText: /live instances? ·/ }), "PR288 step 11: the lane cards should stay too").toHaveCount(LANES.length);
    await expect(banner, "PR288 step 11: a failed poll should raise the stale-data banner").toBeVisible();
    // The banner's own words, with the time of the data still shown.
    await expect(banner.locator("xpath=.."), "PR288 step 11: the amber banner should read as the step words it").toHaveText(
      new RegExp(
        `^Showing data from ${escapeRegExp(await pageClockTime(page, shownTs))} — the last refresh failed and we are still retrying\\. These numbers are not current\\.$`,
      ),
    );
    const { r, g, b } = await paintedRgb(banner.locator("xpath=.."), "backgroundColor");
    expect(r > b + 20 && g > b, `PR288 step 11: the banner should be amber, painted rgb(${r},${g},${b})`).toBe(true);

    // It keeps retrying while the API is down...
    const before = failedPolls;
    await page.clock.runFor(5_000);
    await expect.poll(() => failedPolls, { message: "PR288 step 11: the page should keep retrying" }).toBeGreaterThan(before);
    // ...and recovers on its own when it returns, with no reload and no ask to refresh.
    failing = false;
    await page.clock.runFor(5_000);
    await expect(banner, "PR288 step 11: the banner should clear once the API returns").toHaveCount(0);
    await expect(queueRows).toHaveCount(REGISTERED_QUEUES.length);
    expect(
      await page.evaluate(() => (window as unknown as { __e2eSameDocument?: boolean }).__e2eSameDocument === true),
      "PR288 step 11: recovery should happen with no page reload",
    ).toBe(true);
    await expect(page.getByText(/refresh the page|reload/i), "PR288 step 11: the page should never ask for a refresh").toHaveCount(0);
  });
});

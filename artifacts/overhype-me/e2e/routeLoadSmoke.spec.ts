/**
 * Dev route-load smoke test — the regression net for the crash/reload-loop
 * bug class (see docs/ai-context/known-failure-patterns.md →
 * "Self-retriggering recovery with no bounded exit").
 *
 * What this guards:
 *   The July 2026 crash loop was two infra bugs neither safety net caught:
 *     - a lazy-route chunk failing to load (Vite dev server flapping under an
 *       esbuild OS-thread panic on heavy admin deps), and
 *     - `lazyWithRetry` turning that into an infinite `window.location.reload()`
 *       loop, sometimes settling into the Sentry "Something broke" boundary.
 *   Neither diff review nor product-testing exercises "does every route
 *   actually load in the dev server without looping or erroring." This does.
 *
 * For each heavy route it asserts, against the running dev server:
 *   1. The navigation is served (no 5xx).
 *   2. The lazy chunk actually resolved — the route rendered real content, not
 *      the empty Suspense fallback (`<div aria-busy="true">`).
 *   3. No reload loop — the page does not keep issuing full document loads
 *      after it settles (this is the direct `lazyWithRetry`-loop detector).
 *   4. No Sentry error boundary ("Something broke").
 *   5. No dynamic-import failure surfaced to the console / as a page error
 *      ("Failed to fetch dynamically imported module" and friends).
 *
 * If someone regresses `vite.config.ts` optimizeDeps (dropping recharts /
 * lucide-react back to on-demand), loading /admin/moderation will again trip
 * the esbuild burst and this test fails on assertions 1–2. If someone weakens
 * the `lazyWithRetry` cooldown, assertion 3 fails.
 *
 * Prereqs to run (same shape as the other e2e specs):
 *   1. Both dev workflows up:
 *        - artifacts/api-server: API Server  (port 8080, proxied via /api)
 *        - artifacts/overhype-me: web         (Vite dev server)
 *   2. Chromium installed once: `pnpm exec playwright install chromium`
 *   3. Run: `pnpm --filter @workspace/overhype-me run e2e:smoke`
 *
 * Auth: same dev-only bypass the other specs use — `POST /api/auth/dev-admin-login`
 * sets the `sid` session cookie so the admin routes render past the AdminLayout
 * gate instead of "Access Denied".
 */

import { expect, test, type Page } from "@playwright/test";

interface SmokeRoute {
  path: string;
  name: string;
  /** Admin routes render inside AdminLayout and require the admin session. */
  admin: boolean;
}

/**
 * The heavy routes that matter for this bug class. The admin pages import
 * recharts (a forest of d3-* subpackages) and lucide-react (thousands of icon
 * modules) — exactly the on-demand-transform burst that panicked esbuild.
 * /admin/moderation is the specific page the incident was reported on.
 */
const ROUTES: SmokeRoute[] = [
  { path: "/", name: "Home", admin: false },
  { path: "/top-facts", name: "Top Facts", admin: false },
  { path: "/admin/moderation", name: "Admin · Moderation", admin: true },
  { path: "/admin/facts", name: "Admin · Facts", admin: true },
  { path: "/admin/billing", name: "Admin · Billing", admin: true },
  { path: "/admin/taxonomy-health", name: "Admin · Taxonomy Health", admin: true },
  { path: "/admin/eval", name: "Admin · Eval Dashboard", admin: true },
  // Help carries the largest generated payload in the console (the manual is
  // ~160 KB of prose across 13 dynamically-imported chunks), so it is exactly
  // the shape that trips the lazy-chunk failure class this spec guards.
  { path: "/admin/help", name: "Admin · Help", admin: true },
  { path: "/admin/help/11-admin-console", name: "Admin · Help chapter", admin: true },
];

/** Console / pageerror strings that mean a lazy chunk failed to load. */
const DYNAMIC_IMPORT_FAILURE =
  /failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed|unable to preload/i;

/**
 * Attaches listeners that record any dynamic-import failure surfaced either as
 * a console error or an uncaught page error. Returns a live array of matches.
 */
function collectChunkFailures(page: Page): string[] {
  const failures: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error" && DYNAMIC_IMPORT_FAILURE.test(msg.text())) {
      failures.push(`console: ${msg.text()}`);
    }
  });
  page.on("pageerror", (err) => {
    if (DYNAMIC_IMPORT_FAILURE.test(err.message)) {
      failures.push(`pageerror: ${err.message}`);
    }
  });
  return failures;
}

test.describe("Route-load smoke — no crash/reload loop, no error boundary", () => {
  test.beforeEach(async ({ context }) => {
    // Authenticate as admin so the admin routes render their real content
    // rather than the AdminLayout "Access Denied" gate.
    const loginRes = await context.request.post("/api/auth/dev-admin-login");
    expect(
      loginRes.ok(),
      `dev-admin-login should be 200, got ${loginRes.status()}`,
    ).toBe(true);
  });

  for (const route of ROUTES) {
    test(`${route.name} (${route.path}) loads without looping or erroring`, async ({ page }) => {
      const chunkFailures = collectChunkFailures(page);

      // Count full document loads. The initial navigation fires one; a
      // lazyWithRetry reload loop fires many. SPA client-side navigation does
      // NOT fire 'load', so this only ever counts real full-page (re)loads.
      let loadCount = 0;
      page.on("load", () => { loadCount += 1; });

      // 1. The navigation itself must be served (the SPA index; the route is
      //    then client-rendered). A 5xx here means the dev server is down.
      const resp = await page.goto(route.path, { waitUntil: "domcontentloaded" });
      expect(
        resp?.status() ?? 0,
        `${route.path} should be served, got HTTP ${resp?.status()}`,
      ).toBeLessThan(400);

      // 4. No Sentry error boundary. Check early and again after settling.
      await expect(
        page.getByText("Something broke"),
        `${route.path} hit the Sentry error boundary`,
      ).toHaveCount(0);

      // 2. The lazy chunk resolved and the route rendered real content — not
      //    the empty Suspense fallback (`<div aria-busy="true">` has no text).
      //    For admin routes, the AdminLayout <nav> is the stable signal and
      //    "Access Denied" must be absent.
      if (route.admin) {
        await expect(
          page.locator("nav").first(),
          `${route.path} should render the AdminLayout nav`,
        ).toBeVisible({ timeout: 20_000 });
        await expect(
          page.getByText("Access Denied"),
          `${route.path} should be authorized (admin session)`,
        ).toHaveCount(0);
      }
      await expect
        .poll(async () => (await page.locator("body").innerText()).trim().length, {
          timeout: 20_000,
          message: `${route.path} rendered no content — likely stuck in the Suspense fallback (chunk never loaded)`,
        })
        .toBeGreaterThan(20);

      // 3. Reload-loop detector: sample the load count, wait, and assert no
      //    NEW full loads happened in the observation window. A settled page
      //    stays flat; an active lazyWithRetry loop keeps incrementing at its
      //    ~1.3s cadence. (Tolerates a single legitimate settling reload by
      //    only requiring *stability*, not loadCount === 1.)
      const settledLoads = loadCount;
      await page.waitForTimeout(4_000);
      expect(
        loadCount,
        `${route.path} kept reloading (${settledLoads} → ${loadCount} full loads in 4s) — reload loop not contained`,
      ).toBe(settledLoads);

      // 4 (again) + 5. No error boundary appeared while we watched, and no
      //    dynamic-import failure was ever surfaced.
      await expect(
        page.getByText("Something broke"),
        `${route.path} fell into the Sentry error boundary after settling`,
      ).toHaveCount(0);
      expect(
        chunkFailures,
        `${route.path} surfaced dynamic-import failures:\n${chunkFailures.join("\n")}`,
      ).toEqual([]);
    });
  }
});

// ── #631 7b — the Facts page and the fact lifecycle (PR228, PR242) ──────────
//
// The dev stack's database holds no live fact and cannot make one: going live
// takes the AI prep pipeline, and a staging fact's prep never finishes with no
// AI key. So the facts these tests open are stubbed reads, and their writes
// are answered by `stubFactWrites` the way `routes/admin.ts` answers them (the
// approved-text lock's 409, the staging restart, the resubmit). Bulk import is
// the exception: it runs against the real server.
import type { Route } from "@playwright/test";
import { adminFactRow, enrichmentWithConcept, stubAdminFacts, type AdminFactRow } from "./helpers/adminStubs";

const APPROVED_TEXT_PHRASE = "CHANGE APPROVED FACT TEXT";

interface TextEditEntry {
  id: number;
  oldText: string;
  newText: string;
  reason: string;
  createdAt: string;
  actor: { id: string; name: string | null; email: string | null };
}

function fulfill(route: Route, body: unknown, status = 200): Promise<void> {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

/**
 * Answers the Facts editor's writes for stubbed facts as the server does:
 * a text change on a live fact is refused with the confirmation 409 until the
 * phrase and a reason come with it, then stored and audited; a staging fact's
 * text saves at once and restarts prep. Rows are mutated in place, so the
 * stubbed list reads back what was saved. Register after `stubAdminFacts`.
 */
async function stubFactWrites(page: Page, rows: AdminFactRow[], stagingIds: number[] = []) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const history = new Map<number, TextEditEntry[]>();
  const patches: { id: number; body: Record<string, unknown> }[] = [];
  await page.route(/\/api\/admin\/facts\/(\d+)(\/[a-z-]+)?(\?.*)?$/, async (route) => {
    const req = route.request();
    const m = /\/api\/admin\/facts\/(\d+)(\/[a-z-]+)?$/.exec(new URL(req.url()).pathname)!;
    const row = byId.get(Number(m[1]));
    if (!row) return route.fallback();
    const sub = m[2] ?? "";
    const method = req.method();
    if (method === "GET" && sub === "/text-edit-history") {
      const entries = [...(history.get(row.id) ?? [])].reverse();
      return fulfill(route, { entries, total: entries.length, limit: 20, offset: 0 });
    }
    if (method === "PATCH" && sub === "/enrichment") {
      const body = req.postDataJSON() as { enrichment: unknown };
      return fulfill(route, { success: true, enrichment: body.enrichment });
    }
    if (method === "POST" && sub === "/variants") return fulfill(route, { success: true, queued: true, reviewId: 4241 }, 201);
    if (method === "POST" && sub === "/resubmit-for-moderation") {
      return fulfill(route, { success: true, workflowStage: "prep_pending", reviewId: 4242, factId: row.id });
    }
    if (method !== "PATCH" || sub !== "") return route.fallback();

    const body = req.postDataJSON() as Record<string, unknown>;
    patches.push({ id: row.id, body });
    const { text, confirmTextEdit, ...rest } = body as { text?: string; confirmTextEdit?: { reason: string } };
    Object.assign(row, rest, { parentId: row.parentId });
    const proposed = text?.trim();
    if (proposed === undefined || proposed === row.text) return fulfill(route, { success: true, fact: row });
    if (stagingIds.includes(row.id)) {
      row.text = proposed;
      const prepDispatch = { factId: row.id, enrichment: { status: "pending", inserted: false }, pexels: { status: "pending", inserted: false } };
      return fulfill(route, { success: true, prepDispatch, fact: row });
    }
    if (!confirmTextEdit) {
      return fulfill(route, {
        error: "This fact is approved — editing its text needs explicit confirmation.",
        code: "TEXT_EDIT_REQUIRES_CONFIRMATION",
        impact: {
          protected: true, protectionReason: "active", currentStoredText: row.text, normalizedProposedText: proposed,
          expectedOldTextHash: `stub-${row.id}`, persistedMemeCount: 0, liveMemeCount: 0, refreshInFlight: false,
        },
      }, 409);
    }
    const entries = history.get(row.id) ?? [];
    entries.push({
      id: entries.length + 1, oldText: row.text, newText: proposed, reason: confirmTextEdit.reason,
      createdAt: new Date().toISOString(), actor: { id: "dev-admin", name: "Dev Admin", email: null },
    });
    history.set(row.id, entries);
    row.text = proposed;
    return fulfill(route, { success: true, auditRowId: entries.length, fact: row });
  });
  return { patches, history };
}

/** A CSS property as a Tailwind class resolves it on this page, read through a probe element. */
async function classValue(page: Page, className: string, property: "color" | "borderTopColor"): Promise<string> {
  return page.evaluate(([cls, prop]) => {
    const probe = document.createElement("div");
    probe.className = cls;
    document.body.appendChild(probe);
    const value = getComputedStyle(probe)[prop as "color"];
    probe.remove();
    return value;
  }, [className, property] as const);
}

async function selectFact(page: Page, id: number, text: string): Promise<void> {
  await page.getByText(text, { exact: true }).first().click();
  await expect(page.getByText(`Edit Fact #${id}`, { exact: true })).toBeVisible();
}

/** A fact's wording as the Facts list shows it (the list row, not the edit box). */
function listedText(page: Page, text: string) {
  const exact = new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
  return page.locator("p.line-clamp-2").filter({ hasText: exact });
}

function factTextBox(page: Page) {
  return page.getByText("Text", { exact: true }).locator("xpath=following-sibling::textarea");
}

test.describe("7b — Facts page and fact lifecycle (PR228, PR242)", () => {
  test.beforeEach(async ({ context, page }) => {
    const login = await context.request.post("/api/auth/dev-admin-login");
    expect(login.ok(), `dev-admin-login should be 200, got ${login.status()}`).toBe(true);
    await page.setViewportSize({ width: 1280, height: 900 });
  });

  // The import test's reviews are rejected afterwards, pass or fail: a pending
  // review shows as a count on the sidebar's Moderation entry, which later specs
  // read against this same database.
  let importMarker: string | null = null;
  test.afterEach(async ({ context }) => {
    if (!importMarker) return;
    const marker = importMarker;
    importMarker = null;
    const csrf = (await context.cookies()).find((c) => c.name === "csrf_token")?.value ?? "";
    const queue = await context.request.get("/api/admin/reviews?status=pending&limit=100");
    const { reviews } = (await queue.json()) as { reviews: { id: number; submittedText: string }[] };
    for (const review of reviews.filter((r) => r.submittedText.includes(marker))) {
      const res = await context.request.post(`/api/admin/reviews/${review.id}/reject`, {
        headers: { "x-csrf-token": csrf },
        data: { rejectionReason: "lame", adminNote: "e2e cleanup" },
      });
      expect(res.ok(), `cleanup: rejecting the imported review #${review.id}`).toBe(true);
    }
  });

  test("PR228 1, 6, 7, 9 — a live fact's text change opens the red-bordered modal; Cancel keeps the draft; Confirm saves and records it", async ({ page }) => {
    const OLD = "{NAME} w1 bench-presses the moon.";
    const NEW = "{NAME} w1 bench-presses the moon twice.";
    const REASON = "the approved wording undersold the feat";
    const row = adminFactRow({ id: 96101, text: OLD });
    await stubAdminFacts(page, [{ row, enrichment: enrichmentWithConcept("{NAME} lifts the moon overhead.") }]);
    const server = await stubFactWrites(page, [row]);

    await page.goto("/admin/facts");
    await selectFact(page, 96101, OLD);
    await factTextBox(page).fill(NEW);
    await page.getByRole("button", { name: "Save Changes" }).click();

    // Step 1: the modal, red-bordered — not a silent save, not a Save failed error.
    const modal = page.getByTestId("approved-fact-text-edit-modal");
    await expect(modal.getByRole("heading", { name: "Change approved fact text" }), "PR228 step 1: the Change approved fact text modal appears").toBeVisible();
    const red = await classValue(page, "border border-destructive/40", "borderTopColor");
    expect(red, "the destructive border token should differ from the plain border").not.toBe(await classValue(page, "border border-border", "borderTopColor"));
    await expect(modal.locator(":scope > div"), "PR228 step 1: the modal is red-bordered").toHaveCSS("border-top-color", red);
    await expect(page.getByText(/save failed/i), "PR228 step 1: not a generic Save failed error").toHaveCount(0);
    await expect(page.getByText("Saved successfully.", { exact: true }), "PR228 step 1: not a silent save").toHaveCount(0);

    // Step 9: Cancel closes the modal, saves nothing, keeps the edited text.
    await modal.getByRole("button", { name: "Cancel" }).click();
    await expect(modal, "PR228 step 9: Cancel closes the modal").toHaveCount(0);
    await page.waitForLoadState("networkidle");
    await expect(listedText(page, OLD), "PR228 step 9: nothing is saved — the list keeps the stored wording").toBeVisible();
    expect(server.patches.filter((p) => p.body["confirmTextEdit"]), "PR228 step 9: nothing is saved — no confirmed save was sent").toHaveLength(0);
    await expect(factTextBox(page), "PR228 step 9: the edited text is still in the box").toHaveValue(NEW);

    // Step 6: confirming saves it — the modal closes, a green Saved shows, the fact reads the new wording.
    await page.getByRole("button", { name: "Save Changes" }).click();
    await modal.getByTestId("approved-fact-text-edit-phrase").fill(APPROVED_TEXT_PHRASE);
    await modal.getByTestId("approved-fact-text-edit-reason").fill(REASON);
    await modal.getByTestId("approved-fact-text-edit-confirm").click();
    const saved = page.getByText("Saved successfully.", { exact: true });
    await expect(saved, "PR228 step 6: a Saved confirmation shows").toBeVisible();
    await expect(saved, "PR228 step 6: the Saved confirmation is green").toHaveCSS("color", await classValue(page, "text-green-400", "color"));
    await expect(modal, "PR228 step 6: the modal closes").toHaveCount(0);
    await expect(listedText(page, NEW), "PR228 step 6: the fact now displays the new wording").toBeVisible();
    await expect(listedText(page, OLD), "PR228 step 6: the old wording is gone from the list").toHaveCount(0);

    // Step 7: the expanded history lists who, when, old → new and the reason.
    await page.getByTestId("fact-text-edit-history-toggle").click();
    const entry = page.getByTestId("fact-text-edit-history-toggle").locator("xpath=..").locator("li").first();
    const when = await page.evaluate((iso) => new Date(iso).toLocaleString(), server.history.get(96101)![0]!.createdAt);
    await expect(entry.getByText("Dev Admin", { exact: true }), "PR228 step 7: the entry names who made the edit").toBeVisible();
    await expect(entry.getByText(when, { exact: true }), "PR228 step 7: the entry shows when").toBeVisible();
    await expect(entry.getByText(OLD, { exact: true }), "PR228 step 7: the entry shows the old wording").toHaveCSS("text-decoration-line", "line-through");
    await expect(entry.getByText(`→ ${NEW}`, { exact: true }), "PR228 step 7: the entry shows the new wording").toBeVisible();
    await expect(entry.getByText(`Reason: ${REASON}`, { exact: true }), "PR228 step 7: the entry shows the reason typed").toBeVisible();
  });

  test("PR228 8, R4, 10 — saves that change no approved text open no modal; a staging fact's text saves with Prep restarted", async ({ page }) => {
    const LIVE = "{NAME} w1 outran the sunrise.";
    const STAGING = "{NAME} w1 taught gravity to sit.";
    const STAGING_EDIT = "{NAME} w1 taught gravity to sit and stay.";
    const live = adminFactRow({ id: 96201, text: LIVE });
    const staging = adminFactRow({ id: 96202, text: STAGING, isActive: false });
    await stubAdminFacts(page, [
      { row: live, enrichment: enrichmentWithConcept("{NAME} sprints past the rising sun.") },
      { row: staging, enrichment: enrichmentWithConcept("{NAME} points at a falling apple.") },
    ]);
    const server = await stubFactWrites(page, [live, staging], [96202]);
    const modal = page.getByTestId("approved-fact-text-edit-modal");

    await page.goto("/admin/facts");
    await selectFact(page, 96201, LIVE);

    // Step 8: a non-text edit saves at once, with no warning modal.
    await page.getByPlaceholder("e.g. one_line, meme_caption…").fill("one_line");
    await page.getByRole("button", { name: "Save Changes" }).click();
    await expect(page.getByText("Saved successfully.", { exact: true }), "PR228 step 8: the non-text edit saves").toBeVisible();
    await expect(modal, "PR228 step 8: no warning modal appears for a save that changes no text").toHaveCount(0);
    expect(server.patches.at(-1)?.body, "PR228 step 8: the save sends no text").not.toHaveProperty("text");

    // R4: saving the enrichment editor saves plainly, with no text modal.
    const panel = page.getByTestId("fact-enrichment-panel");
    await panel.getByRole("button", { name: /visual taxonomy enrichment/i }).click();
    await expect(panel.getByTestId("visual-concept-card")).toBeVisible();
    await panel.getByPlaceholder("Add hashtag…").fill("w1tag");
    await panel.getByRole("button", { name: "Add", exact: true }).last().click();
    await panel.getByRole("button", { name: "Save enrichment" }).click();
    await expect(panel.getByText("Saved to server", { exact: true }), "PR228 R4: the enrichment save shows Saved to server").toBeVisible();
    await expect(modal, "PR228 R4: no text modal appears for an enrichment save").toHaveCount(0);

    // Step 10: a never-approved staging fact's text saves at once and restarts prep.
    await selectFact(page, 96202, STAGING);
    await factTextBox(page).fill(STAGING_EDIT);
    await page.getByRole("button", { name: "Save Changes" }).click();
    const message = page.getByText(/^Saved\./);
    await expect(message).toBeVisible();
    await expect(listedText(page, STAGING_EDIT), "PR228 step 10: it just saves — the list reads the new wording").toBeVisible();
    await expect(message, "PR228 step 10: the message notes that prep is restarting").toHaveText(/^Saved\. Prep restarted/);
    await expect(modal, "PR228 step 10: the staging fact's text save opens no dire-warning modal").toHaveCount(0);
  });

  test("PR242 5, 6, 9, 10, 13 — a variant is queued not published; Resubmit shows on inactive facts and Send Back on active ones", async ({ page }) => {
    const ROOT = "{NAME} w1 juggles thunderstorms.";
    const INACTIVE = "{NAME} w1 once out-stared a glacier.";
    const VARIANT = "{NAME} w1 juggles thunderstorms one-handed.";
    const root = adminFactRow({ id: 96301, text: ROOT });
    const inactive = adminFactRow({ id: 96302, text: INACTIVE, isActive: false });
    await stubAdminFacts(page, [
      { row: root, enrichment: enrichmentWithConcept("{NAME} tosses three storm clouds.") },
      { row: inactive, enrichment: enrichmentWithConcept("{NAME} glares at an iceberg.") },
    ]);
    await stubFactWrites(page, [root, inactive]);

    await page.goto("/admin/facts");
    await selectFact(page, 96301, ROOT);

    // Steps 13 and 9: an active fact shows Send Back to Review, and no Resubmit.
    await expect(page.getByTestId("send-back-button"), "PR242 steps 9/13: an active fact shows Send Back to Review").toHaveText("Send Back to Review");
    await expect(page.getByTestId("resubmit-for-moderation-button"), "PR242 step 13: no Resubmit for Moderation button on an active fact").toHaveCount(0);

    // Step 5: adding a variant queues it — the alert says so and nothing appears yet.
    await page.getByRole("button", { name: "Add variant" }).click();
    await page.getByPlaceholder("Variant text…").fill(VARIANT);
    let alertText = "";
    page.once("dialog", (d) => { alertText = d.message(); void d.accept(); });
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await expect.poll(() => alertText, { message: "PR242 step 5: an alert follows the save" }).not.toBe("");
    expect(alertText, "PR242 step 5: the alert reads Variant queued for review").toMatch(
      /^Variant queued for review\. It'll appear under this fact once it's approved through moderation\./,
    );
    await expect(page.getByText("Variants (0)", { exact: true }), "PR242 step 5: the variant does not appear instantly").toBeVisible();
    await expect(page.getByText(VARIANT, { exact: true }), "PR242 step 5: the variant text is nowhere on the page").toHaveCount(0);
    await expect(page.getByRole("button", { name: "Expand variants" }), "PR242 step 6: not nested under the parent before approval").toHaveCount(0);

    // Steps 9 and 10: an inactive fact shows Resubmit for Moderation, and resubmitting names the review and Stage 1.
    await selectFact(page, 96302, INACTIVE);
    const resubmit = page.getByTestId("resubmit-for-moderation-button");
    await expect(resubmit, "PR242 step 9: an inactive fact shows a Resubmit for Moderation button").toHaveText("Resubmit for Moderation");
    await expect(page.getByTestId("send-back-button"), "PR242 step 9: Send Back to Review is not offered on an inactive fact").toHaveCount(0);

    // Step 7: the editor refuses the toggle itself and says why, so no false→true save can be sent.
    const activeToggle = page.getByTitle("Deactivated — re-moderate to reactivate");
    await expect(activeToggle, "PR242 step 7: toggling an inactive fact Active is refused").toBeDisabled();
    await expect(
      page.getByText("Deactivated facts can only go live again through moderation.", { exact: true }),
      "PR242 step 7: the refusal says activation is through moderation",
    ).toBeVisible();
    await resubmit.click();
    await expect(
      page.getByText(/^Resubmitted for moderation/),
      "PR242 step 10: the message reads Resubmitted for moderation — Review #… is back in the queue at Stage 1",
    ).toHaveText(/^Resubmitted for moderation — Review #4242 is back in the queue at Stage 1\./);

    // Step 6: once approved, the variant is listed nested under its parent row.
    root.variants = [adminFactRow({ id: 96303, text: VARIANT, parentId: 96301 })];
    await page.reload();
    await page.getByRole("button", { name: "Expand variants" }).click();
    const variantRow = page.locator("div.cursor-pointer").filter({ hasText: VARIANT });
    await expect(variantRow, "PR242 step 6: after approval the variant appears nested under its parent").toContainText("variant");
    await expect(variantRow, "PR242 step 6: the nested row is indented under the parent").toHaveClass(/pl-10/);
  });

  test("PR242 2, 3 — a bulk import is queued for moderation, never imported, and stays out of the live Facts list", async ({ page }) => {
    const stamp = Date.now();
    importMarker = `w1 import ${stamp}`;
    const [A, B, C] = ["folds the ocean", "naps through earthquakes", "alphabetised the stars"].map(
      (feat) => `{NAME} w1 import ${stamp} ${feat}.`,
    );
    await page.goto("/admin/facts");
    await page.locator("main").getByRole("button", { name: "Utilities", exact: true }).click();
    const box = page.getByPlaceholder(/can sneeze with their eyes open/);
    const result = page.getByText(/fact\(s\)/);

    await box.fill([A, B].join("\n"));
    await page.getByRole("button", { name: "Import Facts" }).click();
    await expect(result).toBeVisible();
    await expect(result, "PR242 step 2: the import message does not say imported").not.toHaveText(/imported/i);
    await expect(result, "PR242 step 2: the message reads Queued N fact(s) for moderation").toHaveText(
      "Queued 2 fact(s) for moderation. They'll appear after review.",
    );

    await box.fill([A, C].join("\n"));
    await page.getByRole("button", { name: "Import Facts" }).click();
    await expect(result, "PR242 step 2: a re-import notes the duplicates it skipped").toHaveText(
      "Queued 1 fact(s) for moderation (1 skipped as duplicates). They'll appear after review.",
    );
    await expect(result, "PR242 step 2: the import message does not say imported").not.toHaveText(/imported/i);

    // Step 3: the imported text is not in the live (active) Facts list.
    await page.locator("main").getByRole("button", { name: "Facts", exact: true }).click();
    const listed = page.waitForResponse((r) => r.url().includes("/api/admin/facts?") && r.url().includes("search="));
    await page.getByPlaceholder("Search facts…").fill(A);
    expect((await listed).ok()).toBe(true);
    await expect(page.getByText("Loading…", { exact: true })).toHaveCount(0);
    await expect(listedText(page, A), "PR242 step 3: the imported fact does not appear in the live fact list").toHaveCount(0);
    await expect(page.getByText("No facts found.", { exact: true }), "PR242 step 3: the live list has nothing for the imported text").toBeVisible();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #631 increment 7b: the admin screens in regular use, asserted in the terms
// their UAT steps use. Each test names the steps it answers. State is set up
// through the real API as the dev admin; the only stubs are the grace-sweep
// status (whose Healthy / amber / drifted states a fresh stack cannot honestly
// reach) and one injected Email Queue row (a real job would need an email
// send), each said where it is made.
// ─────────────────────────────────────────────────────────────────────────────

import { FREE_ACCOUNT, PAID_ACCOUNT, csrfToken } from "./helpers/testAccounts";

/**
 * Records every /api/ response status and how many /api/ requests are still in
 * flight, windowed per navigation: `begin()` before each `goto` opens a route's
 * window, so a route is judged only on its own responses and cannot borrow an
 * earlier route's.
 */
function trackApi(page: Page) {
  const responses: { url: string; status: number }[] = [];
  let inFlight = 0;
  let mark = 0;
  const isApi = (url: string) => new URL(url).pathname.startsWith("/api/");
  page.on("request", (r) => { if (isApi(r.url())) inFlight += 1; });
  page.on("requestfinished", (r) => { if (isApi(r.url())) inFlight -= 1; });
  page.on("requestfailed", (r) => { if (isApi(r.url())) inFlight -= 1; });
  page.on("response", (r) => { if (isApi(r.url())) responses.push({ url: r.url(), status: r.status() }); });
  const mine = () => responses.slice(mark);
  return {
    begin: () => { mark = responses.length; },
    /**
     * Waits until this route has answered at least one API call and nothing has
     * been in flight across three consecutive polls — a single zero can be the
     * gap before the page's effects issue their fetches — or a 429 arrived,
     * which a client may retry forever.
     */
    settled: () => {
      let quiet = 0;
      return expect
        .poll(() => {
          if (mine().some((r) => r.status === 429)) return true;
          quiet = inFlight === 0 && mine().length > 0 ? quiet + 1 : 0;
          return quiet >= 3;
        }, { timeout: 30_000, intervals: [250], message: "this route's API requests never started, or never settled" })
        .toBe(true);
    },
    throttled: () => mine().filter((r) => r.status === 429).map((r) => r.url),
  };
}

/** PR425 R7: an admin screen renders inside the AdminLayout, authorized, with no error boundary. */
async function expectAdminScreen(page: Page, path: string) {
  await page.goto(path, { waitUntil: "domcontentloaded" });
  await expect(page.locator("nav").first(), `PR425 R7: ${path} should render the AdminLayout nav`).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "Access Denied" }), `PR425 R7: ${path} should be authorized`).toHaveCount(0);
  await expect
    .poll(async () => (await page.locator("main").innerText()).trim().length, { message: `PR425 R7: ${path} rendered no content` })
    .toBeGreaterThan(20);
  await expect(page.getByText("Something broke"), `PR425 R7: ${path} hit the error boundary`).toHaveCount(0);
}

test.describe("7b — admin screens in regular use (PR287, PR288, PR293, PR308, PR425)", () => {
  // PR425 R1, PR308 step 1 and R2. Deliberately NOT signed in: the smoke above
  // signs in as admin before every route, so it never sees what a visitor sees.
  test("logged out, the ordinary and feed routes load with no sign-in wall, no 429 and no redirect", async ({ page }) => {
    const api = trackApi(page);
    for (const path of ["/", "/top-facts", "/library"]) {
      api.begin();
      await page.goto(path, { waitUntil: "domcontentloaded" });
      if (path === "/") {
        await expect(page.getByText("For you").first(), "PR425 R1: / should render the real feed for a logged-out visitor").toBeVisible({ timeout: 20_000 });
        await expect(page.getByPlaceholder("Enter your password"), "PR425 R1: / should not put a sign-in wall in front of a logged-out visitor").toHaveCount(0);
      }
      await expect
        .poll(async () => (await page.locator("body").innerText()).trim().length, { message: `${path} rendered no content` })
        .toBeGreaterThan(20);
      await api.settled();
      expect(api.throttled(), `PR308 step 1 / R2: no API response while loading ${path} should be a 429`).toEqual([]);
      expect(new URL(page.url()).pathname, `PR308 step 1: ${path} should stay on its own address`).toBe(path);
    }
  });

  // PR308 step 3 and R6.
  test("the admin moderation and taxonomy-health screens load with no API response answered 429", async ({ page, context }) => {
    expect((await context.request.post("/api/auth/dev-admin-login")).ok()).toBe(true);
    const api = trackApi(page);
    for (const path of ["/admin/moderation", "/admin/taxonomy-health"]) {
      api.begin();
      await page.goto(path, { waitUntil: "domcontentloaded" });
      await expect(page.locator("nav").first(), `${path} should render the AdminLayout nav`).toBeVisible({ timeout: 20_000 });
      await api.settled();
      expect(api.throttled(), `PR308 step 3 / R6: no API response while ${path} loads should be a 429`).toEqual([]);
    }
  });

  // PR287 steps 6, 8, 23 and R8, and PR425 R7 for Users. The grant is read on
  // the seeded paid account; the revoke runs on a user this test creates (and
  // deletes), never on the seeded one the other suites depend on.
  test("Users shows each tier, an admin grant as a grant, creates a Legendary user, and keeps a revoked grant", async ({ page, context }) => {
    expect((await context.request.post("/api/auth/dev-admin-login")).ok()).toBe(true);
    await expectAdminScreen(page, "/admin/users");
    const adminName = String((await (await context.request.get("/api/auth/user")).json()).user.displayName ?? "");
    expect(adminName, "the dev admin needs a display name for its grant label").not.toBe("");

    const row = (email: string) => page.locator("div.cursor-pointer").filter({ hasText: email });
    await page.getByPlaceholder("Search name, email, or ID…").fill("e2e-");
    const paidRow = row(PAID_ACCOUNT.email);
    const freeRow = row(FREE_ACCOUNT.email);
    await expect(paidRow.locator('[aria-label="Legendary"]'), "PR287 step 23: the paid account's row should show the Legendary icon").toBeVisible();
    await expect(paidRow.locator('[aria-label="Registered"]'), "PR287 step 23: ...and not the Registered one").toHaveCount(0);
    await expect(freeRow.locator('[aria-label="Registered"]'), "PR287 step 23: the free account's row should show the Registered icon").toBeVisible();
    await expect(freeRow.locator('[aria-label="Legendary"]'), "PR287 step 23: ...and not the Legendary one").toHaveCount(0);

    const panel = page.locator("div.rounded-sm.overflow-hidden").filter({ hasText: "Membership Status" });
    const lifetime = panel.locator("div").filter({ has: page.getByText("Legendary for Life", { exact: true }) }).last();

    // PR287 step 6 — the seeded grant reads as a grant: who and why, no amount, no payment id.
    await paidRow.click();
    await expect(lifetime.getByText(/^Granted /), "PR287 step 6: the paid account's lifetime row should read Granted").toBeVisible();
    await expect(panel.locator('a[title="Open payment in Stripe"]'), "PR287 step 6: an admin grant shows no payment-intent link").toHaveCount(0);
    await expect(panel, "PR287 step 6: an admin grant shows no amount").not.toContainText(/[$£€]\s?\d|\d\.\d{2}\s?(USD|GBP|EUR)/i);
    await expect(lifetime.getByText(`(admin: ${adminName})`), "PR287 step 6: the grant names who granted it").toBeVisible();
    await expect(
      lifetime.getByText("“E2E paid test account (seeded by scripts/seed-e2e-test-accounts.ts)”"),
      "PR287 step 6: the grant shows why, quoted",
    ).toBeVisible();

    // PR287 R8 — the create-user form submits and the new user appears in the list.
    const email = `e2e-7b-${Date.now()}@example.test`;
    let createdId: string | null = null;
    try {
      await page.getByRole("button", { name: "Add User" }).click();
      const modal = page.locator("div.max-w-md").filter({ has: page.getByRole("heading", { name: "Add User" }) });
      await modal.getByPlaceholder("Name inserted into personalized facts (e.g. Alex Smith)").fill("E2E 7b Created");
      await modal.getByPlaceholder("user@example.com").fill(email);
      await modal.getByPlaceholder("Min. 8 characters").fill("e2e-7b-password");
      await modal.getByRole("button", { name: "Legendary" }).click();
      const created = page.waitForResponse((r) => r.url().endsWith("/api/admin/users") && r.request().method() === "POST");
      await modal.getByRole("button", { name: "Create User" }).click();
      const createdRes = await created;
      if (createdRes.ok()) createdId = String((await createdRes.json()).user.id);
      await expect(modal, "PR287 R8: the form should close once the user is created").toHaveCount(0);
      await expect(row(email), "PR287 R8: the new user should appear in the list").toBeVisible();

      // PR287 step 8 — revoke that user's grant; the row stays, marked revoked, naming who revoked it.
      await row(email).click();
      await expect(lifetime.getByText(/^Granted /)).toBeVisible();
      await panel.getByRole("button", { name: "Revoke" }).click();
      await expect(lifetime.getByText(/^Revoked grant /), "PR287 step 8: the revoked grant should still be listed, marked Revoked grant").toBeVisible();
      await expect(
        lifetime.getByText(new RegExp(`^Revoked \\S+ by ${adminName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)),
        "PR287 step 8: the revoked grant should name who revoked it",
      ).toBeVisible();
    } finally {
      if (createdId) {
        const del = await context.request.delete(`/api/admin/users/${createdId}?hard=true`, {
          headers: { "X-CSRF-Token": await csrfToken(page) },
        });
        expect(del.ok(), `cleanup: hard-deleting ${email} -> ${del.status()}`).toBe(true);
      }
    }
  });

  // PR287 steps 30-34, and PR425 R7 for Refunds & Disputes. The first status
  // read is the real server's (a clean database: nobody pending). The later
  // ones are stubbed, because a fresh stack has never swept and cannot honestly
  // be made Healthy, stale or drifting; each is delivered by the strip's own
  // 30-second poll on a fake clock, which is what step 32 is about.
  test("the Refunds & Disputes convergence strip reads each state honestly and refreshes itself", async ({ page, context }) => {
    expect((await context.request.post("/api/auth/dev-admin-login")).ok()).toBe(true);
    const base = {
      intervalSeconds: 3600, alertAfterSeconds: 21600, lastRunAt: null, lastSuccessAt: null,
      lastConvergedCount: null, lastError: null, consecutiveFailures: 0,
    };
    const drifted = { id: "e2e-drift", email: "drifted@example.test", storedTier: "legendary", effectiveTier: "registered" };
    const stubbed = [
      { health: { ...base, staleSeconds: 300, alerting: false, neverRun: true, neverSucceeded: true }, drifted: [], driftedCount: 0, driftedTruncated: false },
      { health: { ...base, staleSeconds: 120, alerting: false, neverRun: false, neverSucceeded: false, lastRunAt: "2026-10-01T12:00:00.000Z", lastSuccessAt: "2026-10-01T12:00:00.000Z", lastConvergedCount: 0 }, drifted: [], driftedCount: 0, driftedTruncated: false },
      { health: { ...base, staleSeconds: 7 * 3600, alerting: true, neverRun: false, neverSucceeded: false, consecutiveFailures: 7 }, drifted: [drifted], driftedCount: 1, driftedTruncated: false },
    ];
    let reads = 0;
    await page.route("**/api/admin/membership/grace-sweep", async (route) => {
      reads += 1;
      if (reads === 1) return route.fulfill({ response: await route.fetch() });
      return route.fulfill({ json: stubbed[Math.min(reads - 2, stubbed.length - 1)] });
    });
    let loads = 0;
    page.on("load", () => { loads += 1; });
    await page.clock.install();
    await expectAdminScreen(page, "/admin/refunds-disputes");

    const strip = page.locator("div.bg-card").filter({ has: page.getByText("Membership grace sweep", { exact: true }) });
    const status = strip.locator("span").nth(1);
    const grey = strip.getByText(/^every /);
    const amber = await page.evaluate(() => {
      const probe = document.createElement("span");
      probe.style.color = "var(--color-amber-500)";
      document.body.appendChild(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    });

    // PR287 step 33, the normal case — read from the real server.
    await expect(strip.getByText("No users pending convergence", { exact: true }), "PR287 step 33: a clean database reads No users pending convergence").toBeVisible();

    // PR287 step 31 — right after a deploy: honest, never Healthy. Delivered by the poll (step 32).
    await page.clock.runFor(30_000);
    await expect.poll(() => reads, { message: "PR287 step 32: the strip should refetch its status on its own after 30 s" }).toBe(2);
    await expect(status, "PR287 step 31: before any sweep the strip reads Not yet run · waiting Nm since start").toHaveText("Not yet run · waiting 5m since start");
    await expect(strip.getByText(/Healthy/), "PR287 step 31: ...and never Healthy").toHaveCount(0);

    // PR287 step 30 — healthy is grey, not alarming. Also delivered by the poll.
    await page.clock.runFor(30_000);
    await expect.poll(() => reads, { message: "PR287 step 32: ...and again 30 s later" }).toBe(3);
    await expect(status, "PR287 step 30: after a sweep the strip reads Healthy · last converged N ago").toHaveText("Healthy · last converged 2m ago");
    const greyColor = await grey.evaluate((el) => getComputedStyle(el).color);
    expect(greyColor, "the grey reference should not itself be amber").not.toBe(amber);
    await expect(status, "PR287 step 30: Healthy is grey text").toHaveCSS("color", greyColor);
    expect(loads, "PR287 step 32: the strip refreshed without the page reloading").toBe(1);

    // PR287 steps 33 (lagging) and 34 — amber, drifting, and access still correct.
    await page.clock.runFor(30_000);
    await expect(strip.getByText("1 user pending convergence", { exact: true }), "PR287 step 33: a lagging user is counted").toBeVisible();
    await expect(status, "PR287 step 34: the amber strip says stored tiers are drifting").toHaveText("Failing for 7h — stored tiers are drifting");
    await expect(status, "PR287 step 34: ...in amber").toHaveCSS("color", amber);
    await expect(
      strip.getByText("Their stored tier is stale; access is already enforced correctly on every request."),
      "PR287 step 34: the strip says access is still correct",
    ).toBeVisible();
  });

  // PR293 step 4, R1 and R2, and PR425 R7 for Configuration. Two unrelated,
  // harmless keys are edited and saved through the page, read back after a
  // reload, and set back to the value found — the set-back is a real write too.
  test("Configuration lists every existing key, and saving ordinary keys persists each value", async ({ page, context }) => {
    expect((await context.request.post("/api/auth/dev-admin-login")).ok()).toBe(true);
    // Every collapsible section open, so every key the page renders is in the DOM.
    await page.addInitScript(() => {
      for (const k of ["budget", "limits", "email", "zazzle", "moderation", "ai_group", "ai_style_prompts", "ai_gen_limits"]) {
        try { localStorage.setItem(`admin_section_config_${k}`, "1"); } catch { /* storage off: the key checks then fail loudly */ }
      }
    });
    const rowsRes = await context.request.get("/api/admin/config");
    expect(rowsRes.ok()).toBe(true);
    const rows = (await rowsRes.json()) as { key: string; value: string }[];
    // Keys the page deliberately shows elsewhere (Billing) or as the debug toggle.
    const elsewhere = new Set(["debug_mode_active", "stripe_live_mode", "fal_active_endpoints", "pricing_refresh_interval_ms"]);
    const expected = rows.map((r) => r.key).filter((k) => !elsewhere.has(k) && !k.startsWith("style_suffix_"));
    expect(expected.length, "the config table should hold keys for this check to mean anything").toBeGreaterThan(20);

    await expectAdminScreen(page, "/admin/config");
    await expect(page.getByRole("heading", { name: /^Debug Mode (ON|OFF)$/ }), "PR293 R1: /admin/config loads normally").toBeVisible();
    await expect(page.getByText("Loading configuration…"), "PR293 R1: ...past its loading state").toHaveCount(0);
    const shown = await page.locator("code").allInnerTexts();
    expect(expected.filter((k) => !shown.includes(k)), "PR293 R1: every existing key should still be present on the page").toEqual([]);

    const card = (key: string) => page.locator("div.bg-card.rounded-lg.p-5").filter({ has: page.locator("code", { hasText: new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) }) });
    const edits = [
      { key: "share_copy_twitter_hashtags", field: (k: string) => card(k).locator("textarea").first(), next: (v: string) => `${v},e2e7b` },
      { key: "rate_limit_counters.purge_batch_size", field: (k: string) => card(k).locator("input").first(), next: (v: string) => String(Number(v) + 1) },
    ];
    const original = new Map(rows.map((r) => [r.key, r.value]));
    try {
      for (const e of edits) {
        const field = e.field(e.key);
        await field.fill(e.next(original.get(e.key)!));
        const saved = page.waitForResponse((r) => r.url().endsWith(`/api/admin/config/${e.key}`) && r.request().method() === "PATCH");
        await card(e.key).getByRole("button", { name: "Save" }).first().click();
        expect((await saved).status(), `PR293 R2: saving ${e.key} should succeed`).toBe(200);
        await expect(card(e.key).getByRole("button", { name: "Saved" }), `PR293 R2: ${e.key} should show Saved`).toBeVisible();
      }
      await page.reload({ waitUntil: "domcontentloaded" });
      for (const e of edits) {
        await expect(e.field(e.key), `PR293 step 4: ${e.key} should still hold the saved value after a reload`).toHaveValue(e.next(original.get(e.key)!));
      }
    } finally {
      for (const e of edits) {
        const res = await context.request.patch(`/api/admin/config/${e.key}`, {
          headers: { "X-CSRF-Token": await csrfToken(page) },
          data: { value: original.get(e.key) },
        });
        expect(res.ok(), `cleanup: restoring ${e.key} -> ${res.status()}`).toBe(true);
      }
    }
  });

  // PR288 R1, and PR425 R7 for Email Queue and Engines. The queue's list read
  // goes to the real server, which must answer 200; one job is appended to its
  // answer because a real one needs an email send, which this stack must not make.
  test("Email Queue loads and lists its jobs with no error, and Engines loads", async ({ page, context }) => {
    expect((await context.request.post("/api/auth/dev-admin-login")).ok()).toBe(true);
    const job = {
      id: 987001, to: "e2e-7b-queue@example.test", subject: "E2E 7b queued job", text: "body", html: null,
      kind: "e2e", status: "pending", attempts: 0, maxAttempts: 5, lastError: null,
      nextAttemptAt: "2026-10-01T12:00:00.000Z", createdAt: "2026-10-01T12:00:00.000Z", updatedAt: "2026-10-01T12:00:00.000Z",
    };
    const realStatuses: number[] = [];
    await page.route(/\/api\/admin\/email-queue\?/, async (route) => {
      const real = await route.fetch();
      realStatuses.push(real.status());
      if (!real.ok()) return route.fulfill({ response: real });
      const body = await real.json();
      return route.fulfill({ response: real, json: { ...body, rows: [job, ...body.rows], total: body.total + 1 } });
    });
    await expectAdminScreen(page, "/admin/email-queue");
    await expect(page.getByText(job.subject).filter({ visible: true }), "PR288 R1: the Email Queue should list its jobs").toBeVisible();
    expect(realStatuses.length, "the list should have been read from the real server").toBeGreaterThan(0);
    expect(realStatuses.every((s) => s === 200), `PR288 R1: the real list read should succeed, got ${realStatuses.join(",")}`).toBe(true);
    await expect(page.locator("div.bg-destructive\\/10"), "PR288 R1: the Email Queue should show no error").toHaveCount(0);
    await expect(page.getByText("Email queue failed to render"), "PR288 R1: ...and not its render-error panel").toHaveCount(0);

    await expectAdminScreen(page, "/admin/engines");
  });
});

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

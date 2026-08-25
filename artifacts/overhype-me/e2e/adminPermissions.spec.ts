/**
 * Admin permissions core — the two properties PR425 exists to guarantee.
 *
 * Drained out of PR425's UAT document, where these were clicks. #562's triage
 * left 20 items after CI coverage; these are the 7 of those 20 that a browser
 * can genuinely assert with only the app and a database. The other 13 need a
 * fixture this stack does not have — a Legendary or plain-registered login
 * (`dev-admin-login` only ever mints the one bootstrap admin), a fact row (the
 * `facts` table is empty in CI; `seedIfEmpty()` is never called), or a real
 * photo upload through object storage — and stay manual.
 *
 * Covered here:
 *   - steps 6, 7  — Exit Admin leaves admin mode, and the way back stays visible
 *   - step  8     — /admin while previewing explains itself instead of refusing
 *   - step  9     — Resume admin restores the console
 *   - steps 1-3   — the Admin grid row grants a capability the account's own
 *                   tier does not, and revoking it takes the capability away
 *
 * Deliberately NOT asserted, so the names do not outrun the assertions:
 *   - Steps 1-3 name `custom_avatar`, observed on Profile's Photo pill. That
 *     pill only renders for an account with a `profileImageUrl`, which needs
 *     object storage. This file proves the same MECHANISM on a different
 *     feature key (`fact_submit_captcha_bypass`); `custom_avatar`'s own wiring
 *     is not covered here.
 *   - Step 6's "the site reloads as a registered user would see it" is only
 *     covered for the admin console (step 8's test). There is no admin
 *     affordance in the site chrome to assert against, and the Legendary-feature
 *     half is steps 10/12, which need a fact and a photo.
 *   - Steps 22/23's downstream refusal (video generation) needs the builder;
 *     and their real bug was re-seeding on server RESTART, which a browser
 *     cannot exercise at all.
 *
 * Two rules this file is written to, both learned on #563:
 *   1. Every assertion here was falsified before it was trusted — mutated,
 *      watched go red, restored. Note for whoever repeats that: inverting a
 *      `toBeVisible` into `toHaveCount(0)` or `toBeHidden` proves NOTHING here,
 *      because both are satisfied by a page that has not rendered yet and pass
 *      on the first poll. The four visibility assertions were falsified by
 *      breaking their locators instead, which is the product failure they
 *      actually guard: the affordance is missing from the page.
 *   2. No assertion depends on database state. Where a grid value matters the
 *      test SETS it first rather than assuming the migration's default, so a
 *      dev stack with a previously-toggled grid does not fail this closed.
 */

import { expect, test, type Page } from "@playwright/test";

/**
 * The feature this file uses to observe the resolver. Chosen because its gated
 * surface (`/submit`) needs no fixtures at all, unlike every other entitlement
 * whose UI needs a fact row or a stored photo.
 */
const FEATURE = "fact_submit_captcha_bypass";

/** The seeded admin's STORED tier — the whole point is that it is not `admin`. */
const STORED_TIER = "registered";

async function loginAsAdmin(page: Page) {
  const login = await page.context().request.post("/api/auth/dev-admin-login");
  expect(login.ok(), `dev-admin-login should be 200, got ${login.status()}`).toBe(true);
}

/** The SPA sends this on every mutation (main.tsx wraps fetch); APIRequestContext does not. */
async function csrfToken(page: Page): Promise<string> {
  const cookie = (await page.context().cookies()).find((c) => c.name === "csrf_token");
  expect(cookie?.value, "a csrf_token cookie should have been issued").toBeTruthy();
  return cookie!.value;
}

/**
 * Sets one grid cell through the same route the admin console uses. Used to
 * ESTABLISH preconditions and to restore afterwards — never to stand in for the
 * UI click that the test itself is about.
 */
async function setGridCell(page: Page, tier: string, featureKey: string, enabled: boolean) {
  const res = await page.context().request.patch("/api/admin/feature-flags", {
    headers: { "X-CSRF-Token": await csrfToken(page) },
    data: { tier, featureKey, enabled },
  });
  expect(res.ok(), `PATCH feature-flags ${featureKey}/${tier}=${enabled} -> ${res.status()}`).toBe(true);
}

/**
 * Turns preview mode ON, asserting the resulting state rather than assuming it.
 * `toggle-admin-mode` is a pure toggle, so a blind call is only deterministic
 * because `dev-admin-login` mints a FRESH session (admin mode on) every time —
 * the response is checked so a change to that stops being silent.
 */
async function enterPreviewMode(page: Page) {
  const res = await page.context().request.post("/api/auth/toggle-admin-mode", {
    headers: { "X-CSRF-Token": await csrfToken(page) },
  });
  expect(res.ok(), `toggle-admin-mode should be 200, got ${res.status()}`).toBe(true);
  expect(
    (await res.json()).adminModeActive,
    "the session should now be previewing as a user",
  ).toBe(false);
}

/** The admin console's rail — present on every /admin/* page that renders. */
function consoleRail(page: Page) {
  return page.getByRole("link", { name: /Queue Health/i }).first();
}

test.describe("Admin · permissions core", () => {
  test.beforeEach(async ({ page }) => loginAsAdmin(page));

  // PR425 steps 6 and 7. Both directions in one test on purpose: a page that
  // rendered BOTH buttons, or neither, is the failure these two steps exist to
  // catch, and either would satisfy a one-sided check.
  test("Exit Admin leaves admin mode, and the way back is always visible", async ({ page }) => {
    await page.goto("/profile", { waitUntil: "domcontentloaded" });

    const exit = page.getByRole("button", { name: /Exit Admin/i });
    const resume = page.getByRole("button", { name: /Resume Admin/i });

    await expect(exit, "an admin in admin mode should be offered the way out").toBeVisible({ timeout: 30_000 });
    await expect(resume, "...and not simultaneously the way back in").toHaveCount(0);

    await exit.click();

    // Step 7 is the anti-lockout property: before PR425 every entry point was
    // hidden once you left, so this asserts the way back EXISTS, not merely
    // that the way out stopped rendering.
    await expect(resume, "leaving admin mode must leave a way back").toBeVisible({ timeout: 30_000 });
    await expect(exit, "...and the way out should be gone").toHaveCount(0);
  });

  // PR425 step 8 — and step 11, which asks the same question of the same
  // screen ("admin console access ignores the preview toggle") and is
  // therefore already encoded by this test rather than needing its own.
  test("/admin while previewing explains the state instead of refusing", async ({ page }) => {
    await enterPreviewMode(page);
    await page.goto("/admin", { waitUntil: "domcontentloaded" });

    await expect(
      page.getByRole("heading", { name: "Viewing as a user" }),
      "the preview panel should explain the state",
    ).toBeVisible({ timeout: 30_000 });

    // THE regression this step exists for. "Access Denied" is the worst thing
    // to tell someone who still has access and just cannot see it.
    await expect(
      page.getByText("Access Denied"),
      "a real admin previewing as a user must never be told they are denied",
    ).toHaveCount(0);

    // The way out has to be a working control, not just prose. Asserted as
    // enabled, because a disabled button would render identically to a reader
    // of this test and strand the same person.
    const resume = page.getByTestId("admin-resume");
    await expect(resume).toBeVisible();
    await expect(resume).toBeEnabled();

    // A second, independent way back — the panel offers it and it is the only
    // exit if the button ever regresses.
    await expect(
      page.locator('a[href="/"]').filter({ hasText: /Back to site/i }),
      "the panel should also offer a link back to the site",
    ).toHaveCount(1);

    // The panel REPLACES the console rather than rendering alongside it. Without
    // this, a page showing both would pass every assertion above.
    await expect(consoleRail(page), "the console itself should be hidden while previewing").toHaveCount(0);
  });

  // PR425 step 9.
  test("Resume admin restores the console", async ({ page }) => {
    await enterPreviewMode(page);
    await page.goto("/admin", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("admin-resume")).toBeVisible({ timeout: 30_000 });

    await page.getByTestId("admin-resume").click();

    // The click triggers a full reload, so gate on the console arriving rather
    // than on a timeout — both halves, since the panel disappearing during the
    // blank moment mid-reload would satisfy the absence check on its own.
    await expect(consoleRail(page), "the admin console should render again").toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("heading", { name: "Viewing as a user" })).toHaveCount(0);
    await expect(page.getByText("Access Denied")).toHaveCount(0);
  });

  /**
   * PR425 steps 1, 2 and 3 — the headline. Before this PR the Admin column
   * rendered and nothing read it.
   *
   * The account's stored tier is `registered`, for which this feature is OFF,
   * so a granted capability can only have come from the Admin row. That premise
   * is asserted rather than assumed: without it, the captcha being hidden would
   * not distinguish "granted by the Admin row" from "granted by the tier", and
   * the test would prove nothing about the column at all.
   *
   * The revoke and the restore are done by CLICKING the Features screen, which
   * is the other half of the PR ("the Features screen is now real"). Only the
   * initial precondition is set through the API.
   */
  test("the Admin grid row grants a capability the account's own tier does not", async ({ page }) => {
    await expandFeatureGrid(page);
    await setGridCell(page, "admin", FEATURE, true);

    // Premise, checked in the browser: stored tier is `registered`, and the
    // capability is nonetheless granted.
    const before = await readAuthState(page);
    expect(before.membershipTier, "the seeded admin's STORED tier").toBe(STORED_TIER);
    expect(before.allowed, `${FEATURE} should be granted via the Admin row`).toBe(true);

    // Step 1 — the capability is real on the gated surface.
    await expect(await captchaGate(page), "an entitled account should not be gated").toHaveCount(0);

    // Step 2 — unchecking the Admin cell actually removes the capability.
    await toggleGridCellInUi(page, "disable");
    await expect(
      await captchaGate(page),
      "revoking the Admin row should re-gate the account — if not, the column is still decorative",
    ).toHaveCount(1);
    expect((await readAuthState(page)).allowed, "the resolver should now refuse").toBe(false);

    // Step 3 — re-checking restores it. The restore direction matters: a screen
    // stuck showing the gate would pass step 2 on its own.
    await toggleGridCellInUi(page, "enable");
    await expect(await captchaGate(page), "restoring the Admin row should un-gate it").toHaveCount(0);
    expect((await readAuthState(page)).allowed, "the resolver should grant again").toBe(true);
  });

  /**
   * POSITIVE CONTROL for the two "Access Denied" absence assertions above.
   *
   * Those assert a count of ZERO, which a selector matching nothing would
   * satisfy forever — the gate could start denying real admins and both tests
   * would stay green. This proves the same selector does match when the app
   * genuinely refuses, so their zero means something. It is not one of PR425's
   * steps; it is what makes two of them honest.
   *
   * Logged out is the cheapest way to reach the refusal: AdminLayout's gate is
   * `!isAuthenticated || !isAdmin`.
   */
  test("the same Access-Denied selector does match when access is genuinely refused", async ({ page }) => {
    await page.context().clearCookies();
    await page.goto("/admin", { waitUntil: "domcontentloaded" });

    await expect(
      page.getByText("Access Denied"),
      "a logged-out visitor should be refused the console",
    ).toHaveCount(1);
    await expect(
      page.getByRole("heading", { name: "Viewing as a user" }),
      "and should not get the preview panel, which implies admin rights",
    ).toHaveCount(0);
  });

  // Leaves the grid as this file found it even if a test above failed part-way.
  // The grid is shared mutable state; a dirty cell would fail the NEXT run
  // closed, which is exactly the class of flake #563 round 7 removed.
  test.afterEach(async ({ page }) => {
    await setGridCell(page, "admin", FEATURE, true).catch(() => {});
  });
});

/**
 * Makes the Feature Permission Grid render expanded on every subsequent load.
 * CollapsibleSection reads this key once in a useState initializer, so setting
 * it before the document runs is what makes the grid's state deterministic
 * rather than dependent on whatever the previous test left behind.
 */
async function expandFeatureGrid(page: Page) {
  await page.addInitScript(() => {
    try {
      localStorage.setItem("admin_section_features_grid", "1");
    } catch {
      // A context with storage disabled falls back to the collapsed default;
      // the cell assertions below then fail loudly rather than silently.
    }
  });
}

/** The `/submit` captcha gate — visible only when the account lacks the bypass. */
async function captchaGate(page: Page) {
  await page.goto("/submit", { waitUntil: "domcontentloaded" });
  // Gate on the form itself before counting, so an unrendered page cannot read
  // as "no captcha gate".
  await expect(page.getByRole("heading", { name: /Submit a fact/i })).toBeVisible({ timeout: 30_000 });
  return page.getByText("Quick Verification");
}

/** What the server currently believes about this session, read from the page. */
async function readAuthState(page: Page): Promise<{ membershipTier: string; allowed: boolean }> {
  // The relative URL below needs a document on the app's origin to resolve
  // against; a helper called before the first navigation would otherwise fail
  // on about:blank rather than on anything to do with the assertion.
  if (!page.url().startsWith("http")) await page.goto("/", { waitUntil: "domcontentloaded" });
  return page.evaluate(async (feature) => {
    const res = await fetch("/api/auth/user", { credentials: "include" });
    const body = await res.json();
    return {
      membershipTier: body.user?.membershipTier,
      allowed: body.entitlements?.[feature]?.allowed === true,
    };
  }, FEATURE);
}

/**
 * Clicks one cell of the Feature Permission Grid for the Admin column.
 * `intent` is the action the cell currently offers, which is also how the grid
 * encodes its own state — so asking for "disable" both finds a cell that is
 * currently ON and turns it off.
 */
async function toggleGridCellInUi(page: Page, intent: "enable" | "disable") {
  await page.goto("/admin/features", { waitUntil: "domcontentloaded" });

  // The grid must be expanded before any cell exists. Toggling it by clicking
  // the section header is a race — `count()` does not retry, so a check that
  // runs before the fetch resolves reads "collapsed" and the click CLOSES an
  // already-open grid. `expandFeatureGrid` seeds the CollapsibleSection's
  // localStorage key instead, which it reads once at mount, so the section is
  // open on arrival every time.
  const label = intent === "disable" ? "Disable" : "Enable";
  const cell = page
    .locator(`button[title="${label} Skip Captcha on Fact Submission for Admin"]`)
    .filter({ visible: true });

  // Exactly one INTERACTIVE cell per feature/tier. The page renders a desktop
  // table and a mobile card stack from the same data, so both carry the title —
  // an unfiltered locator matches two and a `.first()` would quietly pick one.
  await expect(cell, `exactly one visible "${label}" cell for the Admin column`).toHaveCount(1);
  await cell.click();

  // The write is optimistic in the UI; wait for the cell to actually flip to the
  // opposite affordance so a failed PATCH cannot be mistaken for a success.
  const flipped = intent === "disable" ? "Enable" : "Disable";
  await expect(
    page.locator(`button[title="${flipped} Skip Captcha on Fact Submission for Admin"]`).filter({ visible: true }),
    "the cell should flip to the opposite affordance once the write lands",
  ).toHaveCount(1, { timeout: 30_000 });
}

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
 *   - steps 6, 7  — Exit Admin leaves admin mode, drops the Admin row's
 *                   entitlements, and leaves the way back visible
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
 *   - Step 6 says "the site reloads as a registered user would see it". What is
 *     asserted is that the resolver's answer for this session becomes the
 *     non-admin answer AND that one gated product surface (`/submit`) follows.
 *     That is the substance of the step, but it is not every surface: the
 *     Legendary-feature half is steps 10/12, which need a fact and a photo.
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
 *   2. No assertion depends on database state it did not establish. Every grid
 *      value this file reads is SET by the test first, and restored afterwards
 *      to the value the test found — never to a hardcoded default, which would
 *      silently enable a permission an operator had deliberately turned off.
 *      That includes BOTH tiers the resolver can pick: the account's stored
 *      tier while admin mode is on, and `registered` while previewing, which
 *      `principalFromUser` substitutes regardless of the stored tier. The two
 *      account-row facts the file cannot set (the stored tier and
 *      `captchaVerified`) are asserted as explicit, self-explaining
 *      preconditions rather than assumed. See `establishGridPremise`.
 */

import { expect, test, type Page } from "@playwright/test";

/**
 * The feature this file uses to observe the resolver. Chosen because its gated
 * surface (`/submit`) needs no fixtures at all, unlike every other entitlement
 * whose UI needs a fact row or a stored photo.
 */
const FEATURE = "fact_submit_captcha_bypass";

/** Its `displayName` in the grid, which is what the cell's `title` is built from. */
const FEATURE_LABEL = "Skip Captcha on Fact Submission";
/**
 * The tier every previewing admin resolves as, whatever their stored tier —
 * `principalFromUser` hardcodes it (featureAccess.ts:161) so that a
 * legendary-holding admin in preview does not keep Legendary features.
 */
const PREVIEW_TIER = "registered";

/** One grid cell as this test found it, so `afterEach` can put it back. */
interface CapturedCell {
  tier: string;
  featureKey: string;
  enabled: boolean;
}

/** Reset per test by the beforeEach below; drained by the afterEach. */
let captured: CapturedCell[] = [];

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

/** The whole grid, keyed `tier:featureKey`. */
async function readGrid(page: Page): Promise<Map<string, boolean>> {
  const res = await page.context().request.get("/api/admin/feature-flags");
  expect(res.ok(), `GET feature-flags should be 200, got ${res.status()}`).toBe(true);
  const body = (await res.json()) as { permissions: CapturedCell[] };
  return new Map(body.permissions.map((p) => [`${p.tier}:${p.featureKey}`, p.enabled]));
}

/**
 * Sets one grid cell through the same route the admin console uses, recording
 * what it found the FIRST time it touches that cell so the afterEach can put
 * exactly that back.
 *
 * Restoring to a captured value rather than to `true` is the point: `TESTING.md`
 * tells developers to run this suite against a retained stack, where a
 * permission may be off deliberately. Unconditionally re-enabling it there
 * would change a live operational permission and leave a misleading audit row.
 * (Codex, #570 round 1.)
 */
async function setGridCell(page: Page, tier: string, featureKey: string, enabled: boolean) {
  const key = `${tier}:${featureKey}`;
  if (!captured.some((c) => `${c.tier}:${c.featureKey}` === key)) {
    const before = (await readGrid(page)).get(key);
    expect(before, `the grid should have a ${key} row to restore`).toBeDefined();
    captured.push({ tier, featureKey, enabled: before! });
  }
  const res = await page.context().request.patch("/api/admin/feature-flags", {
    headers: { "X-CSRF-Token": await csrfToken(page) },
    data: { tier, featureKey, enabled },
  });
  expect(res.ok(), `PATCH feature-flags ${key}=${enabled} -> ${res.status()}`).toBe(true);
}

/**
 * Establishes, by construction, the premise both entitlement tests rest on:
 * this account's OWN tier does not grant `FEATURE`, and the Admin row does.
 * Without it, an entitlement being granted would not distinguish "granted by
 * the Admin row" from "granted by the tier", and the tests would prove nothing
 * about the column at all.
 *
 * The account's stored tier is read rather than assumed to be `registered`: on
 * a retained stack `seed-dev-admin.ts` is a no-op for an existing bootstrap
 * admin, whose tier may be anything. (Codex, #570 round 1.)
 *
 * Returns the stored tier so callers can name it in failure messages.
 */
async function establishGridPremise(page: Page): Promise<string> {
  const state = await readAuthState(page);

  // If the account's stored tier were literally `admin`, "the Admin row grants
  // what the tier does not" is not a distinction this account can demonstrate,
  // and no arrangement of the grid would make it one.
  expect(
    state.membershipTier,
    "this suite needs a bootstrap admin whose STORED tier is not itself `admin`",
  ).not.toBe("admin");

  // `/submit` hides its captcha gate when EITHER the entitlement or the
  // account's own onboarding flag says so (`SubmitFact.tsx:69`), so the DOM
  // half of these tests can only observe the entitlement while this is false.
  // Asserted rather than assumed, so a retained stack fails with this sentence
  // instead of with a confusing count mismatch.
  expect(
    state.captchaVerified,
    "this suite needs an admin that has NOT completed captcha onboarding, or the /submit gate cannot observe the entitlement",
  ).toBe(false);

  // The account's OWN tier, which is what resolves while admin mode is on.
  await setGridCell(page, state.membershipTier, FEATURE, false);

  // AND the `registered` row, which is what resolves while PREVIEWING —
  // `principalFromUser` substitutes that tier for every previewing admin and
  // deliberately ignores `membershipTier` (featureAccess.ts:161), so a
  // legendary-tier bootstrap admin would otherwise keep the feature through the
  // untouched Registered row and fail the post-exit assertion while preview was
  // behaving correctly. A no-op second write when the stored tier IS
  // `registered`; `setGridCell` captures each cell only on first touch.
  // (Codex, #570 round 2 — a defect in round 1's fix to this same helper.)
  await setGridCell(page, PREVIEW_TIER, FEATURE, false);

  await setGridCell(page, "admin", FEATURE, true);
  return state.membershipTier;
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
  test.beforeEach(async ({ page }) => {
    captured = [];
    await loginAsAdmin(page);
  });

  /**
   * PR425 steps 6 and 7.
   *
   * The button flip is asserted in both directions on purpose: a page that
   * rendered BOTH controls, or neither, is the failure these two steps exist to
   * catch, and either would satisfy a one-sided check.
   *
   * But the flip alone is presentation. Step 6 promises the SITE changes, and a
   * regression where preview swapped the buttons while the resolver kept
   * applying the Admin row would have passed a button-only test. So this also
   * asserts a real product entitlement is withdrawn in the same preview
   * session — at the resolver, and on a gated product surface. (Codex, #570
   * round 1.)
   */
  test("Exit Admin drops the Admin row's entitlements, and leaves a way back", async ({ page }) => {
    const storedTier = await establishGridPremise(page);

    // Step 6 starts at the AVATAR, not at /profile. Navigating straight to
    // the page would assert the button while leaving unproven the one hop the
    // document tells David to take -- and that hop is load-bearing: the
    // account-menu dropdown `AccountMenu` renders is mounted nowhere, so the
    // avatar navigates instead of opening it. Mount that component and this
    // navigation silently changes under four rewritten UAT steps.
    // (Codex, #575 round 1.)
    await page.goto("/", { waitUntil: "domcontentloaded" });
    const avatar = page.getByRole("button", { name: /Open your profile/i });
    await expect(avatar, "an authenticated header should offer the avatar control").toBeVisible({ timeout: 30_000 });
    await avatar.click();
    await expect(
      page,
      "tapping the avatar should land on Profile, which is where Exit Admin lives",
    ).toHaveURL(/\/profile\/?$/, { timeout: 30_000 });

    const exit = page.getByRole("button", { name: /Exit Admin/i });
    const resume = page.getByRole("button", { name: /Resume Admin/i });

    await expect(exit, "an admin in admin mode should be offered the way out").toBeVisible({ timeout: 30_000 });
    await expect(resume, "...and not simultaneously the way back in").toHaveCount(0);
    expect(
      (await readAuthState(page)).allowed,
      `in admin mode the Admin row should grant ${FEATURE}, which tier "${storedTier}" does not`,
    ).toBe(true);

    await exit.click();

    // Step 7 is the anti-lockout property: before PR425 every entry point was
    // hidden once you left, so this asserts the way back EXISTS, not merely
    // that the way out stopped rendering.
    await expect(resume, "leaving admin mode must leave a way back").toBeVisible({ timeout: 30_000 });
    await expect(exit, "...and the way out should be gone").toHaveCount(0);

    // Step 6's substance. The resolver half...
    expect(
      (await readAuthState(page)).allowed,
      "previewing as a user must actually withdraw the Admin row's entitlements, not just relabel the button",
    ).toBe(false);

    // ...and the product half, on a surface a user would actually meet.
    await expect(
      await captchaGate(page),
      "a previewing admin should meet the same submission gate a registered member meets",
    ).toHaveCount(1);
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
   * The revoke and the restore are done by CLICKING the Features screen, which
   * is the other half of the PR ("the Features screen is now real"). Only the
   * premise is set through the API.
   */
  test("the Admin grid row grants a capability the account's own tier does not", async ({ page }) => {
    const storedTier = await establishGridPremise(page);

    expect(
      (await readAuthState(page)).allowed,
      `${FEATURE} should be granted via the Admin row, since tier "${storedTier}" is set off`,
    ).toBe(true);

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

  // Puts every cell this test touched back to the value it found, even if the
  // test failed part-way. The grid is shared mutable state; a dirty cell would
  // fail the NEXT run closed, which is the class of flake #563 round 7 removed.
  test.afterEach(async ({ page }) => {
    // Every failure is collected rather than thrown, so one unrestorable cell
    // cannot skip the cells after it — then the teardown fails naming exactly
    // what was left dirty. A bare `.catch(() => {})` was not enough: an
    // APIRequestContext rejects only on a network error, so a 403 or a 500
    // resolved normally and left the suite green with a permission still
    // changed. (Codex, #570 round 2.)
    const failures: string[] = [];
    for (const cell of captured.reverse()) {
      try {
        const res = await page.context().request.patch("/api/admin/feature-flags", {
          headers: { "X-CSRF-Token": await csrfToken(page) },
          data: { tier: cell.tier, featureKey: cell.featureKey, enabled: cell.enabled },
        });
        if (!res.ok()) failures.push(`${cell.tier}:${cell.featureKey} -> HTTP ${res.status()}`);
      } catch (err) {
        failures.push(`${cell.tier}:${cell.featureKey} -> ${(err as Error).message}`);
      }
    }
    captured = [];
    expect(failures, `grid cells left dirty by teardown: ${failures.join("; ")}`).toEqual([]);
  });
});

/** The `/submit` captcha gate — visible only when the account lacks the bypass. */
async function captchaGate(page: Page) {
  await page.goto("/submit", { waitUntil: "domcontentloaded" });
  // Gate on the form itself before counting, so an unrendered page cannot read
  // as "no captcha gate".
  await expect(page.getByRole("heading", { name: /Submit a fact/i })).toBeVisible({ timeout: 30_000 });
  return page.getByText("Quick Verification");
}

/** What the server currently believes about this session, read from the page. */
async function readAuthState(
  page: Page,
): Promise<{ membershipTier: string; captchaVerified: boolean; allowed: boolean }> {
  // The relative URL below needs a document on the app's origin to resolve
  // against; a helper called before the first navigation would otherwise fail
  // on about:blank rather than on anything to do with the assertion.
  if (!page.url().startsWith("http")) await page.goto("/", { waitUntil: "domcontentloaded" });
  return page.evaluate(async (feature) => {
    const res = await fetch("/api/auth/user", { credentials: "include" });
    const body = await res.json();
    return {
      membershipTier: body.user?.membershipTier,
      captchaVerified: body.user?.captchaVerified === true,
      allowed: body.entitlements?.[feature]?.allowed === true,
    };
  }, FEATURE);
}

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

/**
 * Clicks one cell of the Feature Permission Grid for the Admin column.
 * `intent` is the action the cell currently offers, which is also how the grid
 * encodes its own state — so asking for "disable" both finds a cell that is
 * currently ON and turns it off.
 */
async function toggleGridCellInUi(page: Page, intent: "enable" | "disable") {
  await expandFeatureGrid(page);
  await page.goto("/admin/features", { waitUntil: "domcontentloaded" });

  const label = intent === "disable" ? "Disable" : "Enable";
  const cell = page
    .locator(`button[title="${label} ${FEATURE_LABEL} for Admin"]`)
    .filter({ visible: true });

  // Exactly one INTERACTIVE cell per feature/tier. The page renders a desktop
  // table and a mobile card stack from the same data, so both carry the title —
  // an unfiltered locator matches two and a `.first()` would quietly pick one.
  await expect(cell, `exactly one visible "${label}" cell for the Admin column`).toHaveCount(1);

  // `toggle()` sets the new value in React state BEFORE awaiting its PATCH
  // (features.tsx:99), so the title flips optimistically and a title-only wait
  // is satisfied while the write is still in flight — navigating then races or
  // aborts it. Wait for the response itself. (Codex, #570 round 1.)
  const patched = page.waitForResponse(
    (r) => r.url().includes("/api/admin/feature-flags") && r.request().method() === "PATCH",
    { timeout: 30_000 },
  );
  await cell.click();
  const response = await patched;
  expect(response.status(), `the grid write should succeed, got ${response.status()}`).toBe(200);

  // And for the cell to leave its `saving` state, which is what re-enables the
  // button — so the UI has observed the same success, not just the network.
  const flipped = intent === "disable" ? "Enable" : "Disable";
  const after = page
    .locator(`button[title="${flipped} ${FEATURE_LABEL} for Admin"]`)
    .filter({ visible: true });
  await expect(
    after,
    "the cell should flip to the opposite affordance once the write lands",
  ).toHaveCount(1, { timeout: 30_000 });
  await expect(after, "and should not still be saving").toBeEnabled({ timeout: 30_000 });
}

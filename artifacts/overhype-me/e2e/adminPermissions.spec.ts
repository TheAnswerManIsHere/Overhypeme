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

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { FREE_ACCOUNT, PAID_ACCOUNT, TEST_ACCOUNT_PASSWORD, csrfToken, signInThroughForm } from "./helpers/testAccounts";

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
    await restoreCapturedCells(page);
  });
});

async function restoreCapturedCells(page: Page) {
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
}

// ─────────────────────────────────────────────────────────────────────────────
// #631 increment 7b: the PR425 steps the file header above lists as not
// asserted, now asserted on the features they name, plus PR242 step 1 and
// PR472 R7.
//
// A stored photo is the one premise this stack cannot produce: an upload needs
// object storage, and a profileImageUrl written through PATCH /users/me can
// never be cleared again through any route, so it would outlive the test and
// change what later suites see. So the profile read (GET /api/users/me) is
// passed through from the real server with only `profileImageUrl` filled in,
// and the photo's bytes are served from the committed fixture. Everything the
// steps are about — the entitlement, the grid, the avatar selection write, the
// gate — is the real server's.
//
// Form sign-ins are counted: the server allows ten per IP per fifteen minutes,
// and the whole E2E job shares one IP, so this block signs in once per account.
// ─────────────────────────────────────────────────────────────────────────────

const STUB_PHOTO_URL = "/api/storage/objects/uploads/e2e-7b-stored-photo";
const FIXTURE_PHOTO = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../api-server/scripts/fixtures/ai-baseline/photo.jpg"),
);

/** Fills in a stored photo on the account's real profile read, and serves its bytes. */
async function withStoredPhoto(page: Page) {
  await page.route(
    (url) => url.pathname === "/api/users/me",
    async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      const real = await route.fetch();
      if (!real.ok()) return route.fulfill({ response: real });
      return route.fulfill({ response: real, json: { ...(await real.json()), profileImageUrl: STUB_PHOTO_URL } });
    },
  );
  await page.route(`**${STUB_PHOTO_URL}`, (route) => route.fulfill({ contentType: "image/jpeg", body: FIXTURE_PHOTO }));
}

/** The real stored avatar selection, read and written as the signed-in account. */
async function avatarSource(page: Page): Promise<string> {
  const res = await page.context().request.get("/api/users/me");
  expect(res.ok()).toBe(true);
  return String((await res.json()).avatarSource ?? "avatar");
}
async function setAvatarSource(page: Page, value: string) {
  const res = await page.context().request.patch("/api/users/me", {
    headers: { "X-CSRF-Token": await csrfToken(page) },
    data: { avatarSource: value },
  });
  expect(res.ok(), `PATCH avatarSource=${value} -> ${res.status()}`).toBe(true);
}

/** Opens Profile's editor, where the Profile Photo section and its Avatar / Photo pills live on desktop. */
async function openProfileEditor(page: Page) {
  await page.goto("/profile", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Edit Profile" }).filter({ visible: true }).click();
  await expect(page.getByText("Profile Photo", { exact: false }).filter({ visible: true }).first()).toBeVisible();
}

const unlockedPhotoPill = (page: Page) => page.locator('button[title="Use custom photo"]').filter({ visible: true });
const lockedPhotoPill = (page: Page) => page.locator('button[title="Custom photo avatars are a Legendary feature"]').filter({ visible: true });
/** The header's avatar image (the control that opens Profile). */
const headerAvatar = (page: Page) => page.getByRole("button", { name: "Open your profile" }).filter({ visible: true }).locator("img");
/** Profile's own large avatar on desktop. */
const profileAvatar = (page: Page) => page.locator("img.rounded-full.object-cover").filter({ visible: true }).first();
const GENERATED_ICON = /^https:\/\/api\.dicebear\.com\//;

/**
 * The resolver's answer for one feature, for this session. Read through the
 * context's request client (same session cookie), not an in-page fetch, which
 * a navigation — Resume Admin's, for one — aborts mid-flight.
 */
async function allowed(page: Page, feature: string): Promise<boolean> {
  const body = await (await page.context().request.get("/api/auth/user")).json();
  return body.entitlements?.[feature]?.allowed === true;
}

/** As establishGridPremise, for any feature: the account's own tier and preview tier off, the Admin row on. */
async function adminRowOnlyGrants(page: Page, feature: string): Promise<string> {
  const res = await page.context().request.get("/api/auth/user");
  const tier = String((await res.json()).user?.membershipTier);
  expect(tier, "this suite needs a bootstrap admin whose STORED tier is not itself `admin`").not.toBe("admin");
  await setGridCell(page, tier, feature, false);
  await setGridCell(page, PREVIEW_TIER, feature, false);
  await setGridCell(page, "admin", feature, true);
  return tier;
}

test.describe("7b — Admin permissions on the features the steps name (PR425, PR242, PR472)", () => {
  test.beforeEach(() => { captured = []; });
  test.afterEach(async ({ page }) => {
    if (captured.length > 0) await restoreCapturedCells(page);
  });

  // PR425 steps 1, 2, 3 and 5, on custom_avatar itself.
  test("the Admin cell alone grants a registered-tier admin the custom-avatar photo, and unchecking it takes it away", async ({ page }) => {
    await loginAsAdmin(page);
    const tier = await adminRowOnlyGrants(page, "custom_avatar");
    expect(tier, "steps 1 and 5 are about a registered-tier admin").toBe("registered");
    await withStoredPhoto(page);
    const before = await avatarSource(page);
    try {
      // Step 1 — available through the Admin row; selecting it works.
      await openProfileEditor(page);
      await expect(unlockedPhotoPill(page), "PR425 step 1: the custom-avatar option should be available to the admin").toBeVisible();
      await unlockedPhotoPill(page).click();
      await expect(headerAvatar(page), "selecting the photo should show it as the avatar").toHaveAttribute("src", STUB_PHOTO_URL);

      // Steps 2 and 5 — the Admin cell off, the registered tier off: refused, generated icon.
      await toggleGridCellInUi(page, "disable", "Custom Avatar Photo");
      await openProfileEditor(page);
      await expect(lockedPhotoPill(page), "PR425 step 2: with the Admin cell off the custom-avatar selection should be refused (locked)").toBeVisible();
      await expect(unlockedPhotoPill(page)).toHaveCount(0);
      await expect(
        lockedPhotoPill(page).locator("svg.lucide-crown"),
        "PR425 step 5: with only its own Admin cell off, the registered-tier admin's option is gone behind the Legendary lock",
      ).toHaveCount(1);
      await expect(headerAvatar(page), "PR425 step 2: the avatar should fall back to the generated icon").toHaveAttribute("src", GENERATED_ICON);
      await expect(profileAvatar(page), "PR425 step 2: ...on Profile too").toHaveAttribute("src", GENERATED_ICON);

      // Step 3 — re-checked: available again.
      await toggleGridCellInUi(page, "enable", "Custom Avatar Photo");
      await openProfileEditor(page);
      await expect(unlockedPhotoPill(page), "PR425 step 3: re-checking the Admin cell should make the option available again").toBeVisible();
    } finally {
      await setAvatarSource(page, before);
    }
  });

  // PR425 steps 6, 10 and 12, and R8.
  test("Exit Admin hides the Admin Panel and withdraws private memes; Resume Admin on Profile restores them", async ({ page }) => {
    await loginAsAdmin(page);
    await adminRowOnlyGrants(page, "meme_private_visibility");
    await page.goto("/profile", { waitUntil: "domcontentloaded" });
    const adminPanel = page.getByRole("button", { name: "Admin Panel" }).filter({ visible: true });
    await expect(adminPanel, "in admin mode Profile offers the Admin Panel").toBeVisible();

    // R8 — the admin's notification preferences are visible and a toggle saves.
    await expect(page.getByRole("heading", { name: "Notification Preferences" }), "PR425 R8: the preferences should be visible on the admin's Profile").toBeVisible();
    const alerts = page.getByRole("switch").first();
    const was = await alerts.getAttribute("aria-checked");
    const flip = async () => {
      const saved = page.waitForResponse((r) => r.url().endsWith("/api/users/me/notifications") && r.request().method() === "PATCH");
      await alerts.click();
      expect((await saved).status(), "PR425 R8: the preference write should succeed").toBe(200);
    };
    await flip();
    try {
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(page.getByRole("switch").first(), "PR425 R8: the toggled preference should persist").toHaveAttribute("aria-checked", was === "true" ? "false" : "true");
    } finally {
      await flip();
    }
    await expect(page.getByRole("switch").first()).toHaveAttribute("aria-checked", String(was));

    expect(await allowed(page, "meme_private_visibility"), "in admin mode the Admin row grants private memes").toBe(true);
    await page.getByRole("button", { name: /Exit Admin/i }).filter({ visible: true }).click();
    await expect(page.getByRole("button", { name: /Resume Admin/i }).filter({ visible: true })).toBeVisible({ timeout: 30_000 });
    await expect(adminPanel, "PR425 step 6: after Exit Admin, Profile should not show the Admin Panel button").toHaveCount(0);
    expect(await allowed(page, "meme_private_visibility"), "PR425 step 10: after Exit Admin the admin no longer holds private memes").toBe(false);

    await page.getByRole("button", { name: /Resume Admin/i }).filter({ visible: true }).click();
    await expect
      .poll(() => allowed(page, "meme_private_visibility"), { message: "PR425 step 12: after Resume Admin the admin holds private memes again" })
      .toBe(true);
    await expect(page.getByRole("button", { name: /Exit Admin/i }).filter({ visible: true })).toBeVisible({ timeout: 30_000 });
  });

  // PR425 step 11 — "nothing you can toggle in Features can cost you console access".
  test("with every Admin-row cell off, the admin still gets the console", async ({ page }) => {
    await loginAsAdmin(page);
    const grid = await readGrid(page);
    const adminCells = [...grid.keys()].filter((k) => k.startsWith("admin:")).map((k) => k.slice("admin:".length));
    expect(adminCells.length, "the grid should have an Admin row").toBeGreaterThan(0);
    for (const feature of adminCells) await setGridCell(page, "admin", feature, false);
    await page.goto("/admin", { waitUntil: "domcontentloaded" });
    await expect(consoleRail(page), "PR425 step 11: the console should still render with every Admin cell off").toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Access Denied"), "PR425 step 11: ...and never Access Denied").toHaveCount(0);
  });

  // PR472 R7 (both halves), PR425 steps 6 (the registered half), 17 and 20, and
  // PR242 step 1 — all as the ordinary free account, signed in once.
  test("the free account: refused at /admin/help, photo withheld and its selection refused, and a submission confirmed", async ({ page, browser }) => {
    await page.context().clearCookies();
    await page.goto("/admin/help", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Access Denied" }), "PR472 R7: /admin/help signed out shows Access Denied").toBeVisible({ timeout: 30_000 });

    await signInThroughForm(page, FREE_ACCOUNT.email, TEST_ACCOUNT_PASSWORD);
    await page.goto("/admin/help", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Access Denied" }), "PR472 R7: /admin/help as a non-admin shows the same Access Denied").toBeVisible({ timeout: 30_000 });

    // The admin context does the account setup and the cleanup, never the free session.
    const admin = await browser.newContext({ baseURL: new URL(page.url()).origin });
    expect((await admin.request.post("/api/auth/dev-admin-login")).ok()).toBe(true);
    const adminCsrf = (await admin.cookies()).find((c) => c.name === "csrf_token")?.value ?? "";
    const freeId = String((await (await page.context().request.get("/api/users/me")).json()).id);
    let reviewId: number | null = null;
    try {
      // PR425 step 20 — a stored, unselected photo: the account's own Profile shows the generated icon.
      await withStoredPhoto(page);
      await page.goto("/profile", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("button", { name: "Edit Profile" }).filter({ visible: true })).toBeVisible();
      await expect(profileAvatar(page), "PR425 step 20: the account's own Profile should show the generated icon").toHaveAttribute("src", GENERATED_ICON);
      // PR425 step 6's comparison: a registered member's Profile has no Admin Panel.
      await expect(page.getByRole("button", { name: "Admin Panel" }), "a registered member's Profile shows no Admin Panel").toHaveCount(0);

      // PR425 step 17 — selecting the photo is refused with the upgrade path, not a silent no-op.
      await openProfileEditor(page);
      await lockedPhotoPill(page).click();
      await expect(page, "PR425 step 17: tapping the locked Photo pill should lead to the upgrade prompt").toHaveURL(/\/pricing\/?$/);

      // PR242 step 1. Onboarding (the one-time captcha) is set as done through
      // the admin route, since the captcha widget is a third party's; the AI
      // conversion and its two helpers are answered here, since they are a
      // vendor call. The submission itself reaches the real server.
      const onboard = await admin.request.patch(`/api/admin/users/${freeId}`, {
        headers: { "X-CSRF-Token": adminCsrf },
        data: { captchaVerified: true },
      });
      expect(onboard.ok(), `setting captchaVerified -> ${onboard.status()}`).toBe(true);
      const template = `{NAME} out-lifted a crane, run ${Date.now()}.`;
      await page.route("**/api/ai/tokenize-fact", (route) => route.fulfill({ json: { template } }));
      await page.route("**/api/ai/check-duplicate", (route) => route.fulfill({ json: { isDuplicate: false, confidence: 0 } }));
      await page.route("**/api/ai/suggest-hashtags", (route) => route.fulfill({ json: { hashtags: [] } }));
      await page.goto("/submit", { waitUntil: "domcontentloaded" });
      await page.getByPlaceholder(/When John does pushups/).fill("Free Tester out-lifted a crane with one hand.");
      await page.getByRole("button", { name: /Preview/ }).click();
      const submitted = page.waitForResponse((r) => r.url().endsWith("/api/facts/submit-review") && r.request().method() === "POST");
      await page.getByRole("button", { name: /Looks Great — Submit/ }).click();
      const submitRes = await submitted;
      if (submitRes.ok()) reviewId = Number((await submitRes.json()).reviewId);
      await expect(page.getByRole("heading", { name: "You're Done!" }), "PR242 step 1: a normal submission shows the confirmation").toBeVisible();
      await expect(page.getByText("Your fact is in the queue for review."), "PR242 step 1: ...saying it is queued for review").toBeVisible();
    } finally {
      if (reviewId) {
        const rej = await admin.request.post(`/api/admin/reviews/${reviewId}/reject`, {
          headers: { "X-CSRF-Token": adminCsrf },
          data: { rejectionReason: "spam", adminNote: "e2e 7b cleanup" },
        });
        expect(rej.ok(), `cleanup: rejecting review ${reviewId} -> ${rej.status()}`).toBe(true);
      }
      const reset = await admin.request.patch(`/api/admin/users/${freeId}`, {
        headers: { "X-CSRF-Token": adminCsrf },
        data: { captchaVerified: false },
      });
      expect(reset.ok(), `cleanup: restoring captchaVerified -> ${reset.status()}`).toBe(true);
      await admin.close();
    }
  });

  // PR425 step 18 — the paid account selects its stored photo and the header avatar shows it.
  test("the paid account selects its stored photo and the avatar shows it", async ({ page }) => {
    await signInThroughForm(page, PAID_ACCOUNT.email, TEST_ACCOUNT_PASSWORD);
    await withStoredPhoto(page);
    const before = await avatarSource(page);
    try {
      if (before === "photo") await setAvatarSource(page, "avatar");
      await openProfileEditor(page);
      await expect(headerAvatar(page)).toHaveAttribute("src", GENERATED_ICON);
      const selected = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/users/me" && r.request().method() === "PATCH");
      await unlockedPhotoPill(page).click();
      expect((await selected).status(), "PR425 step 18: the selection should be accepted").toBe(200);
      await expect(headerAvatar(page), "PR425 step 18: the header avatar should show the photo").toHaveAttribute("src", STUB_PHOTO_URL);
    } finally {
      await setAvatarSource(page, before);
    }
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
async function toggleGridCellInUi(page: Page, intent: "enable" | "disable", featureLabel = FEATURE_LABEL) {
  await expandFeatureGrid(page);
  await page.goto("/admin/features", { waitUntil: "domcontentloaded" });

  const label = intent === "disable" ? "Disable" : "Enable";
  const cell = page
    .locator(`button[title="${label} ${featureLabel} for Admin"]`)
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
    .locator(`button[title="${flipped} ${featureLabel} for Admin"]`)
    .filter({ visible: true });
  await expect(
    after,
    "the cell should flip to the opposite affordance once the write lands",
  ).toHaveCount(1, { timeout: 30_000 });
  await expect(after, "and should not still be saving").toBeEnabled({ timeout: 30_000 });
}

/**
 * End-to-end regression test for the identity meme + video flow (Task #382).
 *
 * What this guards:
 *
 *   Scenario A — Non-Legendary user *with* a profile photo:
 *     1. The Meme Builder mounts with the new "You" tab as the default active
 *        background-mode tab (not Stock / Gradient / Upload).
 *     2. The Identity section shows the user's profile photo preview (no
 *        upload prompt, no paywall).
 *     3. Creating an identity meme via POST /api/memes with
 *        `imageSource: { type: "identity" }` succeeds for a non-Legendary
 *        registered user — i.e. the legacy upload paywall does NOT fire.
 *     4. Opening the just-created meme detail page with the deterministic
 *        `?just_created=1&source=photo` query params shows the dopamine
 *        afterglow upgrade card AND suppresses the "Turn this up to 11" tile
 *        for non-Legendary viewers.
 *
 *   Scenario B — Registered user *without* a profile photo:
 *     1. The "You" tab is still the default and renders the inline
 *        "Add Your Photo" upload prompt (instead of a preview).
 *     2. Uploading a JPEG via POST /api/storage/upload-avatar +
 *        PATCH /api/users/me promotes the user out of the prompt — the
 *        next render shows the profile-photo preview (alt="Your profile photo").
 *     3. Once the user is Legendary, opening the AI Generated tab and
 *        switching to the Reference Photo sub-mode default-selects the new
 *        profile photo as the AI reference (visible "You" badge + an
 *        ImageCard whose alt is "Your profile photo").
 *
 * Why this shape:
 *   - The MemeBuilder still has very few stable selectors for the heavier
 *     interactions (canvas, image generation), so we drive the
 *     authenticated HTTP endpoints directly via `context.request` for the
 *     create-meme step — the same browser context (and therefore the same
 *     session cookie + tier state the UI sees) is used throughout.
 *   - The browser side asserts the user-visible signals that the new flow
 *     hinges on: the "You" tab being the default, the inline upload prompt,
 *     the photo preview, the AI reference identity badge, and the post-
 *     create afterglow card.
 *
 * Prereqs to run locally:
 *   1. Both dev workflows must be up:
 *        - artifacts/api-server: API Server  (port 8080, proxied via /api)
 *        - artifacts/overhype-me: web         (Vite dev server)
 *   2. Chromium installed once: `pnpm exec playwright install chromium`
 *   3. Run: `pnpm --filter @workspace/overhype-me run e2e`
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { expect, test, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Re-use the existing 2400×1600 JPEG fixture as both a profile-photo and
// reference-photo source. It's a small real JPEG that the
// /storage/upload-avatar endpoint will accept.
const FIXTURE_PATH = path.join(__dirname, "fixtures", "upload-2400x1600.jpg");

/** Run a SQL statement against the local Helium dev DB. */
function dbExec(sql: string): string {
  return execFileSync(
    "psql",
    ["-h", "helium", "-U", "postgres", "-d", "heliumdb", "-At", "-c", sql],
    { env: { ...process.env, PGPASSWORD: "password" }, encoding: "utf8" },
  );
}

function escSql(s: string): string {
  return s.replace(/'/g, "''");
}

/** Get an active fact id we can attach memes to. */
function getActiveFactId(): number {
  const raw = dbExec("SELECT id FROM facts WHERE is_active=true ORDER BY id LIMIT 1;").trim();
  const id = Number(raw);
  if (!Number.isFinite(id) || id <= 0) {
    throw new Error(`Expected an active fact id, got "${raw}"`);
  }
  return id;
}

async function ensureJsonOk(label: string, response: Awaited<ReturnType<APIRequestContext["post"]>>) {
  if (!response.ok()) {
    const body = await response.text();
    throw new Error(`${label} failed: HTTP ${response.status()} — ${body}`);
  }
  return response.json();
}

interface RegisteredUser {
  email: string;
  password: string;
  displayName: string;
  /**
   * Session id (sid) extracted from the Set-Cookie response of /auth/register.
   * Sent as `Authorization: Bearer <sid>` on subsequent mutating requests so
   * the server treats them as bearer-auth instead of cookie-session — that's
   * the same path the real React client takes (see main.tsx) and is what the
   * CSRF middleware (app.ts) keys off via `isCookieSessionRequest`. Without
   * this, every POST/PATCH from `context.request` would 403 with "Origin not
   * allowed" because ALLOWED_ORIGINS is empty in dev and the strict CSRF
   * middleware requires Origin/Referer ∈ allowedOrigins for cookie sessions.
   */
  sid: string;
}

/**
 * Read the `sid` session cookie out of the browser context. The cookie is set
 * during /auth/register or /auth/local-login.
 */
async function readSidCookie(context: BrowserContext): Promise<string> {
  const cookies = await context.cookies();
  const sid = cookies.find((c) => c.name === "sid");
  if (!sid?.value) {
    throw new Error("Expected `sid` session cookie to be set after register");
  }
  return sid.value;
}

/**
 * Register a fresh local-auth user via /api/auth/register, which sets the
 * session cookie on `context`. The default tier is "registered" (free) —
 * upgrade explicitly via DB if the test needs Legendary.
 */
async function registerUser(context: BrowserContext, suffix: string): Promise<RegisteredUser> {
  const email = `e2e-identity-${suffix}@example.test`;
  const password = "TestPass1234!";
  const displayName = `Identity Tester ${suffix}`;
  const register = await context.request.post("/api/auth/register", {
    data: {
      email,
      password,
      displayName,
      firstName: "Identity",
      lastName: `Tester${suffix}`,
    },
  });
  await ensureJsonOk("register", register);
  const sid = await readSidCookie(context);
  return { email, password, displayName, sid };
}

/** Build the Bearer auth header for an authenticated mutating request. */
function bearerHeaders(sid: string, extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${sid}`, ...extra };
}

/**
 * Upload a JPEG via /api/storage/upload-avatar and PATCH /api/users/me to
 * record it as the user's profile photo. Returns the canonical
 * /api/storage/objects/... URL the server stored on the user row.
 */
async function setProfilePhotoFromFixture(
  context: BrowserContext,
  sid: string,
  fixturePath: string,
): Promise<string> {
  const buf = readFileSync(fixturePath);
  const uploadRes = await context.request.post("/api/storage/upload-avatar", {
    headers: bearerHeaders(sid, { "content-type": "image/jpeg" }),
    data: buf,
  });
  const upload = (await ensureJsonOk("upload-avatar", uploadRes)) as { objectPath: string };
  expect(upload.objectPath).toMatch(/^\/objects\//);

  const profileImageUrl = `/api/storage${upload.objectPath}`;
  const patchRes = await context.request.patch("/api/users/me", {
    headers: bearerHeaders(sid),
    data: { profileImageUrl, avatarSource: "photo" },
  });
  await ensureJsonOk("patch /users/me", patchRes);
  return profileImageUrl;
}

async function setUserTier(email: string, tier: "registered" | "legendary"): Promise<void> {
  dbExec(`UPDATE users SET membership_tier='${tier}' WHERE email='${escSql(email)}';`);
  const got = dbExec(`SELECT membership_tier FROM users WHERE email='${escSql(email)}';`).trim();
  expect(got, `tier should be ${tier}`).toBe(tier);
}

/** The active mode tab is the only one rendered with the `text-primary` class. */
function modeTabLocator(page: Page, label: string) {
  return page.locator(
    `button.font-bold.uppercase.tracking-wider.border-b-2:has-text("${label}")`,
  );
}

test.describe("Identity meme + video flow", () => {
  test("non-legendary creator: 'You' tab is default, identity meme creation succeeds, afterglow card shows", async ({ browser }) => {
    const suffix = Math.random().toString(36).slice(2, 10);
    const context = await browser.newContext();
    const page = await context.newPage();

    // 1. Register a fresh user (default tier = "registered") and give them a
    //    profile photo. Both endpoints set/read the session cookie on this
    //    browser context.
    const user = await registerUser(context, suffix);
    const profileImageUrl = await setProfilePhotoFromFixture(context, user.sid, FIXTURE_PATH);

    // 2. Sanity-check via /api/auth/user that we are NOT Legendary and the
    //    profile photo is set in the session view of the user.
    const meRes = await context.request.get("/api/auth/user");
    expect(meRes.ok(), `/api/auth/user should be 200, got ${meRes.status()}`).toBe(true);
    const me = await meRes.json();
    expect(me.user?.email).toBe(user.email);
    expect(me.user?.membershipTier).not.toBe("legendary");
    expect(me.user?.profileImageUrl).toBeTruthy();

    // 3. Pick an active fact and open the Meme Builder for it.
    const factId = getActiveFactId();
    const builderResp = await page.goto(`/facts/${factId}/meme`, {
      waitUntil: "domcontentloaded",
    });
    expect(builderResp?.ok() ?? false, `Meme Builder page should load 200, got ${builderResp?.status()}`).toBe(true);

    // 4. Verify the "You" tab is rendered and is the active mode tab on
    //    initial mount. The active state is signaled by the `text-primary`
    //    class on the ModeTab button.
    const youTab = modeTabLocator(page, "You").first();
    await expect(youTab, "the 'You' mode tab should be visible").toBeVisible();
    await expect(
      youTab,
      "the 'You' tab should be the active background-mode tab on initial mount",
    ).toHaveClass(/text-primary/);

    // 5. The IdentityPhotoSection should preview the user's profile photo —
    //    NOT the inline "Add Your Photo" upload prompt.
    const profilePreview = page.locator('img[alt="Your profile photo"]').first();
    await expect(
      profilePreview,
      "the 'You' tab should preview the user's existing profile photo",
    ).toBeVisible();
    await expect(
      page.getByText("Add Your Photo", { exact: false }),
      "the inline upload prompt must NOT be shown when a profile photo already exists",
    ).toHaveCount(0);

    // 6. Create an identity meme via POST /api/memes — this must succeed for
    //    a non-Legendary registered user (no upload paywall).
    const createRes = await context.request.post("/api/memes", {
      headers: bearerHeaders(user.sid),
      data: {
        factId,
        imageSource: { type: "identity" },
        textOptions: {
          topText: "TOP",
          bottomText: "BOTTOM",
          fontFamily: "Impact",
          fontSize: 30,
          color: "#ffffff",
          outlineColor: "#000000",
          textEffect: "outline",
          outlineWidth: 5,
          allCaps: true,
          bold: true,
          italic: false,
          align: "center",
          opacity: 1,
        },
        isPublic: false,
        aspectRatio: "square",
      },
    });
    const created = (await ensureJsonOk("create identity meme", createRes)) as {
      permalinkSlug: string;
    };
    expect(created.permalinkSlug, "identity meme should be created with a slug").toBeTruthy();

    // 7. Verify the meme row in the DB resolved the identity source against
    //    the user's profile photo (the server rewrites identity → upload).
    const profileObjectPath = profileImageUrl.replace("/api/storage", "");
    const storedSourceRaw = dbExec(
      `SELECT image_source::text FROM memes WHERE permalink_slug='${escSql(created.permalinkSlug)}';`,
    ).trim();
    expect(storedSourceRaw, "meme row should exist with an image_source").toBeTruthy();
    const storedSource = JSON.parse(storedSourceRaw) as { type: string; uploadKey?: string };
    expect(storedSource.type, "identity meme should be persisted as an upload-typed source").toBe("upload");
    expect(
      storedSource.uploadKey,
      "the resolved upload key should point at the user's profile photo",
    ).toBe(profileObjectPath);

    // 8. Open the meme detail page with the deterministic
    //    `?just_created=1&source=photo` query params — that's how MemePage
    //    knows we just landed from the builder.
    await page.goto(`/meme/${created.permalinkSlug}?just_created=1&source=photo`, {
      waitUntil: "domcontentloaded",
    });

    // The dopamine-afterglow "What's next?" panel renders TWICE in the DOM:
    // once in the mobile pane (md:hidden) and once in the desktop pane
    // (hidden md:grid). The default Playwright viewport is desktop (1280×720)
    // so the desktop variant is the visible one. We assert two stable
    // signals from MemePage.tsx:
    //   1. The "Try AI mode" CTA (only rendered inside the afterglow path's
    //      AI card — `showAfterglowUpgrade ? <AI card> : <fallback rows>`),
    //      picked with `.last()` since the mobile variant is first in source.
    //   2. The creator-specific desktop subheader "Your meme is yours…"
    //      copy, which only renders when `isCreatorAfterglow` is true and
    //      that in turn requires the deterministic `?just_created=1&source=photo`
    //      query params we just landed with.
    const afterglowCta = page.getByRole("button", { name: /Try AI mode/i }).last();
    await expect(
      afterglowCta,
      "the dopamine-afterglow 'Try AI mode' CTA must be shown after creating a photo meme",
    ).toBeVisible();
    const creatorSubheader = page.getByText(/Your meme is yours\./).first();
    await expect(
      creatorSubheader,
      "the creator-afterglow desktop subheader must be shown when ?just_created=1&source=photo is set",
    ).toBeVisible();

    // 9. The "Turn this up to 11" Legendary upsell tile is suppressed when
    //    the afterglow card is shown (`showLegendaryTile = !showAfterglowUpgrade`).
    await expect(
      page.getByText("Turn this up to 11", { exact: false }),
      "the 'Turn this up to 11' tile must be suppressed when the afterglow card is shown",
    ).toHaveCount(0);

    await context.close();
  });

  test("registered user without a profile photo: inline upload prompt → upload promotes them out → photo becomes AI reference default", async ({ browser }) => {
    const suffix = Math.random().toString(36).slice(2, 10);
    const context = await browser.newContext();
    const page = await context.newPage();

    // 1. Register a fresh user. No profile photo is set yet — exactly what
    //    the inline upload prompt was built for.
    const user = await registerUser(context, suffix);
    const meRes = await context.request.get("/api/auth/user");
    const me = await meRes.json();
    expect(me.user?.email).toBe(user.email);
    expect(me.user?.profileImageUrl ?? null, "fresh user should have no profile photo yet").toBeFalsy();

    const factId = getActiveFactId();

    // 2. Open the Meme Builder. The "You" tab should still be the default
    //    active tab, and the inline "Add Your Photo" prompt should be shown.
    await page.goto(`/facts/${factId}/meme`, { waitUntil: "domcontentloaded" });

    const youTab = modeTabLocator(page, "You").first();
    await expect(youTab, "the 'You' mode tab should be visible").toBeVisible();
    await expect(
      youTab,
      "the 'You' tab should still be the default even when the user has no profile photo",
    ).toHaveClass(/text-primary/);

    await expect(
      page.getByText("Add Your Photo", { exact: false }).first(),
      "the inline 'Add Your Photo' prompt should be shown when no profile photo exists",
    ).toBeVisible();
    // The profile-preview img variant must NOT be present yet.
    await expect(
      page.locator('img[alt="Your profile photo"]'),
      "no profile-photo preview should render before the user uploads one",
    ).toHaveCount(0);

    // 3. Drive the upload through the same endpoints the inline prompt
    //    posts to (POST /api/storage/upload-avatar + PATCH /api/users/me).
    //    The session cookie on `context` is the same one the page uses, so
    //    after this PATCH the user row is updated server-side.
    const profileImageUrl = await setProfilePhotoFromFixture(context, user.sid, FIXTURE_PATH);
    expect(profileImageUrl).toMatch(/^\/api\/storage\/objects\//);

    // 4. Reload the Meme Builder so React picks up the new /api/auth/user
    //    payload. The inline upload prompt must be gone, replaced by the
    //    profile-photo preview (alt="Your profile photo").
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(
      page.locator('img[alt="Your profile photo"]').first(),
      "after upload, the 'You' tab should show the profile-photo preview",
    ).toBeVisible();
    await expect(
      page.getByText("Add Your Photo", { exact: false }),
      "after upload, the 'Add Your Photo' inline prompt must be gone",
    ).toHaveCount(0);

    // 5. Promote to Legendary so the AI Generated tab unlocks. The freshly
    //    uploaded profile photo should be reused as the default reference
    //    in the AI Reference Photo sub-mode.
    await setUserTier(user.email, "legendary");
    await page.reload({ waitUntil: "domcontentloaded" });

    // Open AI Generated → Reference Photo → Add New.
    await modeTabLocator(page, "AI Generated").first().click();
    await page.getByRole("button", { name: "Reference Photo", exact: true }).first().click();
    await page.getByRole("button", { name: /Add New/i }).first().click();

    // The displayedRefUploads list places the identity entry first and
    // tags it with a "You" badge. Its ImageCard alt is "Your profile photo".
    const refIdentityCard = page.locator('img[alt="Your profile photo"]').first();
    await expect(
      refIdentityCard,
      "the AI Reference Photo picker should surface the user's profile photo",
    ).toBeVisible();
    await expect(
      page.locator('span:has-text("You")').filter({ hasText: /^You$/ }).first(),
      "the AI Reference Photo picker should tag the identity entry with a 'You' badge",
    ).toBeVisible();
    await expect(
      page.getByText(/Reference selected/i).first(),
      "the identity entry should be auto-selected as the AI reference default",
    ).toBeVisible();

    await context.close();
  });
});

/**
 * Launch Phase 15, increment 2 — David's admin entry made safe, gesture
 * unchanged: triple-tap the wordmark and land on /admin, signed in as the
 * bootstrap admin.
 *
 * The session is now minted only by `POST /api/auth/dev-admin-login`, made
 * through the app's own fetch (so it passes the origin and CSRF checks), and
 * the route returns the session token in its body for the Replit canvas
 * iframe, which drops the cookie. The second test stands in for that iframe by
 * removing the Set-Cookie from the response: the admin screens must still open
 * on the stored Bearer token alone.
 *
 * Run: `pnpm --filter @workspace/overhype-me run e2e:surfaces`, with the dev
 * stack up (ENABLE_DEV_ADMIN_LOGIN=true, ALLOWED_ORIGINS naming the app's
 * origin) and the dev admin seeded (see `routeLoadSmoke.spec.ts`).
 */
import { expect, test, type Page } from "@playwright/test";
import { seedIdentity } from "./helpers/identity";

const DESKTOP = { width: 1280, height: 900 };

async function tripleTapWordmark(page: Page): Promise<void> {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const wordmark = page.getByRole("link", { name: "Overhype.me" }).filter({ visible: true }).first();
  await expect(wordmark).toBeVisible();
  await wordmark.click({ clickCount: 3 });
}

async function expectAdminDashboard(page: Page): Promise<void> {
  await expect(page).toHaveURL(/\/admin\/?$/, { timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "Access Denied" })).toHaveCount(0);
  await expect(page.getByText("Quick Actions", { exact: true })).toBeVisible({ timeout: 30_000 });
}

test.describe("Admin entry: the wordmark triple-tap (Phase 15, increment 2)", () => {
  test("triple-tapping the wordmark signs in through the POST and lands on /admin", async ({ browser }) => {
    const context = await browser.newContext({ viewport: DESKTOP });
    const page = await context.newPage();
    await seedIdentity(page);

    const methods: string[] = [];
    page.on("request", (req) => {
      if (new URL(req.url()).pathname === "/api/auth/dev-admin-login") methods.push(req.method());
    });

    await tripleTapWordmark(page);
    await expectAdminDashboard(page);

    expect(methods, "the gesture makes exactly one POST and never a GET").toEqual(["POST"]);
    const stored = await page.evaluate(() => localStorage.getItem("auth_token"));
    expect(stored, "the token from the body is stored in the Bearer slot").toBeTruthy();
    await context.close();
  });

  test("with the cookie dropped, as in the Replit canvas, the stored Bearer token still opens /admin", async ({ browser, playwright }) => {
    const context = await browser.newContext({ viewport: DESKTOP });
    const page = await context.newPage();
    await seedIdentity(page);

    // Forward the browser's POST from a separate request context, so its
    // Set-Cookie never reaches this browser (route.fetch() would share the
    // context's cookie jar), and hand the page the response without it.
    const outside = await playwright.request.newContext();
    await page.route("**/api/auth/dev-admin-login", async (route) => {
      const req = route.request();
      const response = await outside.fetch(req.url(), { method: req.method(), headers: req.headers(), data: req.postDataBuffer() ?? undefined });
      const headers = { ...response.headers() };
      delete headers["set-cookie"];
      await route.fulfill({ status: response.status(), headers, body: await response.body() });
    });

    await tripleTapWordmark(page);
    await expectAdminDashboard(page);

    const sid = (await context.cookies()).find((c) => c.name === "sid");
    expect(sid, "the test really dropped the session cookie").toBeUndefined();
    await outside.dispose();
    await context.close();
  });
});

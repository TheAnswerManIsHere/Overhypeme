/**
 * @purpose Real-browser checks of the identity flow's Phase 1 (#719, #722): the identity sheet opens for a cold visitor on every ordinary page including not-found and closes on save or another tab's save, never opens on sign-in pages, share links fill only what is missing, the first landing on a shared meme or fact shows its content and leaving asks, route builders wait for a complete identity, sign-out clears the browser copy, and signed-out capture sends no name to the server.
 * @subsystem public-site
 */
import { expect, test, type Page } from "@playwright/test";
import { factDetail, memeDetail, stubPublicFacts } from "./helpers/apiStubs";
import { seedIdentity } from "./helpers/identity";
import { FREE_ACCOUNT, TEST_ACCOUNT_PASSWORD, signInThroughForm } from "./helpers/testAccounts";

const DESKTOP = { width: 1280, height: 900 };
/** The sheet opens ~600 ms after the decision turns true; wait well past it before asserting absence. */
const PAST_OPEN_DELAY_MS = 1500;

function sheet(page: Page) {
  return page.getByTestId("identity-sheet").filter({ visible: true });
}

async function expectNoSheet(page: Page): Promise<void> {
  await page.waitForTimeout(PAST_OPEN_DELAY_MS);
  await expect(sheet(page)).toHaveCount(0);
}

async function saveIdentity(page: Page, name: string): Promise<void> {
  const s = sheet(page);
  await s.getByTestId("identity-name-input").fill(name);
  await s.getByTestId("identity-save").click();
  await expect(sheet(page)).toHaveCount(0);
}

function stored(page: Page) {
  return page.evaluate(() => ({
    name: localStorage.getItem("fact_db_name"),
    pronouns: localStorage.getItem("fact_db_pronouns"),
  }));
}

test.describe("Identity flow, Phase 1", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(DESKTOP);
  });

  test("a cold visitor is asked on Home, saving stores both halves, and a reload never asks again", async ({ page }) => {
    await stubPublicFacts(page, { facts: [] });
    await page.goto("/");
    await expect(sheet(page)).toBeVisible();
    await expect(sheet(page).getByRole("heading", { name: /what's your name\?/i })).toBeVisible();
    await saveIdentity(page, "Grace");
    expect(await stored(page)).toEqual({ name: "Grace", pronouns: expect.any(String) });
    await page.reload();
    await expectNoSheet(page);
  });

  test("the sheet opens on the not-found page and never on sign-in or password pages", async ({ page }) => {
    await page.goto("/no-such-page-e2e");
    await expect(sheet(page)).toBeVisible();
    for (const path of ["/login", "/forgot-password"]) {
      await page.goto(path);
      await expectNoSheet(page);
    }
  });

  test("signed-out capture suggests pronouns without sending the name to the server", async ({ page }) => {
    const suggestCalls: string[] = [];
    page.on("request", (r) => { if (r.url().includes("/api/ai/suggest-pronouns")) suggestCalls.push(r.url()); });
    await stubPublicFacts(page, { facts: [] });
    await page.goto("/");
    await sheet(page).getByTestId("identity-name-input").fill("Maria");
    await page.waitForTimeout(800);
    await sheet(page).getByTestId("identity-save").click();
    expect(suggestCalls).toEqual([]);
    expect((await stored(page)).pronouns).toBe("she/her");
  });

  test("a full share link sets both halves, never asks, and leaves the address bar clean", async ({ page }) => {
    await stubPublicFacts(page, { facts: [] });
    await page.goto("/?displayName=Grace&pronouns=they%2Fthem");
    await expectNoSheet(page);
    expect(await stored(page)).toEqual({ name: "Grace", pronouns: "they/them" });
    expect(new URL(page.url()).search).toBe("");
    await page.reload();
    await expectNoSheet(page);
  });

  test("a half share link sets its half and asks only for the other", async ({ page }) => {
    await stubPublicFacts(page, { facts: [] });
    await page.goto("/?displayName=Grace");
    await expect(sheet(page)).toBeVisible();
    await expect(sheet(page).getByRole("heading", { name: /pick your pronouns/i })).toBeVisible();
    await expect(sheet(page).getByTestId("identity-name-input")).toHaveValue("Grace");
  });

  test("a share link never overwrites the visitor's own identity", async ({ page }) => {
    await seedIdentity(page, "Ada", "she/her");
    await stubPublicFacts(page, { facts: [] });
    await page.goto("/?displayName=Grace&pronouns=he%2Fhim");
    await expectNoSheet(page);
    expect(await stored(page)).toEqual({ name: "Ada", pronouns: "she/her" });
  });

  test("another tab's save closes an open sheet", async ({ context, page }) => {
    await stubPublicFacts(page, { facts: [] });
    await page.goto("/top-facts");
    await expect(sheet(page)).toBeVisible();
    const other = await context.newPage();
    await other.setViewportSize(DESKTOP);
    await stubPublicFacts(other, { facts: [] });
    await other.goto("/top-facts");
    await saveIdentity(other, "Grace");
    await expect(sheet(page)).toHaveCount(0);
  });

  test("a shared meme shows its content first; leaving it by link or by search asks on the next page", async ({ page }) => {
    await stubPublicFacts(page, {
      facts: [factDetail({ id: 551, text: "{NAME} makes onions cry." })],
      memeDetails: [memeDetail({ id: 5511, factId: 551, permalinkSlug: "e2e-landing", factText: "Nick Baron makes onions cry." })],
      images: ["/api/memes/e2e-landing/image"],
    });
    await page.goto("/m/e2e-landing");
    await expect(page.locator('img[alt="Meme"]').filter({ visible: true })).toBeVisible();
    await expectNoSheet(page);

    // A new tab is a fresh visit to a landing page, and the original tab is unchanged.
    const link = page.getByRole("link", { name: /view full fact/i }).filter({ visible: true }).first();
    const [popup] = await Promise.all([page.context().waitForEvent("page"), link.click({ modifiers: ["Control"] })]);
    await popup.setViewportSize(DESKTOP);
    await stubPublicFacts(popup, { facts: [factDetail({ id: 551, text: "{NAME} makes onions cry." })] });
    await popup.waitForLoadState();
    await expectNoSheet(popup);
    await expectNoSheet(page);
    await popup.close();

    // An in-app link: the next page opens with the sheet over it.
    await link.click();
    await page.waitForURL((u) => u.pathname === "/facts/551");
    await expect(sheet(page)).toBeVisible();

    // Back to the landing page: the exception has lapsed for this visit, so it still asks.
    await page.goBack();
    await page.waitForURL((u) => u.pathname === "/m/e2e-landing");
    await expect(sheet(page)).toBeVisible();

    // Search submitted with Enter, from a fresh landing.
    await page.goto("/m/e2e-landing");
    await expectNoSheet(page);
    const search = page.getByPlaceholder("Search facts, hashtags…").filter({ visible: true }).first();
    await search.fill("onions");
    await search.press("Enter");
    await page.waitForURL((u) => u.pathname === "/search");
    await expect(sheet(page)).toBeVisible();
  });

  test("on a phone, tapping the wordmark to leave a shared meme asks on Home", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const phone = await context.newPage();
    await stubPublicFacts(phone, {
      facts: [factDetail({ id: 552, text: "{NAME} makes onions cry." })],
      memeDetails: [memeDetail({ id: 5521, factId: 552, permalinkSlug: "e2e-landing-phone", factText: "Nick Baron makes onions cry." })],
      images: ["/api/memes/e2e-landing-phone/image"],
    });
    await phone.goto("/m/e2e-landing-phone");
    await expectNoSheet(phone);
    // The mobile wordmark is a button that navigates on touchend and suppresses the click.
    await phone.locator("header button, nav button").filter({ hasText: /overhype/i }).filter({ visible: true }).first().tap();
    await phone.waitForURL((u) => u.pathname === "/");
    await expect(sheet(phone)).toBeVisible();
    await context.close();
  });

  test("on a short phone with custom pronouns open, the whole sheet scrolls into view and saves", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 375, height: 667 }, hasTouch: true, isMobile: true });
    const phone = await context.newPage();
    await stubPublicFacts(phone, { facts: [] });
    await phone.goto("/?displayName=Grace");
    const s = sheet(phone);
    await expect(s).toBeVisible();
    await s.getByRole("button", { name: /^custom(\.\.\.|…)$/i }).click();
    // The billboard's first line can be scrolled to the top of the screen.
    const headline = s.getByRole("heading", { level: 1 });
    await headline.scrollIntoViewIfNeeded();
    expect((await headline.boundingBox())!.y).toBeGreaterThanOrEqual(0);
    // And the save button below the custom fields can be reached and used.
    await s.getByRole("button", { name: "they/them" }).click();
    await s.getByTestId("identity-save").click();
    await expect(sheet(phone)).toHaveCount(0);
    expect(await stored(phone)).toEqual({ name: "Grace", pronouns: "they/them" });
    await context.close();
  });

  test("a nameless signed-in account never keeps a share link's identity, even across a reload before sign-in resolves", async ({ page }) => {
    // A signed-in account with no name, answered only once we release it.
    let release: () => void = () => {};
    let gate = new Promise<void>((r) => { release = r; });
    await page.route("**/api/auth/user", async (route) => {
      await gate;
      await route.fulfill({
        json: {
          user: { id: "e2e-nameless", email: "nameless@example.test", displayName: null, pronouns: null, role: "user" },
          entitlements: {},
        },
      });
    });
    await page.route("**/api/users/me", (route) => route.fulfill({ json: { displayName: null, pronouns: null } }));
    await stubPublicFacts(page, { facts: [] });

    await page.goto("/?displayName=Grace&pronouns=she%2Fher");
    await page.waitForTimeout(800);
    // Nothing from the link is written while sign-in is unresolved, and the link stays in the address bar.
    expect(await stored(page)).toEqual({ name: null, pronouns: null });
    expect(new URL(page.url()).searchParams.get("displayName")).toBe("Grace");

    // Reload in that window, then let sign-in resolve.
    gate = Promise.resolve();
    await page.reload();
    release();
    await expect.poll(() => new URL(page.url()).search).toBe("");
    expect(await stored(page)).toEqual({ name: null, pronouns: null });
    // The nameless account is asked for its own name rather than shown the recipient's.
    await expect(sheet(page)).toBeVisible();
    await expect(sheet(page).getByTestId("identity-name-input")).toHaveValue("");
  });

  for (const viewport of [DESKTOP, { width: 390, height: 844 }]) {
    test(`keyboard focus moves into the sheet and stays there (${viewport.width}px, name already known)`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await stubPublicFacts(page, { facts: [] });
      await page.goto("/?displayName=Grace");
      const s = sheet(page);
      await expect(s).toBeVisible();
      const insideSheet = () => s.evaluate((el) => el.contains(document.activeElement));
      await expect.poll(insideSheet).toBe(true);
      // Forward past the last control and backward past the first both stay inside.
      for (let i = 0; i < 25; i++) {
        await page.keyboard.press("Tab");
        expect(await insideSheet()).toBe(true);
      }
      for (let i = 0; i < 25; i++) {
        await page.keyboard.press("Shift+Tab");
        expect(await insideSheet()).toBe(true);
      }
    });
  }

  test("a cold visitor arriving at a builder route is asked first; the builder then starts with the saved name", async ({ page }) => {
    await stubPublicFacts(page, { facts: [factDetail({ id: 561, text: "{NAME} out-ran the weekend." })] });
    await page.goto("/facts/561/meme");
    await expect(sheet(page)).toBeVisible();
    await expect(page.getByTestId("step1-image-card")).toHaveCount(0);
    await saveIdentity(page, "Grace");
    await page.getByTestId("step1-image-card").click();
    await expect(page.getByText(/Grace out-ran the weekend/i).filter({ visible: true }).first()).toBeVisible();
  });

  test("signing out clears the browser copy, so the next page asks", async ({ page }) => {
    await signInThroughForm(page, FREE_ACCOUNT.email, TEST_ACCOUNT_PASSWORD);
    await page.goto("/profile");
    // Stored once (not by an init script, which would re-seed after the sign-out redirect).
    await page.evaluate(() => {
      localStorage.setItem("fact_db_name", "Ada");
      localStorage.setItem("fact_db_pronouns", "she/her");
    });
    await page.getByRole("button", { name: /sign out/i }).first().click();
    await page.waitForURL((u) => u.pathname === "/");
    await page.waitForLoadState("load");
    expect(await stored(page)).toEqual({ name: null, pronouns: null });
    await expect(sheet(page)).toBeVisible();
  });
});

/**
 * Admin Help — the parts a unit test cannot reach.
 *
 * PR472's search-index and `?`-map steps are already covered by
 * helpContent.test.ts and helpMap.test.ts, which run in CI. Duplicating them
 * in a browser would buy nothing. What those cannot check is whether the
 * manual RENDERS as a document and whether a cold deep link actually parks on
 * its heading — the scroll is a real-layout behaviour, and it is the step the
 * workstream issue singled out as most worth a human's eyes.
 *
 * Needs only the app and a database.
 */

import { expect, test, type Page } from "@playwright/test";

const CHAPTER = "11-admin-console";
const FRAGMENT = "managing-people";

/**
 * The manual has twelve numbered chapters. Asserted as a COUNT of chapter
 * links in the nav rather than as a list of titles: a dropped chapter is the
 * failure PR472 step 1 exists to catch, while a retitled one is ordinary
 * editing that should not turn this red. (Codex, #563 round 5.)
 */
const CHAPTER_COUNT = 12;

async function loginAsAdmin(page: Page) {
  const login = await page.context().request.post("/api/auth/dev-admin-login");
  expect(login.ok(), `dev-admin-login should be 200, got ${login.status()}`).toBe(true);
}

test.describe("Admin · Help", () => {
  test.beforeEach(async ({ page }) => loginAsAdmin(page));

  // PR472 step 1. The failure this guards is markdown reaching the page
  // unconverted — a table rendering as a run of "|" characters.
  test("renders the manual front page as a document, not as markdown source", async ({ page }) => {
    await page.goto("/admin/help", { waitUntil: "domcontentloaded" });
    const main = page.locator("main").first();
    await expect(main.getByRole("heading", { name: /The Overhype\.me Manual/i })).toBeVisible({ timeout: 30_000 });

    // A real table element, not pipes that happen to look like one.
    await expect(main.locator("table").first()).toBeVisible();
    await expect(main.getByText(/^\|.*\|$/m)).toHaveCount(0);

    // The WHOLE chapter list is navigable, not just one named chapter: a
    // front page missing eleven of twelve would satisfy a spot-check.
    const chapterNav = page.getByRole("navigation", { name: /Manual chapters/i });
    await expect(chapterNav).toBeVisible();
    await expect(
      chapterNav.locator('a[href*="/admin/help/"]'),
      "every numbered chapter should be linked from the nav",
    ).toHaveCount(CHAPTER_COUNT);

    await expect(page.getByTestId("help-search-input")).toBeVisible();
  });

  // PR472 step 2.
  test("renders a chapter as prose with real headings and lists", async ({ page }) => {
    await page.goto(`/admin/help/${CHAPTER}`, { waitUntil: "domcontentloaded" });
    const main = page.locator("main").first();

    // Gate on content from the CHAPTER, not on "any heading" -- the chapter
    // body is a dynamic import, and the surrounding nav has headings of its
    // own that are present long before it arrives. A snapshot count taken at
    // that moment measures the nav and nothing else.
    await expect(main.locator(`#${FRAGMENT}`)).toBeVisible({ timeout: 30_000 });

    // Scoped to the chapter body. <main> also contains the chapter nav, which
    // has headings and list items of its own -- so a chapter that rendered
    // nothing at all could have satisfied every count below.
    const body = main.locator("article");
    await expect(body, "the chapter should render in an article").toHaveCount(1);

    // toHaveCount retries; `expect(await locator.count())` does not, and would
    // race the same import all over again.
    await expect(body.locator("h2"), "a chapter should have section headings").not.toHaveCount(0);
    await expect(body.locator("h3"), "a chapter should have sub-headings").not.toHaveCount(0);
    await expect(body.locator("li"), "a chapter should render list items").not.toHaveCount(0);
    await expect(body.getByText(/^#{1,6}\s/m), "no raw markdown heading markers").toHaveCount(0);
  });

  // PR472 step 3 — the cold-load path, which is the one that used to break.
  // Asserted as real scroll position: an anchor that merely EXISTS satisfies
  // helpContent.test.ts already, and would satisfy nothing a reader cares
  // about if the page still opened at the top.
  test("a cold deep link parks on its heading, not the chapter top", async ({ page }) => {
    await page.goto(`/admin/help/${CHAPTER}#${FRAGMENT}`, { waitUntil: "domcontentloaded" });
    const heading = page.locator(`#${FRAGMENT}`);
    await expect(heading).toBeVisible({ timeout: 30_000 });

    // Settle any post-mount scrolling before measuring.
    await page.waitForTimeout(1_500);

    // A scroll must actually have HAPPENED. Position alone only catches this
    // because #managing-people sits below the fold in today's chapter 11 -- move
    // it up, or point this at a shorter chapter, and "never scrolled" would pass
    // while looking identical. Note the window does NOT scroll here: the admin
    // console scrolls an inner pane, so window.scrollY stays 0 either way.
    const scrolled = await heading.evaluate((el) => {
      for (let n = el.parentElement; n; n = n.parentElement) {
        const style = getComputedStyle(n);
        if (/(auto|scroll)/.test(style.overflowY) && n.scrollHeight > n.clientHeight + 4) {
          return n.scrollTop;
        }
      }
      return window.scrollY;
    });
    expect(
      scrolled,
      `the scrolling pane should have moved off its top (scrollTop=${scrolled})`,
    ).toBeGreaterThan(0);

    // ...and it must have landed ON the heading, near the top of the pane
    // rather than merely somewhere on screen.
    const box = await heading.boundingBox();
    expect(box, "the target heading should have a layout box").not.toBeNull();
    const viewport = page.viewportSize();
    expect(viewport, "viewport size should be known").not.toBeNull();
    expect(
      box!.y,
      `the heading should be parked near the top (y=${box!.y}, viewport=${viewport!.height})`,
    ).toBeLessThan(viewport!.height / 2);
    expect(box!.y, `the heading should not be scrolled off the top (y=${box!.y})`).toBeGreaterThan(-1);
  });

  // PR472 step 13. "Tidily" is the recovery, not just the absence of a blank
  // page -- a panel that says "No such chapter" and strands the reader is not
  // what the step asks for, and asserting only the container would pass if the
  // way back disappeared. (Codex, #563 round 5.)
  test("a stale bookmark fails tidily, with a way back", async ({ page }) => {
    await page.goto("/admin/help/99-no-such-chapter", { waitUntil: "domcontentloaded" });
    const panel = page.getByTestId("help-not-found");
    await expect(panel).toBeVisible({ timeout: 30_000 });
    await expect(panel.getByText(/No such chapter/i)).toBeVisible();

    const back = panel.locator('a[href$="/admin/help"]');
    await expect(back, "the panel should offer a link back to the manual").toHaveCount(1);
    await back.click();
    await expect(
      page.getByRole("heading", { name: /The Overhype\.me Manual/i }),
      "following it should reach the manual front page",
    ).toBeVisible({ timeout: 30_000 });
  });
});

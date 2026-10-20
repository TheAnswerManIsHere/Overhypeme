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

import { expect, test, type Locator, type Page } from "@playwright/test";
import { csrfToken } from "./helpers/testAccounts";

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

/**
 * Where an element sits in the admin shell's scrolling pane. The console
 * scrolls an inner pane, not the window, so "parked on a heading" is the
 * pane's scrollTop and the heading's distance below the pane's top edge.
 */
async function paneScroll(target: Locator): Promise<{ scrollTop: number; offset: number }> {
  return target.evaluate((el) => {
    for (let n = el.parentElement; n; n = n.parentElement) {
      const style = getComputedStyle(n);
      if (/(auto|scroll)/.test(style.overflowY) && n.scrollHeight > n.clientHeight + 4) {
        return { scrollTop: n.scrollTop, offset: el.getBoundingClientRect().top - n.getBoundingClientRect().top };
      }
    }
    return { scrollTop: window.scrollY, offset: el.getBoundingClientRect().top };
  });
}

/** Parked = the pane has scrolled, and the heading sits at its top edge (allowing the heading's scroll margin). */
async function expectParkedOn(heading: Locator, step: string): Promise<void> {
  await expect(heading, `${step}: the target heading should be rendered`).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(async () => (await paneScroll(heading)).scrollTop, { message: `${step}: the pane should have scrolled off the chapter top` })
    .toBeGreaterThan(0);
  await expect
    .poll(async () => (await paneScroll(heading)).offset, { message: `${step}: the heading should be parked at the top of the pane` })
    .toBeLessThan(64);
  expect((await paneScroll(heading)).offset, `${step}: the heading should not be scrolled off the top`).toBeGreaterThan(-2);
}

/**
 * Marks the current document so a later check can tell an in-app (router)
 * navigation from a full page load, which would discard the mark.
 */
async function markDocument(page: Page): Promise<void> {
  await page.evaluate(() => { (window as unknown as { __e2eSameDocument?: boolean }).__e2eSameDocument = true; });
}
async function isSameDocument(page: Page): Promise<boolean> {
  return page.evaluate(() => (window as unknown as { __e2eSameDocument?: boolean }).__e2eSameDocument === true);
}

interface ResultRow { href: string; section: string; chapter: string; text: string }

/** Every search result row as the reader sees it: its link, its section name, its chapter name, its text. */
async function searchResultRows(page: Page): Promise<ResultRow[]> {
  return page.getByTestId("help-search-results").locator("a").evaluateAll((rows) =>
    rows.map((a) => {
      const spans = a.querySelectorAll("span");
      return {
        href: a.getAttribute("href") ?? "",
        section: spans[0]?.textContent?.trim() ?? "",
        chapter: spans[1]?.textContent?.trim() ?? "",
        text: (a.textContent ?? "").replace(/\s+/g, " "),
      };
    }),
  );
}

/** The sidebar labels, top to bottom: every item kept from before PR472, then Help. */
const KEPT_SIDEBAR = [
  "Dashboard", "Facts", "Users", "Moderation", "Eval", "Billing", "Refunds & Disputes", "Affiliate",
  "Video Styles", "Engines", "Taxonomy Health", "Email Queue", "Queue Health", "Features", "Configuration",
];

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

    // The chapter table specifically -- the front page's FIRST table is a
    // different one -- found by its "Chapter" column header.
    const chapterTable = main.locator("table").filter({ has: page.locator("th", { hasText: /^Chapter$/ }) });
    await expect(chapterTable, "PR472 step 1: one table should list the chapters").toHaveCount(1);
    await expect(
      chapterTable.locator("tbody tr td:first-child"),
      "PR472 step 1: the chapter table should list chapters 1-12, in order",
    ).toHaveText(Array.from({ length: CHAPTER_COUNT }, (_, i) => String(i + 1)));
    const cellBorder = await chapterTable.locator("td").first().evaluate((el) => {
      const s = getComputedStyle(el);
      return `${s.borderTopStyle} ${s.borderTopWidth} ${s.borderLeftStyle} ${s.borderLeftWidth}`;
    });
    expect(cellBorder, "PR472 step 1: the chapter table's cells should be bordered").toMatch(
      /^solid [0-9.]*[1-9][0-9.]*px solid [0-9.]*[1-9][0-9.]*px$/,
    );

    // "Down the left on a wide screen": the nav ends before the content starts.
    const navBox = await chapterNav.boundingBox();
    const articleBox = await main.locator("article").boundingBox();
    expect(navBox && articleBox, "the chapter list and the content should both have layout boxes").toBeTruthy();
    expect(
      navBox!.x + navBox!.width,
      `PR472 step 1: the chapter list (x=${navBox!.x}) should sit left of the content (x=${articleBox!.x})`,
    ).toBeLessThanOrEqual(articleBox!.x);
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

    // "Inside the console": the admin sidebar and the header still frame it.
    await expect(
      page.locator("aside nav").first().getByRole("link", { name: "Dashboard" }),
      "PR472 step 13: the admin sidebar should still be beside the No such chapter panel",
    ).toBeVisible();
    await expect(
      page.locator("main header h1"),
      "PR472 step 13: the panel should sit under the console's own header",
    ).toHaveText("Help");
    await expect(
      page.locator("main").locator('[data-testid="help-not-found"]'),
      "PR472 step 13: the panel should be inside the console's content area",
    ).toHaveCount(1);

    const back = panel.locator('a[href$="/admin/help"]');
    await expect(back, "the panel should offer a link back to the manual").toHaveCount(1);
    await back.click();
    await expect(
      page.getByRole("heading", { name: /The Overhype\.me Manual/i }),
      "following it should reach the manual front page",
    ).toBeVisible({ timeout: 30_000 });
  });

  // PR472 steps 2, 4 and 12, in one visit: chapters opened by clicking, an
  // in-chapter link into another chapter's section, and a link out to GitHub.
  test("chapters open in-app by click, in-chapter links keep their section, GitHub opens in a new tab", async ({ page }) => {
    await page.goto("/admin/help", { waitUntil: "domcontentloaded" });
    const main = page.locator("main").first();
    const body = main.locator("article");
    const chapterNav = page.getByRole("navigation", { name: /Manual chapters/i });
    await expect(chapterNav).toBeVisible({ timeout: 30_000 });
    await markDocument(page);

    // Step 2: from the front page, click Chapter 3 · Moderation in the list.
    await chapterNav.locator('a[href$="/admin/help/3-moderation"]').click();
    await expect(page, "PR472 step 2: clicking Chapter 3 should open /admin/help/3-moderation").toHaveURL(/\/admin\/help\/3-moderation$/);
    await expect(
      body.getByRole("heading", { level: 1, name: /Chapter 3 · Moderation/ }),
      "PR472 step 2: Chapter 3's body should render",
    ).toBeVisible({ timeout: 30_000 });
    expect(await isSameDocument(page), "PR472 step 2: the chapter should open in-app, not by a page load").toBe(true);

    // Step 2: bold, bullet lists, and a table or quoted block, rendered as such.
    const strongWeight = await body.locator("strong").first().evaluate((el) => Number(getComputedStyle(el).fontWeight));
    expect(strongWeight, "PR472 step 2: bold text should render bold").toBeGreaterThanOrEqual(600);
    const bullet = await body.locator("ul").first().evaluate((el) => getComputedStyle(el).listStyleType);
    expect(bullet, "PR472 step 2: bullet lists should render with bullets").toBe("disc");
    await expect(body.locator("ul > li").first(), "PR472 step 2: a bullet list should render its items").toBeVisible();
    await expect(
      body.locator("table, blockquote").first(),
      "PR472 step 2: a table or quoted block should render inside the chapter",
    ).toBeVisible();
    await expect(body.getByText(/\*\*\S/), "PR472 step 2: no raw markdown bold markers").toHaveCount(0);

    // Step 4: click a chapter in the list, then a link in it into ANOTHER
    // chapter's section. Chosen from the chapter, not hard-coded, so a reworded
    // link does not turn this red.
    await chapterNav.locator('a[href$="/admin/help/5-visual-pipeline"]').click();
    await expect(body.getByRole("heading", { level: 1, name: /Chapter 5/ })).toBeVisible({ timeout: 30_000 });
    const crossLink = body
      .locator('a[data-help-internal*="#"]:not([data-help-internal^="/admin/help/5-visual-pipeline"])')
      .first();
    const target = await crossLink.getAttribute("data-help-internal");
    expect(target, "chapter 5 should link to a section of another chapter").toMatch(/^\/admin\/help\/[^#/]+#.+/);
    const [targetPath, targetFragment] = target!.split("#");
    await crossLink.click();
    await expect
      .poll(() => new URL(page.url()).pathname, { message: "PR472 step 4: the link should open the other chapter" })
      .toBe(targetPath);
    expect(await isSameDocument(page), "PR472 step 4: the link should navigate inside the console, not reload the page").toBe(true);
    await expect(page, "PR472 step 4: the address should carry the section").toHaveURL(new RegExp(`#${targetFragment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
    await expectParkedOn(body.locator(`[id="${targetFragment}"]`), "PR472 step 4");

    // Step 12: a link out of the Manual. GitHub itself is answered locally --
    // the step is about the tab, not about GitHub being reachable from CI.
    await page.context().route("https://github.com/**", (route) =>
      route.fulfill({ status: 200, contentType: "text/html", body: "<title>GitHub</title>" }),
    );
    const outLink = body.locator('a[href^="https://github.com/"]').first();
    await outLink.scrollIntoViewIfNeeded();
    const urlBefore = page.url();
    const placeBefore = await paneScroll(outLink);
    const popupPromise = page.waitForEvent("popup", { timeout: 10_000 }).catch(() => null);
    await outLink.click();
    const popup = await popupPromise;
    expect(popup, "PR472 step 12: a link out of the Manual should open a new tab").not.toBeNull();
    await expect(popup!, "PR472 step 12: the new tab should be GitHub").toHaveURL(/^https:\/\/github\.com\//);
    await popup!.close();
    expect(page.url(), "PR472 step 12: the console tab should stay on the same chapter and section").toBe(urlBefore);
    expect(
      (await paneScroll(outLink)).scrollTop,
      "PR472 step 12: the reader's place in the chapter should be undisturbed",
    ).toBe(placeBefore.scrollTop);
    await expect(body.getByRole("heading", { level: 1 }), "PR472 step 12: the chapter should still be on screen").toBeVisible();
  });

  // PR472 steps 5-9, in one visit. Each row is read as a reader sees it.
  test("search results name their section and chapter, land where they say, and skip what is not prose", async ({ page }) => {
    await page.goto("/admin/help", { waitUntil: "domcontentloaded" });
    const chapterNav = page.getByRole("navigation", { name: /Manual chapters/i });
    await expect(chapterNav).toBeVisible({ timeout: 30_000 });
    const titleBySlug = new Map(
      await chapterNav.locator('a[href*="/admin/help/"]').evaluateAll((as) =>
        as.map((a) => [a.getAttribute("href")!.split("/").pop()!, a.querySelector("span.min-w-0")?.textContent?.trim() ?? ""] as [string, string]),
      ),
    );
    const search = page.getByTestId("help-search-input");
    const results = page.getByTestId("help-search-results");

    async function resultsFor(term: string, step: string): Promise<ResultRow[]> {
      await search.fill(term);
      await expect(results.locator("a").first(), `${step}: searching "${term}" should list results`).toBeVisible({ timeout: 30_000 });
      return searchResultRows(page);
    }
    // A row names its location when its section is named and its chapter is
    // named as THE chapter the row links to.
    function expectRowsNameLocation(rows: ResultRow[], term: string, step: string): void {
      for (const row of rows) {
        const [path, fragment] = row.href.split("#");
        const slug = path.split("/").pop()!;
        expect(fragment, `${step}: "${term}" row "${row.text}" should point at a section`).toBeTruthy();
        expect(row.section, `${step}: "${term}" row "${row.text}" should name its section`).not.toBe("");
        expect(row.chapter, `${step}: "${term}" row "${row.text}" should name its chapter`).toBe(titleBySlug.get(slug));
      }
    }

    // Step 5.
    const visual = await resultsFor("visual concept", "PR472 step 5");
    expectRowsNameLocation(visual, "visual concept", "PR472 step 5");

    // Step 6: click a result. The LAST row, being the weakest match, is the one
    // least likely to be a chapter's opening section -- so landing on it is a
    // real scroll, not the chapter top.
    const chosen = visual[visual.length - 1];
    const [chosenPath, chosenFragment] = chosen.href.split("#");
    await markDocument(page);
    await results.locator("a").last().click();
    await expect
      .poll(() => new URL(page.url()).pathname, { message: "PR472 step 6: the result should open its own chapter" })
      .toBe(chosenPath);
    expect(new URL(page.url()).hash, "PR472 step 6: the address should carry the result's section").toBe(`#${chosenFragment}`);
    expect(await isSameDocument(page), "PR472 step 6: the result should navigate in-app").toBe(true);
    await expectParkedOn(page.locator("main article").locator(`[id="${chosenFragment}"]`), "PR472 step 6");

    // Step 7: other terms, the same shape, and relevant to the term.
    for (const term of ["moderation", "stale"]) {
      const rows = await resultsFor(term, "PR472 step 7");
      expectRowsNameLocation(rows, term, "PR472 step 7");
      for (const row of rows) {
        expect(row.text.toLowerCase(), `PR472 step 7: "${term}" row "${row.text}" should contain the term`).toContain(term);
      }
    }

    // Steps 8 and 9: text that is only in links, and the unindexed front page.
    for (const [term, step] of [["ai-context/glossary.md", "PR472 step 8"], ["Chapter quality bar", "PR472 step 9"]]) {
      await search.fill(term);
      await expect(results.getByText(`No matches for “${term}”.`), `${step}: searching "${term}" should say No matches`).toBeVisible({ timeout: 30_000 });
      await expect(results.locator("a"), `${step}: searching "${term}" should show no result rows`).toHaveCount(0);
    }
  });

  // PR472 R1-R5: the console chrome Help was added to, in one visit.
  test("the console around Help: sidebar order, Moderation badge, collapse, phone drawer, View Site, Sign Out", async ({ page }) => {
    // A pending fact review, so the Moderation badge has something to count.
    // Submitted as the admin, who skips onboarding and the submit throttle,
    // and rejected again at the end so no other spec sees it.
    await page.request.get("/api/auth/user");
    const submit = await page.request.post("/api/facts/submit-review", {
      headers: { "x-csrf-token": await csrfToken(page) },
      data: { text: `{NAME} can out-wait a stopped clock (e2e ${Date.now()}).` },
    });
    expect(submit.status(), "a review submission should be accepted").toBe(201);
    const { reviewId } = (await submit.json()) as { reviewId: number };
    try {
      await page.goto("/admin/help", { waitUntil: "domcontentloaded" });
      const sidebar = page.locator("aside").filter({ has: page.getByRole("button", { name: /sidebar/i }) });
      await expect(sidebar.locator("nav a").first()).toBeVisible({ timeout: 30_000 });

      // R1.
      const labels = await sidebar.locator("nav a").evaluateAll((as) => as.map((a) => a.querySelector("span.flex-1")?.textContent ?? ""));
      expect(labels.filter((l) => l !== "Help"), "PR472 R1: the sidebar should keep its items in the same order").toEqual(KEPT_SIDEBAR);
      expect(labels[labels.length - 1], "PR472 R1: Help should be the last sidebar item").toBe("Help");

      // R2: the badge is the pending reviews plus pending comments.
      const [reviews, comments] = await Promise.all([
        page.request.get("/api/admin/reviews/count").then((r) => r.json() as Promise<{ total: number }>),
        page.request.get("/api/admin/comments/pending/count").then((r) => r.json() as Promise<{ total: number }>),
      ]);
      const pending = reviews.total + comments.total;
      expect(pending, "the submitted review should be pending").toBeGreaterThan(0);
      await expect(
        sidebar.locator('nav a[href="/admin/moderation"] span.rounded-full'),
        "PR472 R2: the Moderation item should carry a badge counting pending reviews and comments",
      ).toHaveText(String(pending));

      // R3: collapse narrows the sidebar; each icon keeps a tooltip naming its page.
      const wide = (await sidebar.boundingBox())!.width;
      await sidebar.getByRole("button", { name: /Collapse sidebar/i }).click();
      await expect
        .poll(async () => (await sidebar.boundingBox())!.width, { message: `PR472 R3: the sidebar (was ${wide}px) should collapse` })
        .toBeLessThan(wide / 2);
      await expect(sidebar.locator("nav a span.flex-1"), "PR472 R3: collapsed, the labels should be gone").toHaveCount(0);
      const tooltips = await sidebar.locator("nav a > div").evaluateAll((ds) => ds.map((d) => d.getAttribute("title")));
      expect(tooltips, "PR472 R3: every collapsed icon should have a tooltip naming its page").toEqual([...KEPT_SIDEBAR, "Help"]);
      await sidebar.getByRole("button", { name: /Expand sidebar/i }).click();

      // R4: at phone width the hamburger opens the drawer, and it closes again.
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByRole("button", { name: "Open menu" }).click();
      const drawer = page.locator("aside").filter({ has: page.getByRole("button", { name: "Close menu" }) });
      await expect(drawer, "PR472 R4: the hamburger should open the drawer").toBeVisible();
      // A trailing digit run is the Moderation badge, which the drawer shows too.
      await expect(drawer.locator("nav a"), "PR472 R4: the drawer should list every nav item").toHaveText(
        [...KEPT_SIDEBAR, "Help"].map((label) => new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\d*$`)),
      );
      await drawer.getByRole("button", { name: "Close menu" }).click();
      await expect(drawer, "PR472 R4: the drawer should close again").toHaveCount(0);
      await page.setViewportSize({ width: 1280, height: 720 });

      // R5: both in the top bar, View Site then Sign Out, and both work.
      const header = page.locator("main header");
      const viewSite = header.getByText("View Site", { exact: true });
      const signOut = header.getByRole("button", { name: "Sign Out" });
      await expect(viewSite, "PR472 R5: View Site should be in the top bar").toBeVisible();
      await expect(signOut, "PR472 R5: Sign Out should be in the top bar").toBeVisible();
      expect((await viewSite.boundingBox())!.x, "PR472 R5: View Site should sit left of Sign Out").toBeLessThan((await signOut.boundingBox())!.x);
      await viewSite.click();
      await expect
        .poll(() => new URL(page.url()).pathname, { message: "PR472 R5: View Site should go to the home page" })
        .toBe("/");
      await page.goBack();
      await header.getByRole("button", { name: "Sign Out" }).click();
      await expect
        .poll(async () => ((await (await page.request.get("/api/auth/user")).json()) as { user: unknown }).user ?? null, {
          message: "PR472 R5: Sign Out should end the session",
        })
        .toBeNull();
    } finally {
      await loginAsAdmin(page);
      await page.request.get("/api/auth/user");
      const reject = await page.request.post(`/api/admin/reviews/${reviewId}/reject`, {
        headers: { "x-csrf-token": await csrfToken(page) },
        data: { rejectionReason: "spam" },
      });
      expect(reject.ok(), `cleanup: rejecting review ${reviewId} → ${reject.status()}`).toBe(true);
    }
  });
});

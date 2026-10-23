/**
 * Public described screens (#631, Phase 2 increment 8, plan D1 and D8).
 *
 * Each test answers one UAT step's screen clause that used to be deferred to
 * "increment 8 (capture and read)": the step's Expect names the elements, text
 * and states a reader would check, and the test asserts exactly those in a
 * real browser against the dev stack. The step cites its test by name.
 *
 * Data: the dev stack's database has no facts, and an active fact can only be
 * made through the moderation pipeline, which needs AI doubles this stack
 * does not run. So the fact, meme and list endpoints are answered by typed
 * stubs (`helpers/apiStubs.ts`); the session, sign-in, config and every other
 * request reach the real server. What the API returns for these facts is
 * asserted in the API suite, which each step's other clauses cite.
 *
 * Run: `pnpm --filter @workspace/overhype-me run e2e:screens`, with the dev
 * stack up and the E2E test accounts seeded (same prerequisites as the other
 * suites; see `routeLoadSmoke.spec.ts`).
 */
import { expect, test, type Page } from "@playwright/test";
import { factDetail, memeDetail, memeItem, stubPublicFacts } from "./helpers/apiStubs";
import { brandOrangeRgb } from "./helpers/brandTokens";
import { FREE_ACCOUNT, TEST_ACCOUNT_PASSWORD, signInThroughForm } from "./helpers/testAccounts";
import { seedIdentity } from "./helpers/identity";

const DESKTOP = { width: 1280, height: 900 };

/** Open the meme builder from /facts/:id/meme; it opens directly on the image step. */
async function openImageStep(page: Page, factId: number): Promise<void> {
  await page.goto(`/facts/${factId}/meme`);
  await expect(page.getByText("Build your meme", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Make my meme" })).toBeVisible();
}

test.describe("Public described screens", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(DESKTOP);
  });

  // PR308 step 1 — ordinary browsing shows the usual layout and content.
  test("home, Top Facts and a fact page show their usual layout and content", async ({ page }) => {
    const facts = [
      factDetail({ id: 501, text: "{NAME} counted to infinity. Twice.", hashtags: ["math"] }),
      factDetail({ id: 502, text: "{NAME} can slam a revolving door.", hashtags: ["doors"] }),
    ];
    await stubPublicFacts(page, { facts });

    await page.goto("/");
    const navbar = page.getByRole("navigation").first();
    await expect(navbar.getByRole("link", { name: "Overhype.me" })).toBeVisible();
    await expect(navbar.getByPlaceholder("Search facts, hashtags…")).toBeVisible();
    await expect(navbar.getByRole("button", { name: /sign in/i })).toBeVisible();
    for (const link of ["Facts", "Top Facts", "Library"]) {
      await expect(page.getByRole("link", { name: link, exact: true })).toBeVisible();
    }
    await expect(page.getByText("About David Franklin").filter({ visible: true })).toBeVisible();
    // A cold visitor is asked for their name by the identity sheet (#719), not by a box on Home.
    await expect(page.getByTestId("identity-sheet").filter({ visible: true })).toBeVisible();
    await expect(page.getByPlaceholder("Type your first name…")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "For you" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 3, name: /counted to infinity\. twice\./i })).toBeVisible();
    await expect(page.getByRole("heading", { level: 3, name: /can slam a revolving door\./i })).toBeVisible();
    await expect(page.getByText(/error loading facts/i)).toHaveCount(0);
    await expect(page.getByText("Something broke")).toHaveCount(0);
    expect(new URL(page.url()).pathname).toBe("/");

    await page.goto("/top-facts");
    await expect(page.getByRole("heading", { level: 1, name: /the facts everyone's memeing/i })).toBeVisible();
    for (const period of ["This week", "This month", "All time"]) {
      await expect(page.getByRole("button", { name: period, exact: true })).toBeVisible();
    }
    await expect(page.getByText("#1 This week")).toBeVisible();
    await expect(page.getByRole("heading", { name: /counted to infinity/i })).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/top-facts");

    await page.goto("/facts/501");
    await expect(page.getByRole("heading", { level: 1, name: /counted to infinity\. twice\./i })).toBeVisible();
    await expect(page.getByRole("button", { name: /make a meme of this/i }).first()).toBeVisible();
    await expect(page.getByRole("heading", { name: "Memes from this fact" })).toBeVisible();
    await expect(page.getByText("Something broke")).toHaveCount(0);
    expect(new URL(page.url()).pathname).toBe("/facts/501");
  });

  // PR398 R5 — the name highlight in fact text elsewhere in the app is the brand orange.
  test("the name inside fact text is drawn in the brand orange", async ({ page }) => {
    const orange = brandOrangeRgb();
    await stubPublicFacts(page, { facts: [] });
    await page.goto("/");

    // The cold-visitor card's fact, with its sample name (Home's own card, not the identity sheet's billboard).
    const teaser = page.locator("main").getByRole("heading", { name: /pushes it/i });
    await expect(teaser).toBeVisible();
    const name = teaser.getByText("David Franklin", { exact: true });
    await expect(name).toHaveCSS("color", orange);
    // The rest of the sentence is not highlighted.
    await expect(teaser.getByText(/the universe doesn't expand/i)).not.toHaveCSS("color", orange);

    // A feed card, once the visitor has given a name of their own.
    await seedIdentity(page, "Nick Baron");
    await stubPublicFacts(page, { facts: [factDetail({ id: 511, text: "{NAME} makes onions cry." })] });
    await page.goto("/");
    const card = page.getByRole("heading", { name: /makes onions cry/i }).first();
    await expect(card).toBeVisible();
    await expect(card.getByText("Nick Baron", { exact: true })).toHaveCSS("color", orange);
    await expect(card.getByText(/makes onions cry/i)).not.toHaveCSS("color", orange);
  });

  // PR256 step 1 — a variant with no images of its own shows none, not its root's.
  test("a variant with no images of its own shows no AI images on its fact page or in its meme builder", async ({ page }) => {
    const rootImages = {
      male: ["/api/storage/objects/e2e/root-ai-male.png"],
      female: ["/api/storage/objects/e2e/root-ai-female.png"],
      neutral: ["/api/storage/objects/e2e/root-ai-neutral.png"],
    };
    const requested = await stubPublicFacts(page, {
      facts: [
        factDetail({ id: 521, text: "{NAME} makes onions cry.", aiMemeImages: rootImages }),
        factDetail({ id: 522, text: "{NAME} makes onions weep.", parentId: 521, aiMemeImages: null }),
      ],
    });
    const rootImagePaths = Object.values(rootImages).flat();
    // A builder waits for a complete identity (#719); this test is about images, not the sheet.
    await seedIdentity(page);
    const imageRequests: string[] = [];
    page.on("request", (r) => {
      if (r.resourceType() === "image") imageRequests.push(new URL(r.url()).pathname);
    });

    await page.goto("/facts/522");
    await expect(page.getByText("View Original Fact #521")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Memes from this fact" })).toBeVisible();
    await expect(page.getByText("No community memes yet. Be the first!")).toBeVisible();

    await openImageStep(page, 522);
    // Nothing of the root's is offered. The AI source went with PuLID (launch Phase 4,
    // removal 3) and the stock source with Pexels (removal 6), so the step has one
    // source -- the viewer's own photo (this logged-out viewer is asked to sign up for it)
    // -- and no source switcher at all.
    await expect(page.getByText("Sign up to create a meme using your photo")).toBeVisible();
    await expect(page.getByRole("tablist", { name: "Source" })).toHaveCount(0);
    await expect(page.getByRole("tab", { name: /ai you|stock/i })).toHaveCount(0);
    const rendered = await page.locator("img").evaluateAll((els) => els.map((e) => new URL((e as HTMLImageElement).src).pathname));
    for (const p of rootImagePaths) {
      expect(rendered, `the variant's pages must not render the root's AI image ${p}`).not.toContain(p);
      expect(imageRequests, `the variant's pages must not load the root's AI image ${p}`).not.toContain(p);
    }
    expect(
      requested.filter((u) => new URL(u).pathname.startsWith("/api/facts/521")),
      "the variant's pages must not read the root fact",
    ).toEqual([]);
  });

  // PR256 R2 — the public feed and a root fact's detail page, every section present.
  test("the public feed and a root fact's detail page show every section", async ({ page }) => {
    const root = factDetail({
      id: 531,
      text: "{NAME} does not sleep. {Subj} {waits|wait}.",
      hashtags: ["legend", "night"],
      commentCount: 0,
      variants: [{ ...factDetail({ id: 532, text: "{NAME} never sleeps.", parentId: 531 }) }],
    });
    const variant = factDetail({ id: 532, text: "{NAME} never sleeps.", parentId: 531, useCase: "short" });
    const other = factDetail({ id: 533, text: "{NAME} can divide by zero.", hashtags: ["math"] });
    await stubPublicFacts(page, {
      facts: [root, variant, other],
      memes: { 531: [memeItem({ id: 5311, factId: 531, permalinkSlug: "e2e-root-meme" })] },
      related: { 531: [other] },
      images: ["/api/memes/e2e-root-meme/image"],
    });

    await page.goto("/");
    await expect(page.getByRole("heading", { name: /does not sleep/i })).toBeVisible();
    await expect(page.getByRole("heading", { name: /can divide by zero/i })).toBeVisible();
    await expect(page.getByRole("link", { name: "#legend" }).first()).toBeVisible();

    await page.goto("/facts/531");
    await expect(page.getByRole("heading", { level: 1, name: /does not sleep/i })).toBeVisible();
    await expect(page.getByRole("link", { name: "#night" })).toBeVisible();
    await expect(page.getByRole("button", { name: "12", exact: true }).first()).toBeVisible(); // upvotes
    await expect(page.getByRole("button", { name: "Downvote" }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /make a meme of this/i }).first()).toBeVisible();
    await expect(page.getByRole("heading", { name: "Memes from this fact" })).toBeVisible();
    await expect(page.getByText("1 total")).toBeVisible();
    // The All / Images / Videos filter went with video (launch Phase 4).
    await expect(page.getByRole("button", { name: "Videos", exact: true })).toHaveCount(0);
    await expect(page.getByRole("combobox", { name: "Sort memes" })).toHaveValue("top");
    await expect(page.locator('img[src$="/api/memes/e2e-root-meme/image"]')).toBeVisible();
    await expect(page.getByText(/comments \(0\)/i)).toBeVisible();
    await expect(page.getByRole("heading", { name: /alternate phrasings \(1\)/i })).toBeVisible();
    await expect(page.getByRole("heading", { name: "More facts you'll like" })).toBeVisible();
    await expect(page.getByText("View Original Fact")).toHaveCount(0);
    await expect(page.getByText("Something broke")).toHaveCount(0);
  });

  // PR398 step 2 — the meme page's caption is the personalized sentence.
  test("the meme page shows the creator's personalized sentence as its caption", async ({ page }) => {
    await stubPublicFacts(page, {
      facts: [factDetail({ id: 541, text: "{NAME} makes onions cry." })],
      memeDetails: [memeDetail({
        id: 5411,
        factId: 541,
        permalinkSlug: "e2e-onions",
        factText: "Nick Baron makes onions cry.",
        createdByName: "Nick Baron",
      })],
      images: ["/api/memes/e2e-onions/image"],
    });
    await page.goto("/m/e2e-onions");
    const picture = page.locator('img[alt="Meme"]').filter({ visible: true });
    await expect(picture).toBeVisible();
    const heading = page.getByRole("heading", { level: 1, name: /what's next\?/i });
    await expect(heading).toBeVisible();
    const caption = page.getByText("Nick Baron makes onions cry.", { exact: true });
    await expect(caption).toBeVisible();
    // Beside the picture, under the heading.
    const [img, h, c] = await Promise.all([picture, heading, caption].map(async (l) => (await l.boundingBox())!));
    expect(c.y).toBeGreaterThan(h.y);
    expect(c.x).toBeGreaterThan(img.x + img.width);
    await expect(page.getByText(/\{NAME\}/)).toHaveCount(0);
  });

  // PR402 step 5 — logged out, the fact page's meme gallery shows the public meme.
  test("logged out, the fact page's gallery shows the public meme and not the private one", async ({ page }) => {
    await stubPublicFacts(page, {
      facts: [factDetail({ id: 551, text: "{NAME} out-stared the sun." })],
      memes: {
        551: [
          memeItem({ id: 5511, factId: 551, permalinkSlug: "e2e-public" }),
          memeItem({ id: 5512, factId: 551, permalinkSlug: "e2e-private", isPublic: false }),
        ],
      },
      images: ["/api/memes/e2e-public/image", "/api/memes/e2e-private/image"],
    });
    await page.goto("/facts/551");
    await expect(page.getByRole("heading", { name: "Memes from this fact" })).toBeVisible();
    await expect(page.getByRole("button", { name: /community/i })).toContainText("1");
    await expect(page.locator('img[src$="/api/memes/e2e-public/image"]')).toBeVisible();
    await expect(page.locator('img[src$="/api/memes/e2e-private/image"]')).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^mine/i })).toHaveCount(0);
  });

  // PR402 step 10 — logged out, the builder's image step shows no visibility control.
  test("logged out, /facts/:id/meme opens the builder and its image step shows no visibility control", async ({ page }) => {
    await stubPublicFacts(page, { facts: [factDetail({ id: 39, text: "{NAME} out-ran the weekend." })] });
    await seedIdentity(page);
    await openImageStep(page, 39);
    await expect(page.getByText("Sign up to create a meme using your photo")).toBeVisible();
    await expect(page.getByTestId("meme-visibility")).toHaveCount(0);
    await expect(page.getByRole("group", { name: /visibility/i })).toHaveCount(0);
  });

  // PR402 step 7 — a plain registered account sees the control, Private dimmed with the LEGEND badge.
  test("a plain registered account sees the visibility control with Private dimmed and the LEGEND badge", async ({ page }) => {
    await signInThroughForm(page, FREE_ACCOUNT.email, TEST_ACCOUNT_PASSWORD);
    await stubPublicFacts(page, { facts: [factDetail({ id: 561, text: "{NAME} out-ran the weekend." })] });
    await openImageStep(page, 561);
    const control = page.getByTestId("meme-visibility");
    await expect(control).toBeVisible();
    const pub = control.getByTestId("meme-visibility-public");
    const priv = control.getByTestId("meme-visibility-private");
    await expect(pub).toBeVisible();
    await expect(pub).toHaveAttribute("aria-pressed", "true");
    await expect(priv).toBeVisible();
    await expect(priv).toHaveAttribute("aria-disabled", "true");
    await expect(priv).toHaveCSS("opacity", "0.6");
    await expect(pub).toHaveCSS("opacity", "1");
    await expect(priv.getByText("LEGEND", { exact: true })).toBeVisible();
  });
});

/**
 * Admin described screens (#631, Phase 2 increment 8, plan D1 and D8).
 *
 * Each test answers one UAT step's screen clause that used to be deferred to
 * "increment 8 (capture and read)", asserting the elements, text and layout
 * the step's Expect names, in a real browser signed in with the dev-admin
 * login. The step cites its test by name.
 *
 * Pages that need no fact (the admin shell, Email Queue) run against the real
 * dev server. A screen that needs a fact or a review in moderation reads it
 * from typed stubs (`helpers/adminStubs.ts`), because the dev stack's database
 * has neither and making one takes the AI pipeline. Saves are never stubbed:
 * the over-budget refusal a test reads comes from the real server's
 * prompt-budget gate.
 *
 * Run: `pnpm --filter @workspace/overhype-me run e2e:screens`, with the dev
 * stack up and the dev admin seeded (see `routeLoadSmoke.spec.ts`).
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { adminFactRow, enrichmentWithConcept, stubAdminFacts, stubConceptReview } from "./helpers/adminStubs";
import { brandOrangeRgb } from "./helpers/brandTokens";

const DESKTOP = { width: 1280, height: 900 };

/** The sidebar's entries, in order (`components/admin/AdminLayout.tsx`, NAV_ITEMS). */
const SIDEBAR = [
  "Dashboard", "Facts", "Users", "Moderation", "Eval", "Billing", "Refunds & Disputes",
  "Trace an image", "Email Queue", "Operations", "Queue Health", "Features", "AI Settings", "Configuration", "Help",
];

/** 2,750 characters dense with {NAME}: fits the box (3,000), but past the 3,500-character pooled budget once names are filled in. */
const OVER_BUDGET_CONCEPT = "{NAME} leaps the canyon. ".repeat(110);

/** The server's refusal sentence for an over-budget Concept, N being the worst-case filled-in length. */
const BUDGET_SENTENCE =
  /^The Visual Concept expands to up to (\d+) characters once names\/pronouns are filled in; the maximum is 3500\. Shorten it or use fewer personalization tokens\.$/;

/** The colour Tailwind's `text-red-500` resolves to on this page, read through a probe element. */
async function red500(page: Page): Promise<string> {
  return page.evaluate(() => {
    const probe = document.createElement("span");
    probe.style.color = "var(--color-red-500)";
    document.body.appendChild(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  });
}

/** The Visual Concept card shows its required marker: a red `*` titled "Required" in its header line. */
async function expectRequiredMarker(page: Page, card: Locator): Promise<void> {
  const header = card.getByText(/visual concept — describe the picture/i);
  await expect(header).toBeVisible();
  const star = header.getByTitle("Required");
  await expect(star).toHaveText("*");
  await expect(star).toBeVisible();
  const red = await red500(page);
  const bodyText = await page.evaluate(() => getComputedStyle(document.body).color);
  expect(red, "the --color-red-500 token should resolve to its own colour, not the inherited text colour").not.toBe(bodyText);
  await expect(star).toHaveCSS("color", red);
  await expect(header).not.toHaveCSS("color", red);
}

/** Open a stubbed fact's sheet from the Facts list, on its Gags tab. */
async function openFactEnrichment(page: Page, id: number, text: string): Promise<Locator> {
  await page.goto("/admin/facts");
  await page.getByTestId(`fact-row-${id}`).click();
  const sheet = page.getByTestId("fact-sheet");
  await expect(sheet.getByTestId("sheet-wording")).toHaveText(text);
  await sheet.getByTestId("sheet-tab-gags").click();
  await expect(sheet.getByTestId("visual-concept-card")).toBeVisible();
  return sheet;
}

/** Open a stubbed review that is waiting at moderation Step 2. */
async function openConceptReview(page: Page, text: string): Promise<Locator> {
  await page.goto("/admin/moderation");
  await page.getByText(`"${text}"`, { exact: true }).first().click();
  const card = page.getByTestId("visual-concept-card");
  await expect(card).toBeVisible();
  return card;
}

test.describe("Admin described screens", () => {
  test.beforeEach(async ({ context, page }) => {
    const login = await context.request.post("/api/auth/dev-admin-login");
    expect(login.ok(), `dev-admin-login should be 200, got ${login.status()}`).toBe(true);
    await page.setViewportSize(DESKTOP);
  });

  // PR472 R6 — admin screens keep their sidebar, header and content.
  const PAGES: { path: string; title: string; nav: string; content: (page: Page) => Promise<void> }[] = [
    {
      path: "/admin",
      title: "Dashboard",
      nav: "Dashboard",
      content: async (page) => {
        for (const tile of [/^total facts$/i, /^total users$/i, /^admin access$/i, /^platform status$/i]) {
          await expect(page.getByText(tile)).toBeVisible();
        }
        await expect(page.getByText("Quick Actions", { exact: true })).toBeVisible();
      },
    },
    {
      path: "/admin/facts",
      title: "Facts Management",
      nav: "Facts",
      content: async (page) => {
        for (const tab of ["Facts", "Utilities"]) {
          await expect(page.locator("main").getByRole("button", { name: tab, exact: true })).toBeVisible();
        }
        await expect(page.getByRole("textbox", { name: "Search facts" })).toBeVisible();
        const show = page.getByRole("combobox", { name: "Show facts" });
        await expect(show).toHaveValue("active");
        await expect(show.locator("option")).toHaveText(["Live", "Deactivated", "Both"]);
        // The override filters went with the override system (PLAN_FACT_LIFECYCLE_REBUILD.md, 2A).
        for (const toggle of ["Overridden", "Needs review"]) {
          await expect(page.getByRole("button", { name: toggle, exact: true })).toHaveCount(0);
        }
      },
    },
    {
      path: "/admin/users",
      title: "Users",
      nav: "Users",
      content: async (page) => {
        await expect(page.getByRole("button", { name: /add user/i })).toBeVisible();
        await expect(page.getByText(/^\d+ users?$/)).toBeVisible();
      },
    },
    {
      path: "/admin/moderation",
      title: "Moderation",
      nav: "Moderation",
      content: async (page) => {
        for (const tab of ["Fact Reviews", "Comment Reviews"]) {
          await expect(page.getByRole("button", { name: tab, exact: true })).toBeVisible();
        }
        for (const status of ["Pending", "Approved", "Rejected", "All"]) {
          await expect(page.getByRole("button", { name: status, exact: true })).toBeVisible();
        }
      },
    },
    {
      path: "/admin/ai",
      title: "AI Settings",
      nav: "AI Settings",
      content: async (page) => {
        await expect(page.getByTestId("ai-settings-steps")).toBeVisible();
        await expect(page.getByText("Gag writer (visual gags and joke read)")).toBeVisible();
        await expect(page.getByRole("textbox")).toHaveCount(0);
      },
    },
    {
      path: "/admin/config",
      title: "Configuration",
      nav: "Configuration",
      content: async (page) => {
        await expect(page.getByText("Changes take effect within 60 seconds — no restart required.")).toBeVisible();
      },
    },
  ];
  for (const { path, title, nav, content } of PAGES) {
    test(`${title} (${path}) shows the admin sidebar, its header and its content`, async ({ page }) => {
      const orange = brandOrangeRgb();
      await page.goto(path);

      const sidebar = page.locator("aside").filter({ visible: true });
      await expect(sidebar.getByText("Admin", { exact: true })).toBeVisible();
      const entries = sidebar.getByRole("link");
      await expect(entries).toHaveText(SIDEBAR);
      // The current page's entry is the one highlighted in the brand orange.
      await expect(sidebar.getByRole("link", { name: nav, exact: true }).locator("> div")).toHaveCSS("background-color", orange);
      await expect(sidebar.getByRole("link", { name: "Help", exact: true }).locator("> div")).not.toHaveCSS("background-color", orange);

      const header = page.locator("main header");
      await expect(header.getByRole("heading", { level: 1 })).toHaveText(title);
      await expect(header.getByLabel("Help for this screen")).toBeVisible();
      await expect(header.getByText("View Site", { exact: true })).toBeVisible();
      await expect(header.getByRole("button", { name: /sign out/i })).toBeVisible();

      await content(page);
      await expect(page.getByText("Access Denied")).toHaveCount(0);
      await expect(page.getByText("Something broke")).toHaveCount(0);
    });
  }

  // PR288 R1 — the Email Queue page, untouched by the queue health work.
  test("Email Queue shows its filters, its actions and its table", async ({ page }) => {
    await page.goto("/admin/email-queue");
    await expect(page.locator("main header").getByRole("heading", { level: 1 })).toHaveText("Email Queue");
    for (const filter of ["All", "Pending", "Sending", "Delivered", "Abandoned"]) {
      await expect(page.getByRole("button", { name: filter, exact: true })).toBeVisible();
    }
    await expect(page.getByText(/^[\d,]+ records?$/)).toBeVisible();
    await expect(page.getByText(/^Auto-purge: (\d+d|off)$/)).toBeVisible();
    for (const action of [/clear pending/i, /clear delivered/i, /clear abandoned/i, /refresh/i]) {
      await expect(page.getByRole("button", { name: action })).toBeVisible();
    }
    const columns = page.getByRole("columnheader");
    await expect(columns).toHaveText([/recipient/i, /subject/i, /kind/i, /status/i, /attempts/i, /last error/i, /next attempt/i, /created/i]);
    // Nothing of the Queue Health page appears here: "Queue Health" is only the sidebar entry.
    await expect(page.getByText("Queue Health", { exact: true }).filter({ visible: true })).toHaveCount(1);
    await expect(page.getByText("Something broke")).toHaveCount(0);
  });

  // PR234 step 1 — Moderation Step 2 leads with the gags, each with its required Visual Concept card
  // (plan docs/plans/PLAN_THREE_GAGS.md: the step is now called Gags).
  test("Moderation Step 2 shows the gags near the top, each Visual Concept card with a red * in its header", async ({ page }) => {
    await stubConceptReview(page, {
      id: 98001,
      submittedText: "{NAME} makes onions cry.",
      stagingFactId: 98002,
      enrichment: enrichmentWithConcept("{NAME} slices an onion and the onion weeps."),
    });
    const card = await openConceptReview(page, "{NAME} makes onions cry.");
    await expectRequiredMarker(page, card);

    // Near the top: only the submitted fact comes before the gags (the step's
    // explanatory line went with increment 1.3b).
    const gags = page.getByTestId("gags-panel");
    const before = await gags.evaluate((el) => {
      const out: string[] = [];
      for (let s = el.previousElementSibling; s; s = s.previousElementSibling) out.unshift((s.textContent ?? "").trim());
      return out;
    });
    expect(before).toHaveLength(1);
    expect(before[0]).toMatch(/^submitted fact/i);
    // In the gag, the concept sits above its bubbles; the gag ideas follow the gags.
    const cardTop = (await card.boundingBox())!.y;
    const gag = page.getByTestId("gag-card").first();
    const bubbles = (await gag.getByText(/speech & thought bubbles/i).first().boundingBox())!.y;
    const ideas = (await page.getByTestId("visual-concepts").getByText(/^gag ideas$/i).boundingBox())!.y;
    expect(cardTop).toBeLessThan(bubbles);
    expect(bubbles).toBeLessThan(ideas);
  });

  // PR234 step 6 — the Facts page shows the same card, required the same way.
  test("the Facts page enrichment view shows the Visual Concept card with its required marker", async ({ page }) => {
    await stubAdminFacts(page, [{
      row: adminFactRow({ id: 97001, text: "{NAME} makes onions cry." }),
      enrichment: enrichmentWithConcept("{NAME} slices an onion and the onion weeps."),
    }]);
    const panel = await openFactEnrichment(page, 97001, "{NAME} makes onions cry.");
    await expectRequiredMarker(page, panel.getByTestId("visual-concept-card"));
  });

  // Plan PLAN_FACT_LIFECYCLE_REBUILD.md, items 18–19 (Issue #1018, increment
  // 3.1): a row carries its needs-attention reasons and opens the fact sheet,
  // the one editor: four tabs, the Overview's five groups, the old editor's
  // counters, prompt diagnostics and edit history gone.
  test("a Facts row shows its reasons and opens the fact sheet: four tabs, five groups, no old editor", async ({ page }) => {
    await stubAdminFacts(page, [{
      row: adminFactRow({ id: 97101, text: "{NAME} does not sleep. {Subj} {waits|wait}.", attention: ["example_missing", "taxonomy_missing"] }),
      enrichment: enrichmentWithConcept("{NAME} sits awake at dawn while the moon yawns."),
    }]);
    await page.goto("/admin/facts");
    const row = page.getByTestId("fact-row-97101");
    await expect(row.getByTestId("fact-row-97101-reason-example_missing")).toHaveText("Example missing");
    await expect(row.getByTestId("fact-row-97101-reason-taxonomy_missing")).toHaveText("Taxonomy missing");
    await expect(page.getByText("Approved facts only.", { exact: false })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Show facts" }).locator("option")).toHaveText(["Live", "Deactivated", "Both"]);
    await row.click();

    const sheet = page.getByTestId("fact-sheet");
    await expect(sheet.getByRole("tab")).toHaveText(["Overview", "Reading and taxonomy", "Gags", "Renders"]);
    for (const g of ["identity", "scoring", "usage", "pictures", "hashtags"]) {
      await expect(sheet.getByTestId(`sheet-group-${g}`), `group ${g}`).toBeVisible();
    }
    await expect(sheet.getByTestId("sheet-attention")).toContainText("Example missing");
    // The old editor is gone: no counter boxes, no prompt diagnostics, no edit history, no Save Changes.
    await expect(page.getByRole("spinbutton")).toHaveCount(0);
    for (const gone of ["Prompt Diagnostics", "Approved text edit history", "Save Changes"]) {
      await expect(page.getByRole("button", { name: gone, exact: true }), gone).toHaveCount(0);
    }
    await expect(page.getByText(/^edit fact #/i)).toHaveCount(0);
    await sheet.getByTestId("sheet-tab-reading").click();
    await expect(sheet.getByRole("textbox", { name: "Humor note" })).toBeVisible();
    await expect(sheet.getByTestId("fact-taxonomy-panel")).toBeVisible();
    await sheet.getByTestId("sheet-tab-renders").click();
    await expect(sheet.getByTestId("sheet-renders-read-only")).toBeVisible();
    await expect(page.getByText("Something broke")).toHaveCount(0);
  });

  // Plan Phase 3 Definition of Done: "the sheet is usable at phone width".
  test("the fact sheet fills a phone's screen and its tabs and close button are reachable", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await stubAdminFacts(page, [{
      row: adminFactRow({ id: 97102, text: "{NAME} counted to infinity. Twice." }),
      enrichment: enrichmentWithConcept("{NAME} writes the last number on a chalkboard."),
    }]);
    await page.goto("/admin/facts");
    await page.getByTestId("fact-row-97102").click();
    const sheet = page.getByTestId("fact-sheet");
    const box = await sheet.boundingBox();
    expect(box, "the sheet is on screen").not.toBeNull();
    expect(Math.round(box!.width), "full width").toBe(390);
    expect(Math.round(box!.height), "full height").toBe(844);
    const scrollWidth = await sheet.evaluate((el) => el.scrollWidth);
    expect(scrollWidth, "nothing in the sheet runs off the side").toBeLessThanOrEqual(390);
    for (const t of ["reading", "gags", "renders", "overview"]) {
      await sheet.getByTestId(`sheet-tab-${t}`).click();
      await expect(sheet.getByTestId(`sheet-panel-${t}`)).toBeVisible();
    }
    await sheet.getByRole("button", { name: "Close the fact sheet" }).click();
    await expect(sheet).toHaveCount(0);
  });

  // PR687 step 4 (mechanical half) — the moderation page shows the server's refusal and saves nothing.
  test("an over-budget Visual Concept saved on the moderation page shows the budget sentence and is refused", async ({ page }) => {
    await stubConceptReview(page, {
      id: 98101,
      submittedText: "{NAME} leaps canyons.",
      stagingFactId: 98102,
      enrichment: enrichmentWithConcept("{NAME} leaps a canyon in one stride."),
    });
    const card = await openConceptReview(page, "{NAME} leaps canyons.");
    await card.getByTestId("visual-concept-textarea").fill(OVER_BUDGET_CONCEPT);
    await expect(card.getByText(`${OVER_BUDGET_CONCEPT.length}/3000`)).toBeVisible();

    // The gag save (PUT /api/admin/facts/:id/gags/:gagId) reaches the real server.
    const saved = page.waitForResponse((r) => r.request().method() === "PUT" && /\/api\/admin\/facts\/98102\/gags\/\d+$/.test(r.url()));
    await page.getByTestId("gag-save").click();
    const response = await saved;
    expect(response.status(), "the real server refuses the save").toBe(400);
    expect(((await response.json()) as { code?: string }).code).toBe("CONTENT_OVER_BUDGET");

    const message = page.getByTestId("gag-error");
    await expect(message).toHaveText(BUDGET_SENTENCE);
    await expect(page.getByText("CONTENT_OVER_BUDGET")).toHaveCount(0);
    // The refused edit stays in the box so it can be shortened.
    await expect(card.getByTestId("visual-concept-textarea")).toHaveValue(OVER_BUDGET_CONCEPT);
  });

  // Plan PLAN_FACT_LIFECYCLE_REBUILD.md, 1F (increment 1.3a): a live fact's
  // gags are not edited until Publish changes (3.2), so the fact sheet's Gags
  // tab shows them read-only and says where editing comes back; "Draft more
  // gags" is gone. The save refusal's wording and wrapping are the moderation
  // test's above.
  test("the fact sheet shows a live fact's gags read-only, with no save and no Draft more gags", async ({ page }) => {
    await stubAdminFacts(page, [{
      row: adminFactRow({ id: 97201, text: "{NAME} leaps canyons." }),
      enrichment: enrichmentWithConcept("{NAME} leaps a canyon in one stride."),
    }]);
    const panel = await openFactEnrichment(page, 97201, "{NAME} leaps canyons.");
    await expect(panel.getByTestId("sheet-gags-read-only")).toContainText("Publish changes");
    const gag = panel.getByTestId("gag-card").first();
    await expect(gag).toBeVisible();
    await expect(gag.getByTestId("gag-save")).toHaveCount(0);
    await expect(gag.getByTestId("gag-remove")).toHaveCount(0);
    await expect(gag.getByTestId("visual-concept-textarea")).toBeDisabled();
    await expect(panel.getByText("Draft more gags")).toHaveCount(0);
  });

  // Launch Phase 4, removal 7: the orphaned comments page file is deleted;
  // its old address still lands on the live screen. (/admin/ai redirected to
  // config until 2026-11-14; it is now the read-only AI settings page.)
  test("the retired comments address redirects to moderation", async ({ page }) => {
    await page.goto("/admin/comments");
    await expect(page).toHaveURL(/\/admin\/moderation$/);
  });
});

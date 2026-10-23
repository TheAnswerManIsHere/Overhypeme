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
  "Engines", "Taxonomy Health", "Email Queue", "Queue Health", "Features", "Configuration", "Help",
];

/** 1,500 characters dense with {NAME}: fits the box, but past the 2,000-character budget once names are filled in. */
const OVER_BUDGET_CONCEPT = "{NAME} leaps the canyon. ".repeat(60);

/** The server's refusal sentence for an over-budget Concept, N being the worst-case filled-in length. */
const BUDGET_SENTENCE =
  /^The Visual Concept expands to up to (\d+) characters once names\/pronouns are filled in; the maximum is 2000\. Shorten it or use fewer personalization tokens\.$/;

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

/** Open the Facts editor on a stubbed fact and expand its Visual Taxonomy Enrichment panel. */
async function openFactEnrichment(page: Page, id: number, text: string): Promise<Locator> {
  await page.goto("/admin/facts");
  await page.getByText(text, { exact: true }).first().click();
  await expect(page.getByText(new RegExp(`edit fact #${id}`, "i"))).toBeVisible();
  const panel = page.getByTestId("fact-enrichment-panel");
  await panel.getByRole("button", { name: /visual taxonomy enrichment/i }).click();
  await expect(panel.getByTestId("visual-concept-card")).toBeVisible();
  return panel;
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
        await expect(page.getByPlaceholder("Search facts…")).toBeVisible();
        const show = page.getByRole("combobox", { name: "Show facts" });
        await expect(show).toHaveValue("active");
        await expect(show.locator("option")).toHaveText(["Active", "Inactive", "Both"]);
        for (const toggle of ["Overridden", "Needs review"]) {
          await expect(page.getByRole("button", { name: toggle, exact: true })).toBeVisible();
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

  // PR234 step 1 — Moderation Step 2 leads with the required Visual Concept card.
  test("Moderation Step 2 shows the Visual Concept card near the top with a red * in its header", async ({ page }) => {
    await stubConceptReview(page, {
      id: 98001,
      submittedText: "{NAME} makes onions cry.",
      stagingFactId: 98002,
      enrichment: enrichmentWithConcept("{NAME} slices an onion and the onion weeps."),
    });
    const card = await openConceptReview(page, "{NAME} makes onions cry.");
    await expectRequiredMarker(page, card);

    // Near the top: only the submitted fact and the one-line instruction come before it.
    const before = await card.evaluate((el) => {
      const out: string[] = [];
      for (let s = el.previousElementSibling; s; s = s.previousElementSibling) out.unshift((s.textContent ?? "").trim());
      return out;
    });
    expect(before).toHaveLength(2);
    expect(before[0]).toMatch(/^submitted fact/i);
    expect(before[1]).toMatch(/^Accept, edit, or write the Visual Concept/);
    // And it sits above the bubbles and the visual ideas that follow it.
    const cardTop = (await card.boundingBox())!.y;
    const step = card.locator("xpath=..");
    const bubbles = (await step.getByText(/speech & thought bubbles/i).boundingBox())!.y;
    const ideas = (await step.getByText(/^visual ideas$/i).boundingBox())!.y;
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

  // PR256 R5 — the Facts editor on a root fact shows its usual panels and fields.
  test("the Facts editor opened on a root fact shows its usual panels and fields with no error", async ({ page }) => {
    await stubAdminFacts(page, [{
      row: adminFactRow({ id: 97101, text: "{NAME} does not sleep. {Subj} {waits|wait}." }),
      enrichment: enrichmentWithConcept("{NAME} sits awake at dawn while the moon yawns."),
    }]);
    await page.goto("/admin/facts");
    await page.getByText("{NAME} does not sleep. {Subj} {waits|wait}.", { exact: true }).first().click();
    const editor = page.locator("main");
    await expect(editor.getByText(/^edit fact #97101$/i)).toBeVisible();
    for (const label of [
      /^id$/i, /^created at$/i, /^updated at$/i, /^caption split$/i, /^text$/i, /^upvotes$/i, /^downvotes$/i,
      /^score$/i, /^wilson score$/i, /^comment count$/i, /^share count$/i, /^parent id \(blank = root fact\)$/i,
      /^use case$/i, /^submitted by id$/i,
    ]) {
      await expect(editor.getByText(label).first(), `field ${label}`).toBeVisible();
    }
    await expect(editor.getByText(/^variants \(0\)$/i)).toBeVisible();
    await expect(editor.getByText("No variants yet. Click + to add one.")).toBeVisible();
    for (const section of ["Visual Taxonomy Enrichment", "Enrichment Version History", "Approved text edit history", "Prompt Diagnostics"]) {
      await expect(editor.getByRole("button", { name: section, exact: true })).toBeVisible();
    }
    await expect(editor.getByTestId("fact-enrichment-panel")).toBeVisible();
    for (const action of ["Save Changes", "Discard", "Cancel", "Send Back to Review", "Delete Fact"]) {
      await expect(editor.getByRole("button", { name: action, exact: true })).toBeVisible();
    }
    await expect(page.getByText("Something broke")).toHaveCount(0);
    await expect(page.getByText(/fact not found/i)).toHaveCount(0);
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
    await expect(card.getByText("1500/1500")).toBeVisible();

    const saved = page.waitForResponse((r) => r.request().method() === "PATCH" && r.url().endsWith("/api/admin/facts/98102/enrichment"));
    await page.getByTestId("enrichment-save").click();
    const response = await saved;
    expect(response.status(), "the real server refuses the save").toBe(400);
    expect(((await response.json()) as { error?: string }).error).toBe("visual_strategy_override_over_budget");

    const message = page.getByText(BUDGET_SENTENCE);
    await expect(message).toBeVisible();
    await expect(page.getByText("visual_strategy_override_over_budget")).toHaveCount(0);
    await expect(page.getByTestId("enrichment-saved")).toHaveCount(0);
    // The refused edit stays in the box so it can be shortened.
    await expect(card.getByTestId("visual-concept-textarea")).toHaveValue(OVER_BUDGET_CONCEPT);
  });

  // PR687 step 5 — the Facts page's refusal box: its text, its layout, its status, and nothing saved.
  test("an over-budget Visual Concept saved on the Facts page shows a wrapped refusal box under the heading", async ({ page }) => {
    await stubAdminFacts(page, [{
      row: adminFactRow({ id: 97201, text: "{NAME} leaps canyons." }),
      enrichment: enrichmentWithConcept("{NAME} leaps a canyon in one stride."),
    }]);
    const panel = await openFactEnrichment(page, 97201, "{NAME} leaps canyons.");
    await panel.getByTestId("visual-concept-textarea").fill(OVER_BUDGET_CONCEPT);

    const saved = page.waitForResponse((r) => r.request().method() === "PATCH" && r.url().endsWith("/api/admin/facts/97201/enrichment"));
    await panel.getByRole("button", { name: "Save enrichment" }).click();
    const response = await saved;
    expect(response.status(), "the real server refuses the save").toBe(400);

    const box = panel.getByTestId("enrichment-commit-error");
    await expect(box).toBeVisible();
    await expect(box).toHaveText(BUDGET_SENTENCE);
    await expect(box.locator("p")).toHaveCSS("color", await page.evaluate(() => {
      const probe = document.createElement("span");
      probe.className = "text-destructive";
      document.body.appendChild(probe);
      const c = getComputedStyle(probe).color;
      probe.remove();
      return c;
    }));

    // The heading line: the heading, "Save refused" beside it, and "Discard changes", above the box.
    const heading = panel.getByRole("heading", { name: /visual taxonomy enrichment/i });
    const status = panel.getByText("Save refused", { exact: true });
    const discard = panel.getByRole("button", { name: "Discard changes" }).first();
    await expect(heading).toBeVisible();
    await expect(status).toBeVisible();
    await expect(discard).toBeVisible();
    const [h, s, d, b, p] = await Promise.all([heading, status, discard, box, panel].map(async (l) => (await l.boundingBox())!));
    const midline = (r: { y: number; height: number }) => r.y + r.height / 2;
    expect(Math.abs(midline(s) - midline(h)), "the status sits on the heading's line").toBeLessThan(h.height);
    expect(Math.abs(midline(d) - midline(h)), "Discard changes sits on the heading's line").toBeLessThan(h.height);
    expect(b.y, "the box sits below the heading line").toBeGreaterThanOrEqual(Math.max(h.y + h.height, d.y + d.height) - 1);

    // It wraps inside the panel: nothing runs past the panel's edge.
    expect(b.x).toBeGreaterThanOrEqual(p.x);
    expect(b.x + b.width).toBeLessThanOrEqual(p.x + p.width + 0.5);
    const overflow = await box.evaluate((el) => {
      const text = el.querySelector("p")!;
      return { box: el.scrollWidth - el.clientWidth, text: text.scrollWidth - text.clientWidth, lines: Math.round(text.getBoundingClientRect().height / parseFloat(getComputedStyle(text).lineHeight)) };
    });
    expect(overflow.box, "the box's content does not overflow it").toBeLessThanOrEqual(0);
    expect(overflow.text, "the sentence does not overflow its line").toBeLessThanOrEqual(0);
    expect(overflow.lines, "the sentence wraps onto more than one line rather than running on").toBeGreaterThanOrEqual(2);

    // Nothing saved: the edit is still an unsaved draft.
    await expect(panel.getByText("Saved to server")).toHaveCount(0);
    await expect(panel.getByTestId("visual-concept-textarea")).toHaveValue(OVER_BUDGET_CONCEPT);
  });

  // Launch Phase 4, removal 7: the orphaned comments and AI-settings page
  // files are deleted; their old addresses still land on the live screens.
  test("the retired comments and AI addresses redirect to moderation and config", async ({ page }) => {
    await page.goto("/admin/comments");
    await expect(page).toHaveURL(/\/admin\/moderation$/);
    await page.goto("/admin/ai");
    await expect(page).toHaveURL(/\/admin\/config$/);
  });
});

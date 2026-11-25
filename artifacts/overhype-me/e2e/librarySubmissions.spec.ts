/**
 * The Library's Submissions tab in a real browser (plan
 * PLAN_LIBRARY_SUBMISSIONS.md): the type and status tabs switch, the address
 * holds the view so a reload and Back return to it, a search narrows the list
 * and shows each status's matches, and "Load more" reaches the end.
 *
 * Why stubs for the two submission reads: the CI dev stack's database is
 * empty and a live fact can only be made through the moderation pipeline (see
 * helpers/apiStubs.ts). What the server answers is asserted against a real
 * database in `api-server/src/__tests__/routes.users.submissions.test.ts`;
 * this spec checks what the screen does with those answers. Sign-in and
 * everything else reach the real dev server.
 */
import { expect, test, type Page } from "@playwright/test";
import type { MySubmission, MySubmissionCounts } from "@workspace/api-client-react";

const blank: Omit<MySubmission, "kind" | "id" | "text"> = {
  hashtags: [], createdAt: "2026-11-01T00:00:00.000Z", decidedAt: null, progress: null, reason: null,
  teamNote: null, fact: null, factId: null, factText: null, factLive: null, hidden: null,
};

/** 30 facts under review (more than one page), 2 declined, 1 comment. */
const REVIEW: MySubmission[] = Array.from({ length: 30 }, (_, i) => ({
  ...blank, kind: "review", id: 1000 + i, text: `{NAME} pending fact ${i + 1}${i === 4 ? " about the moon" : ""}`,
  progress: i % 2 ? "preparing" : "first_look",
}));
const DECLINED: MySubmission[] = [
  { ...blank, kind: "review", id: 2000, text: "{NAME} declined about the moon", reason: "lame", teamNote: "Not quite." },
  { ...blank, kind: "review", id: 2001, text: "{NAME} declined two" },
];
const COMMENTS: MySubmission[] = [
  { ...blank, kind: "comment", id: 3000, text: "my only comment", factId: 1, factText: "{NAME} x", factLive: true, hidden: false },
];
const LISTS: Record<string, MySubmission[]> = {
  "facts:review": REVIEW, "facts:declined": DECLINED, "comments:review": COMMENTS,
};
const PAGE = 24;

function matching(items: MySubmission[], q: string | null) {
  if (!q) return items;
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  return items.filter((i) => words.every((w) => i.text.toLowerCase().includes(w)));
}

async function stubSubmissions(page: Page) {
  await page.route("**/api/users/me/submissions/counts**", async (route) => {
    const q = new URL(route.request().url()).searchParams.get("q");
    const count = (type: string, status: string, query: string | null) => matching(LISTS[`${type}:${status}`] ?? [], query).length;
    const shape = (query: string | null) => ({
      facts: { review: count("facts", "review", query), live: 0, declined: count("facts", "declined", query), gone: 0 },
      comments: { review: count("comments", "review", query), live: 0, declined: 0, gone: 0 },
    });
    const body: MySubmissionCounts = { totals: shape(null), matches: q ? shape(q) : null };
    await route.fulfill({ json: body });
  });
  await page.route(/\/api\/users\/me\/submissions(\?|$)/, async (route) => {
    const url = new URL(route.request().url());
    const key = `${url.searchParams.get("type")}:${url.searchParams.get("status")}`;
    const all = matching(LISTS[key] ?? [], url.searchParams.get("q"));
    const start = Number(url.searchParams.get("cursor") ?? 0);
    const items = all.slice(start, start + PAGE);
    await route.fulfill({ json: { items, nextCursor: start + PAGE < all.length ? String(start + PAGE) : null } });
  });
}

test.describe("Library — Submissions", () => {
  test.beforeEach(async ({ context, page }) => {
    expect((await context.request.post("/api/auth/dev-admin-login")).ok()).toBe(true);
    // A signed-in account without a name and pronouns is asked for them on
    // every ordinary page (#719). The shared dev admin is not given them on
    // the server, which other suites read; this page's copy of the account is.
    await page.route("**/api/auth/user", async (route) => {
      const res = await route.fetch();
      const body = await res.json() as { user?: Record<string, unknown> | null };
      if (body.user) body.user = { ...body.user, displayName: body.user["displayName"] || "David Franklin", pronouns: body.user["pronouns"] || "he/him" };
      await route.fulfill({ response: res, json: body });
    });
    await stubSubmissions(page);
  });

  test("tabs switch, the address restores the view on reload and Back, search narrows, Load more reaches the end", async ({ page }) => {
    await page.goto("/library?tab=submitted");

    // Opens on Facts, Under Review (the first status with anything in it), one page at a time.
    const typeTabs = page.getByRole("tablist", { name: "Submission type" });
    const statusTabs = page.getByRole("tablist", { name: "Status" });
    await expect(typeTabs.getByRole("tab", { name: /facts/i })).toHaveAttribute("aria-selected", "true");
    await expect(statusTabs.getByRole("tab", { name: /under review/i })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("button", { name: /submissions \(33\)/i })).toBeVisible();
    await expect(page.getByText("{NAME} pending fact 24", { exact: true })).toBeVisible();
    await expect(page.getByText("{NAME} pending fact 25", { exact: true })).toHaveCount(0);
    await expect(statusTabs.getByRole("tab", { name: /no longer live/i })).toHaveCount(0);

    await page.getByRole("button", { name: "LOAD MORE" }).click();
    await expect(page.getByText("{NAME} pending fact 30", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "LOAD MORE" })).toHaveCount(0);

    // Declined: the reason's label and the team's note.
    await statusTabs.getByRole("tab", { name: /declined/i }).click();
    await expect(page).toHaveURL(/status=declined/);
    await expect(page.getByText("Not quite.")).toBeVisible();

    // A reload keeps the view.
    await page.reload();
    await expect(statusTabs.getByRole("tab", { name: /declined/i })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByText("{NAME} declined two")).toBeVisible();

    // Comments, then Back returns to Facts / Declined.
    await typeTabs.getByRole("tab", { name: /comments/i }).click();
    await expect(page.getByText("my only comment")).toBeVisible();
    await page.goBack();
    await expect(typeTabs.getByRole("tab", { name: /facts/i })).toHaveAttribute("aria-selected", "true");
    await expect(statusTabs.getByRole("tab", { name: /declined/i })).toHaveAttribute("aria-selected", "true");

    // Search narrows the list and shows each status's matches against its total.
    await page.getByRole("searchbox", { name: /search your facts/i }).fill("moon");
    await expect(page).toHaveURL(/q=moon/);
    await expect(statusTabs.getByRole("tab", { name: /under review/i })).toContainText("1 of 30");
    await expect(statusTabs.getByRole("tab", { name: /declined/i })).toContainText("1 of 2");
    await expect(page.getByText("{NAME} declined two")).toHaveCount(0);
    await expect(page.getByText("{NAME} declined about the moon")).toBeVisible();

    // The search survives a status change; a search with no matches says what it looks at.
    await statusTabs.getByRole("tab", { name: /under review/i }).click();
    await expect(page.getByText("{NAME} pending fact 5 about the moon")).toBeVisible();
    await page.getByRole("searchbox", { name: /search your facts/i }).fill("zebra");
    await expect(page.getByText(/names and pronouns/i)).toBeVisible();
    await page.getByRole("button", { name: "CLEAR SEARCH", exact: true }).click();
    await expect(page.getByText("{NAME} pending fact 1", { exact: true })).toBeVisible();
  });
});

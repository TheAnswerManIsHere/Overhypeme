/**
 * The admin Gags panel (plans docs/plans/PLAN_THREE_GAGS.md and
 * PLAN_GAG_EXAMPLES.md): each gag's state in words, saving a change through the
 * tokenizer, the male, female and pet tiles and approving one as that kind's
 * example, the examples approved so far in words, "Render female and pet",
 * adding a gag, the read-only state during a refresh, the unsaved gags named,
 * and the prompt-budget refusal shown as the server's sentences (#685).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { act } from "@testing-library/react";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import {
  EMPTY_VISUAL_STRATEGY_OVERRIDE,
  castSourceKey,
  type FactGagsView,
  type GagCastEntry,
  type GagView,
  type GagExample,
  type GagExampleKind,
  type GagPictureRoles,
  type PerKind,
  type RemovedGagHistory,
  type RenderHistoryEntry,
  type RenderScenarioCard,
  type VisualPromptStrategyOverride,
} from "@workspace/api-zod";
import { GagsPanel } from "./GagsPanel";
import { approvalWords, costWords } from "./RenderHistory";

const scene = (text: string): VisualPromptStrategyOverride => ({ ...EMPTY_VISUAL_STRATEGY_OVERRIDE, coreSceneOverride: text });
const NONE = { male: null, female: null, pet: null };
const NO_ROLES = { live: null, approvedNext: null, working: null };
const ex = (attemptId: number): GagExample => ({ attemptId, imageUrl: `/api/admin/gags/1/renders/${attemptId}/image` });
function card(key: RenderScenarioCard["key"], over: Partial<RenderScenarioCard> = {}): RenderScenarioCard {
  return {
    key, label: key, purpose: "", referenceIdentityType: null, required: true,
    status: "done", stale: false, latestAttemptId: 901, imageUrl: "/api/admin/gags/2/renders/j/image", message: null,
    ...over,
  };
}

/**
 * A gag as the server sends it. `renders` (test shorthand) is each picture's
 * working render; the official roles follow from the picks as the server
 * computes them (PLAN_RENDER_HISTORY.md D1): live is the published pick, and
 * the draft's pick is "approved for next publish" when it differs.
 */
function gag(over: Partial<GagView> & Pick<GagView, "id" | "slot"> & { renders?: PerKind<RenderScenarioCard | null> }): GagView {
  const { renders = NONE, ...rest } = over;
  const g: GagView = {
    state: "approved",
    availableToUsers: true,
    isDefault: false,
    approvedContent: scene("{NAME} lifts the moon."),
    approvedExamples: NONE,
    grandfathered: false,
    approvedAt: "2026-11-01T00:00:00.000Z",
    pendingContent: null,
    pendingExamples: NONE,
    draftRemoved: false,
    prefilledUntouched: false,
    roles: { male: NO_ROLES, female: NO_ROLES, pet: NO_ROLES },
    ...rest,
  };
  if (over.roles) return g;
  const roleOf = (k: GagExampleKind): GagPictureRoles => {
    const live = g.approvedExamples[k];
    const pick = g.pendingContent != null ? g.pendingExamples[k] : live;
    return { live, approvedNext: pick && pick.attemptId !== live?.attemptId ? pick : null, working: renders[k] };
  };
  return { ...g, roles: { male: roleOf("male"), female: roleOf("female"), pet: roleOf("pet") } };
}

function view(gags: GagView[], over: Partial<FactGagsView> = {}): FactGagsView {
  return { factId: 5, isActive: true, review: null, gags, maxGags: 3, draftReady: { ok: false, reason: null }, filling: false, fillFailed: false, ...over };
}

type Call = { url: string; method: string; body: unknown };

/** Stub fetch: GET answers `initial`; writes answer `after` (or a refusal); tokenize echoes. */
function stubFetch(initial: FactGagsView, opts: { after?: FactGagsView; refuse?: { status: number; body: unknown }; cast?: GagCastEntry[]; castFails?: boolean; history?: (url: string) => unknown; removed?: RemovedGagHistory[]; deleteAnswer?: { status: number; body: unknown } } = {}) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url: String(url), method, body });
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
    if (url === "/api/ai/tokenize-enrichment") {
      const entries = (body as { entries: { path: string; value: string }[] }).entries;
      return json({ results: entries.map((e) => ({ path: e.path, value: e.value.replace(/\bAlex\b/g, "{NAME}"), changed: true, usedLlm: false })) });
    }
    if (String(url).endsWith("/gags/cast")) {
      // Reading who is in a draft's scene: the stubbed cast, keyed to what was sent.
      if (opts.castFails) return json({ error: "Reading who is in the scene failed: model down", code: "CAST_FAILED" }, 502);
      const b = body as { scene: string; bubbles: { entity: string; text: string }[] };
      const cast = opts.cast ?? [];
      const labels = new Set(cast.map((c) => c.label));
      const unboundSpeakers = b.bubbles.map((bb) => bb.entity).filter((e) => e.trim() !== "" && e !== "subject" && !labels.has(e));
      return json({ cast, castExtraction: { promptVersion: "v2", extractedAt: "2026-11-17T00:00:00.000Z", sourceKey: castSourceKey(b.scene, b.bubbles) }, unboundSpeakers });
    }
    if (String(url).includes("/render-history/removed-gags")) return json({ gags: opts.removed ?? [] });
    if (String(url).includes("/render-history")) return json(opts.history?.(String(url)) ?? { gagId: 0, entries: [], nextBefore: null });
    if (String(url).endsWith("/delete")) return json(opts.deleteAnswer?.body ?? { deleted: true, fileStillBeingRemoved: false }, opts.deleteAnswer?.status ?? 200);
    if (method === "GET") return json(initial);
    if (opts.refuse) return json(opts.refuse.body, opts.refuse.status);
    return json(opts.after ?? initial);
  }));
  return calls;
}

afterEach(() => { vi.unstubAllGlobals(); window.localStorage.clear(); });

describe("GagsPanel", () => {
  it("says each gag's state in words, which is the default, and whether users are offered it", async () => {
    stubFetch(view([
      gag({ id: 1, slot: 1, isDefault: true, grandfathered: true }),
      gag({ id: 2, slot: 2, state: "new", availableToUsers: false, approvedContent: null, approvedAt: null, pendingContent: scene("{NAME} juggles planets.") }),
    ]));
    render(<GagsPanel factId={5} reviewId={null} rendersEnabled={false} subjectNames={["Alex"]} />);
    const cards = await screen.findAllByTestId("gag-card");
    expect(cards).toHaveLength(2);
    expect(within(cards[0]!).getByTestId("gag-default")).toBeTruthy();
    expect(within(cards[0]!).getByTestId("gag-availability").textContent).toBe("Offered to users");
    expect(within(cards[0]!).getByTestId("gag-grandfathered")).toBeTruthy();
    expect(within(cards[0]!).getByTestId("gag-example-words").textContent).toBe("No examples approved yet: male, female and pet to approve.");
    expect(within(cards[1]!).getByTestId("gag-availability").textContent).toBe("Hidden from users");
    expect(within(cards[1]!).getByTestId("gag-state").textContent).toMatch(/^Not offered to users yet: goes live with the fact/);
  });

  it("saves a change through the tokenizer, then PUTs the tokenized gag with the review it comes from", async () => {
    const calls = stubFetch(view([gag({ id: 1, slot: 1, isDefault: true })]), {
      after: view([gag({ id: 1, slot: 1, isDefault: true, state: "approved_with_change", pendingContent: scene("{NAME} lifts the sun.") })]),
    });
    render(<GagsPanel factId={5} reviewId={77} rendersEnabled={false} subjectNames={["Alex"]} />);
    const card = await screen.findByTestId("gag-card");
    fireEvent.change(within(card).getByTestId("visual-concept-textarea"), { target: { value: "Alex lifts the sun." } });
    fireEvent.click(within(card).getByTestId("gag-save"));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.url).toBe("/api/admin/facts/5/gags/1");
    expect(put.body).toMatchObject({ reviewId: 77, content: { coreSceneOverride: "{NAME} lifts the sun." } });
    expect(calls.findIndex((c) => c.url === "/api/ai/tokenize-enrichment")).toBeLessThan(calls.indexOf(put));
    await waitFor(() => expect(screen.getByTestId("gag-state").textContent).toBe("Offered to users as published; this gag has an unpublished change"));
  });

  it("REGRESSION #685: an over-budget gag shows the server's budget sentences, not its code, and keeps the edit", async () => {
    const sentence = "The Visual Concept expands to up to 2400 characters once names/pronouns are filled in; the maximum is 2000. Shorten it or use fewer personalization tokens.";
    stubFetch(view([gag({ id: 1, slot: 1 })]), {
      refuse: { status: 400, body: { error: "This gag is too long for the image prompt.", code: "CONTENT_OVER_BUDGET", details: [{ code: "core_scene_rendered_too_long", message: sentence }] } },
    });
    render(<GagsPanel factId={5} reviewId={null} rendersEnabled={false} subjectNames={[]} />);
    const card = await screen.findByTestId("gag-card");
    const long = "{NAME} leaps the canyon. ".repeat(60);
    fireEvent.change(within(card).getByTestId("visual-concept-textarea"), { target: { value: long } });
    fireEvent.click(within(card).getByTestId("gag-save"));
    expect((await within(card).findByTestId("gag-error")).textContent).toBe(sentence);
    expect(screen.queryByText("CONTENT_OVER_BUDGET")).toBeNull();
    expect((within(card).getByTestId("visual-concept-textarea") as HTMLTextAreaElement).value).toBe(long);
  });

  it("says the engine refused a picture, with its reason, and never as a plain failure to retry (plan PLAN_GAG_DIRECT_RENDER.md, B)", async () => {
    const renders: PerKind<RenderScenarioCard | null> = {
      male: card("i2i_male_default", { status: "failed", imageUrl: null, engineRefused: true, message: "fal submit failed: GPT Image 2.6 refused this picture under its content policy (violence)" }),
      female: card("i2i_female_default", { status: "failed", imageUrl: null, engineRefused: false, message: "timed out" }),
      pet: null,
    };
    stubFetch(view([
      gag({ id: 2, slot: 1, state: "new", availableToUsers: false, approvedContent: null, approvedAt: null, pendingContent: scene("{NAME} juggles planets."), renders }),
    ], { isActive: false }));
    render(<GagsPanel factId={5} reviewId={77} rendersEnabled subjectNames={[]} />);
    const tiles = await screen.findAllByTestId("gag-render");
    const refused = within(tiles[0]!).getByTestId("gag-render-status");
    expect(refused.textContent).toMatch(/^The engine refused this picture: .*content policy \(violence\)\. Change the scene, then draw it again\.$/);
    expect(refused.getAttribute("data-refused")).toBe("true");
    const failed = within(tiles[1]!).getByTestId("gag-render-status");
    expect(failed.textContent).toBe("Failed: timed out. Draw it again.");
    expect(failed.getAttribute("data-refused")).toBeNull();
  });

  it("shows a male, a female and a pet tile; approving a finished render sends its attempt; an approved one says so", async () => {
    const renders: PerKind<RenderScenarioCard | null> = {
      male: card("i2i_male_default", { latestAttemptId: 901 }),
      female: card("i2i_female_default", { latestAttemptId: 902 }),
      pet: null,
    };
    const calls = stubFetch(view([
      gag({ id: 2, slot: 1, state: "new", availableToUsers: false, approvedContent: null, approvedAt: null, pendingContent: scene("{NAME} juggles planets."),
        pendingExamples: { male: ex(901), female: null, pet: null }, renders }),
    ], { isActive: false }));
    render(<GagsPanel factId={5} reviewId={77} rendersEnabled subjectNames={[]} />);
    const tiles = await screen.findAllByTestId("gag-render");
    expect(tiles.map((t) => t.getAttribute("data-kind"))).toEqual(["male", "female", "pet"]);
    expect(within(tiles[0]!).getByTestId("gag-render-picked")).toBeTruthy();
    expect(within(tiles[0]!).queryByTestId("gag-approve-render")).toBeNull();
    expect(within(tiles[2]!).getByTestId("gag-render-status").textContent).toMatch(/Not drawn yet/);
    // Image-surface audit R10 (#875): a drawn render opens full size in a new tab.
    const open = within(tiles[1]!).getByTestId("gag-render-open");
    expect(open.getAttribute("href")).toBe("/api/admin/gags/2/renders/j/image");
    expect(open.getAttribute("target")).toBe("_blank");

    fireEvent.click(within(tiles[1]!).getByTestId("gag-approve-render"));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/approve"))).toBe(true));
    const call = calls.find((c) => c.url.endsWith("/approve"))!;
    expect(call.url).toBe("/api/admin/facts/5/gags/2/approve");
    expect(call.body).toEqual({ attemptId: 902, reviewId: 77 });
  });

  it("an in-flight tile reads its progress: Drawing… only while the picture is in progress; none offers Draw again (plan PLAN_JOB_RESUME.md §D)", async () => {
    const inFlight = (progress: RenderScenarioCard["progress"], status: RenderScenarioCard["status"]) =>
      card("i2i_male_default", { status, progress, imageUrl: null, latestAttemptId: 901 });
    const cases: Array<[RenderScenarioCard["progress"], RenderScenarioCard["status"], string]> = [
      ["queued", "queued", "Queued…"],
      ["drawing", "rendering", "Drawing…"],
      ["resuming", "rendering", "Picking back up…"],
      ["saving", "rendering", "Saving…"],
      ["retrying", "rendering", "Retrying shortly…"],
    ];
    for (const [progress, status, words] of cases) {
      stubFetch(view([
        gag({ id: 2, slot: 1, state: "new", availableToUsers: false, approvedContent: null, approvedAt: null,
          pendingContent: scene("{NAME} drives home."), renders: { ...NONE, male: inFlight(progress, status) } }),
      ], { isActive: false }));
      const { unmount } = render(<GagsPanel factId={5} reviewId={77} rendersEnabled subjectNames={[]} />);
      const tiles = await screen.findAllByTestId("gag-render");
      expect(within(tiles[0]!).getByTestId("gag-render-status").textContent).toBe(words);
      expect(within(tiles[0]!).queryByTestId("gag-redraw-render")).toBeNull();
      unmount();
      vi.unstubAllGlobals();
    }
  });

  it("a tile whose picture Nano Banana drew after GPT Image refused says so; others do not (plan PLAN_NB_FALLBACK.md)", async () => {
    const renders: PerKind<RenderScenarioCard | null> = {
      male: card("i2i_male_default", { latestAttemptId: 901, engineFallback: { refusedEngineId: "gpt-image-2-6-edit", drawnByEngineId: "nano-banana-2-1-edit" } }),
      female: card("i2i_female_default", { latestAttemptId: 902 }),
      pet: null,
    };
    stubFetch(view([
      gag({ id: 2, slot: 1, state: "new", availableToUsers: false, approvedContent: null, approvedAt: null, pendingContent: scene("{NAME} drives home."), renders }),
    ], { isActive: false }));
    render(<GagsPanel factId={5} reviewId={77} rendersEnabled subjectNames={[]} />);
    const tiles = await screen.findAllByTestId("gag-render");
    expect(within(tiles[0]!).getByTestId("gag-render-fallback").textContent).toBe("GPT Image refused this picture; Nano Banana drew it.");
    expect(within(tiles[1]!).queryByTestId("gag-render-fallback")).toBeNull();
    expect(within(tiles[0]!).getByTestId("gag-approve-render")).toBeTruthy();
  });

  it("a published gag's examples drawn from an earlier version show on its tiles, approved and out of date, and can be drawn again (Issue #1277)", async () => {
    stubFetch(view([gag({
      id: 1, slot: 1, isDefault: true,
      approvedExamples: { male: ex(11), female: ex(12), pet: ex(13) },
      renders: {
        male: card("i2i_male_default", { latestAttemptId: 11, stale: true }),
        female: card("i2i_female_default", { latestAttemptId: 12, stale: true }),
        pet: card("i2i_nonhuman_animal", { latestAttemptId: 13, stale: true }),
      },
    })]));
    render(<GagsPanel factId={5} reviewId={null} rendersEnabled subjectNames={[]} />);
    const tiles = await screen.findAllByTestId("gag-render");
    for (const t of tiles) {
      expect(within(t).getByRole("img")).toBeTruthy();
      expect(within(t).queryByTestId("gag-render-status")).toBeNull();
      expect(within(t).getByTestId("gag-render-picked")).toBeTruthy();
      expect(within(t).getByTestId("gag-render-stale").textContent).toMatch(/earlier version of this gag/);
      expect(within(t).getByTestId("gag-redraw-render").textContent).toMatch(/Draw again/);
    }
    expect(screen.getByTestId("gag-render-rest").textContent).toMatch(/Render female and pet/);
  });

  it("\"Render female and pet\" draws only those kinds; a tile draws its own again on request", async () => {
    const calls = stubFetch(view([gag({ id: 1, slot: 1, isDefault: true, renders: { ...NONE, male: card("i2i_male_default") } })]));
    render(<GagsPanel factId={5} reviewId={null} rendersEnabled subjectNames={[]} />);
    fireEvent.click(await screen.findByTestId("gag-render-rest"));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/renders"))).toBe(true));
    // Only the pictures that need drawing, each a new render (PLAN_RENDER_HISTORY.md D1).
    expect(calls.find((c) => c.url.endsWith("/renders"))!.body).toEqual({ kinds: ["female", "pet"], redraw: true });

    const male = screen.getAllByTestId("gag-render").find((t) => t.getAttribute("data-kind") === "male")!;
    fireEvent.click(within(male).getByTestId("gag-redraw-render"));
    await waitFor(() => expect(calls.filter((c) => c.url.endsWith("/renders"))).toHaveLength(2));
    expect(calls.filter((c) => c.url.endsWith("/renders"))[1]!.body).toEqual({ kinds: ["male"], redraw: true });
  });

  it("says which examples are approved, and offers no \"Render female and pet\" once both are drawn", async () => {
    const both = view([gag({
      id: 1, slot: 1,
      approvedExamples: { male: ex(1), female: ex(2), pet: ex(3) },
      renders: { male: card("i2i_male_default"), female: card("i2i_female_default"), pet: card("i2i_nonhuman_animal") },
    })]);
    stubFetch(both);
    const gags = render(<GagsPanel factId={5} reviewId={null} rendersEnabled={false} subjectNames={[]} />);
    expect((await screen.findByTestId("gag-example-words")).textContent).toBe("Male, female and pet approved.");
    expect(screen.getAllByTestId("gag-example")).toHaveLength(3);
    gags.unmount();
    render(<GagsPanel factId={5} reviewId={null} rendersEnabled subjectNames={[]} />);
    expect(await screen.findAllByTestId("gag-render")).toHaveLength(3);
    expect(screen.queryByTestId("gag-render-rest")).toBeNull();
  });

  it("at Test Renders a gag is its three render windows and nothing else from the gag setup (plan PLAN_FACT_LIFECYCLE_REBUILD.md, item 11)", async () => {
    stubFetch(view([
      gag({ id: 1, slot: 1, isDefault: true, renders: { ...NONE, male: card("i2i_male_default") } }),
      gag({ id: 2, slot: 2, state: "new", availableToUsers: false, approvedContent: null, approvedAt: null, pendingContent: scene("{NAME} juggles planets.") }),
    ]));
    render(<GagsPanel factId={5} reviewId={77} rendersEnabled subjectNames={[]} />);
    const cards = await screen.findAllByTestId("gag-card");
    expect(cards.map((c) => c.textContent?.startsWith(`Visual gag ${c.getAttribute("data-gag-slot")}`))).toEqual([true, true]);
    for (const c of cards) {
      expect(within(c).getAllByTestId("gag-render").map((t) => t.getAttribute("data-kind"))).toEqual(["male", "female", "pet"]);
    }
    for (const id of ["visual-concept-textarea", "gag-save", "gag-remove", "gag-undo", "gag-state", "gag-availability", "gag-default", "gag-example-words", "gag-add", "gag-new"]) {
      expect(screen.queryAllByTestId(id), id).toHaveLength(0);
    }
    // Every render is drawn on request (Issue #1282); female and pet can be asked for together.
    expect(within(cards[0]!).getByTestId("gag-render-rest").textContent).toMatch(/Render female and pet/);
  });

  it("adds a gag through the create route, up to the limit", async () => {
    const calls = stubFetch(view([gag({ id: 1, slot: 1, isDefault: true })]));
    render(<GagsPanel factId={5} reviewId={null} rendersEnabled={false} subjectNames={[]} />);
    fireEvent.click(await screen.findByTestId("gag-add"));
    const fresh = screen.getByTestId("gag-new");
    fireEvent.change(within(fresh).getByTestId("visual-concept-textarea"), { target: { value: "{NAME} outruns a sunrise." } });
    fireEvent.click(within(fresh).getByTestId("gag-new-save"));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.url === "/api/admin/facts/5/gags")).toBe(true));
    expect(calls.find((c) => c.method === "POST" && c.url === "/api/admin/facts/5/gags")!.body).toMatchObject({ content: { coreSceneOverride: "{NAME} outruns a sunrise." } });
  });

  it("offers no add at the limit of three", async () => {
    stubFetch(view([gag({ id: 1, slot: 1 }), gag({ id: 2, slot: 2 }), gag({ id: 3, slot: 3 })]));
    render(<GagsPanel factId={5} reviewId={null} rendersEnabled={false} subjectNames={[]} />);
    await screen.findAllByTestId("gag-card");
    expect(screen.queryByTestId("gag-add")).toBeNull();
  });

  it("reports unsaved gag work by gag, so an approval can wait for it and name it (Codex, PR #956 round 2)", async () => {
    stubFetch(view([gag({ id: 1, slot: 1, isDefault: true }), gag({ id: 2, slot: 2 })]));
    const onUnsaved = vi.fn();
    render(<GagsPanel factId={5} reviewId={77} rendersEnabled={false} subjectNames={[]} onUnsavedChange={onUnsaved} />);
    const second = (await screen.findAllByTestId("gag-card"))[1]!;
    fireEvent.change(within(second).getByTestId("visual-concept-textarea"), { target: { value: "{NAME} an unsaved edit." } });
    await waitFor(() => expect(onUnsaved).toHaveBeenLastCalledWith(["Visual gag 2"]));
    fireEvent.click(within(second).getByTestId("gag-undo"));
    await waitFor(() => expect(onUnsaved).toHaveBeenLastCalledWith([]));
    // A new gag with text typed in is unsaved work too.
    fireEvent.click(screen.getByTestId("gag-add"));
    fireEvent.change(within(screen.getByTestId("gag-new")).getByTestId("visual-concept-textarea"), { target: { value: "{NAME} typed, not saved." } });
    await waitFor(() => expect(onUnsaved).toHaveBeenLastCalledWith(["the new visual gag"]));
  });

  // Issue #1282 (plan PLAN_RENDERS_MANUAL.md): no render starts by itself, so
  // the panel never waits for one nobody asked for; it reloads only while a
  // render that was asked for is drawing.
  describe("every render is drawn on request", () => {
    const male = card("i2i_male_default", { latestAttemptId: 950 });
    const pendingGag = (m: RenderScenarioCard | null) => gag({
      id: 2, slot: 1, state: "new", availableToUsers: false, approvedContent: null, approvedAt: null,
      pendingContent: scene("{NAME} juggles planets."), renders: { ...NONE, male: m },
    });
    /** GET answers each view in turn, then repeats the last; POSTs are recorded. */
    function stubSequence(views: FactGagsView[]) {
      let n = 0;
      const gets = vi.fn();
      const posts: { url: string; body: unknown }[] = [];
      vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        // The view's own reloads; the removed gags' list is read once on its own.
        if (String(url).includes("/render-history")) return new Response(JSON.stringify({ gags: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
        if (method === "GET") gets(); else posts.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
        const v = views[Math.min(n, views.length - 1)]!;
        if (method === "GET") n++;
        return new Response(JSON.stringify(v), { status: 200, headers: { "Content-Type": "application/json" } });
      }));
      return { gets, posts };
    }
    afterEach(() => vi.useRealTimers());

    it("at Test Renders, a gag with nothing drawn shows three undrawn windows with no spinner, and the panel does not reload waiting for one", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const { gets } = stubSequence([view([pendingGag(null)], { isActive: false })]);
      render(<GagsPanel factId={5} reviewId={77} rendersEnabled subjectNames={[]} />);
      const tiles = await screen.findAllByTestId("gag-render");
      expect(tiles.map((t) => within(t).getByTestId("gag-render-status").textContent)).toEqual(["Not drawn yet.", "Not drawn yet.", "Not drawn yet."]);
      expect(tiles.map((t) => within(t).getByTestId("gag-redraw-render").textContent?.trim())).toEqual(["Draw this render", "Draw this render", "Draw this render"]);
      expect(document.querySelector(".animate-spin")).toBeNull();
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
      expect(gets).toHaveBeenCalledTimes(1);
    });

    it("a first male render is drawn from its own window, asking for male only", async () => {
      const { posts } = stubSequence([view([pendingGag(null)], { isActive: false })]);
      render(<GagsPanel factId={5} reviewId={77} rendersEnabled subjectNames={[]} />);
      const maleTile = (await screen.findAllByTestId("gag-render")).find((t) => t.getAttribute("data-kind") === "male")!;
      fireEvent.click(within(maleTile).getByTestId("gag-redraw-render"));
      await waitFor(() => expect(posts.filter((p) => p.url.endsWith("/renders"))).toHaveLength(1));
      // Every draw asked for makes a new render (PLAN_RENDER_HISTORY.md D1).
      expect(posts.find((p) => p.url.endsWith("/renders"))!.body).toEqual({ kinds: ["male"], redraw: true, reviewId: 77 });
    });

    it("keeps reloading while a render that was asked for is drawing, and shows its approval when it lands", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const { gets } = stubSequence([view([pendingGag({ ...male, status: "queued", imageUrl: null })], { isActive: false }), view([pendingGag(male)], { isActive: false })]);
      render(<GagsPanel factId={5} reviewId={null} rendersEnabled subjectNames={[]} />);
      await screen.findByTestId("gag-card");
      await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
      expect(gets.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(await screen.findByTestId("gag-approve-render")).toBeTruthy();
    });

    it("a reload from outside the panel (an idea used on a gag) does not make it wait for a render", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const { gets } = stubSequence([view([pendingGag(null)])]);
      const first = render(<GagsPanel factId={5} reviewId={null} rendersEnabled subjectNames={[]} reloadKey={0} />);
      await screen.findByTestId("gag-card");
      first.rerender(<GagsPanel factId={5} reviewId={null} rendersEnabled subjectNames={[]} reloadKey={1} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
      expect(gets).toHaveBeenCalledTimes(2);
    });
  });

  describe("the Gags and Renders views each earn their place (Issue #1304, plan PLAN_RENDER_HISTORY.md)", () => {
    const working = (id: number, over: Partial<RenderScenarioCard> = {}) => card("i2i_male_default", { latestAttemptId: id, imageUrl: `/api/admin/gags/1/renders/w${id}/image`, ...over });
    /** A published gag with a draft change: male live is #1, the draft's male pick is #4, and a newer male render #7 is working. */
    const changed = () => gag({
      id: 1, slot: 1, state: "approved_with_change",
      approvedExamples: { male: ex(1), female: ex(2), pet: null },
      pendingContent: scene("{NAME} lifts the sun."),
      pendingExamples: { male: ex(4), female: null, pet: null },
      renders: { male: working(7), female: null, pet: null },
    });

    it("D2: the Gags view shows only each picture's official renders, each under its label, and says when a picture has none", async () => {
      stubFetch(view([changed()]));
      render(<GagsPanel factId={5} reviewId={null} rendersEnabled={false} subjectNames={[]} />);
      const male = (await screen.findAllByTestId("gag-official")).find((o) => o.getAttribute("data-kind") === "male")!;
      expect(within(male).getAllByTestId("gag-example-label").map((l) => l.textContent)).toEqual(["Live example", "Approved for next publish"]);
      expect(within(male).getAllByTestId("gag-example").map((i) => i.getAttribute("src"))).toEqual([ex(1).imageUrl, ex(4).imageUrl]);
      const pet = screen.getAllByTestId("gag-official").find((o) => o.getAttribute("data-kind") === "pet")!;
      expect(within(pet).getByTestId("gag-no-official").textContent).toBe("No approved example yet.");
      // The working render is the Renders view's, never the Gags view's.
      expect(document.querySelector(`img[src="${working(7).imageUrl}"]`)).toBeNull();
      expect(screen.queryByTestId("gag-history")).toBeNull();
    });

    it("D2: on an unpublished fact the pick reads \"Approved for publishing\"", async () => {
      stubFetch(view([gag({ id: 1, slot: 1, state: "new", availableToUsers: false, approvedContent: null, pendingContent: scene("{NAME} x."), pendingExamples: { male: ex(4), female: null, pet: null } })], { isActive: false }));
      render(<GagsPanel factId={5} reviewId={77} rendersEnabled={false} subjectNames={[]} />);
      const male = (await screen.findAllByTestId("gag-official")).find((o) => o.getAttribute("data-kind") === "male")!;
      expect(within(male).getAllByTestId("gag-example-label").map((l) => l.textContent)).toEqual(["Approved for publishing"]);
    });

    it("D3: the Renders view shows each official render locked, with no draw, approve or delete, beside the working render", async () => {
      const calls = stubFetch(view([changed()]));
      render(<GagsPanel factId={5} reviewId={null} rendersEnabled subjectNames={[]} />);
      const male = (await screen.findAllByTestId("gag-render")).find((t) => t.getAttribute("data-kind") === "male")!;
      const official = within(male).getAllByTestId("gag-render-official");
      expect(official.map((o) => o.getAttribute("data-role"))).toEqual(["live", "approved_next"]);
      for (const o of official) {
        expect(o.textContent).toMatch(/Locked/);
        for (const id of ["gag-redraw-render", "gag-approve-render", "gag-history-delete"]) expect(within(o).queryByTestId(id), id).toBeNull();
      }
      const w = within(male).getByTestId("gag-render-working");
      expect(within(w).getByTestId("gag-render-open").querySelector("img")!.getAttribute("src")).toBe(working(7).imageUrl);
      expect(within(w).getByTestId("gag-approve-render")).toBeTruthy();
      fireEvent.click(within(w).getByTestId("gag-redraw-render"));
      await waitFor(() => expect(calls.find((c) => c.url.endsWith("/renders"))?.body).toEqual({ kinds: ["male"], redraw: true }));
    });

    it("D1: a render that is both the working render and a pick is shown once, naming its role", async () => {
      stubFetch(view([gag({
        id: 1, slot: 1, state: "approved_with_change",
        approvedExamples: { male: ex(1), female: null, pet: null },
        pendingContent: scene("{NAME} lifts the sun."),
        pendingExamples: { male: ex(7), female: null, pet: null },
        renders: { male: working(7), female: null, pet: null },
      })]));
      render(<GagsPanel factId={5} reviewId={null} rendersEnabled subjectNames={[]} />);
      const male = (await screen.findAllByTestId("gag-render")).find((t) => t.getAttribute("data-kind") === "male")!;
      expect(within(male).getAllByTestId("gag-render-official").map((o) => o.getAttribute("data-role"))).toEqual(["live"]);
      expect(within(male).getByTestId("gag-render-picked").textContent).toBe("Approved for next publish");
      expect(within(male).queryByTestId("gag-approve-render")).toBeNull();
    });

    const entry = (id: number, over: Partial<RenderHistoryEntry> = {}): RenderHistoryEntry => ({
      attemptId: id, kind: "male", createdAt: `2026-11-2${id % 10}T12:00:00.000Z`,
      drawnBy: { userId: "a1", name: "Raena Admin" }, roles: [], status: "done", error: null,
      imageUrl: `/api/admin/gags/1/renders/j${id}/image`,
      gag: { ...scene("{NAME} lifts the moon."), bubbles: [{ type: "speech", entity: "subject", text: "Light work." }] } as unknown as VisualPromptStrategyOverride,
      reference: { identityType: "male", assetVersion: "v3" },
      engine: { engineId: "gpt-image-2", fallback: null },
      prompt: { compiled: { scene: "lifts the moon" }, requests: [{ id: id * 10, endpointId: "fal-ai/x", engineId: "gpt-image-2", createdAt: "2026-11-24T12:00:00.000Z", request: { prompt: "moon" }, billedUsd: 0.04 }] },
      approval: "not_approved", cost: { state: "billed", usd: 0.04, unbilledRequests: 0, unknownRequests: 0 },
      ...over,
    });

    it("D3/D4: each gag's history is collapsed until opened, lists every render newest first with its roles, and opens to its full record", async () => {
      const calls = stubFetch(view([changed()]), {
        history: (url) => url.includes("before=")
          ? { gagId: 1, entries: [entry(1, { roles: ["live"], approval: "approved" })], nextBefore: null }
          : { gagId: 1, entries: [entry(7, { roles: ["working"] }), entry(5, { status: "failed", imageUrl: null, error: "vendor failed", cost: { state: "never_sent" }, approval: "not_recorded" })], nextBefore: "2026-11-25T12:00:00.000Z|5" },
      });
      render(<GagsPanel factId={5} reviewId={null} rendersEnabled subjectNames={[]} />);
      const history = await screen.findByTestId("gag-history");
      expect(calls.some((c) => c.url.includes("/gags/1/render-history"))).toBe(false);
      fireEvent.click(within(history).getByTestId("gag-history-toggle"));
      await waitFor(() => expect(within(history).getAllByTestId("gag-history-entry")).toHaveLength(2));
      const rows = within(history).getAllByTestId("gag-history-entry");
      expect(rows.map((r) => r.getAttribute("data-attempt-id"))).toEqual(["7", "5"]);
      expect(within(rows[0]!).getByTestId("gag-history-role").textContent).toBe("Working render");
      expect(within(rows[0]!).getByTestId("gag-history-cost").textContent).toBe("· $0.0400");
      expect(within(rows[1]!).getByTestId("gag-history-status").textContent).toBe("· Failed: vendor failed");
      expect(within(rows[1]!).getByTestId("gag-history-cost").textContent).toBe("· Never reached fal; nothing charged");

      fireEvent.click(within(rows[0]!).getByTestId("gag-history-entry-toggle"));
      const record = within(rows[0]!).getByTestId("gag-history-record");
      expect(within(record).getByTestId("gag-history-approval").textContent).toBe("Not approved");
      expect(within(record).getByTestId("gag-history-engine").textContent).toBe("gpt-image-2");
      expect(within(record).getByTestId("gag-history-gag").textContent).toMatch(/lifts the moon.*Light work\./);
      expect(within(record).getByTestId("gag-history-requests").textContent).toMatch(/"prompt": "moon"/);

      // "Load older" reads the next page from the cursor, so no paid render is out of reach.
      fireEvent.click(within(history).getByTestId("gag-history-older"));
      await waitFor(() => expect(within(history).getAllByTestId("gag-history-entry")).toHaveLength(3));
      expect(calls.find((c) => c.url.includes("before="))!.url).toContain(`before=${encodeURIComponent("2026-11-25T12:00:00.000Z|5")}`);
      const oldest = within(history).getAllByTestId("gag-history-entry")[2]!;
      expect(within(oldest).getByTestId("gag-history-role").textContent).toBe("Live example");
      expect(within(history).queryByTestId("gag-history-older")).toBeNull();
    });

    it("D6: an old render is deleted after a confirmation naming the picture and date; an official one offers no delete", async () => {
      const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
      const calls = stubFetch(view([changed()]), {
        history: () => ({ gagId: 1, entries: [entry(1, { roles: ["live"] }), entry(3)], nextBefore: null }),
        deleteAnswer: { status: 200, body: { deleted: true, fileStillBeingRemoved: true } },
      });
      render(<GagsPanel factId={5} reviewId={77} rendersEnabled subjectNames={[]} />);
      const history = await screen.findByTestId("gag-history");
      fireEvent.click(within(history).getByTestId("gag-history-toggle"));
      const rows = await within(history).findAllByTestId("gag-history-entry");
      for (const r of rows) fireEvent.click(within(r).getByTestId("gag-history-entry-toggle"));
      expect(within(rows[0]!).queryByTestId("gag-history-delete"), "the live example cannot be deleted").toBeNull();
      fireEvent.click(within(rows[1]!).getByTestId("gag-history-delete"));
      expect(confirm.mock.calls[0]![0]).toMatch(/^Delete the male render drawn .+ for good\?/);
      await waitFor(() => expect(calls.some((c) => c.url.endsWith("/gags/1/renders/3/delete"))).toBe(true));
      expect(calls.find((c) => c.url.endsWith("/delete"))!.body).toEqual({ reviewId: 77 });
      expect((await within(history).findByTestId("gag-history-notice")).textContent).toBe("Deleted; its picture file is still being removed.");
      confirm.mockRestore();
    });

    it("D6: a cancelled confirmation deletes nothing, and a refusal shows the server's reason", async () => {
      const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
      const calls = stubFetch(view([changed()]), {
        history: () => ({ gagId: 1, entries: [entry(3)], nextBefore: null }),
        deleteAnswer: { status: 409, body: { error: "This render is still drawing.", code: "RENDER_RUNNING" } },
      });
      render(<GagsPanel factId={5} reviewId={null} rendersEnabled subjectNames={[]} />);
      const history = await screen.findByTestId("gag-history");
      fireEvent.click(within(history).getByTestId("gag-history-toggle"));
      const row = await within(history).findByTestId("gag-history-entry");
      fireEvent.click(within(row).getByTestId("gag-history-entry-toggle"));
      fireEvent.click(within(row).getByTestId("gag-history-delete"));
      expect(calls.some((c) => c.url.endsWith("/delete"))).toBe(false);
      confirm.mockReturnValue(true);
      fireEvent.click(within(row).getByTestId("gag-history-delete"));
      expect((await within(history).findByTestId("gag-history-error")).textContent).toBe("This render is still drawing.");
      confirm.mockRestore();
    });

    it("read-only, the history offers no delete", async () => {
      stubFetch(view([changed()]), { history: () => ({ gagId: 1, entries: [entry(3)], nextBefore: null }) });
      render(<GagsPanel factId={5} reviewId={null} rendersEnabled disabled subjectNames={[]} />);
      const history = await screen.findByTestId("gag-history");
      fireEvent.click(within(history).getByTestId("gag-history-toggle"));
      const row = await within(history).findByTestId("gag-history-entry");
      fireEvent.click(within(row).getByTestId("gag-history-entry-toggle"));
      expect(within(row).queryByTestId("gag-history-delete")).toBeNull();
    });

    it("removed gags keep their history, grouped by the gag's own id", async () => {
      const calls = stubFetch(view([changed()]), {
        removed: [{ gagId: 41, renders: 2, lastRenderAt: "2026-11-20T12:00:00.000Z" }],
        history: (url) => ({ gagId: 41, entries: url.includes("/gags/41/") ? [entry(9)] : [], nextBefore: null }),
      });
      render(<GagsPanel factId={5} reviewId={null} rendersEnabled subjectNames={[]} />);
      const removed = await screen.findByTestId("removed-gags-history");
      fireEvent.click(within(removed).getByTestId("removed-gags-toggle"));
      const g = within(removed).getByTestId("removed-gag-history");
      expect(g.getAttribute("data-gag-id")).toBe("41");
      expect(g.textContent).toMatch(/Removed gag #41: 2 renders/);
      fireEvent.click(within(g).getByTestId("gag-history-toggle"));
      await within(g).findByTestId("gag-history-entry");
      expect(calls.some((c) => c.url.endsWith("/gags/41/render-history"))).toBe(true);
    });

    it("the Gags view shows no removed gags' history", async () => {
      stubFetch(view([changed()]), { removed: [{ gagId: 41, renders: 2, lastRenderAt: "2026-11-20T12:00:00.000Z" }] });
      render(<GagsPanel factId={5} reviewId={null} rendersEnabled={false} subjectNames={[]} />);
      await screen.findByTestId("gag-card");
      expect(screen.queryByTestId("removed-gags-history")).toBeNull();
    });

    it("D5 and D4: cost and approval read in words, never a partial sum as the whole and never \"Never approved\" without evidence", () => {
      expect(costWords({ state: "billed", usd: 0.08, unbilledRequests: 0, unknownRequests: 0 })).toBe("$0.0800");
      expect(costWords({ state: "billed", usd: 0.04, unbilledRequests: 1, unknownRequests: 0 })).toBe("$0.0400 so far; 1 request not billed yet");
      expect(costWords({ state: "billed", usd: 0.04, unbilledRequests: 0, unknownRequests: 2 })).toBe("$0.0400 so far; 2 requests whose charge is not on record");
      expect(costWords({ state: "not_checked" })).toBe("Cost not checked yet");
      expect(costWords({ state: "no_bill_found" })).toBe("No bill found at fal yet");
      expect(costWords({ state: "billing_key_not_set" })).toBe("Cost unknown: the billing key is not set");
      expect(costWords({ state: "not_recorded" })).toBe("Cost not recorded");
      expect(costWords({ state: "never_sent" })).toBe("Never reached fal; nothing charged");
      expect(approvalWords("approved")).toBe("Approved");
      expect(approvalWords("not_recorded")).toBe("Approval history not recorded");
      expect(approvalWords("not_approved")).toBe("Not approved");
    });
  });

  describe("unsaved gag edits are kept in the browser (build report, PR #956)", () => {
    it("an edit survives closing and reopening the panel, until it is undone", async () => {
      const v = view([gag({ id: 1, slot: 1, isDefault: true })]);
      stubFetch(v);
      const first = render(<GagsPanel factId={5} reviewId={null} rendersEnabled={false} subjectNames={[]} />);
      const card = await screen.findByTestId("gag-card");
      fireEvent.change(within(card).getByTestId("visual-concept-textarea"), { target: { value: "{NAME} an edit typed before closing." } });
      first.unmount();

      render(<GagsPanel factId={5} reviewId={null} rendersEnabled={false} subjectNames={[]} />);
      const again = await screen.findByTestId("gag-card");
      expect((within(again).getByTestId("visual-concept-textarea") as HTMLTextAreaElement).value).toBe("{NAME} an edit typed before closing.");
      fireEvent.click(within(again).getByTestId("gag-undo"));
      expect(window.localStorage.length).toBe(0);
    });

    it("a kept edit is dropped once the gag changed on the server", async () => {
      stubFetch(view([gag({ id: 1, slot: 1, isDefault: true })]));
      const first = render(<GagsPanel factId={5} reviewId={null} rendersEnabled={false} subjectNames={[]} />);
      fireEvent.change(within(await screen.findByTestId("gag-card")).getByTestId("visual-concept-textarea"), { target: { value: "{NAME} an old edit." } });
      first.unmount();
      vi.unstubAllGlobals();

      stubFetch(view([gag({ id: 1, slot: 1, isDefault: true, approvedContent: scene("{NAME} changed elsewhere.") })]));
      render(<GagsPanel factId={5} reviewId={null} rendersEnabled={false} subjectNames={[]} />);
      const card = await screen.findByTestId("gag-card");
      expect((within(card).getByTestId("visual-concept-textarea") as HTMLTextAreaElement).value).toBe("{NAME} changed elsewhere.");
    });

    it("an edit survives the panel being locked, as Back to Gags does, then closed (Codex, PR #958 round 2)", async () => {
      stubFetch(view([gag({ id: 1, slot: 1, isDefault: true })]));
      const first = render(<GagsPanel factId={5} reviewId={null} rendersEnabled={false} subjectNames={[]} />);
      fireEvent.change(within(await screen.findByTestId("gag-card")).getByTestId("visual-concept-textarea"), { target: { value: "{NAME} typed before Back." } });
      first.rerender(<GagsPanel factId={5} reviewId={null} rendersEnabled={false} subjectNames={[]} disabled />);
      await act(async () => {});
      first.unmount();
      render(<GagsPanel factId={5} reviewId={null} rendersEnabled={false} subjectNames={[]} />);
      const again = await screen.findByTestId("gag-card");
      expect((within(again).getByTestId("visual-concept-textarea") as HTMLTextAreaElement).value).toBe("{NAME} typed before Back.");
    });

    it("a kept edit survives opening the gag read-only, then comes back when editable", async () => {
      stubFetch(view([gag({ id: 1, slot: 1, isDefault: true })]));
      const first = render(<GagsPanel factId={5} reviewId={null} rendersEnabled={false} subjectNames={[]} />);
      fireEvent.change(within(await screen.findByTestId("gag-card")).getByTestId("visual-concept-textarea"), { target: { value: "{NAME} kept while frozen." } });
      first.unmount();
      const locked = render(<GagsPanel factId={5} reviewId={null} rendersEnabled={false} subjectNames={[]} disabled />);
      await screen.findByTestId("gag-card");
      await act(async () => {});
      locked.unmount();
      render(<GagsPanel factId={5} reviewId={null} rendersEnabled={false} subjectNames={[]} />);
      const again = await screen.findByTestId("gag-card");
      expect((within(again).getByTestId("visual-concept-textarea") as HTMLTextAreaElement).value).toBe("{NAME} kept while frozen.");
    });

    it("a new gag, once saved, leaves no draft behind (Codex, PR #958 round 1)", async () => {
      const after = view([gag({ id: 1, slot: 1, isDefault: true }), gag({ id: 2, slot: 2, state: "new", availableToUsers: false, approvedContent: null, approvedAt: null, pendingContent: scene("{NAME} saved as a new gag.") })]);
      stubFetch(view([gag({ id: 1, slot: 1, isDefault: true })]), { after });
      const first = render(<GagsPanel factId={5} reviewId={null} rendersEnabled={false} subjectNames={[]} />);
      fireEvent.click(await screen.findByTestId("gag-add"));
      fireEvent.change(within(screen.getByTestId("gag-new")).getByTestId("visual-concept-textarea"), { target: { value: "{NAME} saved as a new gag." } });
      fireEvent.click(screen.getByTestId("gag-new-save"));
      await waitFor(() => expect(screen.queryByTestId("gag-new")).toBeNull());
      expect(window.localStorage.getItem("gag-draft::5:new")).toBeNull();
      first.unmount();
      render(<GagsPanel factId={5} reviewId={null} rendersEnabled={false} subjectNames={[]} />);
      await screen.findAllByTestId("gag-card");
      expect(screen.queryByTestId("gag-new")).toBeNull();
    });

    it("a new gag's draft reopens its card", async () => {
      stubFetch(view([gag({ id: 1, slot: 1, isDefault: true })]));
      const first = render(<GagsPanel factId={5} reviewId={null} rendersEnabled={false} subjectNames={[]} />);
      fireEvent.click(await screen.findByTestId("gag-add"));
      fireEvent.change(within(screen.getByTestId("gag-new")).getByTestId("visual-concept-textarea"), { target: { value: "{NAME} a new gag half-written." } });
      first.unmount();

      render(<GagsPanel factId={5} reviewId={null} rendersEnabled={false} subjectNames={[]} />);
      const reopened = await screen.findByTestId("gag-new");
      expect((within(reopened).getByTestId("visual-concept-textarea") as HTMLTextAreaElement).value).toBe("{NAME} a new gag half-written.");
    });
  });

  it("has no \"More art direction\" controls: the scene, who is in it, and the bubbles are the whole card (plan PLAN_GAG_DIRECT_RENDER.md, F; Q1: 1)", async () => {
    stubFetch(view([gag({ id: 1, slot: 1, isDefault: true })]));
    render(<GagsPanel factId={5} reviewId={null} rendersEnabled={false} subjectNames={[]} />);
    const card = await screen.findByTestId("gag-card");
    expect(within(card).queryByText("More art direction")).toBeNull();
    expect(within(card).queryByText(/Moderator Intent/i)).toBeNull();
    expect(within(card).queryByText(/Scene Role Assignments/i)).toBeNull();
    expect(within(card).getByTestId("visual-concept-textarea")).toBeTruthy();
    expect(within(card).getByTestId("gag-cast")).toBeTruthy();
    expect(within(card).getByTestId("bubble-editor")).toBeTruthy();
  });

  it("saving reads the cast of the tokenized scene and sends it with the change", async () => {
    const calls = stubFetch(view([gag({ id: 1, slot: 1, isDefault: true })]), { cast: [{ label: "mom", description: "the older woman" }] });
    render(<GagsPanel factId={5} reviewId={null} rendersEnabled={false} subjectNames={["Alex"]} />);
    const card = await screen.findByTestId("gag-card");
    fireEvent.change(within(card).getByTestId("visual-concept-textarea"), { target: { value: "Alex drives; mom grips the dash." } });
    fireEvent.click(within(card).getByTestId("gag-save"));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    const castCall = calls.find((c) => c.url === "/api/admin/facts/5/gags/cast")!;
    expect(castCall.body).toMatchObject({ scene: "{NAME} drives; mom grips the dash." });
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.body).toMatchObject({
      content: {
        coreSceneOverride: "{NAME} drives; mom grips the dash.",
        cast: [{ label: "mom", description: "the older woman" }],
        castExtraction: { sourceKey: castSourceKey("{NAME} drives; mom grips the dash.", []) },
      },
    });
  });

  it("adding a bubble after changing the scene reads who is in it, shows them, and offers the subject and them as speakers", async () => {
    const calls = stubFetch(view([gag({ id: 1, slot: 1, isDefault: true })]), { cast: [{ label: "bartender", description: "the man behind the bar" }] });
    render(<GagsPanel factId={5} reviewId={null} rendersEnabled={false} subjectNames={[]} />);
    const card = await screen.findByTestId("gag-card");
    expect(within(card).getByTestId("gag-cast-unread")).toBeTruthy();
    fireEvent.change(within(card).getByTestId("visual-concept-textarea"), { target: { value: "{NAME} orders milk; the bartender stares." } });
    fireEvent.click(within(card).getByTestId("bubble-add"));
    await waitFor(() => expect(within(card).getAllByTestId("gag-cast-chip").map((c) => c.textContent)).toEqual(["bartender"]));
    expect(calls.filter((c) => c.url.endsWith("/gags/cast"))).toHaveLength(1);
    const options = [...(within(card).getByTestId("bubble-entity") as HTMLSelectElement).options].map((o) => o.value);
    expect(options).toEqual(["subject", "bartender"]);
    // Editing a bubble again, with the scene unchanged, does not read it again.
    fireEvent.change(within(card).getByTestId("bubble-text"), { target: { value: "Milk?" } });
    expect(calls.filter((c) => c.url.endsWith("/gags/cast"))).toHaveLength(1);
  });

  it("a reading that comes back after a save was adopted does not mark the saved card unsaved again (Codex, PR #1002 round 3)", async () => {
    const calls: Call[] = [];
    let releaseFirst: (() => void) | null = null;
    let castReads = 0;
    let saved: VisualPromptStrategyOverride | null = null;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url: String(url), method, body });
      const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });
      if (url === "/api/ai/tokenize-enrichment") {
        const entries = (body as { entries: { path: string; value: string }[] }).entries;
        return json({ results: entries.map((e) => ({ path: e.path, value: e.value, changed: false, usedLlm: false })) });
      }
      if (String(url).endsWith("/gags/cast")) {
        const b = body as { scene: string; bubbles: { entity: string; text: string }[] };
        const n = ++castReads;
        // Each reading is its own model call: its own description and time.
        const answer = () => json({
          cast: [{ label: "bartender", description: n === 1 ? "the first reading" : "the save's reading" }],
          castExtraction: { promptVersion: "v2", extractedAt: `2026-11-17T00:00:0${n}.000Z`, sourceKey: castSourceKey(b.scene, b.bubbles) },
          unboundSpeakers: [],
        });
        if (n === 1) return new Promise<Response>((resolve) => { releaseFirst = () => resolve(answer()); });
        return answer();
      }
      if (method === "PUT") saved = (body as { content: VisualPromptStrategyOverride }).content;
      const g = saved
        ? gag({ id: 1, slot: 1, isDefault: true, state: "approved_with_change", pendingContent: saved })
        : gag({ id: 1, slot: 1, isDefault: true });
      return json(view([g]));
    }));
    const onUnsaved = vi.fn();
    render(<GagsPanel factId={5} reviewId={null} rendersEnabled={false} subjectNames={[]} onUnsavedChange={onUnsaved} />);
    const card = await screen.findByTestId("gag-card");
    fireEvent.change(within(card).getByTestId("visual-concept-textarea"), { target: { value: "{NAME} orders milk; the bartender stares." } });
    fireEvent.click(within(card).getByTestId("bubble-add"));
    await waitFor(() => expect(castReads).toBe(1));
    fireEvent.change(within(card).getByTestId("bubble-text"), { target: { value: "Milk?" } });
    fireEvent.click(within(card).getByTestId("gag-save"));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    await waitFor(() => expect(within(card).queryByTestId("gag-undo")).toBeNull());
    expect(saved!.cast).toEqual([{ label: "bartender", description: "the save's reading" }]);

    await act(async () => { releaseFirst!(); });
    await waitFor(() => expect(castReads).toBe(2));
    // The saved card stays saved: no undo, Save disabled, nothing reported unsaved.
    await new Promise((r) => setTimeout(r, 20));
    expect(within(card).queryByTestId("gag-undo")).toBeNull();
    expect((within(card).getByTestId("gag-save") as HTMLButtonElement).disabled).toBe(true);
    expect(onUnsaved).toHaveBeenLastCalledWith([]);
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1);
  });

  it("a saved speaker the scene does not show is marked, and the save stops naming the bubble, with the draft kept", async () => {
    const withNurse = { ...scene("{NAME} naps alone."), bubbles: [{ type: "speech" as const, entity: "nurse", text: "Shh" }] };
    const calls = stubFetch(view([gag({ id: 1, slot: 1, isDefault: true, approvedContent: withNurse })]), { cast: [] });
    render(<GagsPanel factId={5} reviewId={null} rendersEnabled={false} subjectNames={[]} />);
    const card = await screen.findByTestId("gag-card");
    fireEvent.change(within(card).getByTestId("visual-concept-textarea"), { target: { value: "{NAME} naps alone, snoring." } });
    fireEvent.click(within(card).getByTestId("gag-save"));
    const err = await within(card).findByTestId("gag-error");
    expect(err.textContent).toContain('"nurse" (bubble 1)');
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
    const select = within(card).getByTestId("bubble-entity") as HTMLSelectElement;
    expect(select.value).toBe("nurse");
    expect(select.selectedOptions[0]!.textContent).toBe("nurse (not in this scene)");
    expect((within(card).getByTestId("visual-concept-textarea") as HTMLTextAreaElement).value).toBe("{NAME} naps alone, snoring.");
  });

  it("a failed reading stops the save and keeps the edit; the cast offers a retry", async () => {
    const calls = stubFetch(view([gag({ id: 1, slot: 1, isDefault: true })]), { castFails: true });
    render(<GagsPanel factId={5} reviewId={null} rendersEnabled={false} subjectNames={[]} />);
    const card = await screen.findByTestId("gag-card");
    fireEvent.change(within(card).getByTestId("visual-concept-textarea"), { target: { value: "{NAME} sings." } });
    fireEvent.click(within(card).getByTestId("gag-save"));
    expect((await within(card).findByTestId("gag-error")).textContent).toMatch(/Reading who is in the scene failed.*Your edits are kept/);
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
    fireEvent.click(within(card).getByTestId("bubble-add"));
    expect(await within(card).findByTestId("gag-cast-retry")).toBeTruthy();
  });
  describe("a fill from the gag ideas (Codex 4649903945 and 4649903966, PR #1136 round 1)", () => {
    const filled = (text: string, untouched: boolean) => gag({ id: 31, slot: 1, state: "new", availableToUsers: false, approvedContent: null, approvedAt: null, pendingContent: scene(text), prefilledUntouched: untouched });
    const stubSequence = (views: () => FactGagsView) => {
      let gets = 0;
      vi.stubGlobal("fetch", vi.fn(async () => { gets++; return new Response(JSON.stringify(views()), { status: 200, headers: { "Content-Type": "application/json" } }); }));
      return () => gets;
    };

    it("keeps polling and showing the fill for as long as the view says it is under way, with no deadline, and shows the gag it lands", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        let landed = false;
        const gets = stubSequence(() => (landed
          ? view([filled("{NAME} does thing 0.", true)], { isActive: false, review: { id: 9, stage: "gags" } })
          : view([], { isActive: false, review: { id: 9, stage: "gags" }, filling: true })));
        render(<GagsPanel factId={5} reviewId={9} rendersEnabled={false} subjectNames={[]} startWithGag1 />);
        await screen.findByTestId("gags-filling");
        await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
        expect(screen.getByTestId("gags-filling")).toBeTruthy();
        const before = gets();
        await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
        expect(gets()).toBeGreaterThan(before);
        landed = true;
        await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
        expect((await screen.findByTestId("gag-card")).textContent).toContain("Visual gag 1");
        expect(screen.queryByTestId("gags-filling")).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it("says when the fill failed for good, pointing at the ideas", async () => {
      stubFetch(view([], { isActive: false, review: { id: 9, stage: "gags" }, fillFailed: true }));
      render(<GagsPanel factId={5} reviewId={9} rendersEnabled={false} subjectNames={[]} startWithGag1 />);
      expect((await screen.findByTestId("gags-fill-failed")).textContent).toMatch(/Use an idea below, or write the gag yourself/);
    });

    it("typing in an open gag stays, unsaved, when a fill replaces that gag underneath it", async () => {
      let refilled = false;
      stubSequence(() => view([refilled ? filled("{NAME} the new idea.", true) : filled("{NAME} the old idea.", true)], { isActive: false, review: { id: 9, stage: "gags" } }));
      const onUnsaved = vi.fn();
      const { rerender } = render(<GagsPanel factId={5} reviewId={9} rendersEnabled={false} subjectNames={[]} reloadKey={0} onUnsavedChange={onUnsaved} />);
      const card = await screen.findByTestId("gag-card");
      fireEvent.change(within(card).getByTestId("visual-concept-textarea"), { target: { value: "{NAME} my typing." } });
      refilled = true;
      await act(async () => { rerender(<GagsPanel factId={5} reviewId={9} rendersEnabled={false} subjectNames={[]} reloadKey={1} onUnsavedChange={onUnsaved} />); });
      await waitFor(() => expect(JSON.parse(window.localStorage.getItem("gag-draft::5:31")!).base).toContain("the new idea"));
      expect((within(screen.getByTestId("gag-card")).getByTestId("visual-concept-textarea") as HTMLTextAreaElement).value).toBe("{NAME} my typing.");
      await waitFor(() => expect(onUnsaved).toHaveBeenLastCalledWith(["Visual gag 1"]));
      fireEvent.click(within(screen.getByTestId("gag-card")).getByTestId("gag-undo"));
      expect((within(screen.getByTestId("gag-card")).getByTestId("visual-concept-textarea") as HTMLTextAreaElement).value).toBe("{NAME} the new idea.");
    });

    it("a kept edit comes back on reopening after a fill replaced the gag meanwhile", async () => {
      stubFetch(view([filled("{NAME} the old idea.", true)], { isActive: false, review: { id: 9, stage: "gags" } }));
      const first = render(<GagsPanel factId={5} reviewId={9} rendersEnabled={false} subjectNames={[]} />);
      fireEvent.change(within(await screen.findByTestId("gag-card")).getByTestId("visual-concept-textarea"), { target: { value: "{NAME} typed before closing." } });
      first.unmount();
      vi.unstubAllGlobals();

      stubFetch(view([filled("{NAME} the new idea.", true)], { isActive: false, review: { id: 9, stage: "gags" } }));
      render(<GagsPanel factId={5} reviewId={9} rendersEnabled={false} subjectNames={[]} />);
      const card = await screen.findByTestId("gag-card");
      expect((within(card).getByTestId("visual-concept-textarea") as HTMLTextAreaElement).value).toBe("{NAME} typed before closing.");
    });
  });

  describe("the Gags step's Visual gag 1 (Issue #1018, increment 1.3b)", () => {
    it("with no gag yet, shows an empty Visual gag 1 that cannot be cancelled, and no add button", async () => {
      stubFetch(view([], { isActive: false, review: { id: 9, stage: "gags" } }));
      render(<GagsPanel factId={5} reviewId={9} rendersEnabled={false} subjectNames={[]} startWithGag1 />);
      const card = await screen.findByTestId("gag-new");
      expect(card.textContent).toContain("Visual gag 1");
      expect(within(card).queryByText("Cancel")).toBeNull();
      expect(screen.queryByTestId("gag-add")).toBeNull();
      expect(screen.queryByTestId("gags-empty")).toBeNull();
    });

    it("says while the gags are being filled from the gag ideas", async () => {
      stubFetch(view([], { isActive: false, review: { id: 9, stage: "gags" }, filling: true }));
      render(<GagsPanel factId={5} reviewId={9} rendersEnabled={false} subjectNames={[]} startWithGag1 />);
      expect((await screen.findByTestId("gags-filling")).textContent).toMatch(/Filling from the gag ideas/);
    });

    it("text typed into the empty card stays, as an unsaved edit over gag 1 when the first idea fills it", async () => {
      let filled = false;
      const filledView = view([gag({ id: 21, slot: 1, state: "new", availableToUsers: false, approvedContent: null, approvedAt: null, pendingContent: scene("{NAME} does thing 0.") })], { isActive: false, review: { id: 9, stage: "gags" } });
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(filled ? filledView : view([], { isActive: false, review: { id: 9, stage: "gags" } })), { status: 200, headers: { "Content-Type": "application/json" } })));
      const onUnsaved = vi.fn();
      const { rerender } = render(<GagsPanel factId={5} reviewId={9} rendersEnabled={false} subjectNames={[]} startWithGag1 reloadKey={0} onUnsavedChange={onUnsaved} />);
      const empty = await screen.findByTestId("gag-new");
      fireEvent.change(within(empty).getByTestId("visual-concept-textarea"), { target: { value: "{NAME} typed first." } });
      await waitFor(() => expect(window.localStorage.getItem("gag-draft::5:new")).toBeTruthy());
      filled = true;
      await act(async () => { rerender(<GagsPanel factId={5} reviewId={9} rendersEnabled={false} subjectNames={[]} startWithGag1 reloadKey={1} onUnsavedChange={onUnsaved} />); });
      const card = await screen.findByTestId("gag-card");
      expect(card.textContent).toContain("Visual gag 1");
      expect((within(card).getByTestId("visual-concept-textarea") as HTMLTextAreaElement).value).toBe("{NAME} typed first.");
      await waitFor(() => expect(onUnsaved).toHaveBeenLastCalledWith(["Visual gag 1"]));
      expect(screen.queryByTestId("gag-new")).toBeNull();
    });
  });
});

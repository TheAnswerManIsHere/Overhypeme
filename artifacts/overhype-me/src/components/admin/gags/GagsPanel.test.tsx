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
  type PerKind,
  type RenderScenarioCard,
  type VisualPromptStrategyOverride,
} from "@workspace/api-zod";
import { GagsPanel } from "./GagsPanel";

const scene = (text: string): VisualPromptStrategyOverride => ({ ...EMPTY_VISUAL_STRATEGY_OVERRIDE, coreSceneOverride: text });
const NONE = { male: null, female: null, pet: null };
const ex = (attemptId: number): GagExample => ({ attemptId, imageUrl: `/api/admin/gags/1/renders/${attemptId}/image` });
function card(key: RenderScenarioCard["key"], over: Partial<RenderScenarioCard> = {}): RenderScenarioCard {
  return {
    key, label: key, purpose: "", referenceIdentityType: null, required: true,
    status: "done", stale: false, latestAttemptId: 901, imageUrl: "/api/admin/gags/2/renders/j/image", message: null,
    ...over,
  };
}

function gag(over: Partial<GagView> & Pick<GagView, "id" | "slot">): GagView {
  return {
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
    renders: NONE,
    ...over,
  };
}

function view(gags: GagView[], over: Partial<FactGagsView> = {}): FactGagsView {
  return { factId: 5, isActive: true, review: null, gags, maxGags: 3, draftReady: { ok: false, reason: null }, filling: false, fillFailed: false, ...over };
}

type Call = { url: string; method: string; body: unknown };

/** Stub fetch: GET answers `initial`; writes answer `after` (or a refusal); tokenize echoes. */
function stubFetch(initial: FactGagsView, opts: { after?: FactGagsView; refuse?: { status: number; body: unknown }; cast?: GagCastEntry[]; castFails?: boolean } = {}) {
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

  it("\"Render female and pet\" draws only those kinds; a tile draws its own again on request", async () => {
    const calls = stubFetch(view([gag({ id: 1, slot: 1, isDefault: true, renders: { ...NONE, male: card("i2i_male_default") } })]));
    render(<GagsPanel factId={5} reviewId={null} rendersEnabled subjectNames={[]} />);
    fireEvent.click(await screen.findByTestId("gag-render-rest"));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/renders"))).toBe(true));
    expect(calls.find((c) => c.url.endsWith("/renders"))!.body).toEqual({ kinds: ["female", "pet"] });

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
    // Female and pet are drawn on request.
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

  describe("reloading while an iteration render is on its way (Codex, PR #956 round 1)", () => {
    const male = card("i2i_male_default", { latestAttemptId: 950 });
    const pendingGag = (m: RenderScenarioCard | null) => gag({
      id: 2, slot: 1, state: "new", availableToUsers: false, approvedContent: null, approvedAt: null,
      pendingContent: scene("{NAME} juggles planets."), renders: { ...NONE, male: m },
    });
    /** GET answers each view in turn, then repeats the last. */
    function stubSequence(views: FactGagsView[]) {
      let n = 0;
      const gets = vi.fn();
      vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
        gets();
        const v = views[Math.min(n, views.length - 1)]!;
        if ((init?.method ?? "GET") === "GET") n++;
        return new Response(JSON.stringify(v), { status: 200, headers: { "Content-Type": "application/json" } });
      }));
      return gets;
    }
    afterEach(() => vi.useRealTimers());

    it("at Test Renders, a gag with no male render yet reloads until it appears, and offers its approval", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const gets = stubSequence([view([pendingGag(null)], { isActive: false }), view([pendingGag(male)], { isActive: false })]);
      render(<GagsPanel factId={5} reviewId={77} rendersEnabled rendersExpected subjectNames={[]} />);
      await screen.findByTestId("gag-card");
      expect(screen.queryByTestId("gag-approve-render")).toBeNull();
      await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
      expect(gets.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(await screen.findByTestId("gag-approve-render")).toBeTruthy();
    });

    it("keeps reloading while a render is drawing", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const gets = stubSequence([view([pendingGag({ ...male, status: "queued", imageUrl: null })], { isActive: false })]);
      render(<GagsPanel factId={5} reviewId={null} rendersEnabled subjectNames={[]} />);
      await screen.findByTestId("gag-card");
      await act(async () => { await vi.advanceTimersByTimeAsync(4500); });
      expect(gets.mock.calls.length).toBeGreaterThanOrEqual(3);
    });

    it("in the Facts editor, an idea applied from outside the panel (a reload) keeps it looking until the render appears (Codex, PR #972 round 1)", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const gets = stubSequence([view([pendingGag(null)]), view([pendingGag(null)]), view([pendingGag(male)])]);
      const first = render(<GagsPanel factId={5} reviewId={null} rendersEnabled subjectNames={[]} reloadKey={0} />);
      await screen.findByTestId("gag-card");
      first.rerender(<GagsPanel factId={5} reviewId={null} rendersEnabled subjectNames={[]} reloadKey={1} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
      expect(gets.mock.calls.length).toBeGreaterThanOrEqual(3);
      expect(await screen.findByTestId("gag-approve-render")).toBeTruthy();
    });

    it("in the Facts editor, a gag never drawn does not make the panel poll until an action asks for a render", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const gets = stubSequence([view([pendingGag(null)])]);
      render(<GagsPanel factId={5} reviewId={null} rendersEnabled subjectNames={[]} />);
      await screen.findByTestId("gag-card");
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
      expect(gets).toHaveBeenCalledTimes(1);
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

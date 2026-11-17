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
  type FactGagsView,
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
    pendingReviewId: null,
    pendingExamples: NONE,
    pendingRemove: false,
    refreshedSinceApproval: false,
    renders: NONE,
    ...over,
  };
}

function view(gags: GagView[], over: Partial<FactGagsView> = {}): FactGagsView {
  return { factId: 5, isActive: true, review: null, frozenOutsideReview: false, gags, maxGags: 3, ...over };
}

type Call = { url: string; method: string; body: unknown };

/** Stub fetch: GET answers `initial`; writes answer `after` (or a refusal); tokenize echoes. */
function stubFetch(initial: FactGagsView, opts: { after?: FactGagsView; refuse?: { status: number; body: unknown } } = {}) {
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
    render(<GagsPanel factId={5} reviewId={null} rendersEnabled subjectNames={["Alex"]} />);
    const cards = await screen.findAllByTestId("gag-card");
    expect(cards).toHaveLength(2);
    expect(within(cards[0]!).getByTestId("gag-default")).toBeTruthy();
    expect(within(cards[0]!).getByTestId("gag-availability").textContent).toBe("Offered to users");
    expect(within(cards[0]!).getByTestId("gag-grandfathered")).toBeTruthy();
    expect(within(cards[0]!).getByTestId("gag-example-words").textContent).toBe("No examples approved yet: male, female and pet to approve.");
    expect(within(cards[1]!).getByTestId("gag-availability").textContent).toBe("Hidden from users");
    expect(within(cards[1]!).getByTestId("gag-state").textContent).toMatch(/^New: hidden from users until its male, female and pet examples are approved/);
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
    await waitFor(() => expect(screen.getByTestId("gag-state").textContent).toBe("Approved, with a change waiting for its male, female and pet examples"));
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
    expect(screen.getByTestId("gag-example-words").textContent).toMatch(/^This change: Male picked; female and pet to approve\./);

    fireEvent.click(within(tiles[1]!).getByTestId("gag-approve-render"));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/approve"))).toBe(true));
    const call = calls.find((c) => c.url.endsWith("/approve"))!;
    expect(call.url).toBe("/api/admin/facts/5/gags/2/approve");
    expect(call.body).toEqual({ attemptId: 902, reviewId: 77 });
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
    stubFetch(view([gag({
      id: 1, slot: 1,
      approvedExamples: { male: ex(1), female: ex(2), pet: ex(3) },
      renders: { male: card("i2i_male_default"), female: card("i2i_female_default"), pet: card("i2i_nonhuman_animal") },
    })]));
    render(<GagsPanel factId={5} reviewId={null} rendersEnabled subjectNames={[]} />);
    expect((await screen.findByTestId("gag-example-words")).textContent).toBe("Male, female and pet approved.");
    expect(screen.getAllByTestId("gag-example")).toHaveLength(3);
    expect(screen.queryByTestId("gag-render-rest")).toBeNull();
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

  it("is read-only outside the review while a refresh is open, and says why", async () => {
    stubFetch(view([gag({ id: 1, slot: 1, isDefault: true })], { frozenOutsideReview: true }));
    render(<GagsPanel factId={5} reviewId={null} rendersEnabled subjectNames={[]} />);
    expect(await screen.findByTestId("gags-frozen-note")).toBeTruthy();
    expect(screen.queryByTestId("gag-save")).toBeNull();
    expect(screen.queryByTestId("gag-remove")).toBeNull();
    expect(screen.queryByTestId("gag-render-rest")).toBeNull();
    expect(screen.queryByTestId("gag-redraw-render")).toBeNull();
    expect(screen.queryByTestId("gag-add")).toBeNull();
  });

  it("reports unsaved gag work by gag, so an approval can wait for it and name it (Codex, PR #956 round 2)", async () => {
    stubFetch(view([gag({ id: 1, slot: 1, isDefault: true }), gag({ id: 2, slot: 2 })]));
    const onUnsaved = vi.fn();
    render(<GagsPanel factId={5} reviewId={77} rendersEnabled={false} subjectNames={[]} onUnsavedChange={onUnsaved} />);
    const second = (await screen.findAllByTestId("gag-card"))[1]!;
    fireEvent.change(within(second).getByTestId("visual-concept-textarea"), { target: { value: "{NAME} an unsaved edit." } });
    await waitFor(() => expect(onUnsaved).toHaveBeenLastCalledWith(["Gag 2"]));
    fireEvent.click(within(second).getByTestId("gag-undo"));
    await waitFor(() => expect(onUnsaved).toHaveBeenLastCalledWith([]));
    // A new gag with text typed in is unsaved work too.
    fireEvent.click(screen.getByTestId("gag-add"));
    fireEvent.change(within(screen.getByTestId("gag-new")).getByTestId("visual-concept-textarea"), { target: { value: "{NAME} typed, not saved." } });
    await waitFor(() => expect(onUnsaved).toHaveBeenLastCalledWith(["the new gag"]));
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

  it("offers Keep this gag on a gag the refresh marked for removal, and sends only that", async () => {
    const marked = gag({ id: 1, slot: 1, pendingRemove: true, pendingReviewId: 77 });
    const calls = stubFetch(view([marked, gag({ id: 2, slot: 2 })], { review: { id: 77, stage: "concept_review", refresh: true }, frozenOutsideReview: true }),
      { after: view([gag({ id: 1, slot: 1 }), gag({ id: 2, slot: 2 })], { review: { id: 77, stage: "concept_review", refresh: true }, frozenOutsideReview: true }) });
    render(<GagsPanel factId={5} reviewId={77} rendersEnabled subjectNames={[]} />);
    const cards = await screen.findAllByTestId("gag-card");
    expect(within(cards[0]!).queryByTestId("gag-remove")).toBeNull();
    fireEvent.click(within(cards[0]!).getByTestId("gag-keep"));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.url === "/api/admin/facts/5/gags/1/keep")).toBe(true));
    expect(calls.find((c) => c.url.endsWith("/keep"))!.body).toEqual({ reviewId: 77 });
    await waitFor(() => expect(screen.queryByTestId("gag-keep")).toBeNull());
  });

  describe("unsaved gag edits are kept in the browser (build report, PR #956)", () => {
    it("an edit survives closing and reopening the panel, until it is undone", async () => {
      const v = view([gag({ id: 1, slot: 1, isDefault: true })]);
      stubFetch(v);
      const first = render(<GagsPanel factId={5} reviewId={null} rendersEnabled subjectNames={[]} />);
      const card = await screen.findByTestId("gag-card");
      fireEvent.change(within(card).getByTestId("visual-concept-textarea"), { target: { value: "{NAME} an edit typed before closing." } });
      first.unmount();

      render(<GagsPanel factId={5} reviewId={null} rendersEnabled subjectNames={[]} />);
      const again = await screen.findByTestId("gag-card");
      expect((within(again).getByTestId("visual-concept-textarea") as HTMLTextAreaElement).value).toBe("{NAME} an edit typed before closing.");
      fireEvent.click(within(again).getByTestId("gag-undo"));
      expect(window.localStorage.length).toBe(0);
    });

    it("a kept edit is dropped once the gag changed on the server", async () => {
      stubFetch(view([gag({ id: 1, slot: 1, isDefault: true })]));
      const first = render(<GagsPanel factId={5} reviewId={null} rendersEnabled subjectNames={[]} />);
      fireEvent.change(within(await screen.findByTestId("gag-card")).getByTestId("visual-concept-textarea"), { target: { value: "{NAME} an old edit." } });
      first.unmount();
      vi.unstubAllGlobals();

      stubFetch(view([gag({ id: 1, slot: 1, isDefault: true, approvedContent: scene("{NAME} changed elsewhere.") })]));
      render(<GagsPanel factId={5} reviewId={null} rendersEnabled subjectNames={[]} />);
      const card = await screen.findByTestId("gag-card");
      expect((within(card).getByTestId("visual-concept-textarea") as HTMLTextAreaElement).value).toBe("{NAME} changed elsewhere.");
    });

    it("an edit survives the panel being locked, as Back to Gags does, then closed (Codex, PR #958 round 2)", async () => {
      stubFetch(view([gag({ id: 1, slot: 1, isDefault: true })]));
      const first = render(<GagsPanel factId={5} reviewId={null} rendersEnabled subjectNames={[]} />);
      fireEvent.change(within(await screen.findByTestId("gag-card")).getByTestId("visual-concept-textarea"), { target: { value: "{NAME} typed before Back." } });
      first.rerender(<GagsPanel factId={5} reviewId={null} rendersEnabled subjectNames={[]} disabled />);
      await act(async () => {});
      first.unmount();
      render(<GagsPanel factId={5} reviewId={null} rendersEnabled subjectNames={[]} />);
      const again = await screen.findByTestId("gag-card");
      expect((within(again).getByTestId("visual-concept-textarea") as HTMLTextAreaElement).value).toBe("{NAME} typed before Back.");
    });

    it("a kept edit survives opening the gag read-only, then comes back when editable", async () => {
      stubFetch(view([gag({ id: 1, slot: 1, isDefault: true })]));
      const first = render(<GagsPanel factId={5} reviewId={null} rendersEnabled subjectNames={[]} />);
      fireEvent.change(within(await screen.findByTestId("gag-card")).getByTestId("visual-concept-textarea"), { target: { value: "{NAME} kept while frozen." } });
      first.unmount();
      const locked = render(<GagsPanel factId={5} reviewId={null} rendersEnabled subjectNames={[]} disabled />);
      await screen.findByTestId("gag-card");
      await act(async () => {});
      locked.unmount();
      render(<GagsPanel factId={5} reviewId={null} rendersEnabled subjectNames={[]} />);
      const again = await screen.findByTestId("gag-card");
      expect((within(again).getByTestId("visual-concept-textarea") as HTMLTextAreaElement).value).toBe("{NAME} kept while frozen.");
    });

    it("a new gag, once saved, leaves no draft behind (Codex, PR #958 round 1)", async () => {
      const after = view([gag({ id: 1, slot: 1, isDefault: true }), gag({ id: 2, slot: 2, state: "new", availableToUsers: false, approvedContent: null, approvedAt: null, pendingContent: scene("{NAME} saved as a new gag.") })]);
      stubFetch(view([gag({ id: 1, slot: 1, isDefault: true })]), { after });
      const first = render(<GagsPanel factId={5} reviewId={null} rendersEnabled subjectNames={[]} />);
      fireEvent.click(await screen.findByTestId("gag-add"));
      fireEvent.change(within(screen.getByTestId("gag-new")).getByTestId("visual-concept-textarea"), { target: { value: "{NAME} saved as a new gag." } });
      fireEvent.click(screen.getByTestId("gag-new-save"));
      await waitFor(() => expect(screen.queryByTestId("gag-new")).toBeNull());
      expect(window.localStorage.getItem("gag-draft::5:new")).toBeNull();
      first.unmount();
      render(<GagsPanel factId={5} reviewId={null} rendersEnabled subjectNames={[]} />);
      await screen.findAllByTestId("gag-card");
      expect(screen.queryByTestId("gag-new")).toBeNull();
    });

    it("a new gag's draft reopens its card", async () => {
      stubFetch(view([gag({ id: 1, slot: 1, isDefault: true })]));
      const first = render(<GagsPanel factId={5} reviewId={null} rendersEnabled subjectNames={[]} />);
      fireEvent.click(await screen.findByTestId("gag-add"));
      fireEvent.change(within(screen.getByTestId("gag-new")).getByTestId("visual-concept-textarea"), { target: { value: "{NAME} a new gag half-written." } });
      first.unmount();

      render(<GagsPanel factId={5} reviewId={null} rendersEnabled subjectNames={[]} />);
      const reopened = await screen.findByTestId("gag-new");
      expect((within(reopened).getByTestId("visual-concept-textarea") as HTMLTextAreaElement).value).toBe("{NAME} a new gag half-written.");
    });
  });
});

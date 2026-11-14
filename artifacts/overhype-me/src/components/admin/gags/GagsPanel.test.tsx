/**
 * The admin Gags panel (plan docs/plans/PLAN_THREE_GAGS.md): each gag's state
 * in words, saving a change through the tokenizer, approving a render as the
 * example, adding a gag, the read-only state during a refresh, and the
 * prompt-budget refusal shown as the server's sentences (#685).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import {
  EMPTY_VISUAL_STRATEGY_OVERRIDE,
  type FactGagsView,
  type GagView,
  type RenderScenarioCard,
  type VisualPromptStrategyOverride,
} from "@workspace/api-zod";
import { GagsPanel } from "./GagsPanel";

const scene = (text: string): VisualPromptStrategyOverride => ({ ...EMPTY_VISUAL_STRATEGY_OVERRIDE, coreSceneOverride: text });
const NO_TALLY = { requested: 0, done: 0, rendering: 0, queued: 0, failed: 0, blocked: 0, skipped: 0, stale: 0 };

function gag(over: Partial<GagView> & Pick<GagView, "id" | "slot">): GagView {
  return {
    state: "approved",
    availableToUsers: true,
    isDefault: false,
    approvedContent: scene("{NAME} lifts the moon."),
    approvedExample: null,
    carriedOver: false,
    approvedAt: "2026-11-01T00:00:00.000Z",
    pendingContent: null,
    pendingReviewId: null,
    pendingExample: null,
    pendingRemove: false,
    refreshedSinceApproval: false,
    renders: { reviewId: 0, gagId: over.id, cards: [], tally: NO_TALLY },
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

afterEach(() => vi.unstubAllGlobals());

describe("GagsPanel", () => {
  it("says each gag's state in words, which is the default, and whether users are offered it", async () => {
    stubFetch(view([
      gag({ id: 1, slot: 1, isDefault: true, carriedOver: true }),
      gag({ id: 2, slot: 2, state: "new", availableToUsers: false, approvedContent: null, approvedAt: null, pendingContent: scene("{NAME} juggles planets.") }),
    ]));
    render(<GagsPanel factId={5} reviewId={null} rendersEnabled subjectNames={["Alex"]} />);
    const cards = await screen.findAllByTestId("gag-card");
    expect(cards).toHaveLength(2);
    expect(within(cards[0]!).getByTestId("gag-default")).toBeTruthy();
    expect(within(cards[0]!).getByTestId("gag-availability").textContent).toBe("Offered to users");
    expect(within(cards[0]!).getByTestId("gag-no-example")).toBeTruthy();
    expect(within(cards[1]!).getByTestId("gag-availability").textContent).toBe("Hidden from users");
    expect(within(cards[1]!).getByTestId("gag-state").textContent).toMatch(/^New: hidden from users until a test render is approved/);
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
    await waitFor(() => expect(screen.getByTestId("gag-state").textContent).toBe("Approved, with a change waiting for its example"));
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

  it("approving a finished render sends its attempt as the gag's example", async () => {
    const done: RenderScenarioCard = {
      key: "generic_t2i", label: "Generic", purpose: "", referenceIdentityType: null, required: true,
      status: "done", stale: false, latestAttemptId: 901, imageUrl: "/api/admin/gags/2/renders/j/image", message: null, applicability: null,
    };
    const stale: RenderScenarioCard = { ...done, key: "i2i_male_default", label: "Male", stale: true, latestAttemptId: 902 };
    const calls = stubFetch(view([
      gag({ id: 2, slot: 1, state: "new", availableToUsers: false, approvedContent: null, approvedAt: null, pendingContent: scene("{NAME} juggles planets."),
        renders: { reviewId: 77, gagId: 2, cards: [done, stale], tally: NO_TALLY } }),
    ], { isActive: false }));
    render(<GagsPanel factId={5} reviewId={77} rendersEnabled subjectNames={[]} />);
    const approve = await screen.findAllByTestId("gag-approve-render");
    expect(approve).toHaveLength(1); // the stale render cannot be approved
    fireEvent.click(approve[0]!);
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/approve"))).toBe(true));
    const call = calls.find((c) => c.url.endsWith("/approve"))!;
    expect(call.url).toBe("/api/admin/facts/5/gags/2/approve");
    expect(call.body).toEqual({ attemptId: 901, reviewId: 77 });
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
    expect(screen.queryByTestId("gag-run-renders")).toBeNull();
    expect(screen.queryByTestId("gag-add")).toBeNull();
  });
});

/**
 * The Eval page (plan docs/plans/PLAN_EVAL_PAGE.md): two tabs kept in the URL;
 * the models wizard from fact search to Generate Images, with step gating,
 * the image count and cost and the over-50 warning; one Generate request with
 * a token, safely repeatable; the evaluations list's statuses, retries, Judge
 * results and Results, and its connection-lost state.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";

vi.mock("@/components/admin/PromptRecipes", () => ({ PromptRecipes: () => <div data-testid="recipes-stub" /> }));
vi.mock("@/components/admin/AdminLayout", () => ({
  AdminLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import EvalDashboard from "./evalDashboard";

type Json = Record<string, unknown>;
let posts: Array<{ url: string; body: Json }> = [];
let evaluations: Json[] = [];
let promptEvaluations: Json[] = [];
let listCalls: string[] = [];
let estimate: Json = { panels: 2, images: 4, totalBoundUsd: 1.23, preparationBoundUsd: 0.5, renderBoundUsd: 0.73, warning: false, refusal: null };
let listFails = false;

const EVAL = (over: Json = {}): Json => ({
  id: 7, description: "GPT vs Nano", createdAt: new Date().toISOString(), finishedAt: null, status: "ready",
  images: 4, drawn: 4, inFlight: 0, failed: 0, lost: 0, skippedPanels: 0, judgeablePanels: 2, judgedPanels: 0, needsAction: [],
  engineFamilies: ["gpt-image-2-6", "nano-banana-2-1"], scenarioKeys: ["i2i_male_default"], lookStyleIds: ["none"], factCount: 2, round: 1, imageSize: "comparison",
  ...over,
});

function respond(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body } as unknown as Response;
}

beforeEach(() => {
  posts = [];
  evaluations = [];
  promptEvaluations = [];
  listCalls = [];
  listFails = false;
  estimate = { panels: 2, images: 4, totalBoundUsd: 1.23, preparationBoundUsd: 0.5, renderBoundUsd: 0.73, warning: false, refusal: null };
  window.history.replaceState(null, "", "/admin/eval");
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body ?? "{}")) as Json;
      posts.push({ url, body });
      if (url.endsWith("/evaluations/estimate")) return respond(estimate);
      if (url.endsWith("/evaluations")) return respond({ setId: 9, created: true }, 201);
      return respond({});
    }
    if (url.includes("/eligible-facts")) {
      const q = decodeURIComponent(url.split("q=")[1] ?? "");
      const facts = [{ id: 11, text: "{NAME} lifts a mountain" }, { id: 12, text: "{NAME} outruns light" }].filter((f) => f.text.includes(q));
      return respond({ facts, eligibleTotal: 2 });
    }
    if (url.includes("/comparison/evaluations")) {
      listCalls.push(url);
      if (listFails) return respond({}, 503);
      return respond({ evaluations: url.includes("kind=prompt") ? promptEvaluations : evaluations });
    }
    if (url.endsWith("/look-styles")) return respond([{ id: "anime", label: "Anime" }]);
    if (url.endsWith("/prompt-recipes")) return respond({ families: [] });
    return respond({}, 404);
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

const next = () => fireEvent.click(screen.getByTestId("wizard-next"));

describe("the Eval page", () => {
  it("shows two tabs, kept in the URL, with the wording editor only under Evaluate Prompts", async () => {
    render(<EvalDashboard />);
    expect(screen.getByTestId("eval-tab-models").getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByTestId("eval-wording-editor")).toBeNull();
    fireEvent.click(screen.getByTestId("eval-tab-prompts"));
    expect(window.location.search).toBe("?tab=prompts");
    expect(screen.getByTestId("eval-wording-editor")).toBeTruthy();
    expect(screen.getByTestId("wizard-prompt")).toBeTruthy();
  });

  it("walks the models wizard: search and add facts, tick engines, photo types and looks, see the count and cost, generate once", async () => {
    render(<EvalDashboard />);
    expect((screen.getByTestId("wizard-next") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId("wizard-fact-search"), { target: { value: "mountain" } });
    fireEvent.click(await screen.findByTestId("wizard-fact-11"));
    expect(screen.getByTestId("wizard-chosen-facts").textContent).toMatch(/#11/);
    expect(screen.getByTestId("wizard-fact-total").textContent).toMatch(/2 facts are ready/);
    next();
    expect((screen.getByTestId("wizard-next") as HTMLButtonElement).disabled).toBe(true); // no engine yet
    fireEvent.click(screen.getByTestId("wizard-engine-gpt-image-2-6"));
    fireEvent.click(screen.getByTestId("wizard-engine-nano-banana-2-1"));
    next();
    expect((screen.getByTestId("wizard-photo-i2i_male_default") as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByText(/Female|Non-binary/)).toBeNull();
    next();
    fireEvent.click(await screen.findByTestId("wizard-look-anime"));
    next();
    fireEvent.change(screen.getByTestId("wizard-description"), { target: { value: "GPT vs Nano" } });
    expect((await screen.findByTestId("wizard-count")).textContent).toMatch(/1 fact × 2 engines × 1 photo type × 2 looks = 4 images, at most \$1\.23/);
    const est = posts.find((p) => p.url.endsWith("/estimate"))!;
    expect(est.body).toEqual({ kind: "engine", factIds: [11], engineFamilies: ["gpt-image-2-6", "nano-banana-2-1"], scenarioKeys: ["i2i_male_default"], lookStyleIds: ["none", "anime"] });
    fireEvent.click(screen.getByTestId("wizard-generate"));
    await waitFor(() => expect(posts.some((p) => p.url.endsWith("/comparison/evaluations"))).toBe(true));
    const gen = posts.find((p) => p.url.endsWith("/comparison/evaluations"))!;
    expect(gen.body.description).toBe("GPT vs Nano");
    expect(typeof gen.body.requestToken).toBe("string");
    expect(gen.body.selection).toEqual(est.body);
  });

  it("warns above fifty images", async () => {
    estimate = { ...estimate, images: 120, warning: true };
    render(<EvalDashboard />);
    fireEvent.click(await screen.findByTestId("wizard-fact-11"));
    next();
    fireEvent.click(screen.getByTestId("wizard-engine-muse-image"));
    next(); next(); next();
    expect((await screen.findByTestId("wizard-warning")).textContent).toMatch(/120 images/);
  });

  it("lists evaluations with Judge results, Results, and each failure's retry", async () => {
    evaluations = [
      EVAL({ id: 7, status: "ready" }),
      EVAL({ id: 8, description: "With a failure", status: "needs_action", needsAction: [
        { panelId: 3, cellId: null, action: "retry_scene", costs: true, reason: "planner failed: down" },
        { panelId: 4, cellId: 40, action: "retry_storage", costs: false, reason: "storage failed" },
      ] }),
      EVAL({ id: 9, status: "finished", finishedAt: new Date().toISOString(), judgedPanels: 2 }),
    ];
    render(<EvalDashboard />);
    expect((await screen.findByTestId("evaluation-judge-7")).getAttribute("href")).toBe("/admin/eval/judge/7");
    expect(screen.getByTestId("evaluation-status-8").textContent).toMatch(/Needs action: 2 to retry/);
    expect(screen.getByTestId("evaluation-retry-retry_storage:40").textContent).toMatch(/Retry storage \(free\)/);
    expect(screen.queryByTestId("evaluation-results-8")).toBeNull(); // nothing judged yet
    fireEvent.click(screen.getByTestId("evaluation-retry-retry_scene:3"));
    await waitFor(() => expect(posts.some((p) => p.url.endsWith("/panels/3/reprepare"))).toBe(true));
    expect(screen.getByTestId("evaluation-results-9").getAttribute("href")).toBe("/admin/eval/results?sets=9");
    expect(screen.queryByTestId("evaluation-judge-9")).toBeNull();
  });

  it("keeps each tab's draft across a tab switch and the browser's back button, and shows each tab only its own evaluations", async () => {
    evaluations = [EVAL({ id: 7, description: "A models evaluation" })];
    promptEvaluations = [EVAL({ id: 20, description: "A wording evaluation", engineFamilies: ["gpt-image-2-6"] })];
    render(<EvalDashboard />);
    fireEvent.click(await screen.findByTestId("wizard-fact-11"));
    next();
    expect(screen.getByTestId("wizard-engines")).toBeTruthy();
    expect(await screen.findByTestId("evaluation-7")).toBeTruthy();
    fireEvent.click(screen.getByTestId("eval-tab-prompts"));
    expect(screen.getByTestId("wizard-facts")).toBeTruthy(); // the prompts wizard starts at its own first step
    expect(await screen.findByTestId("evaluation-20")).toBeTruthy();
    expect(screen.queryByTestId("evaluation-7")).toBeNull();
    act(() => { window.history.back(); });
    await waitFor(() => expect(screen.getByTestId("eval-tab-models").getAttribute("aria-selected")).toBe("true"));
    expect(screen.getByTestId("wizard-engines")).toBeTruthy(); // the models draft is where it was left
    fireEvent.click(screen.getByTestId("wizard-back"));
    expect(screen.getByTestId("wizard-chosen-facts").textContent).toMatch(/#11/);
    expect(screen.queryByTestId("evaluation-20")).toBeNull();
  });

  it("offers Resume generation for work never started, and a generating evaluation on the hidden tab keeps being polled", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    evaluations = [EVAL({ id: 7, status: "generating", drawn: 0, needsAction: [{ panelId: 0, cellId: null, action: "resume", costs: true, reason: "2 scenes or pictures not started" }] })];
    render(<EvalDashboard />);
    const resume = await screen.findByTestId("evaluation-retry-resume:7");
    expect(resume.textContent).toMatch(/Resume generation/);
    fireEvent.click(resume);
    await waitFor(() => expect(posts.some((p) => p.url.endsWith("/evaluations/7/resume"))).toBe(true));
    fireEvent.click(screen.getByTestId("eval-tab-prompts"));
    const before = listCalls.filter((u) => u.includes("kind=engine")).length;
    await act(async () => { await vi.advanceTimersByTimeAsync(5_100); });
    expect(listCalls.filter((u) => u.includes("kind=engine")).length).toBeGreaterThan(before);
  });

  it("polls while generating and says the connection is lost rather than that the server stopped", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    evaluations = [EVAL({ status: "generating", drawn: 1 })];
    render(<EvalDashboard />);
    expect((await screen.findByTestId("evaluation-status-7")).textContent).toMatch(/Generating: 1 of 4/);
    listFails = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(5_100); });
    expect((await screen.findByTestId("evaluations-connection-lost")).textContent).toMatch(/Connection lost/);
    expect(screen.getByTestId("evaluation-status-7").textContent).toMatch(/Generating/); // last known status kept
    listFails = false;
    evaluations = [EVAL({ status: "ready" })];
    await act(async () => { await vi.advanceTimersByTimeAsync(5_100); });
    await waitFor(() => expect(screen.queryByTestId("evaluations-connection-lost")).toBeNull());
    expect(screen.getByTestId("evaluation-status-7").textContent).toMatch(/Ready to judge/);
  });
});

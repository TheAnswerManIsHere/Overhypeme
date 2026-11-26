/**
 * The admin gag routes (plan docs/plans/PLAN_THREE_GAGS.md; routes/gags.ts),
 * and the one tokenize step every gag save takes. Every write answers with the
 * fact's whole gags view, so a caller renders what the server now holds.
 */
import {
  castIsCurrent,
  collectRenderedTextEntries,
  hasPlainSubjectReference,
  unboundSpeakers,
  setRenderedTextAtPath,
  type FactGagsView,
  type GagCastView,
  type GagDescriptionView,
  type GagExampleKind,
  type GagRenderDeleteResult,
  type RemovedGagHistory,
  type RenderHistoryPage,
  type VisualPromptStrategyOverride,
} from "@workspace/api-zod";

/**
 * The text a moderator sees when a gag save is refused. The over-budget refusal
 * carries a machine code in `error` and the human sentence for each violated
 * cap in `details[].message`, so the sentences win; any other refusal falls
 * back to `error` (#685). It lived beside the old taxonomy editor until that
 * went (plan PLAN_FACT_LIFECYCLE_REBUILD.md, 2A).
 */
function saveRefusalMessage(body: unknown): string | undefined {
  const b = body as { error?: unknown; details?: unknown } | null;
  if (!b || typeof b !== "object") return undefined;
  const details = Array.isArray(b.details) ? b.details : [];
  const sentences = details
    .map((d) => (d && typeof d === "object" ? (d as { message?: unknown }).message : undefined))
    .filter((m): m is string => typeof m === "string" && m.trim() !== "");
  if (sentences.length > 0) return sentences.join(" ");
  return typeof b.error === "string" && b.error ? b.error : undefined;
}

export type GagResult = { ok: true; view: FactGagsView } | { ok: false; error: string };

export type Answer<T> = { ok: true; data: T } | { ok: false; error: string };

async function request<T = unknown>(method: "GET" | "POST" | "PUT", url: string, body?: unknown): Promise<Answer<T>> {
  let r: Response;
  try {
    r = await fetch(url, {
      method,
      credentials: "include",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    return { ok: false, error: "Network error: could not reach the server." };
  }
  const data = (await r.json().catch(() => null)) as unknown;
  // A refused save says why in words: the prompt-budget refusal carries one
  // sentence per broken cap in `details` (#685), which wins over its code.
  if (!r.ok || !data) return { ok: false, error: saveRefusalMessage(data) ?? `Request failed (${r.status}).` };
  return { ok: true, data: data as T };
}

async function call(method: "GET" | "POST" | "PUT", url: string, body?: unknown): Promise<GagResult> {
  const r = await request<FactGagsView>(method, url, body);
  return r.ok ? { ok: true, view: r.data } : r;
}

const base = (factId: number) => `/api/admin/facts/${factId}/gags`;
/** The review an action comes from; omitted from the body outside one. */
const scope = (reviewId: number | null) => (reviewId != null ? { reviewId } : {});

export const gagApi = {
  load: (factId: number) => call("GET", base(factId)),
  create: (factId: number, content: VisualPromptStrategyOverride, reviewId: number | null, slot?: number) =>
    call("POST", base(factId), { content, ...(slot != null ? { slot } : {}), ...scope(reviewId) }),
  save: (factId: number, gagId: number, content: VisualPromptStrategyOverride, reviewId: number | null) =>
    call("PUT", `${base(factId)}/${gagId}`, { content, ...scope(reviewId) }),
  remove: (factId: number, gagId: number, reviewId: number | null) =>
    call("POST", `${base(factId)}/${gagId}/remove`, scope(reviewId)),
  approve: (factId: number, gagId: number, attemptId: number, reviewId: number | null) =>
    call("POST", `${base(factId)}/${gagId}/approve`, { attemptId, ...scope(reviewId) }),
  /**
   * Draw a new render of the gag's current content for each of these kinds.
   * Every draw an admin asks for makes a new one, and the previous render
   * stays in the gag's history (plan PLAN_RENDER_HISTORY.md D1), so `redraw`
   * is always sent: the route's reuse of a render of this content is for
   * callers that ask without it.
   */
  runRenders: (factId: number, gagId: number, reviewId: number | null, kinds: GagExampleKind[]) =>
    call("POST", `${base(factId)}/${gagId}/renders`, { kinds, redraw: true, ...scope(reviewId) }),
  /**
   * Save and approve the one-line description of one version of a gag (plan
   * PLAN_PHASE7_AI_PICTURE_FLOW.md). `contentFingerprint` names the version the
   * moderator was looking at; a gag changed since is refused.
   */
  saveDescription: (factId: number, gagId: number, contentFingerprint: string, text: string, reviewId: number | null) =>
    call("PUT", `${base(factId)}/${gagId}/description`, { contentFingerprint, text, ...scope(reviewId) }),
};

/** One gag whose published content still needs a reviewed description. */
export interface DescriptionToReview {
  factId: number;
  factText: string;
  gagId: number;
  slot: number;
  description: GagDescriptionView;
}

export const descriptionReviewApi = {
  list: () => request<{ count: number; items: DescriptionToReview[] }>("GET", "/api/admin/gag-descriptions"),
};

// ─── A gag's render history (plan PLAN_RENDER_HISTORY.md D3, D4 and D6) ─────

export const renderHistoryApi = {
  /** One page of a gag's history, newest first; `before` is the previous page's `nextBefore`. */
  page: (factId: number, gagId: number, before?: string | null) =>
    request<RenderHistoryPage>("GET", `${base(factId)}/${gagId}/render-history${before ? `?before=${encodeURIComponent(before)}` : ""}`),
  /** The fact's removed gags that still have renders, grouped by the gag's own id. */
  removedGags: async (factId: number): Promise<Answer<RemovedGagHistory[]>> => {
    const r = await request<{ gags: RemovedGagHistory[] }>("GET", `/api/admin/facts/${factId}/render-history/removed-gags`);
    return r.ok ? { ok: true, data: r.data.gags } : r;
  },
  /** Delete a render for good, its picture file with it; the server refuses an official, running or in-use render, saying why. */
  remove: (factId: number, gagId: number, attemptId: number, reviewId: number | null) =>
    request<GagRenderDeleteResult>("POST", `${base(factId)}/${gagId}/renders/${attemptId}/delete`, scope(reviewId)),
};

/** The scene: the one field re-sent while it holds a plain subject reference (a bubble line may be a speaker's own words). */
const SCENE_PATH = "coreSceneOverride";

export type TokenizeResult =
  | { ok: true; content: VisualPromptStrategyOverride }
  | { ok: false; content: VisualPromptStrategyOverride; fieldErrors: Record<string, string>; error: string | null };

/**
 * Tokenize the text a moderator changed against `baseline` (the version the
 * edit started from), so a typed name becomes `{NAME}` before the save. The
 * changed, non-empty fields are sent, and so is the scene when it still holds
 * a plain subject name or pronoun ("his", "he's"), changed or not: a scene
 * stored that way is otherwise never tokenized again, and every render of it
 * keeps the stored words whoever the subject is. A field error blocks the
 * save and is shown on that field.
 */
export async function tokenizeGag(
  content: VisualPromptStrategyOverride,
  baseline: VisualPromptStrategyOverride | null,
  subjectNames: string[],
): Promise<TokenizeResult> {
  const before = new Map(baseline ? collectRenderedTextEntries(baseline).map((e) => [e.path, e.value]) : []);
  const changed = collectRenderedTextEntries(content).filter((e) => e.value.trim() !== "" && (
    e.value !== before.get(e.path) || (e.path === SCENE_PATH && hasPlainSubjectReference(e.value, subjectNames))
  ));
  if (changed.length === 0) return { ok: true, content };
  let r: Response;
  try {
    r = await fetch("/api/ai/tokenize-enrichment", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        entries: changed.map(({ path, value, kind }) => ({ path, value, kind })),
        subjectContext: { names: subjectNames },
      }),
    });
  } catch {
    return { ok: false, content, fieldErrors: {}, error: "Network error: could not tokenize." };
  }
  if (!r.ok) {
    const b = (await r.json().catch(() => null)) as { error?: string } | null;
    return { ok: false, content, fieldErrors: {}, error: b?.error ?? `Tokenize failed (${r.status}).` };
  }
  const body = (await r.json()) as { results: Array<{ path: string; value: string; error?: string | null }> };
  let next = content;
  const fieldErrors: Record<string, string> = {};
  for (const res of body.results) {
    next = setRenderedTextAtPath(next, res.path, res.value);
    if (res.error) fieldErrors[res.path] = res.error;
  }
  return Object.keys(fieldErrors).length > 0
    ? { ok: false, content: next, fieldErrors, error: null }
    : { ok: true, content: next };
}

// ─── The cast (plan PLAN_GAG_DIRECT_RENDER.md, F) ───────────────────────────

export type CastResult = { ok: true; view: GagCastView } | { ok: false; error: string };

/** Read who is in a (tokenized) scene. Stores nothing. */
export async function readCast(factId: number, scene: string, bubbles: VisualPromptStrategyOverride["bubbles"]): Promise<CastResult> {
  const r = await request<GagCastView>("POST", `${base(factId)}/cast`, { scene, bubbles: bubbles.map(({ type, entity, text }) => ({ type, entity, text })) });
  return r.ok ? { ok: true, view: r.data } : r;
}

export { castIsCurrent };

/** The bubbles (1-based) whose speaker the cast does not hold, with the speaker. */
export function unboundBubbles(c: VisualPromptStrategyOverride): Array<{ bubble: number; speaker: string }> {
  const unbound = new Set(unboundSpeakers(c.bubbles, c.cast));
  const out: Array<{ bubble: number; speaker: string }> = [];
  c.bubbles.forEach((b, i) => {
    const speaker = b.entity.trim();
    if (unbound.has(speaker) && b.text.trim()) out.push({ bubble: i + 1, speaker });
  });
  return out;
}

export function unboundMessage(list: Array<{ bubble: number; speaker: string }>): string {
  const named = list.map((u) => `"${u.speaker}" (bubble ${u.bubble})`).join(", ");
  return `The scene does not show ${named}. Pick another speaker, or say in the scene that they are there, then save again.`;
}

/**
 * Give content the cast read from its scene, unless its cast is already
 * current, and check every bubble speaker is in it. Stores nothing. The one
 * cast step of every save path: an edited gag (after tokenizing) and a used
 * idea (plan PLAN_GAG_DIRECT_RENDER.md, C and F).
 */
export async function ensureCast(
  factId: number,
  content: VisualPromptStrategyOverride,
): Promise<{ ok: true; content: VisualPromptStrategyOverride } | { ok: false; content: VisualPromptStrategyOverride; error: string }> {
  let c = content;
  if (!castIsCurrent(c)) {
    const r = await readCast(factId, c.coreSceneOverride ?? "", c.bubbles);
    if (!r.ok) return { ok: false, content: c, error: `${r.error} Your edits are kept; try again.` };
    c = { ...c, cast: r.view.cast, castExtraction: r.view.castExtraction };
  }
  const unbound = unboundBubbles(c);
  if (unbound.length) return { ok: false, content: c, error: unboundMessage(unbound) };
  return { ok: true, content: c };
}

/**
 * Prepare a draft for saving: the tokenize step, then `ensureCast`. A failed
 * reading, or a speaker the scene does not show, stops the save with the draft
 * kept.
 */
export async function prepareGag(
  factId: number,
  content: VisualPromptStrategyOverride,
  baseline: VisualPromptStrategyOverride | null,
  subjectNames: string[],
): Promise<TokenizeResult> {
  const t = await tokenizeGag(content, baseline, subjectNames);
  if (!t.ok) return t;
  const c = await ensureCast(factId, t.content);
  return c.ok ? c : { ok: false, content: c.content, fieldErrors: {}, error: c.error };
}

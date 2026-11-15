/**
 * The admin gag routes (plan docs/plans/PLAN_THREE_GAGS.md; routes/gags.ts),
 * and the one tokenize step every gag save takes. Every write answers with the
 * fact's whole gags view, so a caller renders what the server now holds.
 */
import {
  collectRenderedTextEntries,
  setRenderedTextAtPath,
  type FactGagsView,
  type GagExampleKind,
  type VisualConceptsResponse,
  type VisualPromptStrategyOverride,
} from "@workspace/api-zod";
import { saveRefusalMessage } from "../useFactEnrichmentEditing";

export type GagResult = { ok: true; view: FactGagsView } | { ok: false; error: string };
export type IdeasResult = { ok: true; ideas: VisualConceptsResponse } | { ok: false; error: string };

async function request(method: "GET" | "POST" | "PUT", url: string, body?: unknown): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
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
  return { ok: true, data };
}

async function call(method: "GET" | "POST" | "PUT", url: string, body?: unknown): Promise<GagResult> {
  const r = await request(method, url, body);
  return r.ok ? { ok: true, view: r.data as FactGagsView } : r;
}

async function ideas(method: "GET" | "POST", factId: number): Promise<IdeasResult> {
  const r = await request(method, `${base(factId)}/ideas`);
  return r.ok ? { ok: true, ideas: r.data as VisualConceptsResponse } : r;
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
  discard: (factId: number, gagId: number, reviewId: number | null) =>
    call("POST", `${base(factId)}/${gagId}/discard`, scope(reviewId)),
  remove: (factId: number, gagId: number, reviewId: number | null) =>
    call("POST", `${base(factId)}/${gagId}/remove`, scope(reviewId)),
  keep: (factId: number, gagId: number, reviewId: number | null) =>
    call("POST", `${base(factId)}/${gagId}/keep`, scope(reviewId)),
  /** A live fact's drafted ideas (Draft more gags). */
  ideas: (factId: number) => ideas("GET", factId),
  /** Draft more gags on a live fact: starts the gag writer, answers with the ideas (working). */
  draftIdeas: (factId: number) => ideas("POST", factId),
  approve: (factId: number, gagId: number, attemptId: number, reviewId: number | null) =>
    call("POST", `${base(factId)}/${gagId}/approve`, { attemptId, ...scope(reviewId) }),
  /**
   * Draw renders of the gag's current content for these kinds (plan
   * PLAN_GAG_EXAMPLES.md): a kind with a render of this content already is
   * reused unless `redraw` asks for a new one.
   */
  runRenders: (factId: number, gagId: number, reviewId: number | null, kinds: GagExampleKind[], redraw = false) =>
    call("POST", `${base(factId)}/${gagId}/renders`, { kinds, ...(redraw ? { redraw: true } : {}), ...scope(reviewId) }),
};

export type TokenizeResult =
  | { ok: true; content: VisualPromptStrategyOverride }
  | { ok: false; content: VisualPromptStrategyOverride; fieldErrors: Record<string, string>; error: string | null };

/**
 * Tokenize the text a moderator changed against `baseline` (the version the
 * edit started from), so a typed name becomes `{NAME}` before the save. Only
 * the changed, non-empty fields are sent; a field error blocks the save and is
 * shown on that field.
 */
export async function tokenizeGag(
  content: VisualPromptStrategyOverride,
  baseline: VisualPromptStrategyOverride | null,
  subjectNames: string[],
): Promise<TokenizeResult> {
  const before = new Map(baseline ? collectRenderedTextEntries(baseline).map((e) => [e.path, e.value]) : []);
  const changed = collectRenderedTextEntries(content).filter((e) => e.value.trim() !== "" && e.value !== before.get(e.path));
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

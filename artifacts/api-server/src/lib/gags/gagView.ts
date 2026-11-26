/**
 * @purpose What the admin Gags panel reads for one fact: each gag's published and draft versions and examples, whether users could be offered it, its test renders, and whether the draft meets the go-live rule.
 * @subsystem visual-pipeline
 *
 * Plans docs/plans/PLAN_THREE_GAGS.md (section E) and
 * docs/plans/PLAN_GAG_EXAMPLES.md (section E): each gag's examples per subject
 * kind and its render of the current content per kind. Read-only; every
 * write is in gagStore.ts.
 */
import { eq, inArray } from "drizzle-orm";
import {
  db,
  factsTable,
  imagePromptAttemptsTable,
  type FactGag,
} from "@workspace/db";
import { GAG_EXAMPLE_KINDS, MAX_GAGS_PER_FACT, mapKinds, type FactGagsView, type GagExample, type GagPictureRoles, type GagView, type PerKind } from "@workspace/api-zod";
import { buildGagWorkingCards, gagRenderImageUrl } from "../reviewRenderScenarios";
import { loadGags, normaliseGagContent, openReviewForFact } from "./resolver";
import { fillState, isUntouchedPrefill } from "./prefill";
import { examplesFor, isGrandfathered, loadExamples, type GagExamples } from "./examples";
import { checkGoLive, describeGoLive } from "./goLive";
import { descriptionsForEditor } from "./descriptions";

async function examples(ids: number[], gagIdOf: Map<number, number>): Promise<Map<number, GagExample>> {
  const out = new Map<number, GagExample>();
  if (ids.length === 0) return out;
  const rows = await db
    .select({ id: imagePromptAttemptsTable.id, renderJobId: imagePromptAttemptsTable.renderJobId, path: imagePromptAttemptsTable.generatedImageObjectPath })
    .from(imagePromptAttemptsTable)
    .where(inArray(imagePromptAttemptsTable.id, ids));
  for (const r of rows) {
    const gagId = gagIdOf.get(r.id);
    out.set(r.id, {
      attemptId: r.id,
      imageUrl: r.renderJobId && r.path && gagId != null ? gagRenderImageUrl(gagId, r.renderJobId) : null,
    });
  }
  return out;
}

let fillStateReader: typeof fillState = fillState;
/** Test seam: wrap the fill-status read (to land a fill while it runs). Returns the restore function. */
export function __setFillStateReaderForTest(fn: typeof fillState): () => void {
  const prev = fillStateReader;
  fillStateReader = fn;
  return () => { fillStateReader = prev; };
}

export async function buildFactGagsView(factId: number): Promise<FactGagsView | null> {
  const [fact] = await db.select({ id: factsTable.id, isActive: factsTable.isActive }).from(factsTable).where(eq(factsTable.id, factId)).limit(1);
  if (!fact) return null;
  const review = await openReviewForFact(factId);
  // The fill status is worked out first, from its own read of the gags, and
  // the gags this answer carries are read after it. Run together, or in the
  // other order, a fill whose write and "done" land between the two reads
  // would answer "finished" beside the gags from before it, and the screen
  // would stop watching with the old gag on it (Codex 4650051101, PR #1136
  // round 2). Not in parallel, deliberately.
  const filling = review?.workflowStage === "gags" ? await fillStateReader(factId, review, await loadGags(factId)) : "none";
  const gags = await loadGags(factId);

  const byGag = await loadExamples(gags.map((g) => g.id));
  const exampleIds: number[] = [];
  const gagIdOf = new Map<number, number>();
  for (const [gagId, set] of byGag) {
    for (const stage of ["approved", "pending"] as const) {
      for (const kind of GAG_EXAMPLE_KINDS) {
        const row = set[stage][kind];
        if (row) { exampleIds.push(row.attemptId); gagIdOf.set(row.attemptId, gagId); }
      }
    }
  }
  const ex = await examples(exampleIds, gagIdOf);
  const defaultId = fact.isActive ? gags.find((g) => g.approvedContent != null)?.id ?? null : null;

  // Each gag's render tiles are independent reads: the view is polled while
  // renders draw, so they run together.
  const descriptions = await descriptionsForEditor(gags);
  const [views, ready] = await Promise.all([
    Promise.all(gags.map((g) => viewOf(g, fact.isActive, defaultId, examplesFor(byGag, g.id), ex, descriptions.get(g.id)!))) as Promise<GagView[]>,
    checkGoLive(factId, "draft", db, gags),
  ]);
  return {
    factId,
    isActive: fact.isActive,
    review: review ? { id: review.id, stage: review.workflowStage } : null,
    gags: views,
    maxGags: MAX_GAGS_PER_FACT,
    draftReady: { ok: ready.ok, reason: ready.ok ? null : describeGoLive(ready) },
    filling: filling === "filling",
    fillFailed: filling === "failed",
  };
}

function perKind(set: GagExamples["approved"], ex: Map<number, GagExample>): PerKind<GagExample | null> {
  return mapKinds((k) => (set[k] ? ex.get(set[k]!.attemptId) ?? null : null));
}

async function viewOf(
  g: FactGag,
  factActive: boolean,
  defaultId: number | null,
  set: GagExamples,
  ex: Map<number, GagExample>,
  descriptions: GagView["descriptions"],
): Promise<GagView> {
  const approved = g.approvedContent != null;
  const state = !approved ? "new" : g.pendingContent != null || g.draftRemoved ? "approved_with_change" : "approved";
  const roles = await rolesView(g.id, set, ex);
  return {
    id: g.id,
    slot: g.slot,
    state,
    availableToUsers: factActive && approved,
    isDefault: g.id === defaultId,
    approvedContent: normaliseGagContent(g.approvedContent),
    approvedExamples: perKind(set.approved, ex),
    grandfathered: approved && isGrandfathered(g),
    approvedAt: g.approvedAt?.toISOString() ?? null,
    pendingContent: normaliseGagContent(g.pendingContent),
    pendingExamples: perKind(set.pending, ex),
    draftRemoved: g.draftRemoved,
    prefilledUntouched: isUntouchedPrefill(g),
    roles,
    descriptions,
  };
}

/**
 * Each picture's roles (plan PLAN_RENDER_HISTORY.md D1): the published pick
 * (live), the draft pick when it differs (approved for the next publish), and
 * the newest render (working). One render can hold several.
 */
async function rolesView(gagId: number, set: GagExamples, ex: Map<number, GagExample>): Promise<PerKind<GagPictureRoles>> {
  const working = await buildGagWorkingCards(gagId);
  const live = perKind(set.approved, ex);
  const pending = perKind(set.pending, ex);
  return mapKinds((k) => ({
    live: live[k],
    approvedNext: pending[k] && pending[k]!.attemptId !== live[k]?.attemptId ? pending[k] : null,
    working: working[k],
  }));
}

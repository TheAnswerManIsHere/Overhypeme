/**
 * @purpose The one rule for a fact going live: between one and three gags, each with an approved male, female and pet render of its current content.
 * @subsystem visual-pipeline
 *
 * Plan docs/plans/PLAN_FACT_LIFECYCLE_REBUILD.md, oracle item 12 and the
 * Source-of-Truth Analysis (*Whether a fact may go live*): one predicate,
 * evaluated server-side on the DRAFT set at "Approve for production" and
 * "Publish changes", and on the PUBLISHED set at activation and
 * "Reactivate". It replaces the old gate, which asked for one approved gag
 * and let unfinished ones stay hidden.
 *
 * The sets (migration 0157, lib/db/src/schema/factGags.ts):
 *   - draft: every non-removed gag not removed in the draft; its content is
 *     its pending content, else its published content; its examples are its
 *     pending picks when it has pending content, else its published examples.
 *   - published: every non-removed gag with published content, with its
 *     published examples.
 * "Of its current content" is checked against each example's own frozen
 * render input (`sameRenderedGag`), not assumed from the write path.
 * Grandfathering (Q11) does not exempt a gag here: it only keeps a gag
 * offered; going live again needs a full set (plan, *Questions for David*).
 */
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db, factGagsTable, imagePromptAttemptsTable, type FactGag } from "@workspace/db";
import { GAG_EXAMPLE_KINDS, MAX_GAGS_PER_FACT, joinWithAnd, type GagExampleKind } from "@workspace/api-zod";
import { examplesFor, loadExamples, type GagExamples } from "./examples";
import { sameRenderedGag } from "./gagStore";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = typeof db | Tx;

export type GagSet = "draft" | "published";

/** One gag of a set that is not ready, and why. */
export interface GagGoLiveGap {
  slot: number;
  /** Kinds with no approved render. */
  missing: GagExampleKind[];
  /** Kinds whose approved render shows other content than the gag holds. */
  outdated: GagExampleKind[];
}

export interface GoLiveCheck {
  ok: boolean;
  /** How many gags the set holds. */
  gagCount: number;
  gaps: GagGoLiveGap[];
}

/** A gag's content and examples as the named set holds them; null when the gag is not in that set. */
function gagInSet(gag: FactGag, examples: GagExamples, set: GagSet): { content: unknown; examples: GagExamples["approved"] } | null {
  if (gag.removedAt != null || (set === "draft" && gag.draftRemoved)) return null;
  const draftChange = set === "draft" && gag.pendingContent != null;
  const content = draftChange ? gag.pendingContent : gag.approvedContent;
  return content == null ? null : { content, examples: draftChange ? examples.pending : examples.approved };
}

/**
 * Evaluate the go-live rule on one of a fact's gag sets. Call inside the
 * transaction that acts on it, with the fact locked. A caller that has just
 * read (and locked) the fact's non-removed gags passes them in.
 */
export async function checkGoLive(factId: number, set: GagSet, executor: Executor = db, loaded?: FactGag[]): Promise<GoLiveCheck> {
  const gags = loaded ?? await executor.select().from(factGagsTable)
    .where(and(eq(factGagsTable.factId, factId), isNull(factGagsTable.removedAt)))
    .orderBy(asc(factGagsTable.slot));
  const examples = await loadExamples(gags.map((g) => g.id), executor);
  const members = gags
    .map((g) => ({ gag: g, inSet: gagInSet(g, examplesFor(examples, g.id), set) }))
    .filter((m): m is { gag: FactGag; inSet: NonNullable<ReturnType<typeof gagInSet>> } => m.inSet != null);

  const attemptIds = members.flatMap((m) => GAG_EXAMPLE_KINDS.map((k) => m.inSet.examples[k]?.attemptId).filter((id): id is number => id != null));
  const snapshots = new Map<number, unknown>();
  if (attemptIds.length) {
    // Only the gag the render drew, not the whole snapshot: this runs on every poll of the Gags view.
    const rows = await executor.select({ id: imagePromptAttemptsTable.id, drew: sql<unknown>`${imagePromptAttemptsTable.factEnrichmentSnapshot} -> 'visualPromptStrategyOverride'` })
      .from(imagePromptAttemptsTable).where(inArray(imagePromptAttemptsTable.id, attemptIds));
    for (const r of rows) snapshots.set(r.id, r.drew);
  }

  const gaps: GagGoLiveGap[] = [];
  for (const { gag, inSet } of members) {
    const missing: GagExampleKind[] = [];
    const outdated: GagExampleKind[] = [];
    for (const kind of GAG_EXAMPLE_KINDS) {
      const ex = inSet.examples[kind];
      if (!ex) { missing.push(kind); continue; }
      const drew = snapshots.get(ex.attemptId);
      if (drew == null || !sameRenderedGag(drew, inSet.content)) outdated.push(kind);
    }
    if (missing.length || outdated.length) gaps.push({ slot: gag.slot, missing, outdated });
  }
  const gagCount = members.length;
  return { ok: gagCount >= 1 && gagCount <= MAX_GAGS_PER_FACT && gaps.length === 0, gagCount, gaps };
}

/** The refusal in words: "A fact needs at least one gag." / "Gag 1 needs female and pet renders approved." */
export function describeGoLive(check: GoLiveCheck): string {
  if (check.gagCount === 0) return "A fact needs at least one gag before it can go live.";
  const parts = check.gaps.map((g) => {
    const words: string[] = [];
    if (g.missing.length) words.push(`needs ${joinWithAnd(g.missing)} render${g.missing.length > 1 ? "s" : ""} approved`);
    if (g.outdated.length) words.push(`has ${joinWithAnd(g.outdated)} render${g.outdated.length > 1 ? "s" : ""} of an older version of it; approve new ones`);
    return `Gag ${g.slot} ${words.join(" and ")}.`;
  });
  return parts.join(" ") || "Every gag needs its male, female and pet renders approved.";
}

/** The go-live rule was not met. */
export class GoLiveError extends Error {
  constructor(public readonly check: GoLiveCheck) {
    super(describeGoLive(check));
    this.name = "GoLiveError";
  }
}

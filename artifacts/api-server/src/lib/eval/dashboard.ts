/**
 * Eval harness (Slice 2B) — dashboard aggregation.
 *
 * Golden facts → per eval RUN, attempts grouped by fact then by attempt-signature
 * (a run spans multiple scenarios/engines). Each run gets an aggregate (rated
 * count, avg rating, failure-tag distribution). The latest run is diffed against
 * the previous one (avg-rating delta + tag-distribution delta) so a pipeline
 * change's effect is legible. Opportunistic (non-run) moderation ratings are
 * summarized SEPARATELY and labeled directional — only eval-run rows are a true
 * A/B.
 */

import { and, desc, eq, isNotNull, isNull, inArray } from "drizzle-orm";
import { db } from "@workspace/db";
import { factsTable, evalRunsTable, imagePromptAttemptsTable, type ImagePromptAttempt } from "@workspace/db/schema";
import {
  FAILURE_TAG_VALUES,
  attemptSignatureKey,
  type FailureTag,
  type AttemptSignature,
} from "@workspace/api-zod";
import { deriveAttemptSignature } from "./signature";
import { buildRenderStatusPayload } from "../imagePromptAttempts";

type TagDistribution = Record<FailureTag, number>;

function emptyTagDistribution(): TagDistribution {
  return { concept: 0, compiler: 0, image_model: 0, none: 0 };
}

interface AggregateStats {
  count: number;
  ratedCount: number;
  avgRating: number | null;
  tagDistribution: TagDistribution;
}

function aggregate(attempts: ImagePromptAttempt[]): AggregateStats {
  const tagDistribution = emptyTagDistribution();
  let ratingSum = 0;
  let ratedCount = 0;
  for (const a of attempts) {
    if (a.moderatorRating != null) {
      ratingSum += a.moderatorRating;
      ratedCount += 1;
    }
    if (a.failureTag && (FAILURE_TAG_VALUES as readonly string[]).includes(a.failureTag)) {
      tagDistribution[a.failureTag as FailureTag] += 1;
    }
  }
  return {
    count: attempts.length,
    ratedCount,
    avgRating: ratedCount > 0 ? ratingSum / ratedCount : null,
    tagDistribution,
  };
}

interface AttemptView {
  attemptId: number;
  factId: number;
  status: string;
  rating: number | null;
  failureTag: string | null;
}

function attemptView(a: ImagePromptAttempt): AttemptView {
  return {
    attemptId: a.id,
    factId: a.factId,
    status: buildRenderStatusPayload(a).status,
    rating: a.moderatorRating ?? null,
    failureTag: a.failureTag ?? null,
  };
}

interface SignatureGroup {
  signatureKey: string;
  signature: AttemptSignature;
  attempts: AttemptView[];
}

interface RunFactGroup {
  factId: number;
  signatures: SignatureGroup[];
}

interface RunView {
  id: number;
  label: string | null;
  createdAt: string;
  runProfile: unknown;
  aggregate: AggregateStats;
  byFact: RunFactGroup[];
}

function groupBySignature(attempts: ImagePromptAttempt[]): SignatureGroup[] {
  const groups = new Map<string, SignatureGroup>();
  for (const a of attempts) {
    const signature = deriveAttemptSignature(a);
    const key = attemptSignatureKey(signature);
    let g = groups.get(key);
    if (!g) {
      g = { signatureKey: key, signature, attempts: [] };
      groups.set(key, g);
    }
    g.attempts.push(attemptView(a));
  }
  return [...groups.values()];
}

interface TagDelta {
  tag: FailureTag;
  current: number;
  previous: number;
  delta: number;
}

export interface EvalDashboard {
  goldenFacts: Array<{ id: number; text: string }>;
  runs: RunView[];
  runDiff: {
    currentRunId: number;
    previousRunId: number;
    avgRatingDelta: number | null;
    tagDeltas: TagDelta[];
  } | null;
  /** Non-run moderation ratings on golden facts — directional only. */
  opportunistic: AggregateStats;
}

const MAX_RUNS = 10;

export async function buildEvalDashboard(): Promise<EvalDashboard> {
  const goldenFacts = await db
    .select({ id: factsTable.id, text: factsTable.text })
    .from(factsTable)
    .where(eq(factsTable.evalGolden, true))
    .orderBy(desc(factsTable.id));
  const goldenIds = goldenFacts.map((f) => f.id);

  const runRows = await db
    .select()
    .from(evalRunsTable)
    .orderBy(desc(evalRunsTable.createdAt))
    .limit(MAX_RUNS);

  const runs: RunView[] = [];
  for (const run of runRows) {
    const attempts = await db
      .select()
      .from(imagePromptAttemptsTable)
      .where(eq(imagePromptAttemptsTable.evalRunId, run.id))
      .orderBy(desc(imagePromptAttemptsTable.createdAt));

    const byFactMap = new Map<number, ImagePromptAttempt[]>();
    for (const a of attempts) {
      const arr = byFactMap.get(a.factId) ?? [];
      arr.push(a);
      byFactMap.set(a.factId, arr);
    }
    const byFact: RunFactGroup[] = [...byFactMap.entries()].map(([factId, atts]) => ({
      factId,
      signatures: groupBySignature(atts),
    }));

    runs.push({
      id: run.id,
      label: run.label,
      createdAt: run.createdAt.toISOString(),
      runProfile: run.runProfile,
      aggregate: aggregate(attempts),
      byFact,
    });
  }

  // Run N vs N-1 diff (runs are newest-first).
  let runDiff: EvalDashboard["runDiff"] = null;
  if (runs.length >= 2) {
    const cur = runs[0]!;
    const prev = runs[1]!;
    runDiff = {
      currentRunId: cur.id,
      previousRunId: prev.id,
      avgRatingDelta:
        cur.aggregate.avgRating != null && prev.aggregate.avgRating != null
          ? cur.aggregate.avgRating - prev.aggregate.avgRating
          : null,
      tagDeltas: FAILURE_TAG_VALUES.map((tag) => ({
        tag,
        current: cur.aggregate.tagDistribution[tag],
        previous: prev.aggregate.tagDistribution[tag],
        delta: cur.aggregate.tagDistribution[tag] - prev.aggregate.tagDistribution[tag],
      })),
    };
  }

  // Opportunistic: rated moderation attempts (no eval_run_id) on golden facts.
  let opportunistic = aggregate([]);
  if (goldenIds.length > 0) {
    const opp = await db
      .select()
      .from(imagePromptAttemptsTable)
      .where(and(
        inArray(imagePromptAttemptsTable.factId, goldenIds),
        isNull(imagePromptAttemptsTable.evalRunId),
        isNotNull(imagePromptAttemptsTable.moderatorRating),
      ));
    opportunistic = aggregate(opp);
  }

  return { goldenFacts, runs, runDiff, opportunistic };
}

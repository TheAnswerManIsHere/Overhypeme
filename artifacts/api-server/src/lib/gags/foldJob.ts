/**
 * @purpose The fold and cast fill (queue `gag_fold`): one resumable job over every gag version that folds its eleven extra fields into the scene, reads its cast, keeps the original, and reports the two lists that gate the switch.
 * @subsystem visual-pipeline
 *
 * Plan docs/plans/PLAN_GAG_DIRECT_RENDER.md, E. Run before any reader of the
 * eleven fields is removed (increment 3), over every renderable gag version:
 * approved and pending independently. A refresh's pending operations
 * (`pending_review_id`, `pending_remove`) and the example picks are never
 * touched; only the version's content changes.
 *
 * Per version, two results:
 *   - fold: nothing to fold · converted · listed for a moderator · already
 *     converted (no-op);
 *   - cast: extracted (possibly empty) · failed (retried by the next run) ·
 *     already extracted (no-op).
 *
 * The report is computed from the gags as they are now, so it is also the
 * dry run: what a run would do, with nothing written. A version listed only
 * because its scene would be too long clears when a moderator shortens it. One
 * listed for an old violence, supporting-text or depiction setting cannot be
 * cleared from the card, which no longer writes those fields; a read-only
 * count on the development database found none (PR #1002 round 1), and the
 * card cannot create one. Increment 3 does not start
 * until both lists are empty: versions listed for a moderator, and versions
 * whose cast is missing or failed.
 *
 * Every write re-reads the version under the fact and gag locks (the order
 * gagStore uses) and gives up, to be retried, when its content changed while
 * the cast was being read, so a moderator's save is never overwritten.
 */
import { desc, eq, isNull } from "drizzle-orm";
import { db, factGagsTable, factsTable, factGagFoldArchiveTable } from "@workspace/db";
import { asyncJobsTable } from "@workspace/db/schema";
import {
  castIsCurrent,
  withoutCast,
  type GagCastState,
  type GagFoldReport,
  type GagFoldStartResponse,
  type GagFoldStage,
  type GagFoldState,
  type GagFoldVersionReport,
  type VisualPromptStrategyOverride,
} from "@workspace/api-zod";
import { enqueueJob, registerJobHandler, type HandlerResult, type JobHandler } from "../asyncJobs";
import { stableStringify } from "../factRenderScenarios";
import { normaliseGagContent } from "./resolver";
import { foldGagContent } from "./fold";
import { extractCast, type CastExtractionInput, type CastExtractionResult } from "./castExtraction";
import { factCharacterLabels } from "./castPreparation";
import { logger } from "../logger";
import { assertJobOwnership, fencedTransaction } from "../jobFence";

export const GAG_FOLD_QUEUE = "gag_fold";

export type GagFoldPayload = {
  gagId: number;
  stage: GagFoldStage;
};

export interface GagFoldDeps {
  extract: (input: CastExtractionInput) => Promise<CastExtractionResult>;
}
const realDeps: GagFoldDeps = { extract: extractCast };

export const foldDedupeKey = (p: GagFoldPayload) => `gag_fold:${p.gagId}:${p.stage}`;


// ─── The report (and dry run) ───────────────────────────────────────────────

interface VersionRow {
  gagId: number;
  factId: number;
  slot: number;
  stage: GagFoldStage;
  raw: unknown;
}

async function renderableVersions(): Promise<VersionRow[]> {
  const gags = await db.select({
    id: factGagsTable.id,
    factId: factGagsTable.factId,
    slot: factGagsTable.slot,
    approvedContent: factGagsTable.approvedContent,
    pendingContent: factGagsTable.pendingContent,
  }).from(factGagsTable).where(isNull(factGagsTable.removedAt));
  const out: VersionRow[] = [];
  for (const g of gags) {
    if (g.approvedContent != null) out.push({ gagId: g.id, factId: g.factId, slot: g.slot, stage: "approved", raw: g.approvedContent });
    if (g.pendingContent != null) out.push({ gagId: g.id, factId: g.factId, slot: g.slot, stage: "pending", raw: g.pendingContent });
  }
  return out.sort((a, b) => a.factId - b.factId || a.slot - b.slot || a.stage.localeCompare(b.stage));
}

/** The latest gag_fold job per version, by its dedupe key. */
async function latestJobs(): Promise<Map<string, { status: string; error: string | null; result: unknown }>> {
  // One row per version: its latest job (DISTINCT ON keeps the first per key in id-descending order).
  const rows = await db.selectDistinctOn([asyncJobsTable.dedupeKey], {
    dedupeKey: asyncJobsTable.dedupeKey,
    status: asyncJobsTable.status,
    lastError: asyncJobsTable.lastError,
    result: asyncJobsTable.result,
  }).from(asyncJobsTable).where(eq(asyncJobsTable.queue, GAG_FOLD_QUEUE)).orderBy(asyncJobsTable.dedupeKey, desc(asyncJobsTable.id));
  const out = new Map<string, { status: string; error: string | null; result: unknown }>();
  for (const r of rows) if (r.dedupeKey && !out.has(r.dedupeKey)) out.set(r.dedupeKey, { status: r.status, error: r.lastError, result: r.result });
  return out;
}

export async function gagFoldReport(): Promise<GagFoldReport> {
  const versions = await renderableVersions();
  const jobs = await latestJobs();
  const archived = new Set(
    (await db.select({ gagId: factGagFoldArchiveTable.gagId, stage: factGagFoldArchiveTable.stage })
      .from(factGagFoldArchiveTable).where(isNull(factGagFoldArchiveTable.revertedAt)))
      .map((a) => `${a.gagId}:${a.stage}`),
  );
  const report: GagFoldReport = {
    versions: versions.length,
    fold: { nothing: 0, would_convert: 0, listed: 0, already_converted: 0 },
    cast: { extracted: 0, missing: 0, stale: 0, failed: 0 },
    jobs: { queued: 0, running: 0 },
    forModerator: [],
    castMissing: [],
  };
  for (const v of versions) {
    const content = normaliseGagContent(v.raw);
    const key = foldDedupeKey(v);
    const job = jobs.get(key) ?? null;
    if (job?.status === "pending") report.jobs.queued++;
    if (job?.status === "processing") report.jobs.running++;
    const jobView = job ? { status: job.status, error: job.error } : null;
    if (!content) {
      // Stored content the schema refuses: only a moderator can repair it.
      const item: GagFoldVersionReport = { ...pick(v), fold: "listed", cast: "missing", reasons: ["the stored content does not validate"], job: jobView };
      report.fold.listed++; report.cast.missing++;
      report.forModerator.push(item); report.castMissing.push(item);
      continue;
    }
    const outcome = foldGagContent(content);
    const fold: GagFoldState = outcome.kind === "nothing"
      ? (archived.has(`${v.gagId}:${v.stage}`) ? "already_converted" : "nothing")
      : outcome.kind === "converted" ? "would_convert" : "listed";
    const unbound = unboundFromJob(job?.result);
    const cast: GagCastState = castIsCurrent(content)
      ? "extracted"
      : job?.status === "failed" || unbound.length ? "failed"
      : content.castExtraction ? "stale" : "missing";
    report.fold[fold]++;
    report.cast[cast]++;
    if (fold === "listed" && outcome.kind === "listed") {
      report.forModerator.push({ ...pick(v), fold, cast, reasons: outcome.reasons, job: jobView });
    }
    if (cast !== "extracted") {
      const reasons = unbound.length
        ? [`the scene does not show bubble speaker ${unbound.map((s) => `"${s}"`).join(", ")}`]
        : cast === "failed" ? [`reading the cast failed: ${job?.error ?? "unknown error"}`]
        : cast === "stale" ? ["the cast was read from an earlier scene"]
        : ["the cast has not been read yet"];
      report.castMissing.push({ ...pick(v), fold, cast, reasons, job: jobView });
    }
  }
  return report;
}

const pick = (v: VersionRow) => ({ gagId: v.gagId, factId: v.factId, slot: v.slot, stage: v.stage });
const unboundFromJob = (result: unknown): string[] => {
  const u = (result as { unboundSpeakers?: unknown } | null)?.unboundSpeakers;
  return Array.isArray(u) ? u.filter((s): s is string => typeof s === "string") : [];
};

// ─── Starting a run ─────────────────────────────────────────────────────────

/** Queue one job per version with work: a fold to do, or a cast that is not current. Re-runnable: done versions are skipped, queued ones deduped. */
export async function startGagFold(): Promise<GagFoldStartResponse> {
  const targets: GagFoldPayload[] = [];
  for (const v of await renderableVersions()) {
    const content = normaliseGagContent(v.raw);
    if (!content) continue;
    if (foldGagContent(content).kind === "converted" || !castIsCurrent(content)) targets.push({ gagId: v.gagId, stage: v.stage });
  }
  let queued = 0;
  let deduped = 0;
  for (const t of targets) {
    const r = await enqueueJob({ queue: GAG_FOLD_QUEUE, payload: t, dedupeKey: foldDedupeKey(t) });
    if (r.inserted) queued++; else deduped++;
  }
  return { requested: targets.length, queued, deduped };
}

// ─── One version ────────────────────────────────────────────────────────────

/** The column a stage's content lives in. */
const contentKey = (stage: GagFoldStage): "approvedContent" | "pendingContent" => (stage === "approved" ? "approvedContent" : "pendingContent");
const skipped = (reason: string): HandlerResult => ({ ok: true, result: { skipped: true, reason } });

export async function runGagFold(payload: unknown, deps: GagFoldDeps = realDeps): Promise<HandlerResult> {
  const p = payload as GagFoldPayload;
  if (!p || typeof p.gagId !== "number" || (p.stage !== "approved" && p.stage !== "pending")) {
    return { ok: false, error: "gag_fold: bad payload" };
  }
  const [gag] = await db.select().from(factGagsTable).where(eq(factGagsTable.id, p.gagId)).limit(1);
  if (!gag || gag.removedAt) return skipped("gag_removed");
  const key = contentKey(p.stage);
  const raw = gag[key];
  const content = normaliseGagContent(raw);
  if (!content) return skipped(raw == null ? "no_version" : "content_invalid");

  const outcome = foldGagContent(content);
  const target = outcome.kind === "converted" ? outcome.content : content;
  if (outcome.kind !== "converted" && castIsCurrent(content)) return skipped("already_current");

  // The paid step, outside any lock: the cast of the scene this version will hold.
  let cast: CastExtractionResult;
  // Paid: only while this run still owns its job (Issue #1000).
  await assertJobOwnership();
  try {
    cast = await deps.extract({
      scene: target.coreSceneOverride ?? "",
      bubbles: target.bubbles,
      factCharacterLabels: (await factCharacterLabels(gag.factId)) ?? [],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err, ...p }, "[gag_fold] cast extraction failed (retried; nothing written)");
    return { ok: false, error: `cast extraction failed: ${msg}` };
  }
  // A speaker the scene does not show stays unbound: the fold still lands, the
  // cast does not, and the version is in the cast list for a moderator.
  const withCast: VisualPromptStrategyOverride = cast.unboundSpeakers.length
    ? withoutCast(target)
    : { ...target, cast: cast.cast, castExtraction: cast.extraction };

  // Fenced (Issue #1000): the fold lands only while this run owns its job.
  return fencedTransaction(db, async (tx): Promise<HandlerResult> => {
    await tx.select({ id: factsTable.id }).from(factsTable).where(eq(factsTable.id, gag.factId)).for("update").limit(1);
    const [locked] = await tx.select().from(factGagsTable).where(eq(factGagsTable.id, p.gagId)).for("update").limit(1);
    if (!locked || locked.removedAt) return skipped("gag_removed");
    const now = locked[key];
    if (stableStringify(now) !== stableStringify(raw)) {
      return { ok: false, error: "deferred: the version changed while its cast was read" };
    }
    if (stableStringify(withCast) === stableStringify(raw)) {
      return { ok: true, result: { fold: "nothing", cast: "unbound", unboundSpeakers: cast.unboundSpeakers } };
    }
    await tx.update(factGagsTable).set({ [key]: withCast, updatedAt: new Date() }).where(eq(factGagsTable.id, p.gagId));
    if (outcome.kind === "converted") {
      await tx.insert(factGagFoldArchiveTable).values({
        gagId: p.gagId,
        factId: gag.factId,
        stage: p.stage,
        originalContent: raw as object,
        foldedContent: withCast,
        moved: outcome.moved,
      });
    }
    return {
      ok: true,
      result: {
        fold: outcome.kind,
        cast: cast.unboundSpeakers.length ? "unbound" : "extracted",
        castSize: cast.cast.length,
        unboundSpeakers: cast.unboundSpeakers,
      },
    };
  });
}

// ─── Reversal ───────────────────────────────────────────────────────────────

/**
 * Restore a converted version's original content, while the version still
 * holds exactly what the fold wrote. Anything since (a moderator's save, a
 * promotion) means the original is no longer the version, and nothing is done.
 */
export async function revertGagFold(archiveId: number): Promise<"reverted" | "changed_since" | "not_found" | "already_reverted"> {
  return db.transaction(async (tx) => {
    const [a] = await tx.select().from(factGagFoldArchiveTable).where(eq(factGagFoldArchiveTable.id, archiveId)).for("update").limit(1);
    if (!a) return "not_found";
    if (a.revertedAt) return "already_reverted";
    await tx.select({ id: factsTable.id }).from(factsTable).where(eq(factsTable.id, a.factId)).for("update").limit(1);
    const [g] = await tx.select().from(factGagsTable).where(eq(factGagsTable.id, a.gagId)).for("update").limit(1);
    const k = contentKey(a.stage);
    const now = g ? g[k] : null;
    if (!g || stableStringify(now) !== stableStringify(a.foldedContent)) return "changed_since";
    await tx.update(factGagsTable).set({ [k]: a.originalContent, updatedAt: new Date() }).where(eq(factGagsTable.id, a.gagId));
    await tx.update(factGagFoldArchiveTable).set({ revertedAt: new Date() }).where(eq(factGagFoldArchiveTable.id, archiveId));
    return "reverted";
  });
}

export const gagFoldHandler: JobHandler = { run: (payload: unknown) => runGagFold(payload) };

export function registerGagFoldHandler(): void {
  // Execution limit (Issue #1000): one cast call, up to 3 tries of 30 s (about 1.5 min), then database work, plus margin.
  registerJobHandler(GAG_FOLD_QUEUE, gagFoldHandler, { executionLimitMs: 10 * 60_000 });
}

/**
 * The engine comparison's runs: admission, preparation, rendering and the
 * record of each call (launch Phase 8, increments 2b and 3; plan
 * `docs/plans/PLAN_PHASE8_ENGINE_EVALUATION.md`, *Proposed Design* C and D).
 *
 * Pricing does not gate a comparison run (David, 2026-11-07: *"Ignore pricing
 * entirely. Doesn't matter right now."*, `decisions.md`): no per-run or weekly
 * limit, no reading of fal's bills, no first-edit gate. What stays is what
 * keeps a paid call from happening twice:
 *
 * - **Admission** runs under one advisory lock, so two starts can never both
 *   take the same pending item: it re-reads the set, takes every pending item
 *   of the run's kind, and writes one reservation row per call (the record of
 *   the call, its bound and its fal request id) and enqueues the work in the
 *   same transaction. Paid dispatch never runs in CI.
 * - **Each call is one call.** Both queues run at one attempt; a cell submits
 *   once through the comparison transport and stores fal's request id before
 *   it polls, so nothing resubmits; a restart that finds a marker but no
 *   result fails as ambiguous rather than calling again.
 * - **The record.** A call that never reached a vendor is released; one that
 *   completed is settled at its bound; one that failed after submission stays
 *   reserved, because it may have been billed.
 * - **A storage failure never buys a second image**: the cell keeps the
 *   vendor's URL and its retry stores that image again.
 */

import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  comparisonCellsTable,
  comparisonPanelsTable,
  comparisonReservationsTable,
  comparisonRunsTable,
  comparisonSetsTable,
  factGagsTable,
  factsTable,
  type ComparisonCell,
  type ComparisonPanel,
  type ComparisonRun,
} from "@workspace/db/schema";
import {
  RENDER_SCENARIO_DESCRIPTORS,
  validateEnrichment,
  type ComparisonRunPlanRequest,
  type GenerationMode,
  type ReferenceIdentityType,
  type RenderScenarioKey,
  type FactEnrichment,
} from "@workspace/api-zod";
import { RESUMES_FROM_CHECKPOINTS, enqueueJob, registerJobHandler, terminalFailure, type HandlerResult } from "../asyncJobs";
import { JobOwnershipLostError, assertJobOwnership, fencedTransaction } from "../jobFence";
import { reportOperationalAlert } from "../operationalAlerts";
import { defaultScenarioRenderControls, syntheticAnalysisForReference } from "../reviewRenderScenarios";
import { ReferenceAssetUnavailableError, resolveDefaultReferenceUrl } from "../defaultReferenceResolver";
import { resolveRenderReviewInput } from "../imagePrompt/resolveRenderReviewInput";
import { assembleImagePromptForPreview } from "../imagePrompt/preview";
import { renderPersonalized } from "../renderCanonical";
import { compileDirect, type DirectCompileArgs } from "../imagePrompt/compilers/nanoBanana2";
import { DirectGagInputError } from "../imagePrompt/directInput";
import { engineFamilyOf, recipeById } from "../imagePrompt/recipeStore";
import { imageEngineRefusal } from "../imageEngineRouting";
import { buildImageRequestSettings } from "../imageRequestBuilder";
import { buildEngineInput, engineById } from "../engineInterpreter";
import { downloadToBuffer, extractFirstImageUrl, imageEngineParams } from "../imageEngineRequest";
import {
  actorForUser,
  actorOf,
  finishAndStore,
  latestCellGenerationRequest,
  recordGenerationRequest,
  setVendorRequestId,
  SYSTEM_ACTOR,
  type ProvenanceActor,
} from "../provenance/records";
import { vendorContext } from "../provenance/vendorContext";
import { blindToken } from "./blindToken";
import { ObjectStorageService } from "../objectStorage";
import { logger } from "../logger";
import { gagRenderInput, normaliseGagContent, primaryGag, type GagContent } from "../gags/resolver";
import { planRun, type RunPlan, type WorkItem } from "./admission";
import { loadSetRows, runItems, type RunScope } from "./sets";
import { awaitResult, comparisonFal } from "./transport";
import { falContentRefusal, falSubmitErrorMessage } from "../falClient";

export const COMPARISON_PREPARE_QUEUE = "comparison_prepare";
/** The prompt text a panel's frozen compiled prompt sends to every engine, or null. */
export function promptTextOf(compiledPrompt: unknown): string | null {
  const compiled = compiledPrompt as { imagePrompt?: unknown; prompt?: unknown } | null;
  const text = compiled?.imagePrompt ?? compiled?.prompt;
  return typeof text === "string" && text.length > 0 ? text : null;
}

export const COMPARISON_RENDER_QUEUE = "comparison_render";

/** The comparison's reference images are sent at most this size on the long edge (plan, D2). */
const COMPARISON_REFERENCE_MAX_EDGE_PX = 1024;

/** How a cell polls its one submission. */
export const CELL_POLL = { intervalMs: 3_000, timeoutMs: 10 * 60_000 };

let allowPaidDispatchInCi = false;
/** Test seam: the suite runs in CI against fakes, so it may start runs there. */
export function __allowComparisonDispatchInCiForTest(allow: boolean): void {
  allowPaidDispatchInCi = allow;
}

/** Why paid dispatch is refused here, or null. */
function paidDispatchRefusal(): string | null {
  if (process.env["CI"] && !allowPaidDispatchInCi) return "paid comparison runs never run in CI";
  return null;
}

export class ComparisonRunRefused extends Error {
  constructor(readonly refusal: string, readonly run: ComparisonRun | null, readonly plan: RunPlan | null) {
    super(refusal);
    this.name = "ComparisonRunRefused";
  }
}

const ADMISSION_LOCK = sql`select pg_advisory_xact_lock(hashtext('comparison_admission'))`;

/**
 * Admit and start the next run of `kind` for a set: every pending item of that
 * kind. Throws `ComparisonRunRefused` (with the refused run row, when one was
 * recorded) when there is nothing to run or the run would be paid in CI.
 */
export async function startComparisonRun(
  setId: number,
  req: ComparisonRunPlanRequest,
  adminUserId: string | null,
  /** Limit a "full" run to one retry's own work. */
  scope?: RunScope,
): Promise<{ run: ComparisonRun; plan: RunPlan } | null> {
  const ci = paidDispatchRefusal();
  if (ci) throw new ComparisonRunRefused(ci, null, null);

  const outcome = await db.transaction(async (tx) => {
    await tx.execute(ADMISSION_LOCK);
    const rows = await loadSetRows(setId, tx);
    if (!rows) return null;
    const plan = planRun(await runItems(req.kind, rows, scope));
    const base = { setId, kind: req.kind, createdBy: adminUserId };
    if (!plan.admitted) {
      const [run] = await tx.insert(comparisonRunsTable).values({ ...base, state: "refused", boundUsd: "0", refusal: plan.refusal, endedAt: new Date() }).returning();
      return { refused: true as const, run: run!, plan };
    }
    const [run] = await tx.insert(comparisonRunsTable).values({ ...base, state: "running", boundUsd: String(plan.boundUsd) }).returning();
    for (const item of plan.items) await admitItem(tx, run!, item);
    return { refused: false as const, run: run!, plan };
  });
  if (!outcome) return null;
  if (outcome.refused) throw new ComparisonRunRefused(outcome.plan.refusal ?? "refused", outcome.run, outcome.plan);
  logger.info({ setId, runId: outcome.run.id, kind: req.kind, items: outcome.plan.items.length, boundUsd: outcome.plan.boundUsd }, "[comparison] run admitted");
  return { run: outcome.run, plan: outcome.plan };
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** One reservation, the item's in-flight state and its job, in admission's transaction. */
async function admitItem(tx: Tx, run: ComparisonRun, item: WorkItem): Promise<void> {
  const [kind, idText] = item.ref.split(":");
  const id = Number(idText);
  if (kind === "panel") {
    const [reservation] = await tx.insert(comparisonReservationsTable).values({
      runId: run.id, kind: "planner", target: item.label.slice(0, 128), panelId: id, boundUsd: String(item.boundUsd),
    }).returning({ id: comparisonReservationsTable.id });
    await tx.update(comparisonPanelsTable).set({ state: "preparing", error: null, updatedAt: new Date() }).where(eq(comparisonPanelsTable.id, id));
    await enqueueJob({ queue: COMPARISON_PREPARE_QUEUE, payload: { runId: run.id, panelId: id, reservationId: reservation!.id }, dedupeKey: `comparison:prepare:${run.id}:${id}`, maxAttempts: 1 }, tx);
    return;
  }
  const [reservation] = await tx.insert(comparisonReservationsTable).values({
    runId: run.id, kind: "image", target: item.engineId ?? "?", cellId: id, boundUsd: String(item.boundUsd),
  }).returning({ id: comparisonReservationsTable.id });
  // A cell whose panel is still being prepared (a "full" run) waits, reserved;
  // the transaction that records its panel prepared queues it.
  const [owner] = await tx.select({ state: comparisonPanelsTable.state }).from(comparisonPanelsTable)
    .innerJoin(comparisonCellsTable, eq(comparisonCellsTable.panelId, comparisonPanelsTable.id))
    .where(eq(comparisonCellsTable.id, id));
  if (owner?.state !== "prepared") {
    await tx.update(comparisonCellsTable).set({ state: "waiting", error: null, updatedAt: new Date() }).where(eq(comparisonCellsTable.id, id));
    return;
  }
  await queueCell(tx, run.id, id, reservation!.id);
}

async function queueCell(tx: Tx, runId: number, cellId: number, reservationId: number): Promise<void> {
  await tx.update(comparisonCellsTable).set({ state: "enqueued", error: null, updatedAt: new Date() }).where(eq(comparisonCellsTable.id, cellId));
  await enqueueJob({ queue: COMPARISON_RENDER_QUEUE, payload: { runId, cellId, reservationId }, dedupeKey: `comparison:render:${runId}:${cellId}`, maxAttempts: 1 }, tx);
}

/** The reserved, unsettled image reservations of a panel's waiting cells. */
async function waitingReservations(tx: Tx, panelId: number): Promise<Array<{ cellId: number; reservationId: number; runId: number }>> {
  const rows = await tx.select({ cellId: comparisonCellsTable.id, reservationId: comparisonReservationsTable.id, runId: comparisonReservationsTable.runId })
    .from(comparisonCellsTable)
    .innerJoin(comparisonReservationsTable, and(eq(comparisonReservationsTable.cellId, comparisonCellsTable.id), eq(comparisonReservationsTable.state, "reserved")))
    .where(and(eq(comparisonCellsTable.panelId, panelId), eq(comparisonCellsTable.state, "waiting")))
    .orderBy(asc(comparisonCellsTable.id));
  return rows;
}

// ─── Settlement ───────────────────────────────────────────────────────────────

/** The call never reached a vendor: its bound is free again. */
async function release(reservationId: number): Promise<void> {
  await fencedTransaction(db, (tx) => tx.update(comparisonReservationsTable).set({ state: "released", settledAt: new Date() }).where(eq(comparisonReservationsTable.id, reservationId)));
}

/**
 * A call completed: it is recorded at its bound, the most it could have cost.
 * No bill is read (David's override, 2026-11-07); fal's dashboard is the
 * record of what was actually billed.
 */
const writeSettlement = async (reservationId: number): Promise<void> => {
  await fencedTransaction(db, (tx) => tx.update(comparisonReservationsTable)
    .set({ state: "settled", settledUsd: sql`${comparisonReservationsTable.boundUsd}`, settledAt: new Date() })
    .where(and(eq(comparisonReservationsTable.id, reservationId), eq(comparisonReservationsTable.state, "reserved"))));
};
let settlementWrite = writeSettlement;
/** Test seam: the settlement write, so a test can make it fail. */
export function __setSettlementWriteForTest(fn: typeof writeSettlement | null): void {
  settlementWrite = fn ?? writeSettlement;
}

export async function settleAtBound(reservationId: number): Promise<void> {
  try {
    await settlementWrite(reservationId);
  } catch (err) {
    // The paid render has already returned: this is the accounting write after
    // a vendor call, and it did not land (launch Phase 16, "spend that could
    // not be recorded"). Reported without a database write, then thrown on
    // exactly as before. A run that lost its claim is not reported: the write
    // was refused because another run holds the job, not because the ledger
    // failed, and the job's own outcome is that other run's.
    if (!(err instanceof JobOwnershipLostError)) {
      reportOperationalAlert("unrecorded_spend", { what: "comparison_settlement", reservationId });
    }
    throw err;
  }
}

/** A run ends when none of its items is still in flight. */
async function finishRunIfDone(runId: number): Promise<void> {
  const [row] = await db.select({
    inFlight: sql<number>`count(*)::int`,
  }).from(comparisonReservationsTable)
    .leftJoin(comparisonPanelsTable, eq(comparisonPanelsTable.id, comparisonReservationsTable.panelId))
    .leftJoin(comparisonCellsTable, eq(comparisonCellsTable.id, comparisonReservationsTable.cellId))
    .where(and(
      eq(comparisonReservationsTable.runId, runId),
      sql`(${comparisonPanelsTable.state} in ('preparing', 'planning') or ${comparisonCellsTable.state} in ('enqueued', 'waiting'))`,
    ));
  if ((row?.inFlight ?? 0) === 0) {
    await fencedTransaction(db, (tx) => tx.update(comparisonRunsTable).set({ state: "done", endedAt: new Date() }).where(and(eq(comparisonRunsTable.id, runId), eq(comparisonRunsTable.state, "running"))));
  }
}

// ─── Preparation ──────────────────────────────────────────────────────────────

interface PreparePayload { runId: number; panelId: number; reservationId: number }

/**
 * A panel that will not be prepared. Its waiting cells (a "full" run) give up
 * their reservations and go back to expected, in the same transaction, so a
 * retry of the panel admits them again and nothing waits for ever.
 */
async function failPanel(panelId: number, state: "failed" | "skipped", reason: string): Promise<void> {
  await fencedTransaction(db, async (tx) => {
    await tx.update(comparisonPanelsTable)
      .set(state === "skipped" ? { state, skipReason: reason, updatedAt: new Date() } : { state, error: reason, updatedAt: new Date() })
      .where(eq(comparisonPanelsTable.id, panelId));
    for (const w of await waitingReservations(tx, panelId)) {
      await tx.update(comparisonReservationsTable).set({ state: "released", settledAt: new Date() }).where(eq(comparisonReservationsTable.id, w.reservationId));
      await tx.update(comparisonCellsTable).set({ state: "expected", updatedAt: new Date() }).where(eq(comparisonCellsTable.id, w.cellId));
    }
  });
}

/**
 * Prepare one panel through the same direct compile the Runtime Compiled
 * Prompt preview uses, and freeze its input for every cell.
 */
export async function preparePanel(p: PreparePayload): Promise<HandlerResult> {
  const [panel] = await db.select().from(comparisonPanelsTable).where(eq(comparisonPanelsTable.id, p.panelId));
  if (panel?.state === "planning") {
    // A panel left mid-planner-call by a restart before the planner was
    // removed: that call may have been billed, so it is not prepared again.
    await failPanel(panel.id, "failed", "interrupted during the planner call: it may have been billed, so it was not repeated");
    await finishRunIfDone(p.runId);
    return terminalFailure("comparison_dispatch_ambiguous", "planner call outcome unknown");
  }
  if (!panel || panel.state !== "preparing") return { ok: true, result: "not in flight" };
  try {
    return await preparePanelInFlight(panel, p);
  } finally {
    await finishRunIfDone(p.runId);
  }
}

async function preparePanelInFlight(panel: ComparisonPanel, p: PreparePayload): Promise<HandlerResult> {
  const [fact] = await db.select({ text: factsTable.text, enrichment: factsTable.enrichment }).from(factsTable).where(eq(factsTable.id, panel.factId));
  // The render input: the fact's classification with the panel's one gag —
  // the gag the panel names (a path set; plan PLAN_GAG_DIRECT_RENDER.md, A),
  // else the fact's primary gag (the lowest-slot gag's approved version;
  // lib/gags/resolver.ts), as a comparison read the fact's one gag before
  // gags had their own table.
  const gag = !fact ? null : panel.gagId != null ? await namedGag(panel.gagId, panel.factId) : (await primaryGag(panel.factId))?.content ?? null;
  const enrichment = fact
    ? validateEnrichment(gag && fact.enrichment ? gagRenderInput(fact.enrichment as FactEnrichment, gag) : fact.enrichment)
    : null;
  if (!fact || !enrichment?.ok || (panel.gagId != null && !gag)) {
    const reason = !fact ? "the fact no longer exists" : panel.gagId != null && !gag ? `gag ${panel.gagId} no longer has content` : "the fact's enrichment does not validate";
    await failPanel(panel.id, "skipped", reason);
    await release(p.reservationId);
    return { ok: true, result: "skipped" };
  }
  const desc = RENDER_SCENARIO_DESCRIPTORS[panel.scenarioKey as RenderScenarioKey];
  let reference: { url: string; version: string } | null = null;
  if (desc.referenceIdentityType) {
    try {
      reference = await resolveDefaultReferenceUrl(desc.referenceIdentityType as ReferenceIdentityType, { maxEdgePx: COMPARISON_REFERENCE_MAX_EDGE_PX });
    } catch (err) {
      const reason = err instanceof ReferenceAssetUnavailableError ? `reference asset unavailable: ${err.detail}` : `reference upload failed: ${err instanceof Error ? err.message : String(err)}`;
      await failPanel(panel.id, err instanceof ReferenceAssetUnavailableError ? "skipped" : "failed", reason);
      await release(p.reservationId);
      return { ok: true, result: "skipped" };
    }
  }
  const lookStyleId = panel.lookStyleId === "none" ? null : panel.lookStyleId;
  let resolved;
  try {
    resolved = await resolveRenderReviewInput(fact.text, enrichment.data, {
      subjectRenderMode: desc.subjectRenderMode,
      sourceImageAnalysis: desc.referenceIdentityType ? syntheticAnalysisForReference(desc.referenceIdentityType as ReferenceIdentityType) : undefined,
      referenceImageUrl: reference?.url ?? null,
      // The fixed photo names the sample subject: the wife's renders as Raena
      // Franklin, she/her, never as David.
      referenceIdentityType: desc.referenceIdentityType,
      lookStyleId,
      renderControls: defaultScenarioRenderControls(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await failPanel(panel.id, "failed", `input assembly failed: ${msg}`);
    await release(p.reservationId);
    return terminalFailure("comparison_input_failed", msg);
  }

  // The panel's one gag, compiled directly: no model call, so preparation
  // costs nothing and needs no marker against a repeated call (plan
  // PLAN_GAG_DIRECT_RENDER.md, D). Each cell compiles the frozen input again
  // with its own wording.
  let assembled;
  try {
    assembled = assembleImagePromptForPreview({
      gag,
      subjectRenderMode: resolved.subjectRenderMode,
      renderControls: resolved.renderControls,
      stylePrompt: resolved.stylePrompt,
      referenceImageUrl: reference?.url ?? null,
      renderedSubject: resolved.renderedSubject,
    });
  } catch (err) {
    // Every compile refusal ends the panel here, with its reservation
    // released: a preparation job runs once (maxAttempts 1), so a throw that
    // escaped would leave the panel in flight and the evaluation unfinishable.
    if (err instanceof DirectGagInputError) {
      await failPanel(panel.id, "skipped", `the gag cannot be drawn as it stands: ${err.message}`);
    } else {
      await failPanel(panel.id, "failed", `the prompt could not be compiled: ${err instanceof Error ? err.message : String(err)}`);
    }
    await release(p.reservationId);
    return { ok: true, result: err instanceof DirectGagInputError ? "skipped" : "failed" };
  }
  await release(p.reservationId);
  // Recording the panel prepared and queueing its waiting cells is one
  // transaction: a restart between the two can neither strand a cell nor
  // queue it twice (each cell leaves "waiting" exactly once).
  await fencedTransaction(db, async (tx) => {
  await tx.update(comparisonPanelsTable).set({
    state: "prepared",
    compiledPrompt: assembled.compiled,
    referenceIdentityType: desc.referenceIdentityType ?? null,
    referenceAssetVersion: reference?.version ?? null,
    referenceImageUrl: reference?.url ?? null,
    styleSnapshot: { lookStyleId: panel.lookStyleId, stylePrompt: resolved.stylePrompt, styleSource: resolved.styleSource },
    renderControls: resolved.renderControls,
    ...frozenJudgingReference(resolved.renderedFactText, enrichment.data, resolved.renderedSubject),
    frozenBubbles: frozenBubblesOf(gag, resolved.renderedSubject),
    // The gag's stored cast, as it reached the prompt.
    gagCast: { cast: assembled.args.cast },
    // The gag, frozen once and shared: each cell compiles it with its own wording.
    compileArgs: { direct: assembled.args } satisfies PanelCompileArgs,
    error: null,
    updatedAt: new Date(),
  }).where(eq(comparisonPanelsTable.id, panel.id));
  for (const w of await waitingReservations(tx, panel.id)) await queueCell(tx, w.runId, w.cellId, w.reservationId);
  });
  return { ok: true, result: "prepared" };
}

/**
 * What a second-edition panel is judged against, frozen at preparation (plan
 * `docs/plans/PLAN_PROMPT_TUNER.md`, *Proposed Design* B): the fact's wording
 * and the gag the panel rendered (its scene, the render input's
 * `visualPromptStrategyOverride.coreSceneOverride`; the fact's primary gag),
 * both rendered for the panel's subject. A fact with no gag freezes null, and
 * the judging page says so.
 */
export function frozenJudgingReference(
  renderedFactText: string,
  enrichment: { visualPromptStrategyOverride?: { coreSceneOverride?: string | null } | null },
  subject: { name: string; pronouns: string },
): { frozenFactText: string; frozenGag: string | null } {
  const gag = enrichment.visualPromptStrategyOverride?.coreSceneOverride?.trim() ?? "";
  return {
    frozenFactText: renderedFactText,
    frozenGag: gag ? renderPersonalized(gag, subject.name, subject.pronouns) : null,
  };
}

/**
 * What preparation freezes on a panel so each cell can compile the same gag
 * with its own wording. A panel prepared before the planner was removed froze
 * a plan and, on a path set, also `direct`; only `direct` can still be drawn.
 */
interface PanelCompileArgs {
  direct?: Omit<DirectCompileArgs, "recipe">;
}

/** A named gag's content for a comparison: its approved version, else its pending change. Null when it has neither or belongs to another fact. */
async function namedGag(gagId: number, factId: number): Promise<GagContent | null> {
  const [row] = await db.select().from(factGagsTable).where(and(eq(factGagsTable.id, gagId), eq(factGagsTable.factId, factId)));
  return row ? normaliseGagContent(row.approvedContent ?? row.pendingContent) : null;
}

/** The gag's complete bubbles as the judge should expect them, rendered for the panel's subject. */
export function frozenBubblesOf(
  gag: Pick<GagContent, "bubbles"> | null,
  subject: { name: string; pronouns: string | null },
): Array<{ type: string; speaker: string; text: string }> | null {
  const bubbles = (gag?.bubbles ?? []).filter((b) => b.entity.trim() && b.text.trim());
  if (!bubbles.length) return null;
  return bubbles.map((b) => ({
    type: b.type,
    speaker: b.entity.trim().toLowerCase() === "subject" ? subject.name : b.entity.trim(),
    text: renderPersonalized(b.text.trim(), subject.name, subject.pronouns),
  }));
}

/**
 * The exact prompt a cell sends: the panel's frozen scene compiled with the
 * cell's prompt wording (the prompt tuner), or, for a panel prepared before
 * scenes were frozen, the panel's one compiled prompt. A path set's direct
 * cell compiles the panel's gag alone (plan PLAN_GAG_DIRECT_RENDER.md, A).
 */
export async function cellPromptText(panel: ComparisonPanel, cell: Pick<ComparisonCell, "recipeVersionId" | "engineId" | "renderPath">): Promise<string | null> {
  const args = panel.compileArgs as PanelCompileArgs | null;
  if (!args) return promptTextOf(panel.compiledPrompt);
  // A planned cell, or a panel that froze only a plan, was drawn through the
  // render planner, which is gone (plan PLAN_GAG_DIRECT_RENDER.md, D): it can
  // no longer be drawn, and drawing it directly would mislabel the result.
  if (cell.renderPath === "planned" || !args.direct) {
    throw new Error("this cell was prepared for the render planner, which has been removed; it can no longer be drawn");
  }
  const recipe = await recipeById(cell.recipeVersionId, engineFamilyOf(cell.engineId));
  return compileDirect({ ...args.direct, recipe }).prompt || null;
}

// ─── Rendering ────────────────────────────────────────────────────────────────

interface RenderPayload { runId: number; cellId: number; reservationId: number }

const objectStorage = new ObjectStorageService();

let storeImageOverride: ((cell: ComparisonCell, url: string) => Promise<string>) | null = null;
/** Test seam: replace the download-and-store step. */
export function __setComparisonImageStoreForTest(impl: ((cell: ComparisonCell, url: string) => Promise<string>) | null): void {
  storeImageOverride = impl;
}

/** The token blind judging serves this cell's picture under, so its judging link traces. */
async function cellBlindToken(cell: ComparisonCell): Promise<string | null> {
  const [panel] = await db.select({ shuffleSeed: comparisonPanelsTable.shuffleSeed }).from(comparisonPanelsTable)
    .where(eq(comparisonPanelsTable.id, cell.panelId)).limit(1);
  return panel ? blindToken(panel, cell.id) : null;
}

/** The admin who created the cell's set: the initiator when no request was captured. */
async function setCreatorActor(cell: ComparisonCell): Promise<ProvenanceActor> {
  const [row] = await db.select({ createdBy: comparisonSetsTable.createdBy })
    .from(comparisonPanelsTable)
    .innerJoin(comparisonSetsTable, eq(comparisonSetsTable.id, comparisonPanelsTable.setId))
    .where(eq(comparisonPanelsTable.id, cell.panelId)).limit(1);
  return row?.createdBy ? actorForUser(row.createdBy, "admin") : SYSTEM_ACTOR;
}

async function storeVendorImage(cell: ComparisonCell, url: string, vendorResult?: unknown): Promise<string> {
  if (storeImageOverride) return storeImageOverride(cell, url);
  const buffer = await downloadToBuffer(url);
  // Image tracing: the record is written from the request frozen at
  // submission (a storage-only retry included), and stamped with the opaque
  // id only — never the engine, so blind judging stays blind. The stamp is
  // spliced into the container; the judged pixels are unchanged.
  const request = await latestCellGenerationRequest(cell.id);
  const actor: ProvenanceActor = request ? actorOf(request) : await setCreatorActor(cell);
  const stamp = Date.now();
  const finished = await finishAndStore({
    store: objectStorage,
    subPathFor: (ext) => `comparison/panel-${cell.panelId}/cell-${cell.id}-${stamp}.${ext}`,
    bytes: buffer,
    kind: "comparison_cell",
    actor,
    stamp: true,
    stampEngine: null,
    generationRequestId: request?.id ?? null,
    comparisonCellId: cell.id,
    attemptId: cell.attemptId ?? null,
    factId: request?.factId ?? null,
    engineId: cell.engineId,
    // The panel's planning lineage is frozen in too (the panel row is deleted with its set or fact), with what the
    // vendor returned — absent on a storage-only retry, which has only the link — and a fingerprint of each
    // reference picture the request named (image tracing, completeness audit).
    snapshot: {
      panelId: cell.panelId,
      blindToken: await cellBlindToken(cell),
      requestCaptured: request != null,
      panel: await panelLineage(cell.panelId),
      ...(await vendorContext(request?.request ?? null, vendorResult)),
    },
  });
  return finished.objectPath;
}

/** A panel as its pictures' records keep it: what the prompt and reference were planned from. */
async function panelLineage(panelId: number): Promise<Record<string, unknown> | null> {
  const [panel] = await db.select().from(comparisonPanelsTable).where(eq(comparisonPanelsTable.id, panelId)).limit(1);
  if (!panel) return null;
  const { error: _error, state: _state, createdAt: _c, updatedAt: _u, ...lineage } = panel;
  return lineage;
}

async function failCell(cellId: number, error: string): Promise<void> {
  await fencedTransaction(db, (tx) => tx.update(comparisonCellsTable).set({ state: "failed", error, updatedAt: new Date() }).where(eq(comparisonCellsTable.id, cellId)));
}

/** Store a rendered cell's vendor image; a failure keeps the URL for a storage-only retry. */
async function storeCell(cell: ComparisonCell, url: string, vendorResult?: unknown): Promise<boolean> {
  try {
    const path = await storeVendorImage(cell, url, vendorResult);
    await fencedTransaction(db, (tx) => tx.update(comparisonCellsTable).set({ state: "rendered", imageObjectPath: path, error: null, updatedAt: new Date() }).where(eq(comparisonCellsTable.id, cell.id)));
    return true;
  } catch (err) {
    await failCell(cell.id, `storage failed (the image is kept at the vendor; retry storage, not the render): ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

export async function renderCell(p: RenderPayload): Promise<HandlerResult> {
  const [cell] = await db.select().from(comparisonCellsTable).where(eq(comparisonCellsTable.id, p.cellId));
  if (!cell || cell.state !== "enqueued") return { ok: true, result: "not in flight" };
  if (cell.requestSettings != null && !cell.falRequestId) {
    // The marker is set and no request id was stored: a restart may have
    // landed after fal accepted the submission. Never submit a second time.
    await failCell(cell.id, "interrupted during submission: fal may have accepted it, so it was not resubmitted");
    await finishRunIfDone(p.runId);
    return terminalFailure("comparison_dispatch_ambiguous", "submission outcome unknown");
  }
  try {
    return await renderCellInFlight(cell, p);
  } finally {
    await finishRunIfDone(p.runId);
  }
}

async function renderCellInFlight(cell: ComparisonCell, p: RenderPayload): Promise<HandlerResult> {
  const [panel] = await db.select().from(comparisonPanelsTable).where(eq(comparisonPanelsTable.id, cell.panelId));
  const engine = engineById(cell.engineId);
  const refusal = !panel || panel.state !== "prepared"
    ? "its panel is not prepared"
    : imageEngineRefusal(engine, panel.imageMode as GenerationMode);
  if (refusal) {
    await failCell(cell.id, `not rendered: ${refusal}`);
    await release(p.reservationId);
    return { ok: true, result: "refused before dispatch" };
  }
  const aspectRatio = (panel!.renderControls as { aspectRatio?: string } | null)?.aspectRatio;
  let promptText = "";
  let input: Record<string, unknown> = {};
  let requestSettings: ReturnType<typeof buildImageRequestSettings> | undefined;
  // A cell already submitted builds no request: it polls the one it made, so
  // it is never compiled again and no refusal here can release a reservation
  // a submission holds.
  if (!cell.falRequestId) {
    try {
      // Inside the refusal handling: a cell that can no longer be drawn (one
      // prepared for the retired render planner) fails here, its reservation
      // released, rather than throwing out of a job that runs once and leaving
      // the evaluation in flight.
      promptText = (await cellPromptText(panel!, cell)) ?? "";
      if (!promptText) throw new Error("the panel's compiled prompt has no text");
      if (panel!.imageMode === "i2i" && !panel!.referenceImageUrl) throw new Error("the panel has no reference image");
      // A set drawn at member size asks for a member's picture (David, 2026-11-11: accurate pricing).
      const [set] = await db.select({ imageSize: comparisonSetsTable.imageSize }).from(comparisonSetsTable).where(eq(comparisonSetsTable.id, panel!.setId));
      requestSettings = buildImageRequestSettings(engine!, set?.imageSize === "final" ? "final" : "comparison", aspectRatio);
      input = buildEngineInput(engine!, imageEngineParams(requestSettings, {
        generationMode: panel!.imageMode as GenerationMode,
        promptText,
        aspectRatio,
        referenceImageUrl: panel!.referenceImageUrl,
      }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await failCell(cell.id, `not rendered: ${msg}`);
      await release(p.reservationId);
      return terminalFailure("comparison_request_invalid", msg);
    }
  }

  // One submission. The request settings are the marker that one may have
  // been made, committed before it; the id is stored before polling.
  let requestId = cell.falRequestId;
  if (!requestId) {
    // The submission's clock starts here, with the marker (David, 2026-11-10: render time matters).
    await fencedTransaction(db, (tx) => tx.update(comparisonCellsTable).set({ requestSettings, promptText, submittedAt: new Date(), completedAt: null, updatedAt: new Date() }).where(eq(comparisonCellsTable.id, cell.id)));
    // Image tracing: the exact input and the admin who started the run,
    // persisted before the vendor is called; a recovery reads this row.
    const [run] = await db.select({ createdBy: comparisonRunsTable.createdBy }).from(comparisonRunsTable)
      .where(eq(comparisonRunsTable.id, p.runId)).limit(1);
    const generationRequestId = await recordGenerationRequest({
      producer: "comparison_cell",
      engineId: cell.engineId,
      endpointId: engine!.endpointId,
      request: input,
      actor: run?.createdBy ? await actorForUser(run.createdBy, "admin") : SYSTEM_ACTOR,
      comparisonCellId: cell.id,
      attemptId: cell.attemptId ?? null,
      factId: panel!.factId,
    });
    // The picture is paid: only while this run still owns its job (plan PLAN_JOB_RESUME.md §A, §G).
    await assertJobOwnership();
    try {
      requestId = await comparisonFal().submit(engine!.endpointId, input);
      await setVendorRequestId(generationRequestId, requestId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await failCell(cell.id, `submit failed: ${msg}`);
      return terminalFailure("comparison_submit_failed", msg);
    }
    const submitted = requestId;
    await fencedTransaction(db, async (tx) => {
      await tx.update(comparisonCellsTable).set({ falRequestId: submitted, updatedAt: new Date() }).where(eq(comparisonCellsTable.id, cell.id));
      await tx.update(comparisonReservationsTable).set({ falRequestId: submitted }).where(eq(comparisonReservationsTable.id, p.reservationId));
    });
  }
  let url: string | null;
  let vendorResult: unknown;
  try {
    vendorResult = await awaitResult(engine!.endpointId, requestId, CELL_POLL);
    url = extractFirstImageUrl(vendorResult) || null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // A model's content refusal arrives here, on the result read, as a 422
    // whose message is only the status text ("Unprocessable Entity"): name the
    // engine and fal's reason, as a member's render does (Issues #985, #1343).
    // The model's moderator is not deterministic, so the cell stays retryable.
    await failCell(cell.id, falContentRefusal(err) ? falSubmitErrorMessage(err, engine!.label) : `render failed: ${msg}`);
    return terminalFailure("comparison_render_failed", msg);
  }
  const completedAt = new Date();
  await settleAtBound(p.reservationId);
  await fencedTransaction(db, (tx) => tx.update(comparisonCellsTable).set({ completedAt, updatedAt: completedAt }).where(eq(comparisonCellsTable.id, cell.id)));
  if (!url) {
    await failCell(cell.id, "render failed: the response carried no image URL");
    return terminalFailure("comparison_render_failed", "no image url");
  }
  await fencedTransaction(db, (tx) => tx.update(comparisonCellsTable).set({ vendorResultUrl: url, updatedAt: new Date() }).where(eq(comparisonCellsTable.id, cell.id)));
  await storeCell({ ...cell, vendorResultUrl: url }, url, vendorResult);
  return { ok: true, result: "rendered" };
}

// ─── Recovery ─────────────────────────────────────────────────────────────────

export class ComparisonCellActionRefused extends Error {}

/** Store a failed cell's vendor image again. Spends nothing. */
export async function retryCellStorage(cellId: number): Promise<ComparisonCell> {
  const [cell] = await db.select().from(comparisonCellsTable).where(eq(comparisonCellsTable.id, cellId));
  if (!cell) throw new ComparisonCellActionRefused("no such cell");
  if (cell.state !== "failed" || !cell.vendorResultUrl || cell.imageObjectPath) {
    throw new ComparisonCellActionRefused("only a failed cell whose image is still at the vendor can retry its storage");
  }
  await storeCell(cell, cell.vendorResultUrl);
  const [after] = await db.select().from(comparisonCellsTable).where(eq(comparisonCellsTable.id, cellId));
  return after!;
}

/** The one re-run a failed cell is allowed: back to expected, so the next render run admits it. */
export async function rerunCell(cellId: number): Promise<ComparisonCell> {
  const [cell] = await db.select().from(comparisonCellsTable).where(eq(comparisonCellsTable.id, cellId));
  if (!cell) throw new ComparisonCellActionRefused("no such cell");
  if (cell.state !== "failed") throw new ComparisonCellActionRefused("only a failed cell can be re-run");
  if (cell.vendorResultUrl) throw new ComparisonCellActionRefused("this cell's image exists at the vendor; retry its storage instead");
  if (cell.rerunCount >= 1) throw new ComparisonCellActionRefused("this cell has had its one re-run");
  const [after] = await db.update(comparisonCellsTable)
    .set({ state: "expected", rerunCount: cell.rerunCount + 1, error: null, falRequestId: null, requestSettings: null, submittedAt: null, completedAt: null, billedUsd: null, updatedAt: new Date() })
    .where(and(eq(comparisonCellsTable.id, cellId), eq(comparisonCellsTable.state, "failed"), isNull(comparisonCellsTable.vendorResultUrl)))
    .returning();
  if (!after) throw new ComparisonCellActionRefused("the cell changed while re-running it");
  return after;
}

/** A failed panel back to pending, so the next preparation run admits it again. */
export async function reprepareFailedPanel(panelId: number): Promise<ComparisonPanel> {
  const [panel] = await db.select().from(comparisonPanelsTable).where(eq(comparisonPanelsTable.id, panelId));
  if (!panel) throw new ComparisonCellActionRefused("no such panel");
  if (panel.state !== "failed") throw new ComparisonCellActionRefused("only a failed panel can be prepared again");
  const [after] = await db.update(comparisonPanelsTable)
    .set({ state: "pending", error: null, updatedAt: new Date() })
    .where(and(eq(comparisonPanelsTable.id, panelId), eq(comparisonPanelsTable.state, "failed")))
    .returning();
  if (!after) throw new ComparisonCellActionRefused("the panel changed while preparing it again");
  return after;
}

export function registerComparisonHandlers(): void {
  // The bulk lane, not render: a cell waits on fal for its whole generation,
  // and a comparison run must never hold up moderation and member renders.
  // Execution limit (Issue #1000): two 180 s planner calls and one 30 s cast call with no retries (6.5 min), plus margin.
  registerJobHandler(COMPARISON_PREPARE_QUEUE, { run: (payload) => preparePanel(payload as PreparePayload) }, { lane: "bulk", executionLimitMs: 15 * 60_000, ...RESUMES_FROM_CHECKPOINTS });
  // Execution limit (Issue #1000): its 10-minute polling allowance, status-call backoff and storing (about 21 min), plus margin.
  registerJobHandler(COMPARISON_RENDER_QUEUE, { run: (payload) => renderCell(payload as RenderPayload) }, { lane: "bulk", executionLimitMs: 30 * 60_000, ...RESUMES_FROM_CHECKPOINTS });
}

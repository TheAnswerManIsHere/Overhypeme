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
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  comparisonCellsTable,
  comparisonPanelsTable,
  comparisonReservationsTable,
  comparisonRunsTable,
  enginesTable,
  factsTable,
  type ComparisonCell,
  type ComparisonPanel,
  type ComparisonRun,
  type Engine,
} from "@workspace/db/schema";
import {
  RENDER_SCENARIO_DESCRIPTORS,
  validateEnrichment,
  type ComparisonRunPlanRequest,
  type GenerationMode,
  type ReferenceIdentityType,
  type RenderScenarioKey,
} from "@workspace/api-zod";
import { enqueueJob, registerJobHandler, terminalFailure, type HandlerResult } from "../asyncJobs";
import { defaultScenarioRenderControls, syntheticAnalysisForReference } from "../reviewRenderScenarios";
import { ReferenceAssetUnavailableError, resolveDefaultReferenceUrl } from "../defaultReferenceResolver";
import { resolveRenderReviewInput } from "../imagePrompt/resolveRenderReviewInput";
import { assembleImagePromptForPreview } from "../imagePrompt/preview";
import { withoutLlmRetries } from "../utilityLLM";
import type { IdentityPolicy } from "@workspace/api-zod";
import { imageEngineRefusal } from "../imageEngineRouting";
import { buildImageRequestSettings } from "../imageRequestBuilder";
import { buildEngineInput } from "../engineInterpreter";
import { downloadToBuffer, extractFirstImageUrl, imageEngineParams } from "../imageEngineRequest";
import { ObjectStorageService } from "../objectStorage";
import { logger } from "../logger";
import { planRun, type RunPlan, type WorkItem } from "./admission";
import { loadSetRows, runItems } from "./sets";
import { awaitResult, comparisonFal } from "./transport";

export const COMPARISON_PREPARE_QUEUE = "comparison_prepare";
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
): Promise<{ run: ComparisonRun; plan: RunPlan } | null> {
  const ci = paidDispatchRefusal();
  if (ci) throw new ComparisonRunRefused(ci, null, null);

  const outcome = await db.transaction(async (tx) => {
    await tx.execute(ADMISSION_LOCK);
    const rows = await loadSetRows(setId, tx);
    if (!rows) return null;
    const plan = planRun(await runItems(req.kind, rows));
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
  await tx.update(comparisonCellsTable).set({ state: "enqueued", error: null, updatedAt: new Date() }).where(eq(comparisonCellsTable.id, id));
  await enqueueJob({ queue: COMPARISON_RENDER_QUEUE, payload: { runId: run.id, cellId: id, reservationId: reservation!.id }, dedupeKey: `comparison:render:${run.id}:${id}`, maxAttempts: 1 }, tx);
}

// ─── Settlement ───────────────────────────────────────────────────────────────

/** The call never reached a vendor: its bound is free again. */
async function release(reservationId: number): Promise<void> {
  await db.update(comparisonReservationsTable).set({ state: "released", settledAt: new Date() }).where(eq(comparisonReservationsTable.id, reservationId));
}

/**
 * A call completed: it is recorded at its bound, the most it could have cost.
 * No bill is read (David's override, 2026-11-07); fal's dashboard is the
 * record of what was actually billed.
 */
async function settleAtBound(reservationId: number): Promise<void> {
  await db.update(comparisonReservationsTable)
    .set({ state: "settled", settledUsd: sql`${comparisonReservationsTable.boundUsd}`, settledAt: new Date() })
    .where(and(eq(comparisonReservationsTable.id, reservationId), eq(comparisonReservationsTable.state, "reserved")));
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
      sql`(${comparisonPanelsTable.state} in ('preparing', 'planning') or ${comparisonCellsTable.state} = 'enqueued')`,
    ));
  if ((row?.inFlight ?? 0) === 0) {
    await db.update(comparisonRunsTable).set({ state: "done", endedAt: new Date() }).where(and(eq(comparisonRunsTable.id, runId), eq(comparisonRunsTable.state, "running")));
  }
}

// ─── Preparation ──────────────────────────────────────────────────────────────

interface PreparePayload { runId: number; panelId: number; reservationId: number }

async function failPanel(panelId: number, state: "failed" | "skipped", reason: string): Promise<void> {
  await db.update(comparisonPanelsTable)
    .set(state === "skipped" ? { state, skipReason: reason, updatedAt: new Date() } : { state, error: reason, updatedAt: new Date() })
    .where(eq(comparisonPanelsTable.id, panelId));
}

/**
 * Prepare one panel through the same planner-and-compiler path the Runtime
 * Compiled Prompt preview uses, and freeze its output for every cell.
 */
export async function preparePanel(p: PreparePayload): Promise<HandlerResult> {
  const [panel] = await db.select().from(comparisonPanelsTable).where(eq(comparisonPanelsTable.id, p.panelId));
  if (panel?.state === "planning") {
    // A restart after the planner call began: it may have been billed, so no second call.
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
  // Everything before the planner call can refuse for free.
  const [fact] = await db.select({ text: factsTable.text, enrichment: factsTable.enrichment }).from(factsTable).where(eq(factsTable.id, panel.factId));
  const enrichment = fact ? validateEnrichment(fact.enrichment) : null;
  if (!fact || !enrichment?.ok) {
    await failPanel(panel.id, "skipped", fact ? "the fact's enrichment does not validate" : "the fact no longer exists");
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
      lookStyleId,
      renderControls: defaultScenarioRenderControls(panel.scenarioKey as RenderScenarioKey),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await failPanel(panel.id, "failed", `input assembly failed: ${msg}`);
    await release(p.reservationId);
    return terminalFailure("comparison_input_failed", msg);
  }

  // The paid call: from here a failure keeps the reservation. The marker is
  // committed first, so a restart mid-call never calls again.
  const [marked] = await db.update(comparisonPanelsTable).set({ state: "planning", updatedAt: new Date() })
    .where(and(eq(comparisonPanelsTable.id, panel.id), eq(comparisonPanelsTable.state, "preparing")))
    .returning({ id: comparisonPanelsTable.id });
  if (!marked) return { ok: true, result: "not in flight" };
  let assembled;
  try {
    // One submission per permitted call: the SDK's own retries are off.
    assembled = await withoutLlmRetries(() => assembleImagePromptForPreview({
      renderedFactText: resolved.renderedFactText,
      enrichment: enrichment.data,
      sourceImageAnalysis: resolved.analysis,
      subjectRenderMode: resolved.subjectRenderMode,
      userSelectedSubjectRenderMode: resolved.userSelectedSubjectRenderMode,
      identityPolicy: resolved.identityPolicy as IdentityPolicy,
      renderControls: resolved.renderControls,
      stylePrompt: resolved.stylePrompt,
      referenceImageUrl: reference?.url ?? null,
      renderedSubject: resolved.renderedSubject,
      requestId: `comparison:${p.runId}:panel:${panel.id}:${randomUUID()}`,
    }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await failPanel(panel.id, "failed", `planner failed: ${msg}`);
    return terminalFailure("comparison_planner_failed", msg);
  }
  await settleAtBound(p.reservationId);
  const provenance = assembled.output.plannerProvenance;
  if (provenance?.fallbackReason) {
    // The planner fell back to another model: this is not the experiment the set describes.
    await failPanel(panel.id, "failed", `the planner fell back (${provenance.fallbackReason}) to ${provenance.model ?? "another model"}`);
    return { ok: true, result: "planner fell back" };
  }
  await db.update(comparisonPanelsTable).set({
    state: "prepared",
    visualPlan: assembled.output.visualPlan,
    compiledPrompt: assembled.compiled,
    referenceIdentityType: desc.referenceIdentityType ?? null,
    referenceAssetVersion: reference?.version ?? null,
    referenceImageUrl: reference?.url ?? null,
    styleSnapshot: { lookStyleId: panel.lookStyleId, stylePrompt: resolved.stylePrompt, styleSource: resolved.styleSource },
    renderControls: resolved.renderControls,
    error: null,
    updatedAt: new Date(),
  }).where(eq(comparisonPanelsTable.id, panel.id));
  return { ok: true, result: "prepared" };
}

// ─── Rendering ────────────────────────────────────────────────────────────────

interface RenderPayload { runId: number; cellId: number; reservationId: number }

const objectStorage = new ObjectStorageService();

let storeImageOverride: ((cell: ComparisonCell, url: string) => Promise<string>) | null = null;
/** Test seam: replace the download-and-store step. */
export function __setComparisonImageStoreForTest(impl: ((cell: ComparisonCell, url: string) => Promise<string>) | null): void {
  storeImageOverride = impl;
}

async function storeVendorImage(cell: ComparisonCell, url: string): Promise<string> {
  if (storeImageOverride) return storeImageOverride(cell, url);
  const buffer = await downloadToBuffer(url);
  return objectStorage.uploadObjectBuffer({ subPath: `comparison/panel-${cell.panelId}/cell-${cell.id}-${Date.now()}.png`, buffer, contentType: "image/png" });
}

async function failCell(cellId: number, error: string): Promise<void> {
  await db.update(comparisonCellsTable).set({ state: "failed", error, updatedAt: new Date() }).where(eq(comparisonCellsTable.id, cellId));
}

/** Store a rendered cell's vendor image; a failure keeps the URL for a storage-only retry. */
async function storeCell(cell: ComparisonCell, url: string): Promise<boolean> {
  try {
    const path = await storeVendorImage(cell, url);
    await db.update(comparisonCellsTable).set({ state: "rendered", imageObjectPath: path, error: null, updatedAt: new Date() }).where(eq(comparisonCellsTable.id, cell.id));
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
  const [engine] = await db.select().from(enginesTable).where(eq(enginesTable.id, cell.engineId));
  const refusal = !panel || panel.state !== "prepared"
    ? "its panel is not prepared"
    : imageEngineRefusal((engine ?? null) as Engine | null, panel.imageMode as GenerationMode);
  if (refusal) {
    await failCell(cell.id, `not rendered: ${refusal}`);
    await release(p.reservationId);
    return { ok: true, result: "refused before dispatch" };
  }
  const compiled = panel!.compiledPrompt as { imagePrompt?: string; prompt?: string } | null;
  const promptText = compiled?.imagePrompt ?? compiled?.prompt;
  const aspectRatio = (panel!.renderControls as { aspectRatio?: string } | null)?.aspectRatio;
  let input: Record<string, unknown>;
  let requestSettings;
  try {
    if (!promptText) throw new Error("the panel's compiled prompt has no text");
    if (panel!.imageMode === "i2i" && !panel!.referenceImageUrl) throw new Error("the panel has no reference image");
    requestSettings = buildImageRequestSettings(engine!, "comparison", aspectRatio);
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

  // One submission. The request settings are the marker that one may have
  // been made, committed before it; the id is stored before polling.
  let requestId = cell.falRequestId;
  if (!requestId) {
    // The submission's clock starts here, with the marker (David, 2026-11-10: render time matters).
    await db.update(comparisonCellsTable).set({ requestSettings, submittedAt: new Date(), completedAt: null, updatedAt: new Date() }).where(eq(comparisonCellsTable.id, cell.id));
    try {
      requestId = await comparisonFal().submit(engine!.endpointId, input);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await failCell(cell.id, `submit failed: ${msg}`);
      return terminalFailure("comparison_submit_failed", msg);
    }
    const submitted = requestId;
    await db.transaction(async (tx) => {
      await tx.update(comparisonCellsTable).set({ falRequestId: submitted, updatedAt: new Date() }).where(eq(comparisonCellsTable.id, cell.id));
      await tx.update(comparisonReservationsTable).set({ falRequestId: submitted }).where(eq(comparisonReservationsTable.id, p.reservationId));
    });
  }
  let url: string | null;
  try {
    url = extractFirstImageUrl(await awaitResult(engine!.endpointId, requestId, CELL_POLL)) || null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await failCell(cell.id, `render failed: ${msg}`);
    return terminalFailure("comparison_render_failed", msg);
  }
  const completedAt = new Date();
  await settleAtBound(p.reservationId);
  await db.update(comparisonCellsTable).set({ completedAt, updatedAt: completedAt }).where(eq(comparisonCellsTable.id, cell.id));
  if (!url) {
    await failCell(cell.id, "render failed: the response carried no image URL");
    return terminalFailure("comparison_render_failed", "no image url");
  }
  await db.update(comparisonCellsTable).set({ vendorResultUrl: url, updatedAt: new Date() }).where(eq(comparisonCellsTable.id, cell.id));
  await storeCell({ ...cell, vendorResultUrl: url }, url);
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
    .set({ state: "expected", rerunCount: cell.rerunCount + 1, error: null, falRequestId: null, requestSettings: null, submittedAt: null, completedAt: null, updatedAt: new Date() })
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
  registerJobHandler(COMPARISON_PREPARE_QUEUE, { run: (payload) => preparePanel(payload as PreparePayload) }, { lane: "bulk" });
  registerJobHandler(COMPARISON_RENDER_QUEUE, { run: (payload) => renderCell(payload as RenderPayload) }, { lane: "bulk" });
}

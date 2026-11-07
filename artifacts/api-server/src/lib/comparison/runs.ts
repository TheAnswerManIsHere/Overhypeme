/**
 * The engine comparison's runs: admission, preparation, rendering and
 * settlement (launch Phase 8, increment 2b; plan
 * `docs/plans/PLAN_PHASE8_ENGINE_EVALUATION.md`, *Settled Decisions*, "Spend
 * is bounded before dispatch, by reservation", and *Proposed Design* C and D).
 *
 * - **Admission** runs under one advisory lock, so two starts can never both
 *   count the same headroom: it re-reads the set and every unresolved
 *   reservation, plans the run, and either records the refusal with its figure
 *   or writes one reservation row per permitted call and enqueues the work in
 *   the same transaction. Paid dispatch never runs in CI.
 * - **Each call is one priced call.** Both queues run at one attempt; a cell
 *   submits once through the comparison transport and stores fal's request id
 *   before it polls, so nothing resubmits.
 * - **Settlement.** A call that never reached a vendor releases its
 *   reservation. A call that completed settles: at its flat price when the
 *   engine bills flat, otherwise with the billed amount marked unknown (the
 *   paid-run ledger records the bound). A call that failed after submission
 *   stays reserved, because it may have been billed.
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
  PAID_RUN_ALLOWANCE_USD,
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
import type { IdentityPolicy } from "@workspace/api-zod";
import { imageEngineRefusal } from "../imageEngineRouting";
import { buildImageRequestSettings } from "../imageRequestBuilder";
import { buildEngineInput } from "../engineInterpreter";
import { downloadToBuffer, extractFirstImageUrl, imageEngineParams } from "../imageEngineRequest";
import { ObjectStorageService } from "../objectStorage";
import { logger } from "../logger";
import type { PriceModel } from "../engines";
import { planRun, type RunPlan, type WorkItem } from "./admission";
import { loadSetRows, runItems, unresolvedReservedUsd } from "./sets";
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
 * Admit and start the next run of `kind` for a set. Throws
 * `ComparisonRunRefused` (with the refused run row, when one was recorded)
 * rather than spending anything it cannot bound.
 */
export async function startComparisonRun(
  setId: number,
  req: ComparisonRunPlanRequest,
  adminUserId: string | null,
): Promise<{ run: ComparisonRun; plan: RunPlan } | null> {
  const ci = paidDispatchRefusal();
  if (ci) throw new ComparisonRunRefused(ci, null, null);
  const allowanceUsd = req.allowanceUsd ?? PAID_RUN_ALLOWANCE_USD;

  const outcome = await db.transaction(async (tx) => {
    await tx.execute(ADMISSION_LOCK);
    const rows = await loadSetRows(setId, tx);
    if (!rows) return null;
    const items = await runItems(req.kind, rows);
    const plan = planRun(items, { allowanceUsd, weekRemainingUsd: req.weekRemainingUsd, unresolvedReservedUsd: await unresolvedReservedUsd(tx) });
    const base = {
      setId, kind: req.kind, allowanceUsd: String(allowanceUsd), weekRemainingUsd: String(req.weekRemainingUsd), createdBy: adminUserId,
    };
    if (!plan.admitted) {
      const [run] = await tx.insert(comparisonRunsTable).values({ ...base, state: "refused", boundUsd: String(plan.boundUsd), refusal: plan.refusal, endedAt: new Date() }).returning();
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

/** The call completed: `billedUsd` when the price is known, else null (the ledger records the bound). */
async function settle(reservationId: number, billedUsd: number | null): Promise<void> {
  await db.update(comparisonReservationsTable)
    .set({ state: "settled", settledUsd: billedUsd == null ? null : String(billedUsd), settledAt: new Date() })
    .where(eq(comparisonReservationsTable.id, reservationId));
}

/** A flat-priced engine's bill is its price; a token-billed one is not known until fal reports it. */
function knownBilledUsd(priceModel: unknown): number | null {
  const m = priceModel as PriceModel | null;
  return m && m.kind === "flat" ? m.usdPerImage : null;
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
      sql`(${comparisonPanelsTable.state} = 'preparing' or ${comparisonCellsTable.state} = 'enqueued')`,
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

  // The paid call: from here a failure keeps the reservation.
  let assembled;
  try {
    assembled = await assembleImagePromptForPreview({
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
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await failPanel(panel.id, "failed", `planner failed: ${msg}`);
    return terminalFailure("comparison_planner_failed", msg);
  }
  await settle(p.reservationId, null);
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

  // One submission. Its id is stored before polling, so nothing submits twice.
  let requestId = cell.falRequestId;
  if (!requestId) {
    try {
      requestId = await comparisonFal().submit(engine!.endpointId, input);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await failCell(cell.id, `submit failed: ${msg}`);
      return terminalFailure("comparison_submit_failed", msg);
    }
    await db.update(comparisonCellsTable).set({ falRequestId: requestId, requestSettings, updatedAt: new Date() }).where(eq(comparisonCellsTable.id, cell.id));
  }
  let url: string | null;
  try {
    url = extractFirstImageUrl(await awaitResult(engine!.endpointId, requestId, CELL_POLL)) || null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await failCell(cell.id, `render failed: ${msg}`);
    return terminalFailure("comparison_render_failed", msg);
  }
  await settle(p.reservationId, knownBilledUsd(engine!.priceModel));
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
    .set({ state: "expected", rerunCount: cell.rerunCount + 1, error: null, falRequestId: null, requestSettings: null, updatedAt: new Date() })
    .where(and(eq(comparisonCellsTable.id, cellId), eq(comparisonCellsTable.state, "failed"), isNull(comparisonCellsTable.vendorResultUrl)))
    .returning();
  if (!after) throw new ComparisonCellActionRefused("the cell changed while re-running it");
  return after;
}

export function registerComparisonHandlers(): void {
  // The bulk lane, not render: a cell waits on fal for its whole generation,
  // and a comparison run must never hold up moderation and member renders.
  registerJobHandler(COMPARISON_PREPARE_QUEUE, { run: (payload) => preparePanel(payload as PreparePayload) }, { lane: "bulk" });
  registerJobHandler(COMPARISON_RENDER_QUEUE, { run: (payload) => renderCell(payload as RenderPayload) }, { lane: "bulk" });
}

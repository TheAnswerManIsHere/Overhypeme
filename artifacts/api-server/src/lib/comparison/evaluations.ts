/**
 * @purpose The Eval page's evaluations: the eligible-fact search, the read-only estimate, Generate Images (create and start one evaluation, idempotently), the evaluations list with statuses derived from panels, cells and judgements, and Finish.
 * @subsystem visual-pipeline
 *
 * Plan `docs/plans/PLAN_EVAL_PAGE.md` (approved by David 2026-11-13). An
 * evaluation is a comparison set made by the wizard: kind engine or prompt,
 * drawn at comparison size, its label the admin's description. Generate
 * Images creates the set and starts one "full" run (`runs.ts`): every scene
 * prepared and every picture queued the moment its scene is ready, admitted
 * once. Statuses are derived on read; nothing counts progress in storage.
 */

import { db } from "@workspace/db";
import {
  comparisonCellsTable,
  comparisonPanelsTable,
  comparisonPicksTable,
  comparisonSetsTable,
  enginesTable,
  factsTable,
  lookStylesTable,
  type ComparisonCell,
  type ComparisonPanel,
} from "@workspace/db/schema";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  EVALUATION_IMAGE_WARNING,
  validateEnrichment,
  type EvaluationCreate,
  type EvaluationSelection,
  type EvaluationStatus,
} from "@workspace/api-zod";
import { ComparisonLayoutError, deriveComparisonLayout } from "./layout";
import { cellBoundUsd, panelPreparationBoundUsd, panelPreparationTypicalUsd, round4 } from "./admission";
import { createComparisonSet, groupCellsByPanel, planComparisonRun, plannerSettings, type RunScope } from "./sets";
import { ComparisonRunRefused, startComparisonRun } from "./runs";
import { cellLost, isJudgeable, panelWait } from "./judging";
import { effectiveEngines } from "../engineInterpreter";

// ─── Eligible facts ───────────────────────────────────────────────────────────

/**
 * Whether a fact can be evaluated: active (the database already requires an
 * active fact to carry a Visual Concept, `facts_active_requires_concept`) and
 * its active enrichment passes validation. A pending refresh candidate does
 * not matter: preparation reads the active enrichment.
 */
function eligible(row: { isActive: boolean; enrichment: unknown }): boolean {
  return row.isActive && validateEnrichment(row.enrichment).ok;
}

export interface EligibleFact { id: number; text: string }

/**
 * Eligible facts whose text contains every word of `q`, newest first, and
 * how many facts are eligible in all (so a surprisingly small pool shows).
 */
export async function searchEligibleFacts(q: string, limit = 25): Promise<{ facts: EligibleFact[]; eligibleTotal: number }> {
  // One read of the active facts serves both the matches and the pool's size.
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
  const rows = await db.select({ id: factsTable.id, text: factsTable.text, isActive: factsTable.isActive, enrichment: factsTable.enrichment })
    .from(factsTable).where(eq(factsTable.isActive, true)).orderBy(desc(factsTable.id));
  const pool = rows.filter(eligible);
  const matching = pool.filter((r) => { const t = r.text.toLowerCase(); return words.every((w) => t.includes(w)); });
  return { facts: matching.slice(0, limit).map((r) => ({ id: r.id, text: r.text })), eligibleTotal: pool.length };
}

/** The named facts that are not eligible, in the order named. */
async function ineligibleFacts(factIds: number[]): Promise<number[]> {
  const rows = await db.select({ id: factsTable.id, isActive: factsTable.isActive, enrichment: factsTable.enrichment }).from(factsTable).where(inArray(factsTable.id, factIds));
  const ok = new Set(rows.filter(eligible).map((r) => r.id));
  return factIds.filter((id) => !ok.has(id));
}

// ─── Estimate ─────────────────────────────────────────────────────────────────

export interface EvaluationEstimate {
  panels: number;
  images: number;
  /** Null when the planner cannot be priced; `refusal` says why. */
  preparationBoundUsd: number | null;
  renderBoundUsd: number;
  totalBoundUsd: number | null;
  /**
   * What it usually costs: scenes at the recorded planner token counts,
   * pictures at the average fal actually billed for each engine (its bound
   * where nothing is billed yet). Null when the planner cannot be priced.
   */
  typicalUsd: number | null;
  warning: boolean;
  refusal: string | null;
}

/** The average fal billed per picture for each engine, over its last 50 billed comparison pictures. */
async function typicalPictureUsd(engineIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!engineIds.length) return out;
  const rows = await db.execute<{ engine_id: string; avg: string }>(sql`
    select engine_id, avg(billed_usd)::text as avg from (
      select engine_id, billed_usd, row_number() over (partition by engine_id order by id desc) as n
      from comparison_cells
      where billed_usd is not null and state = 'rendered' and engine_id in (${sql.join(engineIds.map((id) => sql`${id}`), sql`, `)})
    ) recent where n <= 50 group by engine_id`);
  for (const r of rows.rows) out.set(r.engine_id, Number(r.avg));
  return out;
}

/**
 * The most each paid action could cost, so a retry or Resume shows its
 * amount before it is pressed (PR #931's build report). Built once per read.
 */
export interface ActionPricing {
  /** One scene's preparation at its bound; null when the planner cannot be priced. */
  prepUsd: number | null;
  cellUsd: (engineId: string) => number | null;
}

export async function actionPricing(): Promise<ActionPricing> {
  const engines = await db.select({ id: enginesTable.id, priceModel: enginesTable.priceModel }).from(enginesTable);
  const price = new Map(engines.map((e) => [e.id, e.priceModel]));
  let prepUsd: number | null = null;
  try {
    prepUsd = panelPreparationBoundUsd(await plannerSettings());
  } catch {
    prepUsd = null;
  }
  return {
    prepUsd,
    cellUsd: (id) => {
      try { return cellBoundUsd(price.get(id)); } catch { return null; }
    },
  };
}

/**
 * What a selection would draw and the most it could cost, from the same
 * layout and per-call bounds a run admits with; nothing is saved.
 */
export async function estimateEvaluation(sel: EvaluationSelection): Promise<EvaluationEstimate> {
  // The effective definitions: family and mode come from code (decisions.md 2026-11-14).
  const engines = effectiveEngines(await db.select().from(enginesTable)).filter((e) => e.kind === "image");
  const layout = deriveComparisonLayout({ factIds: sel.factIds, scenarioKeys: sel.scenarioKeys, lookStyleIds: sel.lookStyleIds, engineFamilies: sel.engineFamilies }, engines);
  const price = new Map(engines.map((e) => [e.id, e.priceModel]));
  const perCell = sel.kind === "prompt" ? (sel.recipeVersionIds?.length ?? 0) : 1;
  const renderBoundUsd = round4(layout.reduce((s, p) => s + p.engineIds.reduce((t, id) => t + cellBoundUsd(price.get(id)) * perCell, 0), 0));
  const images = layout.reduce((s, p) => s + p.engineIds.length * perCell, 0);
  let preparationBoundUsd: number | null = null;
  let preparationTypicalUsd: number | null = null;
  let refusal: string | null = null;
  try {
    const settings = await plannerSettings();
    preparationBoundUsd = round4(layout.length * panelPreparationBoundUsd(settings));
    preparationTypicalUsd = layout.length * panelPreparationTypicalUsd(settings);
  } catch (err) {
    if (!(err instanceof ComparisonLayoutError)) throw err;
    refusal = err.reasons.join("; ");
  }
  const billed = await typicalPictureUsd([...new Set(layout.flatMap((p) => p.engineIds))]);
  const renderTypicalUsd = layout.reduce((s, p) => s + p.engineIds.reduce((t, id) => t + (billed.get(id) ?? cellBoundUsd(price.get(id))) * perCell, 0), 0);
  return {
    panels: layout.length,
    images,
    preparationBoundUsd,
    renderBoundUsd,
    totalBoundUsd: preparationBoundUsd == null ? null : round4(preparationBoundUsd + renderBoundUsd),
    typicalUsd: preparationTypicalUsd == null ? null : round4(preparationTypicalUsd + renderTypicalUsd),
    warning: images > EVALUATION_IMAGE_WARNING,
    refusal,
  };
}

// ─── Generate Images ──────────────────────────────────────────────────────────

export class EvaluationRefused extends Error {
  constructor(readonly refusal: string, readonly reasons: string[] = []) {
    super(refusal);
    this.name = "EvaluationRefused";
  }
}

async function setByToken(token: string): Promise<number | null> {
  const [row] = await db.select({ id: comparisonSetsTable.id }).from(comparisonSetsTable).where(eq(comparisonSetsTable.requestToken, token));
  return row?.id ?? null;
}

/**
 * Start the set's outstanding work in one run, when there is any. Work another
 * request has just admitted counts as started: the admission lock decides who
 * admits each item, and the loser's "nothing left to do" is success here.
 */
async function startOutstanding(setId: number, adminUserId: string | null): Promise<boolean> {
  const plan = await planComparisonRun(setId, { kind: "full" });
  if (!plan?.admitted) return false;
  try {
    await startComparisonRun(setId, { kind: "full" }, adminUserId);
    return true;
  } catch (err) {
    if (err instanceof ComparisonRunRefused && err.refusal === "nothing left to do") return false;
    throw err;
  }
}

/** The unique violation of the request-token index, wherever the driver put it in the cause chain. */
function isRequestTokenConflict(err: unknown): boolean {
  let e: unknown = err;
  for (let depth = 0; e != null && depth < 5; depth++) {
    const o = e as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (o.code === "23505" && o.constraint === "UQ_comparison_sets_request_token") return true;
    e = o.cause;
  }
  return false;
}

/**
 * Create and start one evaluation. A repeated request with the same token
 * returns the evaluation it already made, starting anything that request left
 * unstarted, and never creates a second.
 */
export async function createEvaluation(req: EvaluationCreate, adminUserId: string | null): Promise<{ setId: number; created: boolean }> {
  const existing = await setByToken(req.requestToken);
  if (existing != null) {
    await startOutstanding(existing, adminUserId);
    return { setId: existing, created: false };
  }
  const sel = req.selection;
  const styles = sel.lookStyleIds.filter((s) => s !== "none");
  const [ineligible, activeStyles] = await Promise.all([
    ineligibleFacts(sel.factIds),
    styles.length ? db.select({ id: lookStylesTable.id }).from(lookStylesTable).where(and(inArray(lookStylesTable.id, styles), eq(lookStylesTable.isActive, true))) : Promise.resolve([]),
  ]);
  if (ineligible.length) throw new EvaluationRefused("some facts can no longer be evaluated", ineligible.map((id) => `fact ${id} is not active with a valid enrichment`));
  const active = new Set(activeStyles.map((r) => r.id));
  const missing = styles.filter((s) => !active.has(s));
  if (missing.length) throw new EvaluationRefused("some looks are not active", missing.map((s) => `look "${s}"`));
  let setId: number;
  try {
    ({ setId } = await createComparisonSet({
      label: req.description,
      round: 1,
      factIds: sel.factIds,
      scenarioKeys: [...sel.scenarioKeys],
      lookStyleIds: sel.lookStyleIds,
      engineFamilies: [...sel.engineFamilies],
      imageSize: "comparison",
      kind: sel.kind,
      ...(sel.kind === "prompt" ? { recipeVersionIds: sel.recipeVersionIds } : {}),
    }, adminUserId, { requestToken: req.requestToken }));
  } catch (err) {
    // Two requests with one token racing: the loser reads the winner's set
    // and makes sure its work is started, as a repeated request does.
    if (isRequestTokenConflict(err)) {
      const raced = await setByToken(req.requestToken);
      if (raced != null) {
        await startOutstanding(raced, adminUserId);
        return { setId: raced, created: false };
      }
    }
    if (err instanceof ComparisonLayoutError) throw new EvaluationRefused("the selection cannot be drawn", err.reasons);
    throw err;
  }
  await startOutstanding(setId, adminUserId);
  return { setId, created: true };
}

// ─── Status ───────────────────────────────────────────────────────────────────

export interface EvaluationProgress {
  status: EvaluationStatus;
  images: number;
  drawn: number;
  inFlight: number;
  failed: number;
  lost: number;
  skippedPanels: number;
  judgeablePanels: number;
  judgedPanels: number;
  /** Each failure with the one retry that moves it on, and whether that retry can cost another call. */
  needsAction: NeedsAction[];
}

export interface NeedsAction {
  panelId: number;
  cellId: number | null;
  /** "resume": scenes or pictures that were never started (or whose start was interrupted); one action starts them all. */
  action: "retry_scene" | "retry_picture" | "retry_storage" | "resume";
  /** False only for Retry storage, which re-stores an image the vendor already drew. */
  costs: boolean;
  /** The most it could cost, shown on its button; null when free or when it cannot be priced. */
  boundUsd: number | null;
  reason: string;
}

const IN_FLIGHT_CELL = new Set(["waiting", "enqueued"]);
const PANEL_IN_FLIGHT = new Set(["preparing", "planning"]);

/** A sum of bounds that is null as soon as any part cannot be priced. */
function sumUsd(parts: Array<number | null>): number | null {
  return parts.some((x) => x == null) ? null : round4((parts as number[]).reduce((a, b) => a + b, 0));
}

/** The pictures a panel will still draw: everything not drawn and not lost for good. */
const undrawn = (cells: ComparisonCell[]) => cells.filter((c) => c.state !== "rendered" && !cellLost(c));

/** The retries that move a panel needing action on: its scene, or each failed picture that can still be recovered. */
function actionsFor(p: ComparisonPanel, cells: ComparisonCell[], pricing: ActionPricing | null): NeedsAction[] {
  const cellUsd = (c: ComparisonCell) => pricing?.cellUsd(c.engineId) ?? null;
  if (p.state === "failed") {
    // Retry scene prepares the scene again and then draws its pictures.
    const boundUsd = pricing ? sumUsd([pricing.prepUsd, ...undrawn(cells).map(cellUsd)]) : null;
    return [{ panelId: p.id, cellId: null, action: "retry_scene", costs: true, boundUsd, reason: p.error ?? "the scene could not be prepared" }];
  }
  return cells.filter((c) => c.state === "failed" && !cellLost(c)).map((c) => c.vendorResultUrl
    ? { panelId: p.id, cellId: c.id, action: "retry_storage" as const, costs: false, boundUsd: null, reason: c.error ?? "the picture could not be stored" }
    : { panelId: p.id, cellId: c.id, action: "retry_picture" as const, costs: true, boundUsd: cellUsd(c), reason: c.error ?? "the picture failed" });
}

/** Where an evaluation stands, from its rows alone. */
export function progressOf(
  set: { finishedAt: Date | null },
  panels: ComparisonPanel[],
  cellsByPanel: Map<number, ComparisonCell[]>,
  judged: Set<number>,
  pricing: ActionPricing | null = null,
): EvaluationProgress {
  let images = 0, drawn = 0, inFlight = 0, failed = 0, lost = 0, skippedPanels = 0, judgeablePanels = 0, judgedPanels = 0, moving = 0, unstarted = 0;
  const resumeParts: Array<number | null> = [];
  const needsAction: EvaluationProgress["needsAction"] = [];
  for (const p of panels) {
    const cells = cellsByPanel.get(p.id) ?? [];
    images += cells.length;
    drawn += cells.filter((c) => c.state === "rendered").length;
    inFlight += cells.filter((c) => IN_FLIGHT_CELL.has(c.state)).length;
    failed += cells.filter((c) => c.state === "failed").length;
    if (p.state === "skipped") { skippedPanels++; continue; }
    if (isJudgeable(cells)) {
      judgeablePanels++;
      if (judged.has(p.id)) judgedPanels++;
      continue;
    }
    // Only work a run holds is "generating"; work no run holds (a scene never
    // started, a picture left expected) waits for the Resume action.
    if (PANEL_IN_FLIGHT.has(p.state) || cells.some((c) => IN_FLIGHT_CELL.has(c.state))) moving++;
    if (p.state === "pending") {
      unstarted++;
      resumeParts.push(pricing?.prepUsd ?? null, ...cells.filter((c) => c.state === "expected").map((c) => pricing?.cellUsd(c.engineId) ?? null));
    } else if (p.state === "prepared") {
      const expected = cells.filter((c) => c.state === "expected");
      unstarted += expected.length;
      resumeParts.push(...expected.map((c) => pricing?.cellUsd(c.engineId) ?? null));
    }
    const wait = panelWait(p, cells);
    if (wait === "lost") lost += cells.length;
    else if (wait === "needs_action") needsAction.push(...actionsFor(p, cells, pricing));
  }
  if (unstarted > 0) {
    needsAction.unshift({ panelId: 0, cellId: null, action: "resume", costs: true, boundUsd: sumUsd(resumeParts), reason: `${unstarted} scene${unstarted === 1 ? "" : "s"} or picture${unstarted === 1 ? "" : "s"} not started` });
  }
  let status: EvaluationStatus;
  if (moving > 0) status = "generating";
  else if (needsAction.length > 0) status = "needs_action";
  else if (judgeablePanels === 0) status = "nothing_to_judge";
  else if (set.finishedAt) status = "finished";
  else if (judgedPanels > 0) status = "judging";
  else status = "ready";
  return { status, images, drawn, inFlight, failed, lost, skippedPanels, judgeablePanels, judgedPanels, needsAction };
}

async function judgedPanelIds(panelIds: number[]): Promise<Set<number>> {
  if (!panelIds.length) return new Set();
  const rows = await db.select({ panelId: comparisonPicksTable.panelId }).from(comparisonPicksTable).where(inArray(comparisonPicksTable.panelId, panelIds));
  return new Set(rows.map((r) => r.panelId));
}

export interface EvaluationSummary extends EvaluationProgress {
  id: number;
  description: string;
  kind: string;
  createdAt: string;
  finishedAt: string | null;
  engineFamilies: string[];
  scenarioKeys: string[];
  lookStyleIds: string[];
  factCount: number;
  round: number;
  imageSize: string;
}

/** Every evaluation of a kind, newest first, with its derived status. */
export async function listEvaluations(kind: "engine" | "prompt"): Promise<EvaluationSummary[]> {
  const sets = await db.select().from(comparisonSetsTable).where(eq(comparisonSetsTable.kind, kind)).orderBy(desc(comparisonSetsTable.createdAt));
  if (!sets.length) return [];
  const panels = await db.select().from(comparisonPanelsTable).where(inArray(comparisonPanelsTable.setId, sets.map((s) => s.id))).orderBy(asc(comparisonPanelsTable.id));
  const cells = panels.length ? await db.select().from(comparisonCellsTable).where(inArray(comparisonCellsTable.panelId, panels.map((p) => p.id))) : [];
  const cellsByPanel = groupCellsByPanel(cells);
  const judged = await judgedPanelIds(panels.map((p) => p.id));
  const pricing = await actionPricing();
  const panelsBySet = new Map<number, ComparisonPanel[]>();
  for (const p of panels) panelsBySet.set(p.setId, [...(panelsBySet.get(p.setId) ?? []), p]);
  return sets.map((s) => {
    const own = panelsBySet.get(s.id) ?? [];
    return {
      id: s.id,
      description: s.label,
      kind: s.kind,
      createdAt: s.createdAt.toISOString(),
      finishedAt: s.finishedAt?.toISOString() ?? null,
      engineFamilies: s.engineFamilies as string[],
      scenarioKeys: s.scenarioKeys as string[],
      lookStyleIds: s.lookStyleIds as string[],
      factCount: (s.factIds as number[]).length,
      round: s.round,
      imageSize: s.imageSize,
      ...progressOf(s, own, cellsByPanel, judged, pricing),
    };
  });
}

// ─── Finish ───────────────────────────────────────────────────────────────────

/**
 * Mark an evaluation finished, after checking on the server that nothing is
 * still generating or waiting on a retry and that every judgeable panel has a
 * saved judgement (a saved judgement is always complete: `recordJudgement`
 * refuses an incomplete one).
 */
export async function finishEvaluation(setId: number): Promise<EvaluationProgress> {
  const [set] = await db.select().from(comparisonSetsTable).where(eq(comparisonSetsTable.id, setId));
  if (!set) throw new EvaluationRefused("no such evaluation");
  const panels = await db.select().from(comparisonPanelsTable).where(eq(comparisonPanelsTable.setId, setId));
  const cells = panels.length ? await db.select().from(comparisonCellsTable).where(inArray(comparisonCellsTable.panelId, panels.map((p) => p.id))) : [];
  const progress = progressOf({ finishedAt: null }, panels, groupCellsByPanel(cells), await judgedPanelIds(panels.map((p) => p.id)));
  if (progress.status === "generating") throw new EvaluationRefused("pictures are still being generated");
  if (progress.needsAction.length > 0) throw new EvaluationRefused("some scenes or pictures are not drawn yet and can still be started or retried");
  if (progress.status === "nothing_to_judge") throw new EvaluationRefused("there are no images to judge");
  if (progress.judgedPanels < progress.judgeablePanels) throw new EvaluationRefused(`judge every panel first: ${progress.judgedPanels} of ${progress.judgeablePanels} judged`);
  await db.update(comparisonSetsTable).set({ finishedAt: new Date() }).where(and(eq(comparisonSetsTable.id, setId), sql`${comparisonSetsTable.finishedAt} is null`));
  return { ...progress, status: "finished" };
}

/**
 * Start whatever an evaluation has not started: the list's Resume action, and
 * the second half of Retry scene / Retry picture. Admits nothing twice and
 * spends no retry allowance; reading the list never calls it.
 */
export async function resumeEvaluation(setId: number, adminUserId: string | null): Promise<{ started: boolean }> {
  return { started: await startOutstanding(setId, adminUserId) };
}

/**
 * The second half of Retry scene / Retry picture: start exactly that retry's
 * work, the amount its button showed (PR #932 round 1). Other unstarted work
 * in the set is left for Resume generation.
 */
export async function startRetry(setId: number, scope: RunScope, adminUserId: string | null): Promise<{ started: boolean }> {
  try {
    await startComparisonRun(setId, { kind: "full" }, adminUserId, scope);
    return { started: true };
  } catch (err) {
    if (err instanceof ComparisonRunRefused && err.refusal === "nothing left to do") return { started: false };
    throw err;
  }
}


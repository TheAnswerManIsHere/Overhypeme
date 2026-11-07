/**
 * The engine comparison's sets, read and written (launch Phase 8, plan
 * `docs/plans/PLAN_PHASE8_ENGINE_EVALUATION.md`, *Proposed Design* C and D).
 *
 * Create a set (its panels and expected cells, from the layout), read a set's
 * status at both altitudes (per cell, and the aggregate), and plan the next
 * run of a kind with its worst-case figure. Planning writes nothing.
 */

import { randomInt } from "node:crypto";
import { db } from "@workspace/db";
import {
  comparisonCellsTable,
  comparisonPanelsTable,
  comparisonRunsTable,
  comparisonSetsTable,
  enginesTable,
  factsTable,
  lookStylesTable,
  type ComparisonCell,
  type ComparisonPanel,
  type ComparisonRun,
  type ComparisonSet,
} from "@workspace/db/schema";
import { asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  COMPARISON_CELL_STATES,
  COMPARISON_PANEL_STATES,
  type ComparisonRunPlanRequest,
  type ComparisonSetCreate,
} from "@workspace/api-zod";
import { resolveImagePromptLLMSettings } from "../imagePrompt/generator";
import { ComparisonLayoutError, deriveComparisonLayout } from "./layout";
import { cellBoundUsd, panelPreparationBoundUsd, planRun, round4, type PlannerRequestSettings, type RunPlan, type WorkItem } from "./admission";

export { ComparisonLayoutError };

export async function createComparisonSet(input: ComparisonSetCreate, adminUserId: string | null): Promise<{ setId: number; panels: number; cells: number }> {
  const styleIds = input.lookStyleIds.filter((s) => s !== "none");
  const [facts, styles, engines] = await Promise.all([
    db.select({ id: factsTable.id }).from(factsTable).where(inArray(factsTable.id, input.factIds)),
    styleIds.length
      ? db.select({ id: lookStylesTable.id, isActive: lookStylesTable.isActive }).from(lookStylesTable).where(inArray(lookStylesTable.id, styleIds))
      : Promise.resolve([] as Array<{ id: string; isActive: boolean }>),
    db.select().from(enginesTable).where(eq(enginesTable.kind, "image")),
  ]);

  const reasons: string[] = [];
  const knownFacts = new Set(facts.map((f) => f.id));
  const missingFacts = input.factIds.filter((id) => !knownFacts.has(id));
  if (missingFacts.length) reasons.push(`unknown fact ${missingFacts.join(", ")}`);
  for (const id of styleIds) {
    const row = styles.find((s) => s.id === id);
    if (!row) reasons.push(`unknown look style "${id}"`);
    else if (!row.isActive) reasons.push(`look style "${id}" is inactive`);
  }
  let layout: ReturnType<typeof deriveComparisonLayout> = [];
  try {
    layout = deriveComparisonLayout(input, engines);
  } catch (err) {
    if (!(err instanceof ComparisonLayoutError)) throw err;
    reasons.push(...err.reasons);
  }
  if (reasons.length) throw new ComparisonLayoutError(reasons);

  return db.transaction(async (tx) => {
    const [set] = await tx.insert(comparisonSetsTable).values({
      label: input.label,
      round: input.round,
      factIds: input.factIds,
      scenarioKeys: input.scenarioKeys,
      lookStyleIds: input.lookStyleIds,
      engineFamilies: input.engineFamilies,
      createdBy: adminUserId,
    }).returning({ id: comparisonSetsTable.id });
    // Postgres returns a multi-row insert's rows in the order given.
    const panels = await tx.insert(comparisonPanelsTable).values(layout.map((p) => ({
      setId: set!.id,
      factId: p.factId,
      scenarioKey: p.scenarioKey,
      lookStyleId: p.lookStyleId,
      imageMode: p.imageMode,
      shuffleSeed: randomInt(0, 2 ** 31 - 1),
    }))).returning({ id: comparisonPanelsTable.id });
    const cells = layout.flatMap((p, i) => p.engineIds.map((engineId) => ({ panelId: panels[i]!.id, engineId })));
    await tx.insert(comparisonCellsTable).values(cells);
    return { setId: set!.id, panels: panels.length, cells: cells.length };
  });
}

export interface ComparisonSetSummary {
  id: number;
  label: string;
  round: number;
  createdAt: string;
  panels: number;
  cells: number;
}

export async function listComparisonSets(): Promise<ComparisonSetSummary[]> {
  const [sets, counts] = await Promise.all([
    db.select().from(comparisonSetsTable).orderBy(desc(comparisonSetsTable.createdAt)),
    db
      .select({ setId: comparisonPanelsTable.setId, panels: sql<number>`count(distinct ${comparisonPanelsTable.id})::int`, cells: sql<number>`count(${comparisonCellsTable.id})::int` })
      .from(comparisonPanelsTable)
      .leftJoin(comparisonCellsTable, eq(comparisonCellsTable.panelId, comparisonPanelsTable.id))
      .groupBy(comparisonPanelsTable.setId),
  ]);
  const bySet = new Map(counts.map((c) => [c.setId, c]));
  return sets.map((s) => ({
    id: s.id, label: s.label, round: s.round, createdAt: s.createdAt.toISOString(),
    panels: bySet.get(s.id)?.panels ?? 0, cells: bySet.get(s.id)?.cells ?? 0,
  }));
}

type Tally<S extends string> = Record<S, number>;

function tally<S extends string>(states: readonly S[], values: string[]): Tally<S> {
  const out = Object.fromEntries(states.map((s) => [s, 0])) as Tally<S>;
  for (const v of values) if (v in out) out[v as S] += 1;
  return out;
}

export interface ComparisonSetDetail {
  set: ComparisonSet;
  panels: Array<ComparisonPanel & { cells: ComparisonCell[] }>;
  aggregate: {
    panels: Tally<(typeof COMPARISON_PANEL_STATES)[number]>;
    cells: Tally<(typeof COMPARISON_CELL_STATES)[number]>;
  };
  /** The most the set's remaining work can cost: every pending panel, every expected cell. */
  estimate: {
    /** Null when the planner cannot be priced; `preparationRefusal` says why. */
    preparationBoundUsd: number | null;
    preparationRefusal: string | null;
    renderBoundUsd: number;
    perEngineBoundUsd: Record<string, number>;
  };
  runs: ComparisonRun[];
}

/** A database handle or a transaction: the reads admission repeats under its lock. */
export type Executor = Pick<typeof db, "select" | "insert" | "update" | "execute">;

export interface SetRows {
  set: ComparisonSet;
  panels: ComparisonPanel[];
  cells: ComparisonCell[];
  prices: Map<string, unknown>;
}

/**
 * The planner's request settings, from the one resolution its call uses
 * (`resolveImagePromptLLMSettings`). A fallback of any kind refuses: a bound
 * for a planner other than the configured one would price a different
 * experiment, and a guess is no bound.
 */
export async function plannerSettings(): Promise<PlannerRequestSettings> {
  const resolved = await resolveImagePromptLLMSettings();
  const { fallbackReason, configuredEngineId } = resolved.plannerProvenance;
  if (fallbackReason || !resolved.model) {
    throw new ComparisonLayoutError([`the planner engine "${configuredEngineId}" cannot be used (${fallbackReason ?? "no model"}), so no preparation can be bounded`]);
  }
  return { model: resolved.model, maxTokens: resolved.maxTokens, temperature: resolved.temperature, reasoningEffort: resolved.reasoningEffort };
}

export async function loadSetRows(setId: number, exec: Executor = db): Promise<SetRows | null> {
  const [setRow, panels] = await Promise.all([
    exec.select().from(comparisonSetsTable).where(eq(comparisonSetsTable.id, setId)),
    exec.select().from(comparisonPanelsTable).where(eq(comparisonPanelsTable.setId, setId)).orderBy(asc(comparisonPanelsTable.id)),
  ]);
  const set = setRow[0];
  if (!set) return null;
  const cells = panels.length
    ? await exec.select().from(comparisonCellsTable).where(inArray(comparisonCellsTable.panelId, panels.map((p) => p.id))).orderBy(asc(comparisonCellsTable.id))
    : [];
  const engineIds = [...new Set(cells.map((c) => c.engineId))];
  const engines = engineIds.length
    ? await exec.select({ id: enginesTable.id, priceModel: enginesTable.priceModel }).from(enginesTable).where(inArray(enginesTable.id, engineIds))
    : [];
  return { set, panels, cells, prices: new Map(engines.map((r) => [r.id, r.priceModel])) };
}

/** Panels still to prepare, each priced at two planner calls at the planner's real ceiling. */
export function prepareItems(rows: SetRows, planner: PlannerRequestSettings): WorkItem[] {
  const bound = panelPreparationBoundUsd(planner);
  return rows.panels.filter((p) => p.state === "pending").map((p) => ({
    ref: `panel:${p.id}`,
    label: `preparing panel ${p.id} (fact ${p.factId}, ${p.scenarioKey}, ${p.lookStyleId})`,
    boundUsd: bound,
  }));
}

/**
 * Cells still to render, each at its engine's per-call bound, in the order a
 * run takes them. `preparedOnly` limits them to prepared panels: a render run
 * can only take those, while the set's estimate counts every expected cell.
 */
export function renderItems(rows: SetRows, opts: { preparedOnly: boolean }): WorkItem[] {
  const prepared = new Set(rows.panels.filter((p) => p.state === "prepared").map((p) => p.id));
  return rows.cells.filter((c) => c.state === "expected" && (!opts.preparedOnly || prepared.has(c.panelId))).map((c) => ({
    ref: `cell:${c.id}`,
    label: `rendering cell ${c.id} (${c.engineId})`,
    boundUsd: cellBoundUsd(rows.prices.get(c.engineId)),
    engineId: c.engineId,
  }));
}

/** The bounds of a set's remaining work, shared by the status view and the dry run. */
export function estimateOf(prepare: WorkItem[], render: WorkItem[]): Omit<ComparisonSetDetail["estimate"], "preparationRefusal"> & { preparationBoundUsd: number } {
  const perEngine: Record<string, number> = {};
  for (const item of render) perEngine[item.engineId!] = (perEngine[item.engineId!] ?? 0) + item.boundUsd;
  const sum = (items: WorkItem[]) => round4(items.reduce((s, i) => s + i.boundUsd, 0));
  return {
    preparationBoundUsd: sum(prepare),
    renderBoundUsd: sum(render),
    perEngineBoundUsd: Object.fromEntries(Object.entries(perEngine).map(([k, v]) => [k, round4(v)])),
  };
}

export async function getComparisonSet(setId: number): Promise<ComparisonSetDetail | null> {
  const rows = await loadSetRows(setId);
  if (!rows) return null;
  const cellsByPanel = new Map<number, ComparisonCell[]>();
  for (const c of rows.cells) cellsByPanel.set(c.panelId, [...(cellsByPanel.get(c.panelId) ?? []), c]);
  // An unusable planner withholds only the preparation figure; the grid, the
  // render estimate and the runs stay readable.
  let prepare: WorkItem[] = [];
  let preparationRefusal: string | null = null;
  if (rows.panels.some((p) => p.state === "pending")) {
    try {
      prepare = prepareItems(rows, await plannerSettings());
    } catch (err) {
      if (!(err instanceof ComparisonLayoutError)) throw err;
      preparationRefusal = err.reasons.join("; ");
    }
  }
  const estimate = estimateOf(prepare, renderItems(rows, { preparedOnly: false }));
  const runs = await db.select().from(comparisonRunsTable).where(eq(comparisonRunsTable.setId, setId)).orderBy(desc(comparisonRunsTable.createdAt));
  return {
    set: rows.set,
    panels: rows.panels.map((p) => ({ ...p, cells: cellsByPanel.get(p.id) ?? [] })),
    aggregate: {
      panels: tally(COMPARISON_PANEL_STATES, rows.panels.map((p) => p.state)),
      cells: tally(COMPARISON_CELL_STATES, rows.cells.map((c) => c.state)),
    },
    estimate: { ...estimate, preparationBoundUsd: preparationRefusal ? null : estimate.preparationBoundUsd, preparationRefusal },
    runs,
  };
}

/** The work a run of `kind` would take; the planner is resolved only for preparation. */
export async function runItems(kind: "prepare" | "render", rows: SetRows): Promise<WorkItem[]> {
  if (kind === "prepare") return prepareItems(rows, await plannerSettings());
  return renderItems(rows, { preparedOnly: true });
}

export async function planComparisonRun(setId: number, req: ComparisonRunPlanRequest): Promise<RunPlan | null> {
  const rows = await loadSetRows(setId);
  if (!rows) return null;
  return planRun(await runItems(req.kind, rows));
}

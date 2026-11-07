/**
 * The engine comparison's sets, read and written (launch Phase 8, plan
 * `docs/plans/PLAN_PHASE8_ENGINE_EVALUATION.md`, *Proposed Design* C and D).
 *
 * Increment 2a: create a set (its panels and expected cells, from the layout),
 * read a set's status at both altitudes (per cell, and the aggregate), and
 * plan the next run of a kind with its bound, or the refusal with the figure.
 * Planning writes nothing: reservations are written by the run that spends
 * (increment 2b), so a planned run that never executes holds no budget.
 */

import { randomInt } from "node:crypto";
import { db } from "@workspace/db";
import {
  comparisonCellsTable,
  comparisonPanelsTable,
  comparisonReservationsTable,
  comparisonSetsTable,
  enginesTable,
  factsTable,
  lookStylesTable,
  type ComparisonCell,
  type ComparisonPanel,
  type ComparisonSet,
} from "@workspace/db/schema";
import { asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  COMPARISON_CELL_STATES,
  COMPARISON_PANEL_STATES,
  PAID_RUN_ALLOWANCE_USD,
  type ComparisonRunPlanRequest,
  type ComparisonSetCreate,
} from "@workspace/api-zod";
import { getImagePromptEngineId } from "../imagePromptConfig";
import { ComparisonLayoutError, deriveComparisonLayout } from "./layout";
import { cellBoundUsd, panelPreparationBoundUsd, planRun, round4, type RunPlan, type WorkItem } from "./admission";

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
    preparationBoundUsd: number;
    renderBoundUsd: number;
    perEngineBoundUsd: Record<string, number>;
  };
}

interface SetRows {
  set: ComparisonSet;
  panels: ComparisonPanel[];
  cells: ComparisonCell[];
  prices: Map<string, unknown>;
  plannerModel: string;
}

/**
 * The model the planner engine names (`fact_image_prompt_engine_id`). A
 * missing or inactive planner engine refuses rather than pricing a guess.
 */
export async function plannerModel(): Promise<string> {
  const engineId = await getImagePromptEngineId();
  const [row] = await db.select({ endpointId: enginesTable.endpointId, isActive: enginesTable.isActive }).from(enginesTable).where(eq(enginesTable.id, engineId));
  if (!row || !row.isActive) throw new ComparisonLayoutError([`the planner engine "${engineId}" is ${row ? "inactive" : "not in the catalogue"}, so no preparation can be bounded`]);
  return row.endpointId;
}

async function loadSetRows(setId: number): Promise<SetRows | null> {
  const [setRow, panels, model] = await Promise.all([
    db.select().from(comparisonSetsTable).where(eq(comparisonSetsTable.id, setId)),
    db.select().from(comparisonPanelsTable).where(eq(comparisonPanelsTable.setId, setId)).orderBy(asc(comparisonPanelsTable.id)),
    plannerModel(),
  ]);
  const set = setRow[0];
  if (!set) return null;
  const cells = panels.length
    ? await db.select().from(comparisonCellsTable).where(inArray(comparisonCellsTable.panelId, panels.map((p) => p.id))).orderBy(asc(comparisonCellsTable.id))
    : [];
  const engineIds = [...new Set(cells.map((c) => c.engineId))];
  const engines = engineIds.length
    ? await db.select({ id: enginesTable.id, priceModel: enginesTable.priceModel }).from(enginesTable).where(inArray(enginesTable.id, engineIds))
    : [];
  return { set, panels, cells, prices: new Map(engines.map((r) => [r.id, r.priceModel])), plannerModel: model };
}

/**
 * Work still to do, priced at each call's complete bound, in the order a run
 * takes it. `preparedOnly` limits cells to panels already prepared: a render
 * run can only take those, while the set's estimate counts every expected cell.
 */
function workItems(kind: "prepare" | "render", rows: SetRows, opts: { preparedOnly: boolean }): WorkItem[] {
  if (kind === "prepare") {
    const bound = panelPreparationBoundUsd(rows.plannerModel);
    return rows.panels.filter((p) => p.state === "pending").map((p) => ({
      ref: `panel:${p.id}`,
      label: `preparing panel ${p.id} (fact ${p.factId}, ${p.scenarioKey}, ${p.lookStyleId})`,
      boundUsd: bound,
    }));
  }
  const prepared = new Set(rows.panels.filter((p) => p.state === "prepared").map((p) => p.id));
  return rows.cells.filter((c) => c.state === "expected" && (!opts.preparedOnly || prepared.has(c.panelId))).map((c) => ({
    ref: `cell:${c.id}`,
    label: `rendering cell ${c.id} (${c.engineId})`,
    boundUsd: cellBoundUsd(rows.prices.get(c.engineId)),
    engineId: c.engineId,
  }));
}

/** The bounds of a set's remaining work, shared by the status view and the dry run. */
export function estimateOf(prepare: WorkItem[], render: WorkItem[]): ComparisonSetDetail["estimate"] {
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
  return {
    set: rows.set,
    panels: rows.panels.map((p) => ({ ...p, cells: cellsByPanel.get(p.id) ?? [] })),
    aggregate: {
      panels: tally(COMPARISON_PANEL_STATES, rows.panels.map((p) => p.state)),
      cells: tally(COMPARISON_CELL_STATES, rows.cells.map((c) => c.state)),
    },
    estimate: estimateOf(workItems("prepare", rows, { preparedOnly: false }), workItems("render", rows, { preparedOnly: false })),
  };
}

/** Every reservation not yet settled or released counts at its bound. */
async function unresolvedReservedUsd(): Promise<number> {
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${comparisonReservationsTable.boundUsd}), 0)` })
    .from(comparisonReservationsTable)
    .where(eq(comparisonReservationsTable.state, "reserved"));
  return Number(row?.total ?? 0);
}

export async function planComparisonRun(setId: number, req: ComparisonRunPlanRequest): Promise<RunPlan | null> {
  const [rows, reserved] = await Promise.all([loadSetRows(setId), unresolvedReservedUsd()]);
  if (!rows) return null;
  return planRun(workItems(req.kind, rows, { preparedOnly: true }), {
    allowanceUsd: req.allowanceUsd ?? PAID_RUN_ALLOWANCE_USD,
    weekRemainingUsd: req.weekRemainingUsd,
    unresolvedReservedUsd: reserved,
  });
}

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
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  COMPARISON_CELL_STATES,
  COMPARISON_PANEL_STATES,
  PAID_RUN_ALLOWANCE_USD,
  type ComparisonRunPlanRequest,
  type ComparisonSetCreate,
} from "@workspace/api-zod";
import { ComparisonLayoutError, deriveComparisonLayout, type LayoutPanel } from "./layout";
import { cellBoundUsd, panelPreparationBoundUsd, planRun, type RunPlan, type WorkItem } from "./admission";

export { ComparisonLayoutError };

export async function createComparisonSet(input: ComparisonSetCreate, adminUserId: string | null): Promise<{ setId: number; panels: number; cells: number }> {
  const reasons: string[] = [];
  const facts = await db.select({ id: factsTable.id }).from(factsTable).where(inArray(factsTable.id, input.factIds));
  const missingFacts = input.factIds.filter((id) => !facts.some((f) => f.id === id));
  if (missingFacts.length) reasons.push(`unknown fact ${missingFacts.join(", ")}`);
  const styleIds = input.lookStyleIds.filter((s) => s !== "none");
  if (styleIds.length) {
    const styles = await db.select({ id: lookStylesTable.id, isActive: lookStylesTable.isActive }).from(lookStylesTable).where(inArray(lookStylesTable.id, styleIds));
    for (const id of styleIds) {
      const row = styles.find((s) => s.id === id);
      if (!row) reasons.push(`unknown look style "${id}"`);
      else if (!row.isActive) reasons.push(`look style "${id}" is inactive`);
    }
  }
  const engines = await db.select().from(enginesTable).where(eq(enginesTable.kind, "image"));
  let layout: LayoutPanel[] | undefined;
  try {
    layout = deriveComparisonLayout(input, engines);
  } catch (err) {
    if (err instanceof ComparisonLayoutError) reasons.push(...err.reasons);
    else throw err;
  }
  if (reasons.length || !layout) throw new ComparisonLayoutError(reasons);

  const panelsToWrite = layout;
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
    let cells = 0;
    for (const p of panelsToWrite) {
      const [panel] = await tx.insert(comparisonPanelsTable).values({
        setId: set!.id,
        factId: p.factId,
        scenarioKey: p.scenarioKey,
        lookStyleId: p.lookStyleId,
        imageMode: p.imageMode,
        shuffleSeed: randomInt(0, 2 ** 31 - 1),
      }).returning({ id: comparisonPanelsTable.id });
      await tx.insert(comparisonCellsTable).values(p.engineIds.map((engineId: string) => ({ panelId: panel!.id, engineId })));
      cells += p.engineIds.length;
    }
    return { setId: set!.id, panels: panelsToWrite.length, cells };
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
  const sets = await db.select().from(comparisonSetsTable).orderBy(desc(comparisonSetsTable.createdAt));
  if (sets.length === 0) return [];
  const panelCounts = await db
    .select({ setId: comparisonPanelsTable.setId, panels: sql<number>`count(distinct ${comparisonPanelsTable.id})::int`, cells: sql<number>`count(${comparisonCellsTable.id})::int` })
    .from(comparisonPanelsTable)
    .leftJoin(comparisonCellsTable, eq(comparisonCellsTable.panelId, comparisonPanelsTable.id))
    .groupBy(comparisonPanelsTable.setId);
  return sets.map((s) => {
    const c = panelCounts.find((p) => p.setId === s.id);
    return { id: s.id, label: s.label, round: s.round, createdAt: s.createdAt.toISOString(), panels: c?.panels ?? 0, cells: c?.cells ?? 0 };
  });
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
  estimate: {
    preparationBoundUsd: number;
    renderBoundUsd: number;
    perEngineBoundUsd: Record<string, number>;
  };
}

async function loadSetRows(setId: number): Promise<{ set: ComparisonSet; panels: ComparisonPanel[]; cells: ComparisonCell[] } | null> {
  const [set] = await db.select().from(comparisonSetsTable).where(eq(comparisonSetsTable.id, setId));
  if (!set) return null;
  const panels = await db.select().from(comparisonPanelsTable).where(eq(comparisonPanelsTable.setId, setId)).orderBy(asc(comparisonPanelsTable.id));
  const cells = panels.length
    ? await db.select().from(comparisonCellsTable).where(inArray(comparisonCellsTable.panelId, panels.map((p) => p.id))).orderBy(asc(comparisonCellsTable.id))
    : [];
  return { set, panels, cells };
}

async function enginePriceModels(engineIds: string[]): Promise<Map<string, unknown>> {
  if (engineIds.length === 0) return new Map();
  const rows = await db.select({ id: enginesTable.id, priceModel: enginesTable.priceModel }).from(enginesTable).where(inArray(enginesTable.id, engineIds));
  return new Map(rows.map((r) => [r.id, r.priceModel]));
}

/** What is still to do, priced at each call's complete bound, in the order a run takes it. */
function pendingWork(
  kind: "prepare" | "render",
  panels: ComparisonPanel[],
  cells: ComparisonCell[],
  prices: Map<string, unknown>,
): WorkItem[] {
  if (kind === "prepare") {
    const bound = panelPreparationBoundUsd();
    return panels.filter((p) => p.state === "pending").map((p) => ({
      ref: `panel:${p.id}`,
      label: `preparing panel ${p.id} (fact ${p.factId}, ${p.scenarioKey}, ${p.lookStyleId})`,
      boundUsd: bound,
    }));
  }
  const prepared = new Set(panels.filter((p) => p.state === "prepared").map((p) => p.id));
  return cells.filter((c) => c.state === "expected" && prepared.has(c.panelId)).map((c) => ({
    ref: `cell:${c.id}`,
    label: `rendering cell ${c.id} (${c.engineId})`,
    boundUsd: cellBoundUsd(prices.get(c.engineId)),
  }));
}

export async function getComparisonSet(setId: number): Promise<ComparisonSetDetail | null> {
  const rows = await loadSetRows(setId);
  if (!rows) return null;
  const prices = await enginePriceModels([...new Set(rows.cells.map((c) => c.engineId))]);
  const perEngine: Record<string, number> = {};
  for (const c of rows.cells.filter((c) => c.state === "expected")) {
    perEngine[c.engineId] = (perEngine[c.engineId] ?? 0) + cellBoundUsd(prices.get(c.engineId));
  }
  const round4 = (n: number) => Math.round(n * 10_000) / 10_000;
  return {
    set: rows.set,
    panels: rows.panels.map((p) => ({ ...p, cells: rows.cells.filter((c) => c.panelId === p.id) })),
    aggregate: {
      panels: tally(COMPARISON_PANEL_STATES, rows.panels.map((p) => p.state)),
      cells: tally(COMPARISON_CELL_STATES, rows.cells.map((c) => c.state)),
    },
    estimate: {
      preparationBoundUsd: round4(rows.panels.filter((p) => p.state === "pending").length * panelPreparationBoundUsd()),
      renderBoundUsd: round4(Object.values(perEngine).reduce((s, v) => s + v, 0)),
      perEngineBoundUsd: Object.fromEntries(Object.entries(perEngine).map(([k, v]) => [k, round4(v)])),
    },
  };
}

/** Every reservation not yet settled or released counts at its bound. */
export async function unresolvedReservedUsd(): Promise<number> {
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${comparisonReservationsTable.boundUsd}), 0)` })
    .from(comparisonReservationsTable)
    .where(eq(comparisonReservationsTable.state, "reserved"));
  return Number(row?.total ?? 0);
}

export async function planComparisonRun(setId: number, req: ComparisonRunPlanRequest): Promise<RunPlan | null> {
  const rows = await loadSetRows(setId);
  if (!rows) return null;
  const prices = await enginePriceModels([...new Set(rows.cells.map((c) => c.engineId))]);
  return planRun(pendingWork(req.kind, rows.panels, rows.cells, prices), {
    allowanceUsd: req.allowanceUsd ?? PAID_RUN_ALLOWANCE_USD,
    weekRemainingUsd: req.weekRemainingUsd,
    unresolvedReservedUsd: await unresolvedReservedUsd(),
  });
}

// Kept so a later increment's executor shares one query for a set's cells.
export async function cellsForPanels(panelIds: number[]): Promise<ComparisonCell[]> {
  if (panelIds.length === 0) return [];
  return db.select().from(comparisonCellsTable).where(and(inArray(comparisonCellsTable.panelId, panelIds)));
}

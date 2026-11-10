/**
 * Blind judging and results for the engine comparison (launch Phase 8,
 * increment 3; plan `docs/plans/PLAN_PHASE8_ENGINE_EVALUATION.md`, *Proposed
 * Design* E, *Security, Permissions, and Validation*).
 *
 * - **The blind view names no engine.** Each image is addressed by an opaque
 *   token derived from the panel's stored shuffle seed and the cell id; the
 *   seed never leaves the server, so a token says nothing about which engine
 *   drew it or in what order the cells were created. The images are shown in
 *   token order, which is a shuffle that is stable across reloads. The payload
 *   carries no engine id, endpoint, cell id or storage path.
 * - **A panel is judgeable only when every one of its cells has a stored
 *   image**; until then it shows how many are ready and none of them. A
 *   panel skipped at preparation stays listed, with its reason, and counts in
 *   every total: a smaller comparison is never a silent one (plan, *Proposed
 *   Design* C).
 * - **A pick is recorded against the hidden cell.** Re-judging replaces the
 *   pick and keeps the previous one in the row's history.
 * - **Results reveal the engines**: wins per family overall, per mode
 *   (text-to-image; reference edit), per style and per scenario, the face
 *   marks, and what each engine's calls could have cost (no bill is read:
 *   David's override, 2026-11-07, `decisions.md`).
 */

import { createHash } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  comparisonCellsTable,
  comparisonPanelsTable,
  comparisonPicksTable,
  comparisonReservationsTable,
  comparisonRunsTable,
  comparisonSetsTable,
  enginesTable,
  factsTable,
  type ComparisonCell,
  type ComparisonPanel,
} from "@workspace/db/schema";
import { RENDER_SCENARIO_DESCRIPTORS, type ComparisonPickRequest, type RenderScenarioKey } from "@workspace/api-zod";
import { renderCanonical } from "../renderCanonical";
import { round4 } from "./admission";
import { perImagePrice, type PriceModel } from "../engines";
import { groupCellsByPanel } from "./sets";

/** The opaque, engine-free name of a cell in the blind view. */
export function blindToken(panel: Pick<ComparisonPanel, "shuffleSeed">, cellId: number): string {
  return createHash("sha256").update(`comparison-blind:${panel.shuffleSeed}:${cellId}`).digest("hex").slice(0, 16);
}

/** A panel's cells in their blind order, each with its token. */
function blindOrder(panel: ComparisonPanel, cells: ComparisonCell[]): Array<{ cell: ComparisonCell; token: string }> {
  return cells
    .map((cell) => ({ cell, token: blindToken(panel, cell.id) }))
    .sort((a, b) => (a.token < b.token ? -1 : a.token > b.token ? 1 : 0));
}

/** A panel's cells by their blind token. */
function cellsByToken(panel: ComparisonPanel, cells: ComparisonCell[]): Map<string, ComparisonCell> {
  return new Map(cells.map((c) => [blindToken(panel, c.id), c]));
}

const hasImage = (c: ComparisonCell) => c.state === "rendered" && !!c.imageObjectPath;

/** Every cell has a stored image: the only state in which a panel can be judged. */
export function isJudgeable(cells: ComparisonCell[]): boolean {
  return cells.length > 0 && cells.every(hasImage);
}

/**
 * Why a panel that is neither judgeable nor skipped is waiting, in words
 * that name no engine:
 * - "lost": one of its images will never exist (a cell failed after its one
 *   re-run, with no image kept at the vendor, or was skipped), so the panel
 *   can never be judged — the plan's scope question for David, never shown
 *   as work in progress;
 * - "needs_action": something on the comparison screen would move it on (a
 *   failed panel to prepare again, a failed cell to re-run or to retry its
 *   storage);
 * - "rendering": its images are still being prepared or drawn.
 */
export type PanelWait = "lost" | "needs_action" | "rendering";

const cellLost = (c: ComparisonCell) =>
  c.state === "skipped" || (c.state === "failed" && !c.vendorResultUrl && c.rerunCount >= 1);

export function panelWait(panel: Pick<ComparisonPanel, "state">, cells: ComparisonCell[]): PanelWait | null {
  if (panel.state === "skipped" || isJudgeable(cells)) return null;
  if (cells.some(cellLost)) return "lost";
  if (panel.state === "failed" || cells.some((c) => c.state === "failed")) return "needs_action";
  return "rendering";
}

/** Whether a panel's reference is a person, so "not the person" can be marked. */
export function isHumanReference(scenarioKey: string): boolean {
  const type = RENDER_SCENARIO_DESCRIPTORS[scenarioKey as RenderScenarioKey]?.referenceIdentityType;
  return type === "male" || type === "female";
}

export interface BlindImage { token: string; src: string }
export interface BlindPanel {
  panelId: number;
  /** 1-based position in the round. */
  position: number;
  factId: number;
  factText: string;
  scenarioKey: string;
  scenarioLabel: string;
  lookStyleId: string;
  imageMode: string;
  faceMarkable: boolean;
  judgeable: boolean;
  /** Skipped at preparation: it will never be judged. Its reason names no engine. */
  skipped: boolean;
  skipReason: string | null;
  /** Why a panel that is neither judgeable nor skipped is waiting; null otherwise. */
  waiting: PanelWait | null;
  imagesReady: number;
  imagesExpected: number;
  /** Empty until the panel is judgeable. */
  images: BlindImage[];
  pick: { pickedToken: string; faceMismatchTokens: string[]; judgedAt: string } | null;
}
export interface BlindSet {
  set: { id: number; label: string; round: number };
  progress: { panels: number; judgeable: number; judged: number; skipped: number; lost: number };
  panels: BlindPanel[];
}

async function panelRows(setIds: number[]) {
  const panels = await db.select().from(comparisonPanelsTable).where(inArray(comparisonPanelsTable.setId, setIds)).orderBy(asc(comparisonPanelsTable.id));
  const ids = panels.map((p) => p.id);
  const [cells, picks] = ids.length
    ? await Promise.all([
      db.select().from(comparisonCellsTable).where(inArray(comparisonCellsTable.panelId, ids)).orderBy(asc(comparisonCellsTable.id)),
      db.select().from(comparisonPicksTable).where(inArray(comparisonPicksTable.panelId, ids)),
    ])
    : [[], []];
  return { panels, cellsByPanel: groupCellsByPanel(cells), picks: new Map(picks.map((p) => [p.panelId, p])) };
}

const asIds = (v: unknown): number[] => (Array.isArray(v) ? v.filter((n): n is number => typeof n === "number") : []);

/** The blind view of a set: every panel, skipped ones included. */
export async function getBlindSet(setId: number): Promise<BlindSet | null> {
  const [[set], { panels, cellsByPanel, picks }] = await Promise.all([
    db.select().from(comparisonSetsTable).where(eq(comparisonSetsTable.id, setId)),
    panelRows([setId]),
  ]);
  if (!set) return null;
  const factIds = [...new Set(panels.map((p) => p.factId))];
  const facts = factIds.length ? await db.select({ id: factsTable.id, text: factsTable.text }).from(factsTable).where(inArray(factsTable.id, factIds)) : [];
  const factText = new Map(facts.map((f) => [f.id, renderCanonical(f.text)]));

  const out: BlindPanel[] = [];
  for (const panel of panels) {
    const cells = cellsByPanel.get(panel.id) ?? [];
    const ordered = blindOrder(panel, cells);
    const judgeable = isJudgeable(cells);
    const tokenOf = new Map(ordered.map((o) => [o.cell.id, o.token]));
    const pick = picks.get(panel.id);
    out.push({
      panelId: panel.id,
      position: out.length + 1,
      factId: panel.factId,
      factText: factText.get(panel.factId) ?? "",
      scenarioKey: panel.scenarioKey,
      scenarioLabel: RENDER_SCENARIO_DESCRIPTORS[panel.scenarioKey as RenderScenarioKey]?.label ?? panel.scenarioKey,
      lookStyleId: panel.lookStyleId,
      imageMode: panel.imageMode,
      faceMarkable: isHumanReference(panel.scenarioKey),
      judgeable,
      skipped: panel.state === "skipped",
      skipReason: panel.state === "skipped" ? panel.skipReason : null,
      waiting: panelWait(panel, cells),
      imagesReady: cells.filter(hasImage).length,
      imagesExpected: cells.length,
      images: judgeable ? ordered.map((o) => ({ token: o.token, src: `/api/admin/comparison/panels/${panel.id}/images/${o.token}` })) : [],
      pick: pick && tokenOf.has(pick.pickedCellId)
        ? {
          pickedToken: tokenOf.get(pick.pickedCellId)!,
          faceMismatchTokens: asIds(pick.faceMismatchCellIds).map((id) => tokenOf.get(id)).filter((t): t is string => !!t),
          judgedAt: pick.judgedAt.toISOString(),
        }
        : null,
    });
  }
  return {
    set: { id: set.id, label: set.label, round: set.round },
    progress: {
      panels: out.length,
      judgeable: out.filter((p) => p.judgeable).length,
      judged: out.filter((p) => p.pick).length,
      skipped: out.filter((p) => p.skipped).length,
      lost: out.filter((p) => p.waiting === "lost").length,
    },
    panels: out,
  };
}

/** The stored image behind a blind token, or null. */
export async function blindImagePath(panelId: number, token: string): Promise<string | null> {
  const [panel] = await db.select().from(comparisonPanelsTable).where(eq(comparisonPanelsTable.id, panelId));
  if (!panel) return null;
  const cells = await db.select().from(comparisonCellsTable).where(eq(comparisonCellsTable.panelId, panelId));
  const hit = cellsByToken(panel, cells).get(token);
  return hit && hasImage(hit) ? hit.imageObjectPath : null;
}

export class ComparisonPickRefused extends Error {}

/** Record (or replace) David's pick for a panel. */
export async function recordPick(panelId: number, req: ComparisonPickRequest, adminUserId: string | null): Promise<{ pickedToken: string; faceMismatchTokens: string[] }> {
  return db.transaction(async (tx) => {
    const [panel] = await tx.select().from(comparisonPanelsTable).where(eq(comparisonPanelsTable.id, panelId)).for("update");
    if (!panel) throw new ComparisonPickRefused("no such panel");
    const cells = await tx.select().from(comparisonCellsTable).where(eq(comparisonCellsTable.panelId, panelId));
    if (!isJudgeable(cells)) throw new ComparisonPickRefused("this panel cannot be judged until every image is ready");
    const byToken = new Map([...cellsByToken(panel, cells)].map(([t, c]) => [t, c.id]));
    const picked = byToken.get(req.pickedToken);
    if (picked == null) throw new ComparisonPickRefused("the picked image is not one of this panel's");
    const marks = [...new Set(req.faceMismatchTokens)];
    if (marks.length && !isHumanReference(panel.scenarioKey)) throw new ComparisonPickRefused("faces are marked only on panels with a person's reference photo");
    const markIds = marks.map((t) => byToken.get(t));
    if (markIds.some((id) => id == null)) throw new ComparisonPickRefused("a face mark names an image that is not this panel's");

    const [existing] = await tx.select().from(comparisonPicksTable).where(eq(comparisonPicksTable.panelId, panelId));
    const now = new Date();
    if (!existing) {
      await tx.insert(comparisonPicksTable).values({ panelId, pickedCellId: picked, faceMismatchCellIds: markIds, judgedBy: adminUserId, judgedAt: now });
    } else {
      const history = [...(Array.isArray(existing.history) ? existing.history : []), {
        pickedCellId: existing.pickedCellId,
        faceMismatchCellIds: existing.faceMismatchCellIds,
        judgedBy: existing.judgedBy,
        judgedAt: existing.judgedAt.toISOString(),
      }];
      await tx.update(comparisonPicksTable)
        .set({ pickedCellId: picked, faceMismatchCellIds: markIds, judgedBy: adminUserId, judgedAt: now, history })
        .where(and(eq(comparisonPicksTable.id, existing.id), eq(comparisonPicksTable.panelId, panelId)));
    }
    return { pickedToken: req.pickedToken, faceMismatchTokens: marks };
  });
}

// ─── Results ──────────────────────────────────────────────────────────────────

type Wins = Record<string, number>;
export interface ComparisonResults {
  sets: Array<{ id: number; label: string; round: number }>;
  families: string[];
  /** Every panel of the sets counts in `total`; `skipped` will never be judged. */
  panels: { total: number; judged: number; judgeable: number; skipped: number; lost: number };
  wins: {
    overall: Wins;
    /** "t2i" (text-to-image) and "i2i" (reference edit): a winner each. */
    byMode: Record<string, Wins>;
    byStyle: Record<string, Wins>;
    byScenario: Record<string, Wins>;
  };
  /**
   * Stage 2 of judging (David, 2026-11-10): per mode, every family ranked by
   * its wins, with what one of its images costs beside it — exact for a flat
   * price, approximate (`exact: false`) for a token price. The judging page
   * shows no price; this is where quality meets price.
   */
  ranking: Record<string, Array<{ family: string; engineId: string; wins: number; usdPerImage: number | null; exact: boolean }>>;
  /** Per mode, the family (or tied families) with the most wins. */
  leaders: Record<string, { families: string[]; wins: number; judged: number }>;
  /** "Not the person" marks per family, against the human-reference panels judged. */
  faceMismatches: Record<string, number>;
  humanReferencePanelsJudged: number;
  /** Per engine: calls made and what they could have cost (each recorded at its bound). */
  costs: Record<string, { family: string; calls: number; boundUsd: number }>;
  preparationBoundUsd: number;
  perPanel: Array<{
    panelId: number;
    setId: number;
    factId: number;
    scenarioKey: string;
    lookStyleId: string;
    imageMode: string;
    picked: { engineId: string; family: string } | null;
    faceMismatches: Array<{ engineId: string; family: string }>;
  }>;
}

const bump = (w: Wins, k: string) => { w[k] = (w[k] ?? 0) + 1; };

export async function getComparisonResults(setIds: number[]): Promise<ComparisonResults | null> {
  const sets = await db.select().from(comparisonSetsTable).where(inArray(comparisonSetsTable.id, setIds)).orderBy(asc(comparisonSetsTable.id));
  if (sets.length !== setIds.length) return null;
  const { panels, cellsByPanel, picks } = await panelRows(setIds);
  const allCells = [...cellsByPanel.values()].flat();
  const engineIds = [...new Set(allCells.map((c) => c.engineId))];
  const engines = engineIds.length ? await db.select({ id: enginesTable.id, family: enginesTable.family, priceModel: enginesTable.priceModel }).from(enginesTable).where(inArray(enginesTable.id, engineIds)) : [];
  const familyOfEngine = new Map(engines.map((e) => [e.id, e.family ?? e.id]));
  const cellById = new Map(allCells.map((c) => [c.id, c]));
  const familyOfCell = (id: number) => {
    const engineId = cellById.get(id)?.engineId ?? "?";
    return { engineId, family: familyOfEngine.get(engineId) ?? engineId };
  };

  const wins: ComparisonResults["wins"] = { overall: {}, byMode: {}, byStyle: {}, byScenario: {} };
  const judgedByMode: Record<string, number> = {};
  const faceMismatches: Wins = {};
  let humanJudged = 0;
  const perPanel: ComparisonResults["perPanel"] = [];
  for (const panel of panels) {
    const pick = picks.get(panel.id);
    const picked = pick ? familyOfCell(pick.pickedCellId) : null;
    const marks = pick ? asIds(pick.faceMismatchCellIds).map(familyOfCell) : [];
    if (picked) {
      bump(wins.overall, picked.family);
      bump((wins.byMode[panel.imageMode] ??= {}), picked.family);
      bump((wins.byStyle[panel.lookStyleId] ??= {}), picked.family);
      bump((wins.byScenario[panel.scenarioKey] ??= {}), picked.family);
      judgedByMode[panel.imageMode] = (judgedByMode[panel.imageMode] ?? 0) + 1;
      if (isHumanReference(panel.scenarioKey)) humanJudged += 1;
      for (const m of marks) bump(faceMismatches, m.family);
    }
    perPanel.push({
      panelId: panel.id, setId: panel.setId, factId: panel.factId, scenarioKey: panel.scenarioKey,
      lookStyleId: panel.lookStyleId, imageMode: panel.imageMode, picked, faceMismatches: marks,
    });
  }

  // Every engine that drew a panel of a mode, ranked by its family's wins in that mode.
  const priceOf = new Map(engines.map((e) => [e.id, e.priceModel ? perImagePrice(e.priceModel as PriceModel) : null]));
  const enginesByMode = new Map<string, Set<string>>();
  for (const panel of panels) {
    const set = enginesByMode.get(panel.imageMode) ?? new Set<string>();
    for (const c of cellsByPanel.get(panel.id) ?? []) set.add(c.engineId);
    enginesByMode.set(panel.imageMode, set);
  }
  const ranking: ComparisonResults["ranking"] = {};
  for (const [mode, ids] of enginesByMode) {
    ranking[mode] = [...ids].map((engineId) => {
      const family = familyOfEngine.get(engineId) ?? engineId;
      const price = priceOf.get(engineId) ?? null;
      return { family, engineId, wins: wins.byMode[mode]?.[family] ?? 0, usdPerImage: price?.usd ?? null, exact: price?.exact ?? false };
    }).sort((a, b) => b.wins - a.wins || a.family.localeCompare(b.family));
  }

  const leaders: ComparisonResults["leaders"] = {};
  for (const [mode, w] of Object.entries(wins.byMode)) {
    const top = Math.max(...Object.values(w));
    leaders[mode] = { families: Object.keys(w).filter((f) => w[f] === top).sort(), wins: top, judged: judgedByMode[mode] ?? 0 };
  }

  // What each engine's calls could have cost: every image call that reached
  // fal (settled, or held because it failed after submission) at its bound.
  const reservations = await db.select({
    kind: comparisonReservationsTable.kind,
    target: comparisonReservationsTable.target,
    state: comparisonReservationsTable.state,
    boundUsd: comparisonReservationsTable.boundUsd,
  }).from(comparisonReservationsTable)
    .innerJoin(comparisonRunsTable, eq(comparisonRunsTable.id, comparisonReservationsTable.runId))
    .where(inArray(comparisonRunsTable.setId, setIds));
  const costs: ComparisonResults["costs"] = {};
  let preparation = 0;
  for (const r of reservations) {
    if (r.state === "released") continue;
    if (r.kind === "planner") { preparation += Number(r.boundUsd); continue; }
    const c = (costs[r.target] ??= { family: familyOfEngine.get(r.target) ?? r.target, calls: 0, boundUsd: 0 });
    c.calls += 1;
    c.boundUsd = round4(c.boundUsd + Number(r.boundUsd));
  }

  const families = [...new Set(allCells.map((c) => familyOfEngine.get(c.engineId) ?? c.engineId))].sort();
  return {
    sets: sets.map((s) => ({ id: s.id, label: s.label, round: s.round })),
    families,
    panels: {
      total: panels.length,
      judged: picks.size,
      judgeable: panels.filter((p) => isJudgeable(cellsByPanel.get(p.id) ?? [])).length,
      skipped: panels.filter((p) => p.state === "skipped").length,
      lost: panels.filter((p) => panelWait(p, cellsByPanel.get(p.id) ?? []) === "lost").length,
    },
    wins,
    ranking,
    leaders,
    faceMismatches,
    humanReferencePanelsJudged: humanJudged,
    costs,
    preparationBoundUsd: round4(preparation),
    perPanel,
  };
}

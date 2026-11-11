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
 * - **Every image is scored 1 to 5** (David, 2026-11-10: *"Set up the
 *   judging such that each image is rated on a scale of 1 - 5. That way, we
 *   can calculate a ranking that makes more sense."*), in place of picking
 *   the best one.
 * - **A panel is judgeable once every cell is settled** — it has a stored
 *   image, or it is lost for good — and at least one image exists. Until
 *   then it shows how many are ready and none of them. A lost image is shown
 *   as missing, naming no engine, and the rest are scored: the engine that
 *   could not draw simply has no score there, and the results count how often
 *   that happened. A panel skipped at preparation stays listed, with its
 *   reason, and counts in every total: a smaller comparison is never a silent
 *   one (plan, *Proposed Design* C).
 * - **Scores are recorded against the hidden cells.** Re-judging replaces
 *   them and keeps the previous ones in the row's history.
 * - **Results reveal the engines**: each family's average score per mode
 *   (text-to-image; reference edit), per style and per scenario, ranked, with
 *   how many images were scored, how many it could not draw, the face marks,
 *   and what each engine's calls could have cost (no bill is read: David's
 *   override, 2026-11-07, `decisions.md`).
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
import { COMPARISON_SCORE_MAX, COMPARISON_SCORE_MIN, RENDER_SCENARIO_DESCRIPTORS, type ComparisonPickRequest, type RenderScenarioKey } from "@workspace/api-zod";
import { renderCanonical } from "../renderCanonical";
import { round4 } from "./admission";
import { perImagePrice, type PriceModel } from "../engines";
import { groupCellsByPanel } from "./sets";
import { promptTextOf } from "./runs";

export { blindToken } from "./blindToken";
import { blindToken } from "./blindToken";

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

/**
 * A cell whose image will never exist: skipped, or failed after its one
 * re-run with no image kept at the vendor.
 */
export const cellLost = (c: ComparisonCell) =>
  c.state === "skipped" || (c.state === "failed" && !c.vendorResultUrl && c.rerunCount >= 1);

/**
 * Every cell is settled — it has a stored image or is lost for good — and at
 * least one image exists: the state in which a panel can be scored. A lost
 * image does not hold the panel back; it is shown as missing.
 */
export function isJudgeable(cells: ComparisonCell[]): boolean {
  return cells.some(hasImage) && cells.every((c) => hasImage(c) || cellLost(c));
}

/**
 * Why a panel that is neither judgeable nor skipped is waiting, in words
 * that name no engine:
 * - "lost": every one of its images is lost for good, so there is nothing
 *   to score; it is never shown as work in progress;
 * - "needs_action": something on the comparison screen would move it on (a
 *   failed panel to prepare again, a failed cell to re-run or to retry its
 *   storage);
 * - "rendering": its images are still being prepared or drawn.
 */
export type PanelWait = "lost" | "needs_action" | "rendering";

export function panelWait(panel: Pick<ComparisonPanel, "state">, cells: ComparisonCell[]): PanelWait | null {
  if (panel.state === "skipped" || isJudgeable(cells)) return null;
  if (cells.length > 0 && cells.every(cellLost)) return "lost";
  if (panel.state === "failed" || cells.some((c) => c.state === "failed" && !cellLost(c))) return "needs_action";
  return "rendering";
}

/** A stored judgement's scores, by cell id; malformed entries are dropped. */
export function ratingsOf(v: unknown): Map<number, number> {
  const out = new Map<number, number>();
  if (!Array.isArray(v)) return out;
  for (const r of v) {
    const { cellId, score } = (r ?? {}) as { cellId?: unknown; score?: unknown };
    if (typeof cellId === "number" && Number.isInteger(score) && (score as number) >= COMPARISON_SCORE_MIN && (score as number) <= COMPARISON_SCORE_MAX) {
      out.set(cellId, score as number);
    }
  }
  return out;
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
  /**
   * The source photo every engine of a reference panel was given (the same
   * resized default reference), shown beside the pictures so a likeness can be
   * judged against it (David, 2026-11-10). Identical for every engine, so it
   * names none. Null on a text-to-image panel.
   */
  reference: { src: string; identityType: string | null } | null;
  /**
   * The prompt every engine of this panel was sent, word for word (the
   * panel's frozen compiled prompt), so how faithfully each picture follows
   * it can be judged (David, 2026-11-10). The same for every engine, so it
   * names none. Null before the panel is prepared.
   */
  prompt: string | null;
  judgeable: boolean;
  /** Skipped at preparation: it will never be judged. Its reason names no engine. */
  skipped: boolean;
  skipReason: string | null;
  /** Why a panel that is neither judgeable nor skipped is waiting; null otherwise. */
  waiting: PanelWait | null;
  imagesReady: number;
  imagesExpected: number;
  /** Images lost for good (shown as missing, naming no engine). */
  imagesMissing: number;
  /** Empty until the panel is judgeable; only the images that exist. */
  images: BlindImage[];
  /** The saved scores, by blind token. */
  pick: { ratings: Record<string, number>; faceMismatchTokens: string[]; judgedAt: string } | null;
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
    const scores = pick ? ratingsOf(pick.ratings) : new Map<number, number>();
    const savedRatings = Object.fromEntries([...scores].filter(([id]) => tokenOf.has(id)).map(([id, score]) => [tokenOf.get(id)!, score]));
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
      reference: panel.referenceImageUrl ? { src: panel.referenceImageUrl, identityType: panel.referenceIdentityType } : null,
      prompt: promptTextOf(panel.compiledPrompt),
      judgeable,
      skipped: panel.state === "skipped",
      skipReason: panel.state === "skipped" ? panel.skipReason : null,
      waiting: panelWait(panel, cells),
      imagesReady: cells.filter(hasImage).length,
      imagesExpected: cells.length,
      imagesMissing: cells.filter(cellLost).length,
      images: judgeable
        ? ordered.filter((o) => hasImage(o.cell)).map((o) => ({ token: o.token, src: `/api/admin/comparison/panels/${panel.id}/images/${o.token}` }))
        : [],
      pick: pick && Object.keys(savedRatings).length > 0
        ? {
          ratings: savedRatings,
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

/**
 * Record (or replace) David's scores for a panel: exactly one score for each
 * image the panel shows, none for a missing one.
 */
export async function recordPick(panelId: number, req: ComparisonPickRequest, adminUserId: string | null): Promise<{ ratings: Record<string, number>; faceMismatchTokens: string[] }> {
  return db.transaction(async (tx) => {
    const [panel] = await tx.select().from(comparisonPanelsTable).where(eq(comparisonPanelsTable.id, panelId)).for("update");
    if (!panel) throw new ComparisonPickRefused("no such panel");
    const cells = await tx.select().from(comparisonCellsTable).where(eq(comparisonCellsTable.panelId, panelId));
    if (!isJudgeable(cells)) throw new ComparisonPickRefused("this panel cannot be judged until every image is ready or lost for good");
    const tokens = cellsByToken(panel, cells);
    const byToken = new Map([...tokens].map(([t, c]) => [t, c.id]));
    const shown = new Set([...tokens].filter(([, c]) => hasImage(c)).map(([t]) => t));
    const scored = new Map<string, number>();
    for (const r of req.ratings) {
      if (scored.has(r.token)) throw new ComparisonPickRefused("an image is scored twice");
      if (!shown.has(r.token)) throw new ComparisonPickRefused("a score names an image that is not one of this panel's");
      scored.set(r.token, r.score);
    }
    if (scored.size !== shown.size) throw new ComparisonPickRefused(`score every image: ${scored.size} of ${shown.size} scored`);
    const ratings = [...scored].map(([t, score]) => ({ cellId: byToken.get(t)!, score }));
    const marks = [...new Set(req.faceMismatchTokens)];
    if (marks.length && !isHumanReference(panel.scenarioKey)) throw new ComparisonPickRefused("faces are marked only on panels with a person's reference photo");
    const markIds = marks.map((t) => byToken.get(t));
    if (markIds.some((id) => id == null) || marks.some((t) => !shown.has(t))) throw new ComparisonPickRefused("a face mark names an image that is not this panel's");

    const [existing] = await tx.select().from(comparisonPicksTable).where(eq(comparisonPicksTable.panelId, panelId));
    const now = new Date();
    if (!existing) {
      await tx.insert(comparisonPicksTable).values({ panelId, ratings, faceMismatchCellIds: markIds, judgedBy: adminUserId, judgedAt: now });
    } else {
      const history = [...(Array.isArray(existing.history) ? existing.history : []), {
        ratings: existing.ratings,
        faceMismatchCellIds: existing.faceMismatchCellIds,
        judgedBy: existing.judgedBy,
        judgedAt: existing.judgedAt.toISOString(),
      }];
      await tx.update(comparisonPicksTable)
        .set({ ratings, faceMismatchCellIds: markIds, judgedBy: adminUserId, judgedAt: now, history })
        .where(and(eq(comparisonPicksTable.id, existing.id), eq(comparisonPicksTable.panelId, panelId)));
    }
    return { ratings: Object.fromEntries(scored), faceMismatchTokens: marks };
  });
}

// ─── Results ──────────────────────────────────────────────────────────────────

/** The score a picture an engine could not draw counts as (David, 2026-11-10). */
export const LOST_IMAGE_SCORE = COMPARISON_SCORE_MIN;

/** An average score: the mean of `count` scores of 1 to 5, or null when none. */
export interface Score { mean: number | null; count: number }
type Scores = Record<string, Score>;

export interface RankRow {
  /** 1-based; engines with the same average share a rank. */
  rank: number;
  family: string;
  engineId: string;
  mean: number | null;
  /** Images of this engine David scored in this mode. */
  scored: number;
  /** This engine's images in this mode, on judged panels, lost for good; each counts as a 1 in `mean`. */
  lost: number;
  usdPerImage: number | null;
  exact: boolean;
  /**
   * How long this engine took per picture in this mode, from sending the
   * request to fal to getting the image back (fal's queue plus drawing), in
   * seconds: the median and the slowest, over `timed` pictures. Null when none
   * was timed (David, 2026-11-10: render time is part of the choice).
   */
  medianSeconds: number | null;
  slowestSeconds: number | null;
  timed: number;
}

/** The middle value of a non-empty list (the mean of the two middle values for an even count). */
export function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export interface ComparisonResults {
  sets: Array<{ id: number; label: string; round: number }>;
  families: string[];
  /** Every panel of the sets counts in `total`; `skipped` will never be judged. */
  panels: { total: number; judged: number; judgeable: number; skipped: number; lost: number };
  /** Each family's average score, per grouping. */
  scores: {
    overall: Scores;
    /** "t2i" (text-to-image) and "i2i" (reference edit): a winner each. */
    byMode: Record<string, Scores>;
    byStyle: Record<string, Scores>;
    byScenario: Record<string, Scores>;
  };
  /**
   * Per mode, every engine that drew a panel, ranked by its average score,
   * with what one of its images costs beside it — exact for a flat price,
   * approximate (`exact: false`) for a token price. Stage 2 of judging (David,
   * 2026-11-10): the judging page shows no price; this is where quality meets
   * price.
   */
  ranking: Record<string, RankRow[]>;
  /** Per mode, the family (or tied families) with the highest average score. */
  /** `pictures[i]` is how many pictures `families[i]`'s average rests on (scored, plus lost counted as 1). */
  leaders: Record<string, { families: string[]; pictures: number[]; mean: number; judged: number }>;
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
    ratings: Array<{ engineId: string; family: string; score: number }>;
    faceMismatches: Array<{ engineId: string; family: string }>;
  }>;
}

type Tally = { sum: number; count: number };
const tally = (t: Record<string, Tally>, k: string, score: number) => {
  const cur = (t[k] ??= { sum: 0, count: 0 });
  cur.sum += score;
  cur.count += 1;
};
const meanOf = (t: Tally | undefined): number | null => (t && t.count > 0 ? Math.round((t.sum / t.count) * 100) / 100 : null);
const toScores = (t: Record<string, Tally>): Scores => Object.fromEntries(Object.entries(t).map(([k, v]) => [k, { mean: meanOf(v), count: v.count }]));
const toGroupedScores = (g: Record<string, Record<string, Tally>>): Record<string, Scores> => Object.fromEntries(Object.entries(g).map(([k, v]) => [k, toScores(v)]));
const bump = (w: Record<string, number>, k: string) => { w[k] = (w[k] ?? 0) + 1; };

const timing = (secs: number[]) => secs.length
  ? { medianSeconds: Math.round(median(secs) * 10) / 10, slowestSeconds: Math.round(Math.max(...secs) * 10) / 10, timed: secs.length }
  : { medianSeconds: null, slowestSeconds: null, timed: 0 };

/** Rank rows by average score, best first; equal averages share a rank, unscored rows last. */
export function rankByMean<T extends { mean: number | null; family: string }>(rows: T[]): Array<T & { rank: number }> {
  const sorted = [...rows].sort((a, b) => (b.mean ?? -1) - (a.mean ?? -1) || a.family.localeCompare(b.family));
  let rank = 0;
  return sorted.map((row, i) => {
    if (i === 0 || row.mean !== sorted[i - 1]!.mean) rank = i + 1;
    return { ...row, rank };
  });
}

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

  const overall: Record<string, Tally> = {};
  const byMode: Record<string, Record<string, Tally>> = {};
  const byStyle: Record<string, Record<string, Tally>> = {};
  const byScenario: Record<string, Record<string, Tally>> = {};
  /** Keyed `${mode}|${engineId}`. */
  const byEngineMode: Record<string, Tally> = {};
  const lostByEngineMode: Record<string, number> = {};
  const enginesByMode = new Map<string, Set<string>>();
  /** Keyed `${mode}|${engineId}`: seconds from submission to the image coming back. */
  const secondsByEngineMode: Record<string, number[]> = {};
  const judgedByMode: Record<string, number> = {};
  const faceMismatches: Record<string, number> = {};
  let humanJudged = 0;
  let judged = 0;
  const perPanel: ComparisonResults["perPanel"] = [];
  for (const panel of panels) {
    const cells = cellsByPanel.get(panel.id) ?? [];
    const engines = enginesByMode.get(panel.imageMode) ?? new Set<string>();
    enginesByMode.set(panel.imageMode, engines);
    for (const c of cells) {
      engines.add(c.engineId);
      if (c.submittedAt && c.completedAt) {
        (secondsByEngineMode[`${panel.imageMode}|${c.engineId}`] ??= []).push((c.completedAt.getTime() - c.submittedAt.getTime()) / 1000);
      }
    }
    const pick = picks.get(panel.id);
    const scores = pick ? ratingsOf(pick.ratings) : new Map<number, number>();
    const ratings = [...scores].map(([cellId, score]) => ({ ...familyOfCell(cellId), score }));
    const marks = pick ? asIds(pick.faceMismatchCellIds).map(familyOfCell) : [];
    if (ratings.length > 0) {
      judged += 1;
      judgedByMode[panel.imageMode] = (judgedByMode[panel.imageMode] ?? 0) + 1;
      // A picture an engine could not draw counts as the lowest score (David,
      // 2026-11-10: "Count it as 1"), on the panels David judged.
      const lostAsScores = cells.filter(cellLost).map((c) => ({ ...familyOfCell(c.id), score: LOST_IMAGE_SCORE }));
      for (const l of lostAsScores) bump(lostByEngineMode, `${panel.imageMode}|${l.engineId}`);
      for (const r of [...ratings, ...lostAsScores]) {
        tally(overall, r.family, r.score);
        tally((byMode[panel.imageMode] ??= {}), r.family, r.score);
        tally((byStyle[panel.lookStyleId] ??= {}), r.family, r.score);
        tally((byScenario[panel.scenarioKey] ??= {}), r.family, r.score);
        tally(byEngineMode, `${panel.imageMode}|${r.engineId}`, r.score);
      }
      if (isHumanReference(panel.scenarioKey)) humanJudged += 1;
      for (const m of marks) bump(faceMismatches, m.family);
    }
    perPanel.push({
      panelId: panel.id, setId: panel.setId, factId: panel.factId, scenarioKey: panel.scenarioKey,
      lookStyleId: panel.lookStyleId, imageMode: panel.imageMode, ratings, faceMismatches: marks,
    });
  }

  // Every engine that drew a panel of a mode, ranked by its average score in that mode.
  const priceOf = new Map(engines.map((e) => [e.id, e.priceModel ? perImagePrice(e.priceModel as PriceModel) : null]));
  const ranking: ComparisonResults["ranking"] = {};
  for (const [mode, ids] of enginesByMode) {
    ranking[mode] = rankByMean([...ids].map((engineId) => {
      const t = byEngineMode[`${mode}|${engineId}`];
      const price = priceOf.get(engineId) ?? null;
      return {
        family: familyOfEngine.get(engineId) ?? engineId,
        engineId,
        mean: meanOf(t),
        scored: (t?.count ?? 0) - (lostByEngineMode[`${mode}|${engineId}`] ?? 0),
        lost: lostByEngineMode[`${mode}|${engineId}`] ?? 0,
        usdPerImage: price?.usd ?? null,
        exact: price?.exact ?? false,
        ...timing(secondsByEngineMode[`${mode}|${engineId}`] ?? []),
      };
    }));
  }

  const leaders: ComparisonResults["leaders"] = {};
  for (const [mode, rows] of Object.entries(ranking)) {
    const top = rows.filter((r) => r.rank === 1 && r.mean != null);
    if (top.length) {
      const sorted = [...top].sort((a, b) => a.family.localeCompare(b.family));
      leaders[mode] = { families: sorted.map((r) => r.family), pictures: sorted.map((r) => r.scored + r.lost), mean: top[0]!.mean!, judged: judgedByMode[mode] ?? 0 };
    }
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
      judged,
      judgeable: panels.filter((p) => isJudgeable(cellsByPanel.get(p.id) ?? [])).length,
      skipped: panels.filter((p) => p.state === "skipped").length,
      lost: panels.filter((p) => panelWait(p, cellsByPanel.get(p.id) ?? []) === "lost").length,
    },
    scores: {
      overall: toScores(overall),
      byMode: toGroupedScores(byMode),
      byStyle: toGroupedScores(byStyle),
      byScenario: toGroupedScores(byScenario),
    },
    ranking,
    leaders,
    faceMismatches,
    humanReferencePanelsJudged: humanJudged,
    costs,
    preparationBoundUsd: round4(preparation),
    perPanel,
  };
}

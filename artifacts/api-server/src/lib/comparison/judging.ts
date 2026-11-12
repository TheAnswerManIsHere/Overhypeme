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
  promptRecipeVersionsTable,
  type ComparisonCell,
  type ComparisonPanel,
} from "@workspace/db/schema";
import {
  COMPARISON_SCORE_MAX,
  COMPARISON_SCORE_MIN,
  JUDGING_CATEGORY_KEYS,
  RENDER_SCENARIO_DESCRIPTORS,
  judgingCategoriesFor,
  type ComparisonJudgementRequest,
  type ComparisonPickRequest,
  type JudgingCategoryKey,
  type RenderScenarioKey,
} from "@workspace/api-zod";
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

/**
 * Whether a panel's engines were given a photo — a person, a pet or an
 * object — so Likeness is asked (David, 2026-11-12: "Likeness is what I'm
 * going for").
 */
export function hasReferencePhoto(scenarioKey: string): boolean {
  return !!RENDER_SCENARIO_DESCRIPTORS[scenarioKey as RenderScenarioKey]?.referenceIdentityType;
}

/** The second-edition categories asked on a panel. */
export const panelCategories = (panel: Pick<ComparisonPanel, "lookStyleId" | "scenarioKey">): JudgingCategoryKey[] =>
  judgingCategoriesFor({ styled: isStyled(panel.lookStyleId), hasPhoto: hasReferencePhoto(panel.scenarioKey) });

/** One picture's second-edition scores, by category. */
export type CategoryScores = Partial<Record<JudgingCategoryKey, number>>;

/** A stored second-edition judgement's scores, by cell id; malformed entries and out-of-range scores are dropped. */
export function categoryScoresOf(v: unknown): Map<number, CategoryScores> {
  const out = new Map<number, CategoryScores>();
  if (!Array.isArray(v)) return out;
  for (const r of v) {
    const row = (r ?? {}) as Record<string, unknown>;
    if (typeof row["cellId"] !== "number") continue;
    const scores: CategoryScores = {};
    for (const k of JUDGING_CATEGORY_KEYS) {
      const s = row[k];
      if (Number.isInteger(s) && (s as number) >= COMPARISON_SCORE_MIN && (s as number) <= COMPARISON_SCORE_MAX) scores[k] = s as number;
    }
    out.set(row["cellId"] as number, scores);
  }
  return out;
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
  /** A styled panel: each picture can be marked "captured the style". */
  styleMarkable: boolean;
  /**
   * Second edition: the approved visual gag the panel is judged against,
   * frozen at preparation; null on the first edition, before preparation, or
   * for a fact with no approved gag.
   */
  gag: string | null;
  /** Second edition: the categories each picture is scored on; empty on the first edition. */
  categories: JudgingCategoryKey[];
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
   * names none. Null before the panel is prepared, and always null on the
   * second edition, which is judged against the gag and never the prompt
   * (plan `docs/plans/PLAN_PROMPT_TUNER.md`, *Proposed Design* B).
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
  /** First edition: the saved scores, by blind token. */
  pick: { ratings: Record<string, number>; faceMismatchTokens: string[]; styleCapturedTokens: string[]; judgedAt: string } | null;
  /** Second edition: the saved judgement, by blind token. */
  judgement: { scores: Record<string, CategoryScores>; bestToken: string | null; brokenTokens: string[]; judgedAt: string } | null;
}
export interface BlindSet {
  set: { id: number; label: string; round: number; judgingEdition: number };
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
  const second = set.judgingEdition >= 2;
  // The second edition reads only what was frozen at preparation; the live fact row is the first edition's.
  const factIds = second ? [] : [...new Set(panels.map((p) => p.factId))];
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
    const categoryScores = second && pick ? categoryScoresOf(pick.categoryScores) : new Map<number, CategoryScores>();
    const savedScores = Object.fromEntries([...categoryScores].filter(([id]) => tokenOf.has(id)).map(([id, s]) => [tokenOf.get(id)!, s]));
    out.push({
      panelId: panel.id,
      position: out.length + 1,
      factId: panel.factId,
      factText: second ? (panel.frozenFactText ?? "") : (factText.get(panel.factId) ?? ""),
      scenarioKey: panel.scenarioKey,
      scenarioLabel: RENDER_SCENARIO_DESCRIPTORS[panel.scenarioKey as RenderScenarioKey]?.label ?? panel.scenarioKey,
      lookStyleId: panel.lookStyleId,
      imageMode: panel.imageMode,
      faceMarkable: isHumanReference(panel.scenarioKey),
      styleMarkable: isStyled(panel.lookStyleId),
      gag: second ? panel.frozenGag : null,
      categories: second ? panelCategories(panel) : [],
      reference: panel.referenceImageUrl ? { src: panel.referenceImageUrl, identityType: panel.referenceIdentityType } : null,
      prompt: second ? null : promptTextOf(panel.compiledPrompt),
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
      pick: !second && pick && Object.keys(savedRatings).length > 0
        ? {
          ratings: savedRatings,
          faceMismatchTokens: asIds(pick.faceMismatchCellIds).map((id) => tokenOf.get(id)).filter((t): t is string => !!t),
          styleCapturedTokens: asIds(pick.styleCapturedCellIds).map((id) => tokenOf.get(id)).filter((t): t is string => !!t),
          judgedAt: pick.judgedAt.toISOString(),
        }
        : null,
      judgement: second && pick && Object.keys(savedScores).length > 0
        ? {
          scores: savedScores,
          bestToken: pick.pickedCellId != null ? (tokenOf.get(pick.pickedCellId) ?? null) : null,
          brokenTokens: asIds(pick.brokenCellIds).map((id) => tokenOf.get(id)).filter((t): t is string => !!t),
          judgedAt: pick.judgedAt.toISOString(),
        }
        : null,
    });
  }
  return {
    set: { id: set.id, label: set.label, round: set.round, judgingEdition: set.judgingEdition },
    progress: {
      panels: out.length,
      judgeable: out.filter((p) => p.judgeable).length,
      judged: out.filter((p) => p.pick || p.judgement).length,
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
/** A panel with a look style, on which "captured the style" can be marked. */
export const isStyled = (lookStyleId: string): boolean => lookStyleId !== "none";

export async function recordPick(panelId: number, req: ComparisonPickRequest, adminUserId: string | null): Promise<{ ratings: Record<string, number>; faceMismatchTokens: string[]; styleCapturedTokens: string[] }> {
  return db.transaction(async (tx) => {
    const [panel] = await tx.select().from(comparisonPanelsTable).where(eq(comparisonPanelsTable.id, panelId)).for("update");
    if (!panel) throw new ComparisonPickRefused("no such panel");
    if ((await editionOfSet(tx, panel.setId)) !== 1) throw new ComparisonPickRefused("this set is judged on the five categories, with a pick");
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
    const styleMarks = [...new Set(req.styleCapturedTokens ?? [])];
    if (styleMarks.length && !isStyled(panel.lookStyleId)) throw new ComparisonPickRefused("\"captured the style\" is marked only on panels with a look style");
    if (styleMarks.some((t) => !shown.has(t))) throw new ComparisonPickRefused("a style mark names an image that is not this panel's");
    const styleIds = styleMarks.map((t) => byToken.get(t)!);

    await saveJudgement(tx, panelId, { ratings, faceMismatchCellIds: markIds, styleCapturedCellIds: styleIds, judgedBy: adminUserId, judgedAt: new Date() });
    return { ratings: Object.fromEntries(scored), faceMismatchTokens: marks, styleCapturedTokens: styleMarks };
  });
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function editionOfSet(tx: Tx, setId: number): Promise<number> {
  const [set] = await tx.select({ e: comparisonSetsTable.judgingEdition }).from(comparisonSetsTable).where(eq(comparisonSetsTable.id, setId));
  return set?.e ?? 1;
}

/** A judgement's history entry: every judgement field as it stood, with who and when. */
function historyEntry(existing: typeof comparisonPicksTable.$inferSelect) {
  return {
    ratings: existing.ratings,
    faceMismatchCellIds: existing.faceMismatchCellIds,
    styleCapturedCellIds: existing.styleCapturedCellIds,
    categoryScores: existing.categoryScores,
    pickedCellId: existing.pickedCellId,
    brokenCellIds: existing.brokenCellIds,
    judgedBy: existing.judgedBy,
    judgedAt: existing.judgedAt.toISOString(),
  };
}

/** Write a panel's judgement, moving any earlier one into the row's history. */
async function saveJudgement(tx: Tx, panelId: number, values: Omit<typeof comparisonPicksTable.$inferInsert, "panelId" | "history">): Promise<void> {
  const [existing] = await tx.select().from(comparisonPicksTable).where(eq(comparisonPicksTable.panelId, panelId));
  if (!existing) {
    await tx.insert(comparisonPicksTable).values({ panelId, ...values });
    return;
  }
  const history = [...(Array.isArray(existing.history) ? existing.history : []), historyEntry(existing)];
  await tx.update(comparisonPicksTable).set({ ...values, history })
    .where(and(eq(comparisonPicksTable.id, existing.id), eq(comparisonPicksTable.panelId, panelId)));
}

/**
 * Which judging edition a group of sets was judged on: 1, 2, "mixed" (sets
 * of both, never read together), or null when any of them does not exist.
 */
export async function editionOfSets(setIds: number[]): Promise<1 | 2 | "mixed" | null> {
  const rows = await db.select({ e: comparisonSetsTable.judgingEdition }).from(comparisonSetsTable).where(inArray(comparisonSetsTable.id, setIds));
  if (rows.length !== setIds.length) return null;
  const editions = new Set(rows.map((r) => (r.e >= 2 ? 2 : 1)));
  return editions.size > 1 ? "mixed" : ([...editions][0] as 1 | 2);
}

/**
 * Record (or replace) a second-edition judgement of a panel (plan
 * `docs/plans/PLAN_PROMPT_TUNER.md`, *Proposed Design* C): every picture
 * shown scored on exactly the categories that apply to the panel, one of
 * them picked, any of them marked broken. A partial judgement is refused.
 */
export async function recordJudgement(panelId: number, req: ComparisonJudgementRequest, adminUserId: string | null): Promise<{ scores: Record<string, CategoryScores>; bestToken: string; brokenTokens: string[] }> {
  return db.transaction(async (tx) => {
    const [panel] = await tx.select().from(comparisonPanelsTable).where(eq(comparisonPanelsTable.id, panelId)).for("update");
    if (!panel) throw new ComparisonPickRefused("no such panel");
    if ((await editionOfSet(tx, panel.setId)) < 2) throw new ComparisonPickRefused("this set is judged with one score per picture");
    const cells = await tx.select().from(comparisonCellsTable).where(eq(comparisonCellsTable.panelId, panelId));
    if (!isJudgeable(cells)) throw new ComparisonPickRefused("this panel cannot be judged until every image is ready or lost for good");
    const tokens = cellsByToken(panel, cells);
    const shown = new Set([...tokens].filter(([, c]) => hasImage(c)).map(([t]) => t));
    const asked = new Set(panelCategories(panel));
    const scored = new Map<string, CategoryScores>();
    for (const s of req.scores) {
      if (scored.has(s.token)) throw new ComparisonPickRefused("a picture is scored twice");
      if (!shown.has(s.token)) throw new ComparisonPickRefused("a score names a picture that is not one of this panel's");
      const scores: CategoryScores = {};
      for (const k of JUDGING_CATEGORY_KEYS) {
        const v = s[k];
        if (asked.has(k) && v == null) throw new ComparisonPickRefused(`every picture needs a ${k} score on this panel`);
        if (!asked.has(k) && v != null) throw new ComparisonPickRefused(`${k} is not asked on this panel`);
        if (v != null) scores[k] = v;
      }
      scored.set(s.token, scores);
    }
    if (scored.size !== shown.size) throw new ComparisonPickRefused(`score every picture: ${scored.size} of ${shown.size} scored`);
    if (!shown.has(req.bestToken)) throw new ComparisonPickRefused("the pick names a picture that is not one of this panel's");
    const broken = [...new Set(req.brokenTokens ?? [])];
    if (broken.some((t) => !shown.has(t))) throw new ComparisonPickRefused("a broken mark names a picture that is not this panel's");
    const idOf = (t: string) => tokens.get(t)!.id;
    const categoryScores = [...scored].map(([t, s]) => ({ cellId: idOf(t), ...s }));
    const values = {
      ratings: [],
      faceMismatchCellIds: [],
      styleCapturedCellIds: [],
      categoryScores,
      pickedCellId: idOf(req.bestToken),
      brokenCellIds: broken.map(idOf),
      judgedBy: adminUserId,
      judgedAt: new Date(),
    };
    await saveJudgement(tx, panelId, values);
    return { scores: Object.fromEntries(scored), bestToken: req.bestToken, brokenTokens: broken };
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
   * What fal actually charged per picture for this engine in this mode: the
   * mean, cheapest and dearest over the `billed` pictures whose bill has been
   * read (migration 0130), and their total. Null when none has (David,
   * 2026-11-11: "I want to know for real what GPT Image is costing").
   */
  billedUsdPerImage: number | null;
  billedMinUsd: number | null;
  billedMaxUsd: number | null;
  billedTotalUsd: number | null;
  billed: number;
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
  /** First-edition results; second-edition sets read `getJudgedResults`. */
  edition: 1;
  sets: Array<{ id: number; label: string; round: number; imageSize: string }>;
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
  /**
   * "Captured the style" per look style and family, on judged styled panels:
   * how many of the family's pictures David marked, of how many it drew
   * (David, 2026-11-11: some engines may suit some styles).
   */
  styleCaptured: Record<string, Record<string, { captured: number; pictures: number }>>;
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
    styleCaptured: Array<{ engineId: string; family: string }>;
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

const billing = (usd: number[]) => usd.length
  ? { billedUsdPerImage: round4(usd.reduce((a, b) => a + b, 0) / usd.length), billedMinUsd: round4(Math.min(...usd)), billedMaxUsd: round4(Math.max(...usd)), billedTotalUsd: round4(usd.reduce((a, b) => a + b, 0)), billed: usd.length }
  : { billedUsdPerImage: null, billedMinUsd: null, billedMaxUsd: null, billedTotalUsd: null, billed: 0 };

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
  /** Keyed `${mode}|${engineId}`: what fal charged for each picture it drew. */
  const billedByEngineMode: Record<string, number[]> = {};
  const judgedByMode: Record<string, number> = {};
  const faceMismatches: Record<string, number> = {};
  const styleCaptured: ComparisonResults["styleCaptured"] = {};
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
      // The average is per picture drawn: a refusal fal did not charge for is not a cheap picture.
      if (c.billedUsd != null && c.state === "rendered") {
        (billedByEngineMode[`${panel.imageMode}|${c.engineId}`] ??= []).push(Number(c.billedUsd));
      }
    }
    const pick = picks.get(panel.id);
    const scores = pick ? ratingsOf(pick.ratings) : new Map<number, number>();
    const ratings = [...scores].map(([cellId, score]) => ({ ...familyOfCell(cellId), score }));
    const marks = pick ? asIds(pick.faceMismatchCellIds).map(familyOfCell) : [];
    const styleMarks = pick ? asIds(pick.styleCapturedCellIds).map(familyOfCell) : [];
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
      if (isStyled(panel.lookStyleId)) {
        const byFamily = (styleCaptured[panel.lookStyleId] ??= {});
        for (const r of ratings) (byFamily[r.family] ??= { captured: 0, pictures: 0 }).pictures += 1;
        for (const m of styleMarks) (byFamily[m.family] ??= { captured: 0, pictures: 0 }).captured += 1;
      }
    }
    perPanel.push({
      panelId: panel.id, setId: panel.setId, factId: panel.factId, scenarioKey: panel.scenarioKey,
      lookStyleId: panel.lookStyleId, imageMode: panel.imageMode, ratings, faceMismatches: marks, styleCaptured: styleMarks,
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
        ...billing(billedByEngineMode[`${mode}|${engineId}`] ?? []),
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
    edition: 1,
    sets: sets.map((s) => ({ id: s.id, label: s.label, round: s.round, imageSize: s.imageSize })),
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
    styleCaptured,
    costs,
    preparationBoundUsd: round4(preparation),
    perPanel,
  };
}

// ─── Second-edition results ───────────────────────────────────────────────────

/** One engine's second-edition results in one mode. */
export interface JudgedRow {
  family: string;
  engineId: string;
  /** The prompt version this row's pictures were drawn with; null is the baseline (the prompt tuner). */
  recipeVersionId: number | null;
  /** "Baseline" or "Version N". */
  recipeLabel: string;
  recipeNote: string | null;
  /** Judged panels on which this engine had a picture, drawn or lost: the pick share's denominator. */
  panels: number;
  /** Panels on which its picture was the one to send. */
  picked: number;
  /** `picked / panels`, or null when it was on no judged panel. */
  pickShare: number | null;
  /**
   * Each category's average over the pictures it was asked on, a picture
   * lost for good counting 1 (David, 2026-11-10: "Count it as 1"); a
   * category never asked has `count` 0.
   */
  categories: Record<JudgingCategoryKey, Score>;
  /** Pictures scored, lost for good (each a 1 in every category asked), and marked broken. */
  scored: number;
  lost: number;
  broken: number;
  billedUsdPerImage: number | null;
  billedMinUsd: number | null;
  billedMaxUsd: number | null;
  billedTotalUsd: number | null;
  billed: number;
  medianSeconds: number | null;
  slowestSeconds: number | null;
  timed: number;
}

export interface JudgedResults {
  edition: 2;
  /** "prompt" when every set is a prompt comparison on one family, whose versions can then be promoted here. */
  kind: "engine" | "prompt";
  family: string | null;
  sets: Array<{ id: number; label: string; round: number; imageSize: string; kind: string }>;
  panels: { total: number; judged: number; judgeable: number; skipped: number; lost: number };
  /**
   * Per mode ("t2i", "i2i"), every engine that drew a panel, by pick share
   * then name. No blended score is computed from the five categories: the
   * pick share is the headline (plan `docs/plans/PLAN_PROMPT_TUNER.md`,
   * *Proposed Design* C).
   */
  rows: Record<string, JudgedRow[]>;
  /** The same rows within each look (style id, or "none"): an engine can win photoreal and another a style. */
  byLook: Record<string, Record<string, JudgedRow[]>>;
  /** Every picture, revealed: its engine, prompt version, the exact prompt it sent, and how it was judged. */
  pictures: Array<{
    panelId: number; factId: number; scenarioKey: string; lookStyleId: string; imageMode: string;
    engineId: string; family: string; recipeVersionId: number | null; recipeLabel: string;
    promptText: string | null; picked: boolean; broken: boolean; lost: boolean; scores: CategoryScores | null;
  }>;
}

/**
 * Results for second-edition sets: per engine and mode, how often its
 * picture was the one to send, each category's average, and what it cost
 * and how long it took.
 */
export async function getJudgedResults(setIds: number[]): Promise<JudgedResults | null> {
  const sets = await db.select().from(comparisonSetsTable).where(inArray(comparisonSetsTable.id, setIds)).orderBy(asc(comparisonSetsTable.id));
  if (sets.length !== setIds.length) return null;
  const { panels, cellsByPanel, picks } = await panelRows(setIds);
  const allCells = [...cellsByPanel.values()].flat();
  const engineIds = [...new Set(allCells.map((c) => c.engineId))];
  const versionIds = [...new Set(allCells.map((c) => c.recipeVersionId).filter((v): v is number => v != null))];
  const [engines, versions] = await Promise.all([
    engineIds.length ? db.select({ id: enginesTable.id, family: enginesTable.family }).from(enginesTable).where(inArray(enginesTable.id, engineIds)) : [],
    versionIds.length ? db.select({ id: promptRecipeVersionsTable.id, number: promptRecipeVersionsTable.number, note: promptRecipeVersionsTable.note }).from(promptRecipeVersionsTable).where(inArray(promptRecipeVersionsTable.id, versionIds)) : [],
  ]);
  const familyOf = new Map(engines.map((e) => [e.id, e.family ?? e.id]));
  const versionOf = new Map(versions.map((v) => [v.id, v]));
  const recipeLabel = (id: number | null) => (id == null ? "Baseline" : `Version ${versionOf.get(id)?.number ?? "?"}`);

  // One accumulator per engine and prompt version, overall and per look.
  type Acc = { panels: number; picked: number; scored: number; lost: number; broken: number; cats: Record<string, Tally>; secs: number[]; usd: number[] };
  const newAcc = (): Acc => ({ panels: 0, picked: 0, scored: 0, lost: 0, broken: 0, cats: {}, secs: [], usd: [] });
  const overall = new Map<string, Acc>();
  const perLook = new Map<string, Map<string, Acc>>();
  const keyOf = (mode: string, c: ComparisonCell) => `${mode}|${c.engineId}|${c.recipeVersionId ?? 0}`;
  const accsFor = (look: string, key: string): Acc[] => {
    const lookMap = perLook.get(look) ?? new Map<string, Acc>();
    perLook.set(look, lookMap);
    if (!overall.has(key)) overall.set(key, newAcc());
    if (!lookMap.has(key)) lookMap.set(key, newAcc());
    return [overall.get(key)!, lookMap.get(key)!];
  };
  const pictures: JudgedResults["pictures"] = [];
  let judged = 0;
  for (const panel of panels) {
    const cells = cellsByPanel.get(panel.id) ?? [];
    for (const c of cells) {
      for (const a of accsFor(panel.lookStyleId, keyOf(panel.imageMode, c))) {
        if (c.submittedAt && c.completedAt) a.secs.push((c.completedAt.getTime() - c.submittedAt.getTime()) / 1000);
        if (c.billedUsd != null && c.state === "rendered") a.usd.push(Number(c.billedUsd));
      }
    }
    const pick = picks.get(panel.id);
    const scores = pick ? categoryScoresOf(pick.categoryScores) : new Map<number, CategoryScores>();
    const broken = new Set(pick ? asIds(pick.brokenCellIds) : []);
    for (const c of cells) {
      pictures.push({
        panelId: panel.id, factId: panel.factId, scenarioKey: panel.scenarioKey, lookStyleId: panel.lookStyleId, imageMode: panel.imageMode,
        engineId: c.engineId, family: familyOf.get(c.engineId) ?? c.engineId, recipeVersionId: c.recipeVersionId, recipeLabel: recipeLabel(c.recipeVersionId),
        promptText: c.promptText, picked: !!pick && pick.pickedCellId === c.id, broken: broken.has(c.id), lost: cellLost(c), scores: scores.get(c.id) ?? null,
      });
    }
    if (scores.size === 0) continue;
    judged += 1;
    const asked = panelCategories(panel);
    for (const c of cells) {
      const s = scores.get(c.id);
      const lost = !s && cellLost(c);
      if (!s && !lost) continue;
      for (const a of accsFor(panel.lookStyleId, keyOf(panel.imageMode, c))) {
        a.panels += 1;
        if (pick!.pickedCellId === c.id) a.picked += 1;
        if (broken.has(c.id)) a.broken += 1;
        if (lost) a.lost += 1; else a.scored += 1;
        for (const k of asked) tally(a.cats, k, lost ? LOST_IMAGE_SCORE : (s![k] ?? LOST_IMAGE_SCORE));
      }
    }
  }

  const toRows = (accs: Map<string, Acc>): Record<string, JudgedRow[]> => {
    const rows: Record<string, JudgedRow[]> = {};
    for (const [key, a] of accs) {
      const [mode, engineId, version] = key.split("|") as [string, string, string];
      const recipeVersionId = Number(version) || null;
      (rows[mode] ??= []).push({
        family: familyOf.get(engineId) ?? engineId,
        engineId,
        recipeVersionId,
        recipeLabel: recipeLabel(recipeVersionId),
        recipeNote: recipeVersionId == null ? null : (versionOf.get(recipeVersionId)?.note ?? null),
        panels: a.panels,
        picked: a.picked,
        pickShare: a.panels > 0 ? Math.round((a.picked / a.panels) * 100) / 100 : null,
        categories: { ...Object.fromEntries(JUDGING_CATEGORY_KEYS.map((k) => [k, { mean: null, count: 0 }])), ...toScores(a.cats) } as Record<JudgingCategoryKey, Score>,
        scored: a.scored,
        lost: a.lost,
        broken: a.broken,
        ...billing(a.usd),
        ...timing(a.secs),
      });
    }
    for (const list of Object.values(rows)) {
      list.sort((x, y) => (y.pickShare ?? -1) - (x.pickShare ?? -1) || x.family.localeCompare(y.family) || x.recipeLabel.localeCompare(y.recipeLabel));
    }
    return rows;
  };

  const prompt = sets.every((s) => s.kind === "prompt") && new Set(sets.map((s) => s.engineFamilies as string[]).flat()).size === 1;
  return {
    edition: 2,
    kind: prompt ? "prompt" : "engine",
    family: prompt ? (sets[0]!.engineFamilies as string[])[0]! : null,
    sets: sets.map((s) => ({ id: s.id, label: s.label, round: s.round, imageSize: s.imageSize, kind: s.kind })),
    panels: {
      total: panels.length,
      judged,
      judgeable: panels.filter((p) => isJudgeable(cellsByPanel.get(p.id) ?? [])).length,
      skipped: panels.filter((p) => p.state === "skipped").length,
      lost: panels.filter((p) => panelWait(p, cellsByPanel.get(p.id) ?? []) === "lost").length,
    },
    rows: toRows(overall),
    byLook: Object.fromEntries([...perLook].map(([look, accs]) => [look, toRows(accs)])),
    pictures,
  };
}

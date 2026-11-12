/**
 * Prompt recipes, stored (the prompt tuner, part 2; plan
 * `docs/plans/PLAN_PROMPT_TUNER.md`, *Proposed Design* A and D; migration
 * 0134). The one resolver every render path reads its wording through — the
 * render worker, the moderation preview and the comparison tool — so what a
 * preview shows is what a render sends.
 *
 * - A version is saved once and never edited.
 * - The newest promotion per engine family is live; none, or one of no
 *   version, is the baseline (today's wording).
 * - Saving or comparing a version changes nothing live; only a promotion
 *   does, and it changes wording only, never which engine is used.
 */
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { enginesTable, promptRecipePromotionsTable, promptRecipeVersionsTable } from "@workspace/db/schema";
import { BASELINE_RECIPE, RECIPE_PIECE_KEYS, changedPolicyPieces, recipeFrom, recipeProblems, type RecipePieceKey, type ResolvedRecipe } from "./recipe";
import { recipeBudgetProblems } from "./promptBudget";

export class RecipeRefused extends Error {
  constructor(message: string, readonly details: Record<string, unknown> = {}) { super(message); }
}

/** Versions are never edited, so a version read once is kept for the process's life. */
const versionCache = new Map<number, ResolvedRecipe>();

/** A stored version as the compiler uses it; null, or a version that no longer exists, is the baseline. */
export async function recipeById(versionId: number | null | undefined): Promise<ResolvedRecipe> {
  if (versionId == null) return BASELINE_RECIPE;
  const cached = versionCache.get(versionId);
  if (cached) return cached;
  const [row] = await db.select({ id: promptRecipeVersionsTable.id, pieces: promptRecipeVersionsTable.pieces }).from(promptRecipeVersionsTable).where(eq(promptRecipeVersionsTable.id, versionId));
  if (!row) return BASELINE_RECIPE;
  const recipe = recipeFrom(row.id, row.pieces);
  versionCache.set(row.id, recipe);
  return recipe;
}

/** The live version id per family (null: the baseline), for the families asked. */
export async function liveRecipeVersionIds(families: string[]): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>(families.map((f) => [f, null]));
  if (families.length === 0) return out;
  const rows = await db.execute<{ engine_family: string; version_id: number | null }>(sql`
    select distinct on (engine_family) engine_family, version_id
    from ${promptRecipePromotionsTable}
    where engine_family in (${sql.join(families.map((f) => sql`${f}`), sql`, `)})
    order by engine_family, id desc`);
  for (const r of rows.rows) out.set(r.engine_family, r.version_id == null ? null : Number(r.version_id));
  return out;
}

/** One family's live version id (null: the baseline). */
export async function liveRecipeVersionIdForFamily(family: string): Promise<number | null> {
  return (await liveRecipeVersionIds([family])).get(family) ?? null;
}

/** Each engine's family (its own id when it has none), in one read. */
export async function engineFamiliesOf(engineIds: string[]): Promise<Map<string, string>> {
  const rows = engineIds.length ? await db.select({ id: enginesTable.id, family: enginesTable.family }).from(enginesTable).where(inArray(enginesTable.id, engineIds)) : [];
  const out = new Map(engineIds.map((id) => [id, id]));
  for (const r of rows) if (r.family) out.set(r.id, r.family);
  return out;
}

/** The live version id for each engine a render could be routed to, in two reads. */
export async function liveRecipeVersionIdsForEngines(engineIds: string[]): Promise<Map<string, number | null>> {
  const families = await engineFamiliesOf(engineIds);
  const live = await liveRecipeVersionIds([...new Set(families.values())]);
  return new Map(engineIds.map((id) => [id, live.get(families.get(id)!) ?? null]));
}

/** The live version id and recipe for the engine a render is routed to. */
export async function liveRecipeForEngine(engineId: string): Promise<{ versionId: number | null; recipe: ResolvedRecipe }> {
  const versionId = (await liveRecipeVersionIdsForEngines([engineId])).get(engineId) ?? null;
  return { versionId, recipe: await recipeById(versionId) };
}

/**
 * The wording an edit starts from — the version named, the baseline for
 * null, or the family's live version when none is named — with the edited
 * pieces laid over it. Shared by save and preview, so the two never differ.
 */
export async function draftRecipe(family: string, basedOnVersionId: number | null | undefined, pieces: Record<string, string>): Promise<{ base: ResolvedRecipe; draft: ResolvedRecipe }> {
  const base = await recipeById(basedOnVersionId !== undefined ? basedOnVersionId : await liveRecipeVersionIdForFamily(family));
  return { base, draft: recipeFrom(null, { ...base.pieces, ...pieces }) };
}

async function assertImageFamily(family: string): Promise<void> {
  const rows = await db.select({ deletedAt: enginesTable.deletedAt }).from(enginesTable)
    .where(and(eq(enginesTable.family, family), eq(enginesTable.kind, "image")));
  if (!rows.some((r) => r.deletedAt == null)) throw new RecipeRefused(`"${family}" is not an image engine family`);
}

/**
 * Save a new version for a family: the pieces given over the family's live
 * wording (so an editor sending only what changed keeps everything else),
 * checked for form and for the prompt budget. Never edits a version.
 */
export async function saveRecipeVersion(args: { family: string; pieces: Record<string, string>; note: string; basedOnVersionId?: number | null; userId: string | null }): Promise<{ id: number; number: number }> {
  await assertImageFamily(args.family);
  const formProblems = recipeProblems(args.pieces);
  if (formProblems.length) throw new RecipeRefused("the wording is not valid", { problems: formProblems });
  const { base, draft: merged } = await draftRecipe(args.family, args.basedOnVersionId, args.pieces);
  const budget = recipeBudgetProblems(merged);
  if (budget.length) throw new RecipeRefused("the wording does not fit the prompt", { problems: budget });
  if (RECIPE_PIECE_KEYS.every((k) => merged.pieces[k] === base.pieces[k])) throw new RecipeRefused("nothing changed from the version it is based on");
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`prompt-recipe:${args.family}`}))`);
    const [last] = await tx.select({ n: promptRecipeVersionsTable.number }).from(promptRecipeVersionsTable)
      .where(eq(promptRecipeVersionsTable.engineFamily, args.family)).orderBy(desc(promptRecipeVersionsTable.number)).limit(1);
    const [row] = await tx.insert(promptRecipeVersionsTable).values({
      engineFamily: args.family,
      number: (last?.n ?? 0) + 1,
      pieces: merged.pieces,
      note: args.note,
      createdBy: args.userId,
    }).returning({ id: promptRecipeVersionsTable.id, number: promptRecipeVersionsTable.number });
    return row!;
  });
}

/**
 * Make a version (or, with null, the baseline) live for its family. A change
 * to a policy piece against the live wording needs `confirmPolicy`; without
 * it the promotion is refused, naming what changed, and nothing is written.
 */
export async function promoteRecipe(args: { family: string; versionId: number | null; confirmPolicy?: boolean; userId: string | null }): Promise<{ promotionId: number; changedPolicy: RecipePieceKey[] }> {
  await assertImageFamily(args.family);
  if (args.versionId != null) {
    const [v] = await db.select({ family: promptRecipeVersionsTable.engineFamily }).from(promptRecipeVersionsTable).where(eq(promptRecipeVersionsTable.id, args.versionId));
    if (!v) throw new RecipeRefused("no such version");
    if (v.family !== args.family) throw new RecipeRefused(`that version belongs to ${v.family}, not ${args.family}`);
  }
  const live = await recipeById(await liveRecipeVersionIdForFamily(args.family));
  const next = await recipeById(args.versionId);
  const changedPolicy = changedPolicyPieces(live.pieces, next.pieces);
  if (changedPolicy.length && !args.confirmPolicy) {
    throw new RecipeRefused("this version changes policy wording; confirm it to promote", { needsPolicyConfirmation: true, changedPolicy });
  }
  const [row] = await db.insert(promptRecipePromotionsTable).values({ engineFamily: args.family, versionId: args.versionId, promotedBy: args.userId }).returning({ id: promptRecipePromotionsTable.id });
  return { promotionId: row!.id, changedPolicy };
}

export interface RecipeFamilySummary {
  family: string;
  /** The engines of the family, e.g. its text-to-image and edit endpoints. */
  engines: Array<{ id: string; label: string; imageMode: string | null; retired: boolean }>;
  /** The live version, or null for the baseline. */
  liveVersionId: number | null;
  versions: Array<{ id: number; number: number; note: string; createdBy: string | null; createdAt: string; pieces: Record<string, string> }>;
  promotions: Array<{ id: number; versionId: number | null; promotedBy: string | null; promotedAt: string }>;
}

/** Every image engine family with its versions, the live one and its promotion history, newest first. */
export async function listRecipeFamilies(): Promise<RecipeFamilySummary[]> {
  // An archived (soft-deleted) engine is left out; the engines table is small, so it is filtered here.
  const engines = (await db.select({ id: enginesTable.id, label: enginesTable.label, family: enginesTable.family, imageMode: enginesTable.imageMode, retired: enginesTable.retired, deletedAt: enginesTable.deletedAt })
    .from(enginesTable).where(eq(enginesTable.kind, "image")).orderBy(asc(enginesTable.id))).filter((e) => e.deletedAt == null);
  const families = [...new Set(engines.map((e) => e.family).filter((f): f is string => !!f))].sort();
  if (families.length === 0) return [];
  const [versions, promotions, live] = await Promise.all([
    db.select().from(promptRecipeVersionsTable).where(inArray(promptRecipeVersionsTable.engineFamily, families)).orderBy(desc(promptRecipeVersionsTable.number)),
    db.select().from(promptRecipePromotionsTable).where(inArray(promptRecipePromotionsTable.engineFamily, families)).orderBy(desc(promptRecipePromotionsTable.id)),
    liveRecipeVersionIds(families),
  ]);
  return families.map((family) => ({
    family,
    engines: engines.filter((e) => e.family === family).map((e) => ({ id: e.id, label: e.label, imageMode: e.imageMode, retired: e.retired })),
    liveVersionId: live.get(family) ?? null,
    versions: versions.filter((v) => v.engineFamily === family).map((v) => ({
      id: v.id, number: v.number, note: v.note, createdBy: v.createdBy, createdAt: v.createdAt.toISOString(),
      pieces: recipeFrom(v.id, v.pieces).pieces,
    })),
    promotions: promotions.filter((p) => p.engineFamily === family).map((p) => ({ id: p.id, versionId: p.versionId, promotedBy: p.promotedBy, promotedAt: p.promotedAt.toISOString() })),
  }));
}

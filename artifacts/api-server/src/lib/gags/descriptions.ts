/**
 * @purpose A gag's one-line description: keyed to the exact scene and bubbles it describes, drafted by the utility model, reviewed by a moderator, and shown to members only when reviewed and describing the published content.
 * @subsystem visual-pipeline
 *
 * Plan docs/plans/PLAN_PHASE7_AI_PICTURE_FLOW.md (approved by David
 * 2026-11-26, Issue #1331), *Descriptions*; migration 0176.
 *
 *   - A description belongs to a gag and a content fingerprint
 *     (`gagContentFingerprint`): the scene and the complete bubbles, as the
 *     gag schema normalizes them. It is never part of the drawing content, so
 *     it reaches no prompt and no render freshness, and editing it changes no
 *     content and clears no example pick.
 *   - Members see a description only when it is reviewed and its fingerprint
 *     equals the published content's (`publishedDescriptions`). Publishing a
 *     fact's draft therefore brings along the draft content's description with
 *     nothing to copy, and a description written for other content is never
 *     shown. Reviewing a description of the published content shows it at once
 *     and publishes nothing else (David, Q15: 1).
 *   - Drafting is a sweep over stored state (`runDescriptionSweep`): every gag
 *     version with no description for its fingerprint gets one drafted (Q14: 1).
 *     It reads what is stored, so editor saves, the prefill job and the
 *     backfill are one path. A drafting result is stored only where no text
 *     exists for its fingerprint, so a moderator's text is never replaced, and
 *     a result for content that has since changed sits unused under its old
 *     fingerprint.
 *   - Coverage is kept at publication (`missingDescriptionsForPublish`, used
 *     by the go-live check): a gag whose content is new or changed in a publish
 *     needs a reviewed description of that content.
 */
import { createHash } from "node:crypto";
import { and, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { zodResponseFormat } from "openai/helpers/zod";
import { db, factGagDescriptionsTable, factGagsTable, factsTable } from "@workspace/db";
import {
  DESCRIPTION_MAX_CHARS,
  canonicalizeNameToken,
  isStandInGagContent,
  validateTemplate,
  visualPromptStrategyOverrideSchema,
  type GagDescriptionView,
  type GagDescriptions,
  type VisualPromptStrategyOverride,
} from "@workspace/api-zod";
import { callUtilityLLM } from "../utilityLLM";
import { renderedGagProjection } from "../imagePrompt/directInput";
import { stableStringify } from "../factRenderScenarios";
import { logger } from "../logger";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Db = typeof db | Tx;

export { DESCRIPTION_MAX_CHARS };
/** Drafting attempts before a version is left for a moderator to write by hand. */
export const DESCRIPTION_MAX_ATTEMPTS = 3;
/** How long a claimed draft is held before another run may retry it. */
const CLAIM_STALE_MS = 10 * 60 * 1000;
/** Versions drafted in one sweep run. */
export const DESCRIPTION_SWEEP_BATCH = 25;

export class DescriptionError extends Error {
  constructor(readonly code: "DESCRIPTION_INVALID" | "GAG_NOT_FOUND" | "CONTENT_CHANGED", message: string, readonly status = 400) {
    super(message);
    this.name = "DescriptionError";
  }
}

/**
 * The fingerprint of what a description describes: a gag version as it draws,
 * the same projection render freshness, reuse and approval compare
 * (`renderedGagProjection`: the scene, the complete bubbles and the cast), so a
 * description goes stale exactly when the version's renders do. Content is
 * read through the gag schema, so a gag carried over in its legacy shape and
 * the same gag re-saved fingerprint alike. Null for content the schema refuses.
 */
export function gagContentFingerprint(content: unknown): string | null {
  const parsed = visualPromptStrategyOverrideSchema.safeParse(content);
  return parsed.success ? fingerprintOfParsed(parsed.data as VisualPromptStrategyOverride) : null;
}

/** `gagContentFingerprint` for content already read through the gag schema. */
export function fingerprintOfParsed(content: VisualPromptStrategyOverride): string {
  return createHash("sha256").update(`v1:${stableStringify(renderedGagProjection(content))}`).digest("hex");
}

/**
 * A description as a moderator saves it: one line, at most 160 characters,
 * with the gag scene's personalization tokens only ({NAME}, {NAME_POSSESSIVE},
 * the pronoun tokens), canonicalized the same way. Throws DESCRIPTION_INVALID.
 */
export function validateDescriptionText(raw: unknown): string {
  if (typeof raw !== "string") throw new DescriptionError("DESCRIPTION_INVALID", "A description is a line of text.");
  const text = canonicalizeNameToken(raw.replace(/\s+/g, " ").trim());
  if (!text) throw new DescriptionError("DESCRIPTION_INVALID", "Write the description: one line saying what happens in the picture.");
  if (text.length > DESCRIPTION_MAX_CHARS) {
    throw new DescriptionError("DESCRIPTION_INVALID", `A description is at most ${DESCRIPTION_MAX_CHARS} characters.`);
  }
  if (text.includes("{")) {
    const res = validateTemplate(text);
    if (!res.valid) {
      throw new DescriptionError("DESCRIPTION_INVALID", `The description has an invalid personalization token: ${res.error ?? "invalid token"}. Use {NAME}, {NAME_POSSESSIVE} and pronoun tokens only.`);
    }
  }
  return text;
}

// ─── What members read ──────────────────────────────────────────────────────

/**
 * The reviewed description of each gag's published content, by gag id. A gag
 * whose published content has no reviewed description is absent.
 */
export async function publishedDescriptions(
  gags: Array<{ gagId: number; approvedContent: unknown }>,
  conn: Db = db,
): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  const want = new Map<number, string>();
  for (const g of gags) {
    const fp = gagContentFingerprint(g.approvedContent);
    if (fp) want.set(g.gagId, fp);
  }
  if (want.size === 0) return out;
  const rows = await conn.select({
    gagId: factGagDescriptionsTable.gagId,
    fp: factGagDescriptionsTable.contentFingerprint,
    text: factGagDescriptionsTable.text,
  }).from(factGagDescriptionsTable)
    .where(and(inArray(factGagDescriptionsTable.gagId, [...want.keys()]), sql`${factGagDescriptionsTable.reviewedAt} IS NOT NULL`));
  for (const r of rows) {
    if (r.text && want.get(r.gagId) === r.fp) out.set(r.gagId, r.text);
  }
  return out;
}

// ─── What moderators read and write ─────────────────────────────────────────

export type DescriptionView = GagDescriptionView;
export type GagDescriptionsView = GagDescriptions;

function viewOf(row: typeof factGagDescriptionsTable.$inferSelect | undefined, fp: string, earlierText: string | null = null): DescriptionView {
  // No row: the sweep drafts every stored version of every gag not removed,
  // so a version with none is waiting to be drafted, never "drafted"
  // (Codex 4713938187, PR #1334). A row whose attempts are spent without
  // text has failed for good, whether or not its last error was recorded.
  if (!row) return { contentFingerprint: fp, text: null, origin: "ai", reviewed: false, drafting: "drafting", lastError: null, earlierText };
  const failed = row.text == null && (row.lastError != null || row.attempts >= DESCRIPTION_MAX_ATTEMPTS);
  return {
    contentFingerprint: fp,
    text: row.text,
    origin: row.origin,
    reviewed: row.reviewedAt != null,
    drafting: row.text != null ? "none" : failed ? "failed" : "drafting",
    lastError: row.lastError,
    earlierText,
  };
}

/** Both versions' descriptions for a set of gags, for the editor. */
export async function descriptionsForEditor(
  gags: Array<{ id: number; approvedContent: unknown; pendingContent: unknown }>,
  conn: Db = db,
): Promise<Map<number, GagDescriptionsView>> {
  const out = new Map<number, GagDescriptionsView>();
  if (gags.length === 0) return out;
  const rows = await conn.select().from(factGagDescriptionsTable)
    .where(inArray(factGagDescriptionsTable.gagId, gags.map((g) => g.id)));
  const byGag = new Map<number, Array<(typeof rows)[number]>>();
  for (const r of rows) byGag.set(r.gagId, [...(byGag.get(r.gagId) ?? []), r]);
  for (const g of gags) {
    const mine = byGag.get(g.id) ?? [];
    const pubFp = g.approvedContent != null ? gagContentFingerprint(g.approvedContent) : null;
    const draftFp = g.pendingContent != null ? gagContentFingerprint(g.pendingContent) : null;
    const hasDraft = !!draftFp && draftFp !== pubFp;
    // The starting point is chosen for the version being described, from the
    // reviewed text of the content it replaces (Codex 4713938194, PR #1334):
    // the draft is offered the published content's description first, then
    // the latest reviewed text of any other earlier version; the published
    // version, the latest reviewed text of an earlier one. A version is never
    // offered its own text, nor the published version the draft's.
    const reviewed = mine
      .filter((r) => r.reviewedAt != null && r.text)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    const latestExcept = (...fps: Array<string | null>) => reviewed.find((r) => !fps.includes(r.contentFingerprint))?.text ?? null;
    const pubText = pubFp ? reviewed.find((r) => r.contentFingerprint === pubFp)?.text ?? null : null;
    out.set(g.id, {
      published: pubFp ? viewOf(mine.find((r) => r.contentFingerprint === pubFp), pubFp, latestExcept(pubFp, hasDraft ? draftFp : null)) : null,
      draft: hasDraft ? viewOf(mine.find((r) => r.contentFingerprint === draftFp), draftFp!, pubText ?? latestExcept(draftFp)) : null,
    });
  }
  return out;
}

/**
 * A moderator writes, edits or approves the description of one version of a
 * gag. `contentFingerprint` names the version the moderator was looking at; it
 * must still be that gag's published or draft content, so a description is
 * never saved against content that changed under the editor (CONTENT_CHANGED).
 * The text is stored as the moderator's and reviewed by them: reviewing the
 * published content's description shows it to members at once (Q15: 1), and
 * changes nothing else.
 */
export async function saveReviewedDescription(
  gagId: number,
  contentFingerprint: string,
  rawText: unknown,
  adminId: string,
  conn: Db = db,
): Promise<DescriptionView> {
  const text = validateDescriptionText(rawText);
  const [gag] = await conn.select({ approvedContent: factGagsTable.approvedContent, pendingContent: factGagsTable.pendingContent, removedAt: factGagsTable.removedAt })
    .from(factGagsTable).where(eq(factGagsTable.id, gagId)).limit(1);
  if (!gag || gag.removedAt) throw new DescriptionError("GAG_NOT_FOUND", "That gag no longer exists.", 404);
  const versions = [gag.approvedContent, gag.pendingContent].filter((c) => c != null).map(gagContentFingerprint);
  if (!versions.includes(contentFingerprint)) {
    throw new DescriptionError("CONTENT_CHANGED", "This gag changed since you opened it. Reload it and review the description again.", 409);
  }
  const now = new Date();
  const [row] = await conn.insert(factGagDescriptionsTable).values({
    gagId, contentFingerprint, text, origin: "moderator", reviewedBy: adminId, reviewedAt: now, updatedAt: now,
  }).onConflictDoUpdate({
    target: [factGagDescriptionsTable.gagId, factGagDescriptionsTable.contentFingerprint],
    set: { text, origin: "moderator", reviewedBy: adminId, reviewedAt: now, lastError: null, updatedAt: now },
  }).returning();
  return viewOf(row, contentFingerprint);
}

// ─── Coverage at publication ────────────────────────────────────────────────

/**
 * The gags whose content a publish would make new or changed for members and
 * which have no reviewed description of that content. The go-live check
 * refuses the publish while any are listed. A gag already published and
 * unchanged (no draft change) is never listed, so the backfill never blocks a
 * fact's other edits from publishing.
 */
export async function missingDescriptionsForPublish(
  gags: Array<{ id: number; slot: number; approvedContent: unknown; pendingContent: unknown; draftRemoved: boolean }>,
  conn: Db = db,
): Promise<Array<{ gagId: number; slot: number }>> {
  // Changing means the draft draws something other than the published
  // version: a draft opened only to stage example picks (approveGagRender
  // copies the published content into it), or a re-save the drawing
  // projection does not see, is unchanged. Content the schema refuses has no
  // fingerprint and always counts as changed. The editor draws the same line
  // (`descriptionsForEditor`: a draft row only where the fingerprints differ).
  const changing = gags
    .filter((g) => !g.draftRemoved && g.pendingContent != null)
    .map((g) => ({ gagId: g.id, slot: g.slot, fp: gagContentFingerprint(g.pendingContent), publishedFp: g.approvedContent != null ? gagContentFingerprint(g.approvedContent) : null }))
    .filter((g) => !g.fp || g.fp !== g.publishedFp);
  if (changing.length === 0) return [];
  const rows = await conn.select({ gagId: factGagDescriptionsTable.gagId, fp: factGagDescriptionsTable.contentFingerprint })
    .from(factGagDescriptionsTable)
    .where(and(inArray(factGagDescriptionsTable.gagId, changing.map((c) => c.gagId)), sql`${factGagDescriptionsTable.reviewedAt} IS NOT NULL`));
  const have = new Set(rows.map((r) => `${r.gagId}:${r.fp}`));
  return changing.filter((c) => !c.fp || !have.has(`${c.gagId}:${c.fp}`)).map(({ gagId, slot }) => ({ gagId, slot }));
}

// ─── The review list ────────────────────────────────────────────────────────

export interface DescriptionToReview {
  factId: number;
  factText: string;
  gagId: number;
  slot: number;
  /** The published content's description, as it stands. */
  description: DescriptionView;
}

/**
 * The gags members can pick (published, not removed, on an active fact) whose
 * published content has no reviewed description, with each one's drafting
 * state: the backfill's review, countable and finishable.
 */
export async function descriptionsToReview(conn: Db = db): Promise<DescriptionToReview[]> {
  const gags = await conn.select({
    id: factGagsTable.id, factId: factGagsTable.factId, slot: factGagsTable.slot,
    approvedContent: factGagsTable.approvedContent, factText: factsTable.text,
  }).from(factGagsTable)
    .innerJoin(factsTable, eq(factsTable.id, factGagsTable.factId))
    .where(and(isNull(factGagsTable.removedAt), sql`${factGagsTable.approvedContent} IS NOT NULL`, eq(factsTable.isActive, true)));
  if (gags.length === 0) return [];
  const rows = await conn.select().from(factGagDescriptionsTable)
    .where(inArray(factGagDescriptionsTable.gagId, gags.map((g) => g.id)));
  const byKey = new Map(rows.map((r) => [`${r.gagId}:${r.contentFingerprint}`, r]));
  const out: DescriptionToReview[] = [];
  for (const g of gags) {
    // Members are never offered the backfilled stand-in (the resolver's rule,
    // shared), so it has no description to review (Codex 4714175064, PR #1334).
    // The drafting sweep still covers it: it drafts every stored version.
    if (isStandInGagContent(g.approvedContent)) continue;
    const fp = gagContentFingerprint(g.approvedContent);
    if (!fp) continue;
    const row = byKey.get(`${g.id}:${fp}`);
    if (row?.reviewedAt) continue;
    out.push({ factId: g.factId, factText: g.factText, gagId: g.id, slot: g.slot, description: viewOf(row, fp) });
  }
  return out.sort((a, b) => a.factId - b.factId || a.slot - b.slot);
}

// ─── Drafting ───────────────────────────────────────────────────────────────

const draftWireSchema = z.object({ description: z.string() });

export const DESCRIPTION_SYSTEM_PROMPT = [
  "You write a one-line caption that tells a reader what happens in a picture, so they can tell it apart from other pictures of the same joke.",
  "The picture's subject is written as {NAME}. Refer to the subject as {NAME} (or {NAME_POSSESSIVE} for the possessive), and use {SUBJ}, {OBJ}, {POSS} or {REFL} for pronouns. Never use any other name for the subject and never write a pronoun for the subject as a plain word.",
  "Describe what is visible and what happens, in the present tense, as one plain sentence of at most 140 characters. No quotation marks, no emoji, no explanation of the joke, no mention of art style.",
  "Return JSON: {\"description\": \"...\"}.",
].join("\n");

/** The request the drafting call sends for one version's content. */
export function buildDescriptionUserMessage(content: VisualPromptStrategyOverride, factText: string | null): string {
  const bubbles = (content.bubbles ?? []).filter((b) => b.entity.trim() && b.text.trim());
  return [
    factText ? `The fact the picture illustrates (for context only): ${factText}` : null,
    `The scene: ${(content.coreSceneOverride ?? "").trim()}`,
    bubbles.length ? `Speech and thought bubbles:\n${bubbles.map((b) => `- ${b.entity} (${b.type}): ${b.text}`).join("\n")}` : null,
  ].filter(Boolean).join("\n\n");
}

/** Parse and validate a drafting answer. Throws on anything a moderator could not save. */
export function parseDescriptionResponse(raw: string): string {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("the drafting answer was not JSON"); }
  const wire = draftWireSchema.safeParse(parsed);
  if (!wire.success) throw new Error("the drafting answer had no description");
  return validateDescriptionText(wire.data.description.replace(/^["“]|["”]$/g, ""));
}

export type DescriptionDrafter = (content: VisualPromptStrategyOverride, factText: string | null) => Promise<string>;

/**
 * The real drafter, on the utility model (as cast extraction is). Like the
 * other moderation helpers it passes no per-account budget gate and writes no
 * cost row: no member account is behind a draft (David, Q18: 1, 2026-11-27).
 * Spend is bounded by the sweep: DESCRIPTION_MAX_ATTEMPTS tries per version,
 * DESCRIPTION_SWEEP_BATCH versions a run, each try counted in `attempts`.
 */
export const draftDescriptionWithModel: DescriptionDrafter = async (content, factText) => {
  const response = await callUtilityLLM({
    responseFormat: zodResponseFormat(draftWireSchema, "gag_description"),
    messages: [
      { role: "system", content: DESCRIPTION_SYSTEM_PROMPT },
      { role: "user", content: buildDescriptionUserMessage(content, factText) },
    ],
  });
  return parseDescriptionResponse(response.choices[0]?.message?.content ?? "");
};

/**
 * Draft the descriptions of these gags now, in the background, after a gag
 * content write (plan: drafting "runs after any gag content write and on a
 * schedule"). The same sweep, narrowed to the gags written; the schedule
 * remains the backstop for anything this misses (a crash, a failed draft).
 * Never throws and never delays the caller.
 */
export function draftDescriptionsSoon(gagIds: number[]): void {
  if (gagIds.length === 0) return;
  setImmediate(() => {
    runDescriptionSweep({ gagIds }).catch((err: unknown) => logger.warn({ err, gagIds }, "[gag-descriptions] drafting after a write failed; the schedule retries"));
  });
}

let drafterForTest: DescriptionDrafter | null = null;
export function __setDescriptionDrafterForTest(d: DescriptionDrafter | null): void { drafterForTest = d; }

export interface DescriptionSweepResult {
  /** Versions with no row that were claimed. */
  queued: number;
  drafted: number;
  failed: number;
  /** Versions that already had a description (or a moderator's text). */
  skipped: number;
  /** Claimed versions that another writer filled first. */
  noop: number;
}

/**
 * Draft a description for every gag version (published and draft, of gags not
 * removed) that has none for its fingerprint, a bounded batch a run. Each
 * version is claimed by inserting its row first (unique on gag and
 * fingerprint), so two runs never draft the same version; a failed or stale
 * claim is retried up to DESCRIPTION_MAX_ATTEMPTS times. The result is written
 * only while the row still holds no text, so a moderator's text that landed
 * meanwhile is kept. Publishes nothing: a drafted description is unreviewed.
 */
export async function runDescriptionSweep(opts: { batch?: number; drafter?: DescriptionDrafter; gagIds?: number[] } = {}): Promise<DescriptionSweepResult> {
  const batch = opts.batch ?? DESCRIPTION_SWEEP_BATCH;
  const drafter = opts.drafter ?? drafterForTest ?? draftDescriptionWithModel;
  const result: DescriptionSweepResult = { queued: 0, drafted: 0, failed: 0, skipped: 0, noop: 0 };

  const gags = await db.select({
    id: factGagsTable.id, approvedContent: factGagsTable.approvedContent, pendingContent: factGagsTable.pendingContent,
    factText: factsTable.text,
  }).from(factGagsTable)
    .innerJoin(factsTable, eq(factsTable.id, factGagsTable.factId))
    // `gagIds` narrows a run to some gags (tests); the schedule sweeps them all.
    .where(and(isNull(factGagsTable.removedAt), opts.gagIds ? inArray(factGagsTable.id, opts.gagIds.length ? opts.gagIds : [-1]) : undefined));
  if (gags.length === 0) return result;
  const rows = await db.select({
    gagId: factGagDescriptionsTable.gagId, fp: factGagDescriptionsTable.contentFingerprint,
    text: factGagDescriptionsTable.text, attempts: factGagDescriptionsTable.attempts, updatedAt: factGagDescriptionsTable.updatedAt,
  }).from(factGagDescriptionsTable).where(inArray(factGagDescriptionsTable.gagId, gags.map((g) => g.id)));
  const byKey = new Map(rows.map((r) => [`${r.gagId}:${r.fp}`, r]));

  // Published versions first: they are what members are offered.
  const todo: Array<{ gagId: number; fp: string; content: VisualPromptStrategyOverride; factText: string | null; retry: boolean }> = [];
  const queued = new Set<string>();
  for (const stage of ["approvedContent", "pendingContent"] as const) {
    for (const g of gags) {
      const raw = g[stage];
      if (raw == null) continue;
      const parsed = visualPromptStrategyOverrideSchema.safeParse(raw);
      if (!parsed.success) continue;
      const fp = fingerprintOfParsed(parsed.data as VisualPromptStrategyOverride);
      const key = `${g.id}:${fp}`;
      if (queued.has(key)) continue;
      queued.add(key);
      const row = byKey.get(key);
      if (row?.text != null) { result.skipped++; continue; }
      if (row && (row.attempts >= DESCRIPTION_MAX_ATTEMPTS || Date.now() - row.updatedAt.getTime() < CLAIM_STALE_MS)) { result.skipped++; continue; }
      todo.push({ gagId: g.id, fp, content: parsed.data as VisualPromptStrategyOverride, factText: g.factText, retry: !!row });
    }
  }

  for (const t of todo.slice(0, batch)) {
    // Claim: a new row, or a stale failed one, under this run's timestamp.
    const now = new Date();
    const claimed = t.retry
      ? await db.update(factGagDescriptionsTable)
        .set({ attempts: sql`${factGagDescriptionsTable.attempts} + 1`, updatedAt: now })
        .where(and(
          eq(factGagDescriptionsTable.gagId, t.gagId), eq(factGagDescriptionsTable.contentFingerprint, t.fp),
          isNull(factGagDescriptionsTable.text), lt(factGagDescriptionsTable.attempts, DESCRIPTION_MAX_ATTEMPTS),
          lt(factGagDescriptionsTable.updatedAt, new Date(now.getTime() - CLAIM_STALE_MS)),
        )).returning({ id: factGagDescriptionsTable.id })
      : await db.insert(factGagDescriptionsTable)
        .values({ gagId: t.gagId, contentFingerprint: t.fp, origin: "ai", attempts: 1, updatedAt: now })
        .onConflictDoNothing().returning({ id: factGagDescriptionsTable.id });
    if (claimed.length === 0) { result.noop++; continue; }
    result.queued++;
    const id = claimed[0]!.id;
    try {
      const text = await drafter(t.content, t.factText);
      const written = await db.update(factGagDescriptionsTable)
        .set({ text, origin: "ai", lastError: null, updatedAt: new Date() })
        .where(and(eq(factGagDescriptionsTable.id, id), isNull(factGagDescriptionsTable.text)))
        .returning({ id: factGagDescriptionsTable.id });
      if (written.length) result.drafted++; else result.noop++;
    } catch (err) {
      result.failed++;
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ err, gagId: t.gagId }, "[gag-descriptions] drafting failed; retried by a later run");
      await db.update(factGagDescriptionsTable)
        .set({ lastError: message.slice(0, 500), updatedAt: new Date() })
        .where(and(eq(factGagDescriptionsTable.id, id), isNull(factGagDescriptionsTable.text)));
    }
  }
  return result;
}


/**
 * @purpose The fact sheet's reads and its two at-once edits: one approved fact's detail for the admin fact sheet, and the hashtag and humor-note saves on it.
 * @subsystem moderation
 *
 * Plan docs/plans/PLAN_FACT_LIFECYCLE_REBUILD.md, intent items 18–20 and
 * design 3A; the increment 3.1 outline on Issue #1018. The sheet opens only an
 * approved fact (live or deactivated): a staging fact is the moderation
 * screen's. Hashtags and the Humor Note are "saved at once, logged" (item 20);
 * gag and example edits wait for Publish (3.2). A changed note on an approved
 * fact rewrites no gag ideas and touches no gag: that rule is the Gags step's.
 */
import { attachedContent, factHasUnpublishedChanges } from "./factLifecycle";
import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db, usersTable } from "@workspace/db";
import {
  factsTable,
  factHashtagsTable,
  hashtagsTable,
  factGagsTable,
  factGagExamplesTable,
  factReadingsTable,
  pendingReviewsTable,
  adminActionsTable,
} from "@workspace/db/schema";
import { GAG_EXAMPLE_KINDS, type AttentionReason, type GagExampleKind } from "@workspace/api-zod";
import { ATTENTION_REASONS_COLUMN, approvedFact } from "./factAttention";
import { FACT_HASHTAG_LIMIT, attachHashtags, detachHashtags, factHashtagNames } from "./factHashtags";
import { readingView } from "./readingJobs";
import { recordAdminAction } from "./adminActions";
import { lockFactRow } from "./reviewLocks";
import { sanitizeHashtagsForPersistence } from "./hashtags";

export { FACT_HASHTAG_LIMIT };

type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/** A person, by the name an admin reads; null when the user row is gone. */
const userName = (t: { displayName: unknown; firstName: unknown; email: unknown }) =>
  sql<string | null>`coalesce(${t.displayName}, ${t.firstName}, ${t.email})`;

/** The sheet opens approved facts only (plan item 18). */
const isApproved = approvedFact;

export interface FactSheetGagPictures {
  gagId: number;
  slot: number;
  /** The kinds with a published example; a full set has every GAG_EXAMPLE_KINDS. */
  approvedKinds: GagExampleKind[];
  /** The kinds a full set still lacks. */
  missingKinds: GagExampleKind[];
}

/** Per published gag, which example kinds are published. */
async function gagPictures(factId: number): Promise<FactSheetGagPictures[]> {
  const gags = await db
    .select({ id: factGagsTable.id, slot: factGagsTable.slot })
    .from(factGagsTable)
    .where(and(eq(factGagsTable.factId, factId), isNull(factGagsTable.removedAt), isNotNull(factGagsTable.approvedContent)))
    .orderBy(asc(factGagsTable.slot));
  if (gags.length === 0) return [];
  const examples = await db
    .select({ gagId: factGagExamplesTable.gagId, kind: factGagExamplesTable.subjectKind })
    .from(factGagExamplesTable)
    .where(and(inArray(factGagExamplesTable.gagId, gags.map((g) => g.id)), eq(factGagExamplesTable.stage, "approved")));
  return gags.map((g) => {
    const have = new Set(examples.filter((e) => e.gagId === g.id).map((e) => e.kind));
    return {
      gagId: g.id,
      slot: g.slot,
      approvedKinds: GAG_EXAMPLE_KINDS.filter((k) => have.has(k)),
      missingKinds: GAG_EXAMPLE_KINDS.filter((k) => !have.has(k)),
    };
  });
}

/**
 * One approved fact as the sheet shows it, or null when no approved fact has
 * this id. Everything is read-only here except the hashtags and the note,
 * which save through `saveFactHashtags` and `saveFactHumorNote`.
 */
export async function factSheet(factId: number) {
  const submitter = alias(usersTable, "submitter");
  const approver = alias(usersTable, "approver");
  const noteApprover = alias(usersTable, "note_approver");
  const [row] = await db
    .select({
      id: factsTable.id,
      text: factsTable.text,
      canonicalText: factsTable.canonicalText,
      isActive: factsTable.isActive,
      createdAt: factsTable.createdAt,
      updatedAt: factsTable.updatedAt,
      splitTokenIndex: factsTable.splitTokenIndex,
      submittedById: factsTable.submittedById,
      submittedByName: userName(submitter),
      approvedAt: factsTable.approvedAt,
      approvalSource: factsTable.approvalSource,
      approvedByName: userName(approver),
      upvotes: factsTable.upvotes,
      downvotes: factsTable.downvotes,
      score: factsTable.score,
      wilsonScore: factsTable.wilsonScore,
      commentCount: factsTable.commentCount,
      shareCount: factsTable.shareCount,
      enrichmentStatus: factsTable.enrichmentStatus,
      /** The stored taxonomy's suggestions: a source the hashtag editor offers, never shipped by itself. */
      suggestedHashtags: sql<string[] | null>`(${factsTable.enrichment} -> 'suggestedHashtags')`,
      hasEmbedding: sql<boolean>`(${factsTable.embedding} IS NOT NULL)`,
      humorNote: factsTable.humorNote,
      humorNoteReadingId: factsTable.humorNoteReadingId,
      humorNoteApprovedBy: factsTable.humorNoteApprovedBy,
      humorNoteApprovedByName: userName(noteApprover),
      humorNoteApprovedAt: factsTable.humorNoteApprovedAt,
      attention: ATTENTION_REASONS_COLUMN,
      /** The draft differs from the published set: "Publish changes" or "Discard changes" (plan 3B). */
      hasUnpublishedChanges: factHasUnpublishedChanges,
    })
    .from(factsTable)
    .leftJoin(submitter, eq(submitter.id, factsTable.submittedById))
    .leftJoin(approver, eq(approver.id, factsTable.approvedById))
    .leftJoin(noteApprover, eq(noteApprover.id, factsTable.humorNoteApprovedBy))
    .where(and(eq(factsTable.id, factId), isApproved))
    .limit(1);
  if (!row) return null;

  // The research shown with a note is the research it was written from
  // (plan 1B); a note with no recorded basis shows the latest run.
  const readingWhere = row.humorNoteReadingId != null
    ? eq(factReadingsTable.id, row.humorNoteReadingId)
    : eq(factReadingsTable.factId, factId);

  const [hashtags, pictures, usage, [review], [reading]] = await Promise.all([
    factHashtagNames(factId),
    gagPictures(factId),
    // The delete's own definition of what is attached (lib/factLifecycle.ts).
    attachedContent(factId),
    db.select({ id: pendingReviewsTable.id })
      .from(pendingReviewsTable)
      .where(eq(pendingReviewsTable.approvedFactId, factId))
      .orderBy(desc(pendingReviewsTable.id))
      .limit(1),
    db.select().from(factReadingsTable).where(readingWhere).orderBy(desc(factReadingsTable.id)).limit(1),
  ]);

  const { humorNote, humorNoteReadingId, humorNoteApprovedBy, humorNoteApprovedByName, humorNoteApprovedAt, approvedAt, attention, ...rest } = row;
  return {
    ...rest,
    suggestedHashtags: Array.isArray(rest.suggestedHashtags) ? rest.suggestedHashtags.filter((t): t is string => typeof t === "string") : [],
    approvedAt: approvedAt!.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    attention: attention as AttentionReason[],
    reviewId: review?.id ?? null,
    hashtags,
    usage,
    pictures,
    reading: {
      ...readingView(reading ?? null, { humorNote, humorNoteReadingId, humorNoteApprovedBy, humorNoteApprovedAt }),
      approvedByName: humorNoteApprovedByName,
    },
  };
}

export type FactSheet = NonNullable<Awaited<ReturnType<typeof factSheet>>>;

/** A save's outcome: not an approved fact, refused with a reason, or saved. */
export type FactSheetSave<T> = { kind: "not_found" } | { kind: "refused"; error: string } | { kind: "saved"; value: T };

/**
 * Replace an approved fact's hashtags with `tags` (sanitized as at approval),
 * keeping each hashtag's fact count, and log what changed. A fact can't be
 * left without tags, as at approval. An unchanged list writes nothing.
 */
export async function saveFactHashtags(factId: number, tags: readonly unknown[], actorId: string | undefined): Promise<FactSheetSave<string[]>> {
  const wanted = sanitizeHashtagsForPersistence(tags, { limit: FACT_HASHTAG_LIMIT });
  if (wanted.length === 0) return { kind: "refused", error: "A fact needs at least one hashtag." };
  return db.transaction(async (tx) => {
    if (!(await lockFactRow(tx, factId))) return { kind: "not_found" as const };
    const [fact] = await tx.select({ id: factsTable.id }).from(factsTable).where(and(eq(factsTable.id, factId), isApproved)).limit(1);
    if (!fact) return { kind: "not_found" as const };

    const current = await tx
      .select({ hashtagId: factHashtagsTable.hashtagId, name: hashtagsTable.name })
      .from(factHashtagsTable)
      .innerJoin(hashtagsTable, eq(hashtagsTable.id, factHashtagsTable.hashtagId))
      .where(eq(factHashtagsTable.factId, factId));
    const removed = current.filter((c) => !wanted.includes(c.name));
    const have = new Set(current.map((c) => c.name));
    const added = wanted.filter((t) => !have.has(t));

    await detachHashtags(tx, factId, removed.map((r) => r.hashtagId));
    await attachHashtags(tx, factId, added);

    if (removed.length > 0 || added.length > 0) {
      await recordAdminAction({ factId }, actorId, "hashtags_save", { added, removed: removed.map((r) => r.name) }, tx);
    }
    return { kind: "saved" as const, value: await factHashtagNames(factId, tx) };
  });
}

/**
 * Correct an approved fact's Humor Note, recording who and when, and log it.
 * Unlike the Gags step's save, it asks for no new gag ideas and changes no
 * gag: the fact's gags are published, and change only through Publish (3.2).
 * An unchanged note writes nothing.
 */
export async function saveFactHumorNote(factId: number, text: string, actorId: string | undefined) {
  return db.transaction(async (tx): Promise<FactSheetSave<{ text: string; approvedAt: string | null }>> => {
    if (!(await lockFactRow(tx, factId))) return { kind: "not_found" };
    const [fact] = await tx
      .select({ humorNote: factsTable.humorNote, approvedAt: factsTable.humorNoteApprovedAt })
      .from(factsTable)
      .where(and(eq(factsTable.id, factId), isApproved))
      .limit(1);
    if (!fact) return { kind: "not_found" };
    if ((fact.humorNote ?? "").trim() === text) {
      return { kind: "saved", value: { text, approvedAt: fact.approvedAt?.toISOString() ?? null } };
    }
    const approvedAt = new Date();
    await tx.update(factsTable)
      .set({ humorNote: text, humorNoteApprovedBy: actorId ?? null, humorNoteApprovedAt: approvedAt })
      .where(eq(factsTable.id, factId));
    await recordAdminAction({ factId }, actorId, "humor_note_save", { text, from: fact.humorNote ?? null }, tx);
    return { kind: "saved", value: { text, approvedAt: approvedAt.toISOString() } };
  });
}

/** The most History shows: far more than any fact's real record, so a runaway writer can't stall the sheet. */
export const FACT_HISTORY_LIMIT = 500;

/**
 * The fact's History tab (plan 3C, oracle item 22): every admin action on the
 * fact, newest first — the records keyed to the fact and, since a Triage action
 * happens before a fact exists, those keyed only to one of its reviews (the
 * review that staged it, or approved it). Null when the fact is not approved,
 * as the sheet is.
 */
export async function factHistory(factId: number) {
  const [fact] = await db.select({ id: factsTable.id }).from(factsTable).where(and(eq(factsTable.id, factId), isApproved)).limit(1);
  if (!fact) return null;
  const actor = alias(usersTable, "actor");
  const reviewIds = db.select({ id: pendingReviewsTable.id }).from(pendingReviewsTable)
    .where(sql`${pendingReviewsTable.stagingFactId} = ${factId} OR ${pendingReviewsTable.approvedFactId} = ${factId}`);
  const rows = await db
    .select({
      id: adminActionsTable.id,
      action: adminActionsTable.action,
      reviewId: adminActionsTable.reviewId,
      actorName: userName(actor),
      actorId: adminActionsTable.actorId,
      detail: adminActionsTable.detail,
      createdAt: adminActionsTable.createdAt,
    })
    .from(adminActionsTable)
    .leftJoin(actor, eq(actor.id, adminActionsTable.actorId))
    .where(sql`${adminActionsTable.factId} = ${factId} OR ${adminActionsTable.reviewId} IN (${reviewIds})`)
    .orderBy(desc(adminActionsTable.createdAt), desc(adminActionsTable.id))
    .limit(FACT_HISTORY_LIMIT);
  return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
}

export type FactHistoryEntry = NonNullable<Awaited<ReturnType<typeof factHistory>>>[number];

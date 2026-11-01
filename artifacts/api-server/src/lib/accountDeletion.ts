/**
 * @purpose The one account deletion engine (launch Phase 5, plan S14): accepts a request under the admin population lock (sessions revoked, content hidden by the live rule in the same commit), advances it stage by stage by compare-and-set — subscriptions cancelled, the person told, a billing dispute holding the purge — and at its date purges the account under the owner's content lock: their files through preserve, their memes, comments, links, reviews, uploads and generations, their reactions with the surviving targets recounted, facts kept and credited to a former member, the user row last. Cancel wins any race it can win; every stage is idempotent and resumes where a crash left it.
 * @subsystem security
 */
import { db } from "@workspace/db";
import {
  accountDeletionRequestsTable,
  activityFeedTable,
  commentsTable,
  factsTable,
  membershipEntitlementsTable,
  membershipHistoryTable,
  memesTable,
  reactionsTable,
  stripeCheckoutRequestLedgerTable,
  uploadImageMetadataTable,
  userAiImagesTable,
  usersTable,
  type AccountDeletionRequester,
  type AccountDeletionStage,
  type ReactionTargetType,
} from "@workspace/db/schema";
import { and, eq, inArray, isNull, ne, notInArray, sql } from "drizzle-orm";

import { acquireAdminPopulationLock, assertAdminPopulationSurvives } from "./adminLockoutGuard";
import { revokeUserSessions } from "./auth";
import { aiImageIsOwnersOwn } from "./contentVisibility";
import { buildAccountDeletionCancelledEmail, buildAccountDeletionScheduledEmail, sendEmail } from "./email";
import { logger } from "./logger";
import { ObjectStorageService } from "./objectStorage";
import { refreshTargetCounts } from "./reactions";
import { getSiteBaseUrl } from "./siteUrl";
import { memeObjectPaths } from "./storageKeys";


/** The cooling-off before a self-service deletion is purged (David, pick 1). */
export const DELETION_COOLING_OFF_DAYS = 14;

/** Subscription states that still bill or can resume billing: each is cancelled at acceptance (the gap `past_due` left open). */
const CANCELLABLE_SUBSCRIPTION_STATUSES = ["active", "trialing", "past_due", "unpaid", "paused", "incomplete"];

const adr = accountDeletionRequestsTable;

/** A request that is neither cancelled nor finished. */
const active = (userId: string) => and(eq(adr.userId, userId), isNull(adr.cancelledAt), ne(adr.stage, "done"));

// ── Accept and cancel ─────────────────────────────────────────────────

export type AcceptOutcome =
  | { status: "accepted"; purgeAfter: Date }
  | { status: "already_pending"; purgeAfter: Date }
  | { status: "not_found" };

/**
 * Accepts a deletion request: in one transaction under the admin population
 * lock (so it can never remove the last administrator; throws
 * `AdminLockoutError`), the request row is written and every session of the
 * person is deleted. From that commit their content is hidden (the live rule
 * reads the request) and they can only cancel. A repeated request returns the
 * pending one unchanged; a request after a cancel starts a new window.
 * The non-destructive stages are kicked right after the commit; the hourly
 * worker finishes whatever that kick did not.
 */
export async function acceptAccountDeletion(
  userId: string,
  opts: { requestedBy: AccountDeletionRequester; purgeAfter?: Date; now?: Date; kick?: boolean },
): Promise<AcceptOutcome> {
  const now = opts.now ?? new Date();
  const purgeAfter = opts.purgeAfter ?? new Date(now.getTime() + DELETION_COOLING_OFF_DAYS * 86_400_000);
  const outcome = await db.transaction(async (tx): Promise<AcceptOutcome> => {
    await acquireAdminPopulationLock(tx);
    const [user] = await tx.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.id, userId)).for("update");
    if (!user) return { status: "not_found" };
    const [pending] = await tx.select({ purgeAfter: adr.purgeAfter }).from(adr).where(active(userId));
    if (pending) {
      // An admin's purge-now brings a pending request's date forward; nothing else changes it.
      if (opts.purgeAfter && opts.purgeAfter < pending.purgeAfter) {
        await tx.update(adr).set({ purgeAfter: opts.purgeAfter }).where(active(userId));
        return { status: "already_pending", purgeAfter: opts.purgeAfter };
      }
      return { status: "already_pending", purgeAfter: pending.purgeAfter };
    }
    await assertAdminPopulationSurvives(tx, userId);
    await tx
      .insert(adr)
      .values({ userId, requestedAt: now, purgeAfter, requestedBy: opts.requestedBy, stage: "accepted", stageUpdatedAt: now })
      .onConflictDoUpdate({
        // A cancelled (or finished-then-restored) row restarts as a new request.
        target: adr.userId,
        set: {
          requestedAt: now, purgeAfter, requestedBy: opts.requestedBy, cancelledAt: null,
          stage: "accepted", stageUpdatedAt: now, holdReason: null, lastError: null, attempts: 0,
        },
      });
    await revokeUserSessions(tx, userId);
    return { status: "accepted", purgeAfter };
  });
  // A caller that advances the request itself (the admin purge-now) asks for no kick.
  if (outcome.status === "accepted" && opts.kick !== false) kick(userId);
  return outcome;
}

export type CancelOutcome = "cancelled" | "not_pending" | "too_late";

/**
 * Cancels a pending deletion: one compare-and-set on a request not yet
 * purging, so a cancel and the purge can never both win. The person's content
 * is live again at once (whatever they had deleted by hand stays deleted), and
 * an email confirms it. Their sessions are not restored: they sign in again.
 */
export async function cancelAccountDeletion(userId: string, opts: { notify?: boolean } = {}): Promise<CancelOutcome> {
  const [row] = await db
    .update(adr)
    .set({ cancelledAt: new Date(), holdReason: null, lastError: null })
    .where(and(active(userId), notInArray(adr.stage, ["purging", "done"])))
    .returning({ userId: adr.userId });
  if (!row) {
    const [existing] = await db.select({ stage: adr.stage }).from(adr).where(active(userId));
    return existing ? "too_late" : "not_pending";
  }
  if (opts.notify !== false) {
    const [user] = await db.select({ email: usersTable.email }).from(usersTable).where(eq(usersTable.id, userId));
    if (user?.email) {
      await sendEmail({ to: user.email, kind: "account_deletion_cancelled", ...buildAccountDeletionCancelledEmail(getSiteBaseUrl()) })
        .catch((err: unknown) => logger.warn({ err, userId }, "[account-deletion] cancel email not queued"));
    }
  }
  return "cancelled";
}

/** The pending request of an account, for the cancel screen and the admin panel; null when none. */
export async function pendingDeletion(userId: string) {
  const [row] = await db.select().from(adr).where(active(userId));
  return row ?? null;
}

// ── Advancing ─────────────────────────────────────────────────────────

/** Moves a request from one stage to the next only if it is still at the first and still active. */
async function compareAndSet(userId: string, from: AccountDeletionStage[], to: AccountDeletionStage, extra: Partial<typeof adr.$inferInsert> = {}): Promise<boolean> {
  const rows = await db
    .update(adr)
    .set({ stage: to, stageUpdatedAt: new Date(), lastError: null, ...extra })
    .where(and(active(userId), inArray(adr.stage, from)))
    .returning({ userId: adr.userId });
  return rows.length > 0;
}

async function recordFailure(userId: string, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  await db
    .update(adr)
    .set({ lastError: message.slice(0, 1000), attempts: sql`${adr.attempts} + 1` })
    .where(eq(adr.userId, userId));
}

/** Runs `advanceAccountDeletion` without waiting for it: the request is already safe, the worker is the recovery. */
function kick(userId: string): void {
  void advanceAccountDeletion(userId).catch((err: unknown) =>
    logger.warn({ err, userId }, "[account-deletion] kick did not finish; the worker resumes it"),
  );
}

/**
 * Cancels every subscription of the person that still bills or could resume
 * billing, and refreshes each source so membership recomputes from what
 * remains (an admin grant or a lifetime purchase survives). One already
 * cancelled or gone at Stripe counts as done.
 */
async function cancelSubscriptions(userId: string): Promise<void> {
  const subs = await db
    .select({ subscriptionId: membershipEntitlementsTable.providerRef })
    .from(membershipEntitlementsTable)
    .where(and(
      eq(membershipEntitlementsTable.userId, userId),
      eq(membershipEntitlementsTable.sourceType, "stripe_subscription"),
      inArray(membershipEntitlementsTable.lifecycleStatus, CANCELLABLE_SUBSCRIPTION_STATUSES),
    ));
  if (subs.length === 0) return;
  const { getUncachableStripeClient } = await import("./stripeClient");
  const { refreshSubscriptionSource } = await import("./membershipRefresh");
  const stripe = await getUncachableStripeClient();
  for (const { subscriptionId } of subs) {
    if (!subscriptionId) continue;
    try {
      await stripe.subscriptions.cancel(subscriptionId);
    } catch (err) {
      const code = (err as { code?: string }).code;
      const alreadyGone = code === "resource_missing" || /canceled|cancelled/i.test(err instanceof Error ? err.message : "");
      if (!alreadyGone) throw err;
    }
    await refreshSubscriptionSource(stripe, subscriptionId, { expectedUserId: userId, transitionEvent: "account_deletion" });
  }
}

/** True when a billing dispute on any of the person's sources is still open: the purge waits for it. */
async function openDispute(userId: string): Promise<boolean> {
  const rows = await db.execute(sql`
    SELECT 1 FROM entitlement_source_disputes d
    JOIN membership_entitlements e ON e.id = d.source_id
    WHERE e.user_id = ${userId} AND NOT d.is_terminal
    LIMIT 1
  `);
  return rows.rows.length > 0;
}

export type AdvanceResult = AccountDeletionStage | "cancelled" | "gone";

/**
 * Advances one request as far as it can go now and returns the stage it
 * reached. Each step is a compare-and-set from the stage before, so a crash or
 * a concurrent run resumes or no-ops rather than repeating a destructive step.
 */
export async function advanceAccountDeletion(userId: string, now = new Date()): Promise<AdvanceResult> {
  for (;;) {
    const [row] = await db.select().from(adr).where(eq(adr.userId, userId));
    if (!row) return "gone";
    if (row.cancelledAt) return "cancelled";
    try {
      switch (row.stage) {
        case "accepted":
          await cancelSubscriptions(userId);
          if (!(await compareAndSet(userId, ["accepted"], "subscription_cancelled"))) continue;
          break;
        case "subscription_cancelled": {
          // An admin's purge-now tells no one; a scheduled deletion is told its date.
          if (row.requestedBy !== "admin") {
            const [user] = await db.select({ email: usersTable.email }).from(usersTable).where(eq(usersTable.id, userId));
            if (user?.email) {
              await sendEmail({
                to: user.email,
                kind: "account_deletion_scheduled",
                ...buildAccountDeletionScheduledEmail(row.purgeAfter, `${getSiteBaseUrl()}/account/deletion`),
              });
            }
          }
          if (!(await compareAndSet(userId, ["subscription_cancelled"], "notified"))) continue;
          break;
        }
        case "notified":
        case "held":
          if (row.purgeAfter > now) return row.stage;
          if (await openDispute(userId)) {
            if (row.stage === "notified") await compareAndSet(userId, ["notified"], "held", { holdReason: "An open billing dispute on this account's purchases" });
            return "held";
          }
          if (!(await compareAndSet(userId, ["notified", "held"], "purging", { holdReason: null }))) continue;
          break;
        case "purging":
          await purgeAccount(userId);
          return "done";
        case "done":
          return "done";
      }
    } catch (err) {
      await recordFailure(userId, err);
      throw err;
    }
  }
}

// ── The purge ─────────────────────────────────────────────────────────

/** Every storage object the person owns, collected by owner rather than only through their memes. */
async function ownedObjects(userId: string): Promise<string[]> {
  const [memes, uploads, generated] = await Promise.all([
    db.select({ slug: memesTable.permalinkSlug }).from(memesTable).where(eq(memesTable.createdById, userId)),
    db.select({ path: uploadImageMetadataTable.objectPath }).from(uploadImageMetadataTable).where(eq(uploadImageMetadataTable.userId, userId)),
    // A fact gallery's background is everyone's: never destroyed with the account it was filed under.
    db.select({ path: userAiImagesTable.storagePath }).from(userAiImagesTable).where(and(eq(userAiImagesTable.userId, userId), aiImageIsOwnersOwn(userAiImagesTable))),
  ]);
  return [
    ...memes.flatMap((m) => memeObjectPaths(m.slug)),
    ...uploads.map((u) => u.path),
    ...generated.map((g) => g.path),
  ];
}

/**
 * The destructive stage, run only from `purging`. Objects first, through
 * preserve-before-change (the 7-day backup keeps them, S15); a failure leaves
 * the request at `purging` with the error recorded, and the next run retries
 * (a key already gone counts as deleted). Then, in one transaction under the
 * owner's content lock (shared with the content purger), the rows, the
 * reaction recount and the user row. Never the photo a meme was made from
 * unless it is the person's own upload, and never a quarantine record:
 * `quarantined_memes` and `ncmec_reports` keep their rows with the person set
 * null by their foreign keys.
 */
async function purgeAccount(userId: string): Promise<void> {
  const storage = new ObjectStorageService();
  for (const path of await ownedObjects(userId)) await storage.deleteObject(path);

  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`content-owner:${userId}`}))`);
    const [still] = await tx.select({ stage: adr.stage }).from(adr).where(and(active(userId), eq(adr.stage, "purging"))).for("update");
    if (!still) return;

    // Reactions the person left on what survives them: collect the targets,
    // delete, then recount each one that still exists.
    const targets = await tx
      .selectDistinct({ type: reactionsTable.targetType, id: reactionsTable.targetId })
      .from(reactionsTable)
      .where(eq(reactionsTable.userId, userId));
    await tx.delete(reactionsTable).where(eq(reactionsTable.userId, userId));

    const memeIds = (await tx.select({ id: memesTable.id }).from(memesTable).where(eq(memesTable.createdById, userId))).map((m) => m.id);
    const commentIds = (await tx.select({ id: commentsTable.id }).from(commentsTable).where(eq(commentsTable.authorId, userId))).map((c) => c.id);
    if (memeIds.length > 0) {
      await tx.delete(reactionsTable).where(and(eq(reactionsTable.targetType, "meme"), inArray(reactionsTable.targetId, memeIds)));
      await tx.delete(memesTable).where(inArray(memesTable.id, memeIds));
    }
    if (commentIds.length > 0) {
      await tx.delete(reactionsTable).where(and(eq(reactionsTable.targetType, "comment"), inArray(reactionsTable.targetId, commentIds)));
      await tx.delete(commentsTable).where(inArray(commentsTable.id, commentIds));
    }
    await tx.execute(sql`DELETE FROM external_links WHERE added_by_id = ${userId}`);
    await tx.execute(sql`DELETE FROM pending_reviews WHERE submitted_by_id = ${userId}`);
    await tx.execute(sql`UPDATE pending_reviews SET reviewed_by_id = NULL WHERE reviewed_by_id = ${userId}`);
    await tx.execute(sql`UPDATE pending_reviews SET production_rejected_by_id = NULL WHERE production_rejected_by_id = ${userId}`);
    await tx.delete(uploadImageMetadataTable).where(eq(uploadImageMetadataTable.userId, userId));
    await tx.delete(userAiImagesTable).where(eq(userAiImagesTable.userId, userId));

    // Facts persist forever, credited to a former member (plan S3).
    await tx.update(factsTable).set({ submittedById: null, submitterDeletedAt: new Date() }).where(eq(factsTable.submittedById, userId));

    // The admin path's explicit deletes: rows whose foreign key would block the user row.
    await tx.delete(stripeCheckoutRequestLedgerTable).where(eq(stripeCheckoutRequestLedgerTable.userId, userId));
    await tx.update(membershipHistoryTable).set({ performedByAdminId: null }).where(eq(membershipHistoryTable.performedByAdminId, userId));
    await tx.delete(membershipHistoryTable).where(eq(membershipHistoryTable.userId, userId));
    await tx.delete(activityFeedTable).where(eq(activityFeedTable.userId, userId));

    for (const t of targets) {
      if ((t.type === "meme" && memeIds.includes(t.id)) || (t.type === "comment" && commentIds.includes(t.id))) continue;
      await refreshTargetCounts(tx, t.type as ReactionTargetType, t.id);
    }

    // Last: the user row. Its cascades take sessions, tokens, entitlements,
    // preferences, share intents and this request; `ncmec_reports` and
    // `quarantined_memes` keep their rows with the person set null.
    await tx.delete(usersTable).where(eq(usersTable.id, userId));
  });
}

// ── The worker ────────────────────────────────────────────────────────

export interface DeletionWorkerCounts {
  selected: number;
  advanced: number;
  purged: number;
  held: number;
  failed: number;
}

/**
 * One pass over every active request (hourly, `index.ts`): advances each as
 * far as it can go. Recovery for an interrupted kick and the only path to the
 * destructive stage. `userIds` restricts the run (tests).
 */
export async function runAccountDeletionWorker(opts: { userIds?: string[]; now?: Date } = {}): Promise<DeletionWorkerCounts> {
  const counts: DeletionWorkerCounts = { selected: 0, advanced: 0, purged: 0, held: 0, failed: 0 };
  const rows = await db
    .select({ userId: adr.userId, stage: adr.stage })
    .from(adr)
    .where(and(isNull(adr.cancelledAt), ne(adr.stage, "done"), opts.userIds ? inArray(adr.userId, opts.userIds) : undefined));
  for (const row of rows) {
    counts.selected++;
    try {
      const reached = await advanceAccountDeletion(row.userId, opts.now);
      if (reached === "done") counts.purged++;
      else if (reached === "held") counts.held++;
      else if (reached !== row.stage) counts.advanced++;
    } catch (err) {
      counts.failed++;
      logger.warn({ err, userId: row.userId }, "[account-deletion] stage failed; retried next run");
    }
  }
  if (counts.selected > 0) logger.info(counts, "[account-deletion] worker run");
  return counts;
}

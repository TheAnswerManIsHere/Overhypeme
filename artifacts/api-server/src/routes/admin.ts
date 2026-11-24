import { Router, type IRouter, type Request, type Response } from "express";
import { profilePictureUrl } from "../lib/profilePicture";
import { z } from "zod";
import * as Sentry from "@sentry/node";
import { db, usersTable, sessionsTable } from "@workspace/db";
import { factsTable, commentsTable, adminConfigTable, featureFlagsTable, userGenerationCostsTable, membershipEntitlementsTable, entitlementSourceDisputesTable, membershipHistoryTable, asyncJobsTable, stripeWebhookAuditTable, factTaxonomyRunsTable } from "@workspace/db/schema";
import { eq, desc, count, ilike, sql, and, or, inArray, isNull, asc, gt, getTableColumns } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { requireRole } from "../middlewares/tierMiddleware";
import { backfillEmbeddings } from "../lib/embeddings";
import { ATTENTION_COUNT_COLUMNS, ATTENTION_PREDICATES, ATTENTION_REASONS, ATTENTION_REASONS_COLUMN, approvedFact, attentionReasonOf } from "../lib/factAttention";
import { enqueueJob, USE_CONFIGURED_MAX_ATTEMPTS } from "../lib/asyncJobs";
import { emailRetryReset } from "../lib/email";
import { laneHealth, queueHealth, queueHealthJobs, skipReasonOf } from "../lib/queueHealth";
import { isNcmecReservedConfigKey, NCMEC_RESERVED_KEY_REFUSAL } from "../lib/moderation/ncmecConfig";
import { READ_ONLY_CONFIG_KEY } from "../lib/readOnlyMode";
import { CODE_OWNED_AI_SETTING_REFUSAL, isCodeOwnedAiConfigKey, withoutCodeOwnedAiSettings } from "../lib/codeOwnedPrompts";
import { checkSharedRateLimit } from "../lib/sharedRateLimiter";
import { revokeUserSessions } from "../lib/auth";
import {
  checkPersonalName,
  FACT_TEXT_EDIT_CODES,
  humorNoteSaveSchema,
} from "@workspace/api-zod";
import { type AuthenticatedRequest } from "../middlewares/authMiddleware";
import { normalizeFactTemplateForStorage } from "../lib/normalizeFactTemplateForStorage";
import { logActivity } from "../lib/activity";
import { recordAdminAction } from "../lib/adminActions";
import { publishFactChanges, discardFactChanges, deactivateFact, reactivateFact, deleteFact, factHasUnpublishedChanges, type AttachedContent, type FactLifecycleResult } from "../lib/factLifecycle";
import { FACT_HASHTAG_LIMIT, FACT_HISTORY_LIMIT, factHistory, factSheet, saveFactHashtags, saveFactHumorNote } from "../lib/factSheet";
import { factEnrichmentPayload } from "../lib/enrichmentJobs";
import { getAllConfig, bustConfigCache, getPublicConfig } from "../lib/adminConfig";
import {
  isMembershipConfigKey,
  lockAndLoadMembershipConfig,
  validateMembershipConfigWrite,
  type MembershipConfigKey,
} from "../lib/membershipTiming";

/**
 * A relational-config rejection raised from inside the write transaction.
 *
 * Distinguished by type rather than by message so the catch cannot mistake a
 * genuine database failure for a validation rejection and answer it with a 400.
 */
class RelationalConfigError extends Error {}

/**
 * Parse a config value EXACTLY as the runtime resolver will.
 *
 * `adminConfig`'s `getConfigInt` uses `parseInt`, which stops at the first
 * non-digit: "1e5" is 1 at runtime but 100000 to `Number`. Validating with one
 * and running with the other lets an operator store a value the validator
 * approved and the system then violates. Non-canonical strings are refused
 * outright rather than silently reinterpreted — round-tripping the parsed number
 * back to a string is what makes "canonical" checkable.
 */
function parseMembershipConfigValue(raw: string, dataType: string): number | null {
  const trimmed = raw.trim();
  if (dataType === "integer") {
    const parsed = parseInt(trimmed, 10);
    if (Number.isNaN(parsed)) return null;
    return String(parsed) === trimmed ? parsed : null;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}
import { effectiveTierExpr } from "../lib/membershipState";
import { driftedMembershipUsers } from "../lib/membershipGraceSweep";
import { graceSweepHealth } from "../lib/membershipSchedules";
import { refreshSubscriptionSource } from "../lib/membershipRefresh";
import {
  hasQualifyingLifetimeSource,
  recomputeMembership,
  writeAdminGrant,
  applyAdminGrant,
  writeAdminRevocation,
} from "../lib/membershipSources";
import { authorizeAdminGrant, authorizeAdminRevocation } from "../lib/entitlementVerification";
import {
  acquireAdminPopulationLock,
  assertAdminPopulationSurvives,
  assertNotSelfDemotion,
  crossesBootstrapBoundary,
  respondToGuardError,
} from "../lib/adminLockoutGuard";
import { isReachableAdminSql, isRealAdminRow, isRealAdminSql } from "../lib/adminIdentity";
import {
  getAllTierFeatureMatrix,
  setTierFeature,
  UnknownFeatureError,
  UnknownTierError,
} from "../lib/featureAccess";
import { getSiteBaseUrl } from "../lib/siteUrl";
import bcrypt from "bcryptjs";
import { exportUserData, runRetentionWindowJobs } from "../lib/dataLifecycle";
import { validateVisualStrategyOverridePersistence } from "../lib/imagePrompt/promptBudget";
import { logger } from "../lib/logger";
import { stripeDriver } from "../lib/stripeDriver.js";
import { adminPurgeNow, pendingDeletion, purgeNowBody } from "../lib/accountDeletion";

/**
 * The human-readable label an admin action is attributed by.
 *
 * First NON-BLANK candidate, not first non-null: the admin edit route accepts a
 * whitespace-only display name, and `??` would pick that over a perfectly good
 * email — which `authorizeAdminGrant` then trims to empty and rejects, turning
 * grant, revoke and Legendary user-creation into 500s. Returns "" when nothing
 * readable exists, which those constructors reject deliberately; the raw id is
 * never a fallback, since no internal id may reach an admin-visible surface.
 */
function adminLabel(actor: { displayName?: string | null; email?: string | null }): string {
  return [actor.displayName, actor.email].find((v) => (v ?? "").trim() !== "")?.trim() ?? "";
}

const router: IRouter = Router();

/**
 * Shim for backwards-compatibility.
 * Delegates to requireRole("admin") — the single source of admin gating.
 */
export const requireAdmin = requireRole("admin");

router.get("/admin/stats", requireAdmin, async (_req: Request, res: Response) => {
  const [[{ totalFacts }], [{ totalUsers }]] = await Promise.all([
    db.select({ totalFacts: count() }).from(factsTable).where(eq(factsTable.isActive, true)),
    db.select({ totalUsers: count() }).from(usersTable).where(eq(usersTable.isActive, true)),
  ]);
  res.json({ totalFacts, totalUsers });
});

router.get("/admin/users", requireAdmin, async (req: Request, res: Response) => {
  const page = Math.max(1, parseInt(String(req.query["page"] ?? "1"), 10));
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query["limit"] ?? "50"), 10)));
  const offset = (page - 1) * limit;
  const search = String(req.query["search"] ?? "").trim();
  const showInactive = req.query["inactive"] === "true";

  const activeFilter = showInactive ? undefined : eq(usersTable.isActive, true);
  const searchFilter = search
    ? sql`(${usersTable.email} ilike ${`%${search}%`} OR ${usersTable.displayName} ilike ${`%${search}%`} OR ${usersTable.id}::text ilike ${`%${search}%`})`
    : undefined;
  const where = activeFilter && searchFilter ? and(activeFilter, searchFilter) : (activeFilter ?? searchFilter);

  // The admin list renders `membershipTier`, so it reports the EFFECTIVE tier
  // rather than the raw column: with the convergence sweep failing and a grace
  // horizon passed, authorization has already demoted the user and this screen
  // would otherwise still show Legendary. Both surfaces evaluate at one bound
  // instant so the list cannot disagree with itself mid-page.
  const asOf = new Date();
  const [users, [{ total }]] = await Promise.all([
    db
      .select({ ...getTableColumns(usersTable), membershipTier: effectiveTierExpr(asOf) })
      .from(usersTable)
      .where(where)
      .orderBy(desc(usersTable.createdAt))
      .limit(limit)
      .offset(offset),
    db.select({ total: count() }).from(usersTable).where(where),
  ]);

  // The same picture rule as every other surface: the uploaded photo or none.
  res.json({ users: users.map((u) => ({ ...u, profileImageUrl: profilePictureUrl(u.profileImageUrl) })), total, page, limit });
});

router.patch("/admin/users/:id", requireAdmin, async (req: Request, res: Response) => {
  const id = String(req.params["id"] ?? "");
  const body = req.body as Record<string, unknown>;

  const updates: Record<string, unknown> = {};
  // isActive is no longer an admin edit (launch Phase 5, Increment 7a):
  // removal is suspension or deletion. Ignored if sent.
  if (typeof body["isAdmin"] === "boolean") updates.isAdmin = body["isAdmin"];
  if (typeof body["adminNotifications"] === "boolean") updates.adminNotifications = body["adminNotifications"];
  if (typeof body["disputeNotifications"] === "boolean") updates.disputeNotifications = body["disputeNotifications"];
  // nsfwModeEnabled is withdrawn (launch Phase 5, S13): ignored if sent.
  if (body["displayName"] !== undefined) {
    // The shared name rule applies to admin edits too (identity-flow Phase 2).
    if (body["displayName"]) {
      const checked = checkPersonalName(body["displayName"]);
      if (!checked.ok) {
        res.status(400).json({ error: checked.error });
        return;
      }
      updates.displayName = checked.value;
    } else {
      updates.displayName = null;
    }
  }
  if (body["email"] !== undefined) updates.email = body["email"] ? String(body["email"]).trim().toLowerCase() : null;
  // `membershipTier` is deliberately NOT accepted here. It is derived from
  // entitlement sources, and accepting it would let an admin write a value the
  // next recompute silently reverts — the failure mode being that the change
  // appears to work and then does not. Comping a membership is
  // POST /admin/users/:id/grant-lifetime, which writes an entitlement.
  if (body["pronouns"] !== undefined) {
    const p = String(body["pronouns"]).trim();
    if (p.length > 0 && p.length <= 80) updates.pronouns = p;
  }
  if ("monthlyGenerationLimitOverrideUsd" in body) {
    if (body["monthlyGenerationLimitOverrideUsd"] === null || body["monthlyGenerationLimitOverrideUsd"] === "") {
      updates.monthlyGenerationLimitOverrideUsd = null;
    } else {
      const parsed = parseFloat(String(body["monthlyGenerationLimitOverrideUsd"]));
      if (!isNaN(parsed) && parsed >= 0) {
        updates.monthlyGenerationLimitOverrideUsd = String(parsed);
      }
    }
  }

  // ── Lockout guards ──────────────────────────────────────────────────────
  // Two edits here can remove an admin's console access: clearing isAdmin,
  // and an email change, because authMiddleware derives real-admin status
  // partly FROM the email — so changing the last bootstrap-email-only admin's
  // address removes their access without touching isAdmin. (Suspension and
  // deletion, the other two, have their own routes under the same guard.)
  const demoting = updates.isAdmin === false;

  // Self-demotion doesn't need the population lock or a DB read — `demoting`
  // comes straight from the request body, so it can't be stale.
  if (demoting) {
    try {
      // An admin may not remove their own admin flag. Checked before the
      // population count, so the error names the real reason.
      assertNotSelfDemotion(req.user?.id, id);
    } catch (err) {
      if (respondToGuardError(err, res)) return;
      throw err;
    }
  }

  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "No valid fields to update" });
    return;
  }


  let updated;
  try {
    [updated] = await db.transaction(async (tx) => {
    // The lock FIRST — before reading anything the removal decision depends
    // on. Round 4 of PR #425's review found the email-crossing check reading
    // the target's email/isAdmin before this transaction even opened: a
    // concurrent admin-mutating transaction could change that row between the
    // read and the lock, so the DECISION of whether to guard at all could be
    // made from data that was already stale by the time it was used — not
    // just the count afterward, which the lock already protected.
    await acquireAdminPopulationLock(tx);

    // A crossing alone isn't enough: if the target is ALSO a real admin via
    // `is_admin` (or the env allowlist) before AND after this update, losing
    // the bootstrap-email grant removes nothing — they're still reachable
    // through the other mechanism. Round 2 of PR #425's review caught this:
    // the boundary-crossing check alone would reject changing a genuinely
    // multi-mechanism admin's email as `last_admin` even though nothing is
    // actually being removed.
    let emailCrossesBootstrap = false;
    if (updates.email !== undefined) {
      const [current] = await tx
        .select({ id: usersTable.id, email: usersTable.email, isAdmin: usersTable.isAdmin })
        .from(usersTable)
        .where(eq(usersTable.id, id))
        .limit(1);
      if (current && crossesBootstrapBoundary(current.email, updates.email as string | null)) {
        const nextIsAdmin =
          updates.isAdmin !== undefined ? (updates.isAdmin as boolean) : current.isAdmin;
        const wasAdmin = isRealAdminRow(current);
        const willBeAdmin = isRealAdminRow({
          id: current.id,
          email: updates.email as string | null,
          isAdmin: nextIsAdmin,
        });
        emailCrossesBootstrap = wasAdmin && !willBeAdmin;
      }
    }

    const removesAdminAccess = demoting || emailCrossesBootstrap;

    // The lock, the count, and the write are ONE transaction. Splitting them
    // leaves the race the guard exists to close: at READ COMMITTED two
    // transactions removing DIFFERENT admin rows both read a count of two and
    // both commit, because the rows they write don't overlap.
    if (removesAdminAccess) {
      await assertAdminPopulationSurvives(tx, id);
    }

    const [row] = await tx
      .update(usersTable)
      .set(updates)
      .where(eq(usersTable.id, id))
      .returning();

    return [row];
    });
  } catch (err) {
    if (respondToGuardError(err, res)) return;
    throw err;
  }

  if (!updated) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  res.json({ success: true, user: updated });
});

router.get("/admin/administrators", requireAdmin, async (_req: Request, res: Response) => {
  const admins = await db
    .select({
      id: usersTable.id,
      displayName: usersTable.displayName,
      email: usersTable.email,
      adminNotifications: usersTable.adminNotifications,
      disputeNotifications: usersTable.disputeNotifications,
      isActive: usersTable.isActive,
    })
    .from(usersTable)
    // All three grant mechanisms, not the stored column alone. This listing is
    // what an operator looks at to answer "how many admins do we have?" before
    // demoting someone, so showing them a subset of the real population is
    // exactly the wrong place to be approximate.
    .where(isRealAdminSql())
    .orderBy(usersTable.displayName);
  res.json({ administrators: admins });
});

router.delete("/admin/users/:id", requireAdmin, async (req: Request, res: Response) => {
  const id = String(req.params["id"] ?? "");
  if (!id) { res.status(400).json({ error: "Invalid user id" }); return; }

  const hard = req.query["hard"] === "true";

  // ── Hard delete: the account deletion engine, purging now ───────────────
  // One engine owns every account deletion (launch Phase 5, plan S14): the
  // request is accepted under the admin population lock (never the last
  // administrator), the person's subscriptions are cancelled, and the purge
  // runs at once unless a billing dispute holds it. A failed stage is
  // recorded and the hourly worker resumes it.
  if (hard) {
    try {
      assertNotSelfDemotion(req.user?.id, id);
      // An admin's removal: a request the member already made becomes the
      // admin's, so their comments, submissions, votes and hearts go too.
      const outcome = await adminPurgeNow(id, { takeOver: true });
      if (outcome.status === "not_found") { res.status(404).json({ error: "User not found" }); return; }
      res.json(purgeNowBody(outcome.stage));
    } catch (err) {
      if (respondToGuardError(err, res)) return;
      logger.error({ err, userId: id }, "[hard-delete] engine stage failed; the worker retries it");
      const pending = await pendingDeletion(id).catch(() => null);
      res.status(500).json({ error: err instanceof Error ? err.message : "Deletion failed", stage: pending?.stage ?? "unknown" });
    }
    return;
  }

  // The soft delete is retired (launch Phase 5, Increment 7a): an account is
  // removed by suspension, or deleted through the engine above.
  res.status(400).json({ error: "Soft delete is retired: suspend the account, or delete it with ?hard=true." });
});

// GET /admin/users/:id/membership — full membership status for a user
router.get("/admin/users/:id/membership", requireAdmin, async (req: Request, res: Response) => {
  const id = String(req.params["id"] ?? "");
  try {
    const [lifetimeRows, subRows, historyRows] = await Promise.all([
      // A lifetime PURCHASE and an admin GRANT are now different source types,
      // where the old schema conflated them: a comp was a lifetime row with a
      // synthesized payment-intent id and amount 0. This screen shows both, and
      // says which is which.
      db.select({
        id: membershipEntitlementsTable.id,
        userId: membershipEntitlementsTable.userId,
        sourceType: membershipEntitlementsTable.sourceType,
        stripePaymentIntentId: membershipEntitlementsTable.providerRef,
        amount: membershipEntitlementsTable.amount,
        currency: membershipEntitlementsTable.currency,
        status: membershipEntitlementsTable.lifecycleStatus,
        isMembershipProduct: membershipEntitlementsTable.isMembershipProduct,
        disputeLossRevokedAt: membershipEntitlementsTable.disputeLossRevokedAt,
        grantedByAdminId: membershipEntitlementsTable.grantedByAdminId,
        grantedByAdminLabel: membershipEntitlementsTable.grantedByAdminLabel,
        grantReason: membershipEntitlementsTable.grantReason,
        revokedByAdminLabel: membershipEntitlementsTable.revokedByAdminLabel,
        revokedReason: membershipEntitlementsTable.revokedReason,
        revokedAt: membershipEntitlementsTable.revokedAt,
        createdAt: membershipEntitlementsTable.createdAt,
      })
        .from(membershipEntitlementsTable)
        .where(and(
          eq(membershipEntitlementsTable.userId, id),
          or(
            eq(membershipEntitlementsTable.sourceType, "stripe_lifetime_payment"),
            eq(membershipEntitlementsTable.sourceType, "admin_grant"),
          ),
        ))
        .orderBy(desc(membershipEntitlementsTable.createdAt))
        .limit(5),
      db.select().from(membershipEntitlementsTable)
        .where(and(
          eq(membershipEntitlementsTable.userId, id),
          eq(membershipEntitlementsTable.sourceType, "stripe_subscription"),
        ))
        .orderBy(desc(membershipEntitlementsTable.createdAt))
        .limit(1),
      (() => {
        const adminUsers = alias(usersTable, "admin_users");
        return db.select({
          id: membershipHistoryTable.id,
          event: membershipHistoryTable.event,
          plan: membershipHistoryTable.plan,
          amount: membershipHistoryTable.amount,
          currency: membershipHistoryTable.currency,
          createdAt: membershipHistoryTable.createdAt,
          stripePaymentIntentId: membershipHistoryTable.stripePaymentIntentId,
          stripeInvoiceId: membershipHistoryTable.stripeInvoiceId,
          stripeDisputeId: membershipHistoryTable.stripeDisputeId,
          performedByAdminId: membershipHistoryTable.performedByAdminId,
          performedByAdminDisplayName: adminUsers.displayName,
          performedByAdminEmail: adminUsers.email,
        }).from(membershipHistoryTable)
          .leftJoin(adminUsers, eq(membershipHistoryTable.performedByAdminId, adminUsers.id))
          .where(eq(membershipHistoryTable.userId, id))
          .orderBy(desc(membershipHistoryTable.createdAt))
          .limit(30);
      })(),
    ]);

    // The shape this endpoint has always returned, rebuilt from the entitlement
    // source so the admin client contract is unchanged — same pattern as
    // GET /stripe/subscription.
    const subSource = subRows[0] ?? null;
    const appSub = subSource
      ? {
          id: subSource.id,
          userId: subSource.userId,
          stripeSubscriptionId: subSource.providerRef,
          plan: subSource.plan,
          status: subSource.lifecycleStatus,
          currentPeriodEnd: subSource.currentPeriodEnd,
          cancelAtPeriodEnd: subSource.cancelAtPeriodEnd ?? false,
          createdAt: subSource.createdAt,
          updatedAt: subSource.updatedAt,
        }
      : null;

    let stripeSub: Record<string, unknown> | null = null;
    if (appSub?.stripeSubscriptionId) {
      const result = await db.execute(
        sql`SELECT s.id, s.status, s.current_period_start, s.current_period_end, s.cancel_at_period_end, s.canceled_at, s.created
            FROM stripe.subscriptions s WHERE s.id = ${appSub.stripeSubscriptionId} LIMIT 1`,
      );
      stripeSub = (result.rows[0] as Record<string, unknown>) ?? null;
    }

    const { getConfigStringRaw } = await import("../lib/adminConfig");
    const liveMode = (await getConfigStringRaw("stripe_live_mode", "false")) === "true";

    res.json({
      // Qualification, not existence: a refunded purchase keeps its row.
      isLifetime: await hasQualifyingLifetimeSource(id),
      // Separate from `isLifetime` on purpose. Revoking only ever acts on an
      // active admin grant, so the client needs to know about THAT source
      // specifically — a paid lifetime purchase also makes `isLifetime` true and
      // has nothing for revoke to act on.
      hasActiveAdminGrant: lifetimeRows.some(
        (row) => row.sourceType === "admin_grant" && row.status === "active",
      ),
      lifetimeEntitlement: lifetimeRows[0] ?? null,
      appSubscription: appSub,
      stripeSub,
      history: historyRows,
      liveMode,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to fetch membership data";
    res.status(500).json({ error: msg });
  }
});

// GET /admin/refunds-disputes — paginated list of refund/dispute events from membership_history
// Returns rows for events: refund, partial_refund, dispute_opened, dispute_won,
// dispute_lost, dispute_closed.
// Joined with the users table so the UI can display who was affected without a second round-trip.
/**
 * GET /admin/membership/grace-sweep — the sweep's status at BOTH altitudes.
 *
 * `health` is the aggregate: cadence, staleness, whether it is past its alert
 * threshold, and the last error. `drifted` is the per-item disposition: the
 * users whose stored tier currently disagrees with what the read path enforces,
 * i.e. exactly what a sweep that partially converged and then failed left
 * behind.
 *
 * Nothing here is an access bug. `effectiveTierExpr` demotes these users on
 * every request already; what this reports is a projection lag, which is
 * precisely why it needs a surface rather than an alarm.
 *
 * Rate-limited like its `queue-health` sibling above: `requireAdmin` bounds
 * *who* can call this, not how often — an authenticated or compromised admin
 * session could otherwise re-run `driftedMembershipUsers()`'s full active-user
 * scan on every request. Same family/shape as `admin.queue-health`.
 */
router.get("/admin/membership/grace-sweep", requireAdmin, async (req: Request, res: Response) => {
  try {
    const rateLimit = await checkSharedRateLimit(
      { endpoint: "admin.membership.grace-sweep", ip: req.ip ?? null, userId: req.user?.id ?? null },
      { limit: 60, windowMs: 60_000 },
    );
    if (!rateLimit.allowed) { res.status(429).json({ error: "Too many requests" }); return; }

    const [health, drifted] = await Promise.all([
      graceSweepHealth(),
      driftedMembershipUsers(),
    ]);
    // `driftedCount` is the UNCAPPED total, not the length of the sample. A cap
    // reported as the total is a silent truncation, and this surface exists to
    // tell an operator the real backlog.
    res.json({
      health,
      drifted: drifted.users,
      driftedCount: drifted.total,
      driftedTruncated: drifted.truncated,
    });
  } catch (err) {
    logger.error({ err }, "[admin] grace sweep status query failed");
    res.status(503).json({ error: "Could not read grace sweep status" });
  }
});

router.get("/admin/refunds-disputes", requireAdmin, async (req: Request, res: Response) => {
  const REFUND_DISPUTE_EVENTS = [
    "refund",
    // A partial refund is a real refund event with its own durable history row
    // (it deliberately leaves the entitlement active). Omitting it here hid it
    // from the one surface dedicated to refunds while it sat in the database.
    "partial_refund",
    "dispute_opened",
    "dispute_won",
    "dispute_lost",
    "dispute_closed",
  ] as const;

  const page = Math.max(1, parseInt(String(req.query["page"] ?? "1"), 10));
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query["limit"] ?? "50"), 10)));
  const offset = (page - 1) * limit;
  const search = String(req.query["search"] ?? "").trim();

  // Event filter: comma-separated list, falling back to all refund/dispute events.
  const rawEvent = String(req.query["event"] ?? "").trim();
  const requestedEvents = rawEvent
    ? rawEvent.split(",").map((e) => e.trim()).filter((e): e is typeof REFUND_DISPUTE_EVENTS[number] =>
        (REFUND_DISPUTE_EVENTS as readonly string[]).includes(e),
      )
    : [...REFUND_DISPUTE_EVENTS];
  const eventList = requestedEvents.length > 0 ? requestedEvents : [...REFUND_DISPUTE_EVENTS];

  const eventFilter = inArray(membershipHistoryTable.event, eventList);
  const searchFilter = search
    ? sql`(${usersTable.email} ilike ${`%${search}%`} OR ${usersTable.displayName} ilike ${`%${search}%`} OR ${usersTable.id}::text ilike ${`%${search}%`})`
    : undefined;
  const where = searchFilter ? and(eventFilter, searchFilter) : eventFilter;

  try {
    const { getConfigStringRaw } = await import("../lib/adminConfig");
    const liveMode = (await getConfigStringRaw("stripe_live_mode", "false")) === "true";

    const [rows, [{ total }]] = await Promise.all([
      db
        .select({
          id: membershipHistoryTable.id,
          createdAt: membershipHistoryTable.createdAt,
          event: membershipHistoryTable.event,
          plan: membershipHistoryTable.plan,
          amount: membershipHistoryTable.amount,
          currency: membershipHistoryTable.currency,
          stripePaymentIntentId: membershipHistoryTable.stripePaymentIntentId,
          stripeSubscriptionId: membershipHistoryTable.stripeSubscriptionId,
          stripeInvoiceId: membershipHistoryTable.stripeInvoiceId,
          stripeDisputeId: membershipHistoryTable.stripeDisputeId,
          userId: membershipHistoryTable.userId,
          userEmail: usersTable.email,
          userDisplayName: usersTable.displayName,
        })
        .from(membershipHistoryTable)
        .leftJoin(usersTable, eq(membershipHistoryTable.userId, usersTable.id))
        .where(where)
        .orderBy(desc(membershipHistoryTable.createdAt))
        .limit(limit)
        .offset(offset),
      db
        .select({ total: count() })
        .from(membershipHistoryTable)
        .leftJoin(usersTable, eq(membershipHistoryTable.userId, usersTable.id))
        .where(where),
    ]);

    res.json({ rows, total, page, limit, liveMode, eventTypes: REFUND_DISPUTE_EVENTS });
  } catch (err) {
    logger.error({ err }, "[admin] refunds-disputes error");
    const msg = err instanceof Error ? err.message : "Failed to load refunds and disputes";
    res.status(500).json({ error: msg });
  }
});

// POST /admin/users/:id/grant-lifetime — comp a membership
//
// W1b: an admin comp is an ENTITLEMENT with an actor, a label and a reason —
// never a payment. What this replaces inserted a `lifetime_entitlements` row
// with a synthesized payment-intent id (`admin_grant_<timestamp>_<random>`),
// `stripeCustomerId: "admin_grant"` and `amount: 0`, which is indistinguishable
// from a real purchase in any payment audit, and then set the tier by hand.
router.post("/admin/users/:id/grant-lifetime", requireAdmin, async (req: Request, res: Response) => {
  const id = String(req.params["id"] ?? "");
  try {
    const [userRows] = await Promise.all([
      db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.id, id)).limit(1),
    ]);
    if (!userRows[0]) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const actor = req.user!;
    // The only constructor for a grant. It throws rather than returning a
    // partial record, so a blank actor or reason cannot reach the database and
    // be discovered at a constraint — or not at all, if a future writer bypasses
    // the constraint's shape.
    const grant = authorizeAdminGrant({
      userId: id,
      grantedByAdminId: actor.id,
      // Never the raw admin id: a raw internal id may not reach any
      // admin-visible surface, and `authorizeAdminGrant` rejects a blank label
      // rather than let the write proceed with nothing human-readable to show.
      grantedByAdminLabel: adminLabel(actor),
      grantReason: String((req.body as Record<string, unknown>)?.["reason"] ?? "").trim() ||
        "Comped by an administrator",
    });

    // The entitlement row, its history event and the derived-tier recompute,
    // in one transaction (lib/membershipSources.ts).
    const outcome = await applyAdminGrant(grant);

    if (!outcome.created) {
      // The partial unique index on active admin grants makes a duplicate
      // submission — or a retry after an uncertain response — a no-op rather
      // than a second qualifying row that would survive a later revoke.
      res.status(400).json({ error: "User already has an active admin grant" });
      return;
    }

    const [updated] = await db.select().from(usersTable).where(eq(usersTable.id, id)).limit(1);
    res.json({ success: true, user: updated });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Grant failed";
    res.status(500).json({ error: msg });
  }
});

// POST /admin/users/:id/revoke-lifetime — revoke an admin grant
//
// W1b's revocation clause: the grant is marked revoked WITH provenance, never
// deleted. Deleting it — which is what this replaces — destroys the record that
// a human granted and a human took it away, and history is append-only.
router.post("/admin/users/:id/revoke-lifetime", requireAdmin, async (req: Request, res: Response) => {
  const id = String(req.params["id"] ?? "");
  try {
    const actor = req.user!;
    const revocation = authorizeAdminRevocation({
      revokedByAdminId: actor.id,
      // Never the raw admin id — same reasoning as the grant path above.
      revokedByAdminLabel: adminLabel(actor),
      revokedReason: String((req.body as Record<string, unknown>)?.["reason"] ?? "").trim() ||
        "Revoked by an administrator",
    });

    const outcome = await db.transaction(async (tx) => {
      const { revoked } = await writeAdminRevocation(tx, id, revocation);
      if (!revoked) return { revoked: false as const };

      await tx.insert(membershipHistoryTable).values({
        userId: id,
        event: "admin_revoke",
        performedByAdminId: actor.id,
      });
      await recomputeMembership(tx, id);
      return { revoked: true as const };
    });

    if (!outcome.revoked) {
      res.status(400).json({ error: "User does not have an active admin grant" });
      return;
    }

    res.json({ success: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Revoke failed";
    res.status(500).json({ error: msg });
  }
});

router.post("/admin/users", requireAdmin, async (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;

  const email = body["email"] ? String(body["email"]).trim().toLowerCase() : null;
  const password = body["password"] ? String(body["password"]) : null;
  let displayName: string | null = null;
  if (body["displayName"]) {
    const checked = checkPersonalName(body["displayName"]);
    if (!checked.ok) {
      res.status(400).json({ error: checked.error });
      return;
    }
    displayName = checked.value;
  }
  const membershipTier = ["unregistered", "registered", "legendary"].includes(String(body["membershipTier"] ?? "unregistered"))
    ? (String(body["membershipTier"] ?? "unregistered") as "unregistered" | "registered" | "legendary")
    : "unregistered";
  const isAdmin = body["isAdmin"] === true;

  if (!email) {
    res.status(400).json({ error: "Email is required" });
    return;
  }
  if (!password) {
    res.status(400).json({ error: "Password is required" });
    return;
  }
  if (password.length < 8) {
    res.status(400).json({ error: "Password must be at least 8 characters" });
    return;
  }
  if (password.length > 128) {
    res.status(400).json({ error: "Password must be at most 128 characters" });
    return;
  }
  if (!displayName) {
    res.status(400).json({ error: "Display name is required" });
    return;
  }

  const passwordHash = await bcrypt.hash(password, 12);

  try {
    // Settled decision 8: admin user-creation writes an ENTITLEMENT, never a
    // tier. Creating a user at `legendary` directly would put the one field this
    // whole model derives back under manual control, and the first recompute
    // would silently undo it — the user would appear Legendary until any event
    // touched them, then drop.
    const actor = req.user!;
    const created = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(usersTable)
        .values({
          email,
          passwordHash,
          displayName,
          // Never `legendary`: that tier is granted below, through the model.
          membershipTier: membershipTier === "legendary" ? "registered" : membershipTier,
          isAdmin,
          isActive: true,
        })
        .returning();

      if (membershipTier === "legendary") {
        await writeAdminGrant(
          tx,
          authorizeAdminGrant({
            userId: row.id,
            grantedByAdminId: actor.id,
            // Never the raw admin id: a raw internal id may not reach any
      // admin-visible surface, and `authorizeAdminGrant` rejects a blank label
      // rather than let the write proceed with nothing human-readable to show.
      grantedByAdminLabel: adminLabel(actor),
            grantReason: "Created as a Legendary member by an administrator",
          }),
        );
        await tx.insert(membershipHistoryTable).values({
          userId: row.id,
          event: "admin_grant",
          performedByAdminId: actor.id,
        });
        await recomputeMembership(tx, row.id);
        const [refreshed] = await tx.select().from(usersTable).where(eq(usersTable.id, row.id)).limit(1);
        return refreshed ?? row;
      }

      return row;
    });

    const { passwordHash: _omit, ...safeUser } = created;
    res.status(201).json({ success: true, user: safeUser });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("duplicate key") || msg.includes("unique")) {
      if (msg.includes("email")) {
        res.status(409).json({ error: "A user with that email already exists" });
      } else {
        res.status(409).json({ error: "A user with those details already exists" });
      }
      return;
    }
    logger.error({ err }, "[admin] Create user error");
    res.status(500).json({ error: "Failed to create user" });
  }
});

// Column projection for the facts list.
const FACT_LIST_COLUMNS = {
  id: factsTable.id,
  text: factsTable.text,
  canonicalText: factsTable.canonicalText,
  isActive: factsTable.isActive,
  upvotes: factsTable.upvotes,
  downvotes: factsTable.downvotes,
  score: factsTable.score,
  wilsonScore: factsTable.wilsonScore,
  commentCount: factsTable.commentCount,
  shareCount: factsTable.shareCount,
  submittedById: factsTable.submittedById,
  splitTokenIndex: factsTable.splitTokenIndex,
  createdAt: factsTable.createdAt,
  updatedAt: factsTable.updatedAt,
  // Read from the stored taxonomy itself: the projection column is no longer
  // written (2.1b) and is dropped in 2.1c.
  primaryArchetype: sql<string | null>`(${factsTable.enrichment} ->> 'primaryArchetype')`,
  enrichmentStatus: factsTable.enrichmentStatus,
  hasEmbedding: sql<boolean>`(${factsTable.embedding} IS NOT NULL)`,
  hasEnrichment: sql<boolean>`(${factsTable.enrichment} IS NOT NULL)`,
  hasUnpublishedChanges: factHasUnpublishedChanges,
} as const;

// The Facts list, newest first: approved facts only, live or deactivated
// (plan PLAN_FACT_LIFECYCLE_REBUILD.md, item 18; a staging fact is the
// moderation screen's), filtered by visibility, search and a needs-attention
// reason (2C). The response carries one count per reason, computed by the
// same predicates the filter uses (lib/factAttention.ts) over the same
// approved facts, and each row's own reasons. A search that is a whole
// number also matches that fact id.
router.get("/admin/facts", requireAdmin, async (req: Request, res: Response) => {
  const page = Math.max(1, parseInt(String(req.query["page"] ?? "1"), 10));
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query["limit"] ?? "50"), 10)));
  const offset = (page - 1) * limit;
  const search = String(req.query["search"] ?? "").trim();
  const attention = attentionReasonOf(req.query["attention"]);
  if (req.query["attention"] !== undefined && !attention) {
    res.status(400).json({ error: `attention must be one of: ${ATTENTION_REASONS.join(", ")}` });
    return;
  }
  // A reason names exactly its facts, live or deactivated: visibility
  // defaults to both under it, so the list's total equals the reason's count.
  const visibility = String(req.query["visibility"] ?? (attention || req.query["inactive"] === "true" ? "both" : "active"));
  const like = `%${search}%`;

  const visibilityFilter = visibility === "both" ? undefined : eq(factsTable.isActive, visibility !== "inactive");
  const searchId = /^\d{1,9}$/.test(search) ? Number(search) : null;
  const searchFilter = search
    ? (searchId != null ? or(ilike(factsTable.text, like), eq(factsTable.id, searchId)) : ilike(factsTable.text, like))
    : undefined;
  const attentionFilter = attention ? ATTENTION_PREDICATES[attention] : undefined;
  const approved = approvedFact;
  const where = and(...[approved, visibilityFilter, searchFilter, attentionFilter].filter(Boolean));

  const [facts, [{ total }], [attentionCounts]] = await Promise.all([
    db.select({ ...FACT_LIST_COLUMNS, attention: ATTENTION_REASONS_COLUMN })
      .from(factsTable)
      .where(where)
      .orderBy(desc(factsTable.createdAt))
      .limit(limit)
      .offset(offset),
    db.select({ total: count() }).from(factsTable).where(where),
    db.select(ATTENTION_COUNT_COLUMNS).from(factsTable).where(approved),
  ]);

  res.json({ facts, total, page, limit, attentionCounts });
});

// POST /admin/facts/:id/publish, /discard, /deactivate, /reactivate — an
// approved fact's lifecycle actions on the fact sheet (plan 3B; oracle items
// 12, 14 and 21). Each is one transaction and recorded (lib/factLifecycle.ts).
// The DELETE route that only deactivated is gone: deactivation is
// /deactivate, and DELETE becomes the guarded permanent delete (3.2c).
function sendLifecycle<T>(res: Response, result: FactLifecycleResult<T>): void {
  switch (result.kind) {
    case "done": res.json(result.value); return;
    case "not_found": res.status(404).json({ error: "Fact not found" }); return;
    case "no_changes": res.status(409).json({ error: "This fact has no unpublished changes.", code: "NO_CHANGES" }); return;
    case "already": res.status(409).json({ error: result.isActive ? "This fact is already live." : "This fact is already deactivated.", code: "ALREADY", isActive: result.isActive }); return;
    case "go_live": res.status(409).json({ error: result.error, code: "GO_LIVE", check: result.check }); return;
    case "still_live": res.status(409).json({ error: "Deactivate the fact before deleting it.", code: "STILL_LIVE" }); return;
    case "attached": res.status(409).json({ error: attachedSentence(result.attached), code: "MEMBER_CONTENT_ATTACHED", attached: result.attached }); return;
  }
}

function lifecycleRoute(name: string, act: (factId: number, adminId: string) => Promise<FactLifecycleResult<unknown>>) {
  return async (req: Request, res: Response) => {
    const id = Number(req.params["id"]);
    if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "Invalid fact id" }); return; }
    try {
      sendLifecycle(res, await act(id, req.user!.id));
    } catch (e) {
      logger.error({ err: e, factId: id }, `[admin/facts/:id ${name}] failed`);
      res.status(500).json({ error: "Something went wrong. Nothing was changed." });
    }
  };
}

router.post("/admin/facts/:id/publish", requireAdmin, lifecycleRoute("publish", publishFactChanges));
router.post("/admin/facts/:id/discard", requireAdmin, lifecycleRoute("discard", discardFactChanges));
router.post("/admin/facts/:id/deactivate", requireAdmin, lifecycleRoute("deactivate", deactivateFact));
router.post("/admin/facts/:id/reactivate", requireAdmin, lifecycleRoute("reactivate", reactivateFact));

/** The delete refusal in words: "Members have 2 memes and 1 comment on this fact, so it can't be deleted. Deactivating keeps it off the site." */
function attachedSentence(a: AttachedContent): string {
  const parts = [
    a.memes ? `${a.memes} meme${a.memes === 1 ? "" : "s"}` : null,
    a.aiPictures ? `${a.aiPictures} AI picture${a.aiPictures === 1 ? "" : "s"}` : null,
    a.comments ? `${a.comments} comment${a.comments === 1 ? "" : "s"}` : null,
  ].filter((p): p is string => p != null);
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0];
  return `Members have ${list} on this fact, so it can't be deleted. Deactivating keeps it off the site.`;
}

// DELETE /admin/facts/:id — the guarded permanent delete (plan 3B, oracle
// item 21): a deactivated fact only, refused while any member's meme, AI
// picture or comment is attached, the check and the delete one protected
// operation (lib/factLifecycle.ts, deleteFact).
router.delete("/admin/facts/:id", requireAdmin, lifecycleRoute("delete", deleteFact));

// PATCH /admin/facts/:id (the old side editor's counters, wording, active
// toggle and submitter) and GET /admin/facts/:id/text-edit-history are
// removed (plan item 23; increment 3.2c): no screen has called either since
// 3.1, and with them goes every admin write to a fact's counters or wording,
// which are read-only (plan 3B).

// GET /admin/facts/:id — admin detail shape for the Facts editor. Intentionally
// trimmed: includes the editable scalars + the enrichment blob and
// enrichmentStatus, but omits the embedding vector and the large generation
// blobs (aiScenePrompts, aiMemeImages) the editor never
// touches. `:id` must be a positive integer (a non-numeric segment is a 400,
// never a silent match against a static subpath like /import).
router.get("/admin/facts/:id", requireAdmin, async (req: Request, res: Response) => {
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "Invalid fact id" }); return; }

  const [row] = await db
    .select({
      id: factsTable.id,
      text: factsTable.text,
      canonicalText: factsTable.canonicalText,
      isActive: factsTable.isActive,
      upvotes: factsTable.upvotes,
      downvotes: factsTable.downvotes,
      score: factsTable.score,
      wilsonScore: factsTable.wilsonScore,
      commentCount: factsTable.commentCount,
      shareCount: factsTable.shareCount,
      submittedById: factsTable.submittedById,
      splitTokenIndex: factsTable.splitTokenIndex,
      createdAt: factsTable.createdAt,
      updatedAt: factsTable.updatedAt,
      enrichment: factsTable.enrichment,
      enrichmentStatus: factsTable.enrichmentStatus,
      hasEmbedding: sql<boolean>`(${factsTable.embedding} IS NOT NULL)`,
    })
    .from(factsTable)
    .where(eq(factsTable.id, id))
    .limit(1);
  if (!row) { res.status(404).json({ error: "Fact not found" }); return; }

  res.json(row);
});

// GET /admin/facts/:id/sheet — one approved fact as the fact sheet shows it
// (plan PLAN_FACT_LIFECYCLE_REBUILD.md, items 19–20; lib/factSheet.ts). A
// staging fact is a 404 here: it is the moderation screen's.
router.get("/admin/facts/:id/sheet", requireAdmin, async (req: Request, res: Response) => {
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "Invalid fact id" }); return; }
  const sheet = await factSheet(id);
  if (!sheet) { res.status(404).json({ error: "Fact not found" }); return; }
  res.json(sheet);
});

// GET /admin/facts/:id/history — every admin action on the fact, newest first,
// with who and when (plan 3C, oracle item 22). A 404 for a fact the Facts page
// does not list, as the sheet is.
router.get("/admin/facts/:id/history", requireAdmin, async (req: Request, res: Response) => {
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "Invalid fact id" }); return; }
  const history = await factHistory(id);
  if (!history) { res.status(404).json({ error: "Fact not found" }); return; }
  res.json({ history, limit: FACT_HISTORY_LIMIT });
});

const FactHashtagsBody = z.object({ hashtags: z.array(z.string()).max(FACT_HASHTAG_LIMIT) }).strict();

// PUT /admin/facts/:id/hashtags — replace an approved fact's hashtags, saved at
// once and recorded (plan item 20). Sanitized as at approval; never empty.
router.put("/admin/facts/:id/hashtags", requireAdmin, async (req: Request, res: Response) => {
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "Invalid fact id" }); return; }
  const parsed = FactHashtagsBody.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid hashtags" }); return; }
  const saved = await saveFactHashtags(id, parsed.data.hashtags, req.user?.id);
  if (saved.kind === "not_found") { res.status(404).json({ error: "Fact not found" }); return; }
  if (saved.kind === "refused") { res.status(400).json({ error: saved.error }); return; }
  res.json({ hashtags: saved.value });
});

// PUT /admin/facts/:id/humor-note — correct an approved fact's Humor Note,
// saved at once and recorded (plan item 20). It asks for no gag ideas and
// changes no gag; the review-scoped save on the Gags step does that.
router.put("/admin/facts/:id/humor-note", requireAdmin, async (req: Request, res: Response) => {
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "Invalid fact id" }); return; }
  const parsed = humorNoteSaveSchema.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid humor note" }); return; }
  const saved = await saveFactHumorNote(id, parsed.data.text, req.user?.id);
  if (saved.kind !== "saved") { res.status(404).json({ error: "Fact not found" }); return; }
  res.json({ humorNote: saved.value });
});

// GET /admin/facts/:id/taxonomy-runs — the fact's taxonomy run history, newest
// first (plan item 16): every classifier call, failures included, and the
// legacy versions 0159 converted. Read-only.
router.get("/admin/facts/:id/taxonomy-runs", requireAdmin, async (req: Request, res: Response) => {
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "Invalid fact id" }); return; }
  const [fact] = await db.select({ id: factsTable.id }).from(factsTable).where(eq(factsTable.id, id)).limit(1);
  if (!fact) { res.status(404).json({ error: "Fact not found" }); return; }

  const runs = await db
    .select({
      id: factTaxonomyRunsTable.id,
      outcome: factTaxonomyRunsTable.outcome,
      origin: factTaxonomyRunsTable.origin,
      output: factTaxonomyRunsTable.output,
      error: factTaxonomyRunsTable.error,
      requestedByName: sql<string | null>`coalesce(${usersTable.displayName}, ${usersTable.firstName}, ${usersTable.email})`,
      createdAt: factTaxonomyRunsTable.createdAt,
    })
    .from(factTaxonomyRunsTable)
    .leftJoin(usersTable, eq(usersTable.id, factTaxonomyRunsTable.requestedBy))
    .where(eq(factTaxonomyRunsTable.factId, id))
    .orderBy(desc(factTaxonomyRunsTable.createdAt), desc(factTaxonomyRunsTable.id));
  res.json({ runs });
});

// POST /admin/facts/:id/enrich — "Re-run": a fresh taxonomy run for the fact.
// Marks enrichmentStatus "pending" and enqueues the enrichment job, carrying who
// asked so the run's history row records it (plan item 16). The paid-call
// confirmation is the client's; this endpoint just enqueues.
router.post("/admin/facts/:id/enrich", requireAdmin, async (req: Request, res: Response) => {
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "Invalid fact id" }); return; }

  const [fact] = await db.select({ id: factsTable.id }).from(factsTable).where(eq(factsTable.id, id)).limit(1);
  if (!fact) { res.status(404).json({ error: "Fact not found" }); return; }

  await db.update(factsTable).set({ enrichmentStatus: "pending" }).where(eq(factsTable.id, id));
  await enqueueJob({
    queue: "enrichment",
    payload: factEnrichmentPayload(id, "rerun", req.user?.id ?? null),
    dedupeKey: `enrichment:fact:${id}`,
  });
  await recordAdminAction({ factId: id }, req.user?.id, "classification_rerun", {});

  res.json({ success: true, enrichmentStatus: "pending" });
});

// GET /admin/comments/pending — comments awaiting first moderation
router.get("/admin/comments/pending", requireAdmin, async (_req: Request, res: Response) => {
  const rows = await db
    .select({
      id: commentsTable.id,
      factId: commentsTable.factId,
      text: commentsTable.text,
      authorId: commentsTable.authorId,
      createdAt: commentsTable.createdAt,
    })
    .from(commentsTable)
    .where(eq(commentsTable.status, "pending"))
    .orderBy(desc(commentsTable.createdAt))
    .limit(100);

  const authorIds = [...new Set(rows.filter((r) => r.authorId).map((r) => r.authorId!))];
  const authorMap = new Map<string, { displayName: string | null; email: string | null }>();
  if (authorIds.length) {
    const users = await db
      .select({ id: usersTable.id, displayName: usersTable.displayName, email: usersTable.email })
      .from(usersTable)
      .where(inArray(usersTable.id, authorIds));
    for (const u of users) authorMap.set(u.id, u);
  }

  res.json({
    comments: rows.map((c) => ({
      ...c,
      createdAt: c.createdAt.toISOString(),
      authorDisplayName: c.authorId ? (authorMap.get(c.authorId)?.displayName ?? null) : null,
      authorEmail: c.authorId ? (authorMap.get(c.authorId)?.email ?? null) : null,
    })),
    total: rows.length,
  });
});

// GET /admin/comments/pending/count — badge count for nav
router.get("/admin/comments/pending/count", requireAdmin, async (_req: Request, res: Response) => {
  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(commentsTable)
    .where(eq(commentsTable.status, "pending"));
  res.json({ total });
});

// GET /admin/comments/flagged — approved comments that were later AI-flagged
router.get("/admin/comments/flagged", requireAdmin, async (_req: Request, res: Response) => {
  const rows = await db
    .select({
      id: commentsTable.id,
      factId: commentsTable.factId,
      text: commentsTable.text,
      authorId: commentsTable.authorId,
      flagReason: commentsTable.flagReason,
      createdAt: commentsTable.createdAt,
    })
    .from(commentsTable)
    .where(and(eq(commentsTable.status, "approved"), eq(commentsTable.flagged, true)))
    .orderBy(desc(commentsTable.createdAt))
    .limit(100);

  const authorIds = [...new Set(rows.filter((r) => r.authorId).map((r) => r.authorId!))];
  const authorMap = new Map<string, { displayName: string | null; email: string | null }>();
  if (authorIds.length) {
    const users = await db
      .select({ id: usersTable.id, displayName: usersTable.displayName, email: usersTable.email })
      .from(usersTable)
      .where(inArray(usersTable.id, authorIds));
    for (const u of users) authorMap.set(u.id, u);
  }

  res.json({
    comments: rows.map((c) => ({
      ...c,
      createdAt: c.createdAt.toISOString(),
      authorDisplayName: c.authorId ? (authorMap.get(c.authorId)?.displayName ?? null) : null,
      authorEmail: c.authorId ? (authorMap.get(c.authorId)?.email ?? null) : null,
    })),
  });
});

// POST /admin/comments/:id/approve — approve a pending or flagged comment
router.post("/admin/comments/:id/approve", requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id ?? "0"), 10);
  if (!id) { res.status(400).json({ error: "Invalid id" }); return; }
  const [current] = await db
    .select({ factId: commentsTable.factId, status: commentsTable.status, authorId: commentsTable.authorId })
    .from(commentsTable)
    .where(eq(commentsTable.id, id));
  if (!current) { res.status(404).json({ error: "Comment not found" }); return; }
  await db.update(commentsTable).set({ status: "approved", flagged: false, flagReason: null }).where(eq(commentsTable.id, id));
  if (current.status === "pending") {
    await db
      .update(factsTable)
      .set({ commentCount: sql`${factsTable.commentCount} + 1` })
      .where(eq(factsTable.id, current.factId));
  }
  if (current.authorId) {
    void logActivity({
      userId: current.authorId,
      actionType: "comment_approved",
      message: "Your comment was approved and is now visible publicly.",
      metadata: { commentId: id, factId: current.factId },
    });
  }
  res.json({ success: true });
});

// POST /admin/comments/:id/reject — reject a pending or flagged comment (soft delete, sets status)
router.post("/admin/comments/:id/reject", requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id ?? "0"), 10);
  if (!id) { res.status(400).json({ error: "Invalid id" }); return; }
  const body = req.body as Record<string, unknown>;
  const note = body["note"] && typeof body["note"] === "string" ? body["note"].trim() : null;
  const [current] = await db
    .select({ factId: commentsTable.factId, status: commentsTable.status, authorId: commentsTable.authorId })
    .from(commentsTable)
    .where(eq(commentsTable.id, id));
  if (!current) { res.status(404).json({ error: "Comment not found" }); return; }
  await db.update(commentsTable).set({ status: "rejected", flagged: true, flagReason: note || null }).where(eq(commentsTable.id, id));
  if (current.status === "approved") {
    await db
      .update(factsTable)
      .set({ commentCount: sql`GREATEST(0, ${factsTable.commentCount} - 1)` })
      .where(eq(factsTable.id, current.factId));
  }
  if (current.authorId) {
    const message = note
      ? `Your comment was rejected. Reason: ${note}`
      : "Your comment was rejected by a moderator.";
    void logActivity({
      userId: current.authorId,
      actionType: "comment_rejected",
      message,
      metadata: { commentId: id, factId: current.factId, ...(note ? { note } : {}) },
    });
  }
  res.json({ success: true });
});

// DELETE /admin/comments/:id — permanently delete any non-approved comment
router.delete("/admin/comments/:id", requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id ?? "0"), 10);
  if (!id) { res.status(400).json({ error: "Invalid id" }); return; }
  const [deleted] = await db
    .delete(commentsTable)
    .where(eq(commentsTable.id, id))
    .returning({ factId: commentsTable.factId });
  if (!deleted) { res.status(404).json({ error: "Comment not found" }); return; }
  res.json({ success: true });
});

// POST /admin/users/:id/verify-email — manually mark a user's email as verified
router.post("/admin/users/:id/verify-email", requireAdmin, async (req: Request, res: Response) => {
  const id = String(req.params["id"] ?? "");
  if (!id) { res.status(400).json({ error: "Invalid user id" }); return; }

  const [updated] = await db
    .update(usersTable)
    .set({ emailVerifiedAt: new Date() })
    .where(and(eq(usersTable.id, id), eq(usersTable.isActive, true)))
    .returning();

  if (!updated) { res.status(404).json({ error: "User not found" }); return; }

  res.json({ success: true, user: updated });
});

// GET /api/admin/users/:id/spend — monthly spend history for any user (computed at request time)
router.get("/admin/users/:id/spend", requireAdmin, async (req: Request, res: Response) => {
  const id = String(req.params["id"] ?? "");
  if (!id) { res.status(400).json({ error: "Invalid user id" }); return; }

  const rows = await db
    .select({
      year: sql<number>`EXTRACT(YEAR FROM ${userGenerationCostsTable.createdAt} AT TIME ZONE 'UTC')::int`,
      month: sql<number>`EXTRACT(MONTH FROM ${userGenerationCostsTable.createdAt} AT TIME ZONE 'UTC')::int`,
      totalUsd: sql<string>`COALESCE(SUM(${userGenerationCostsTable.computedCostUsd}), 0)::text`,
    })
    .from(userGenerationCostsTable)
    .where(eq(userGenerationCostsTable.userId, id))
    .groupBy(
      sql`EXTRACT(YEAR FROM ${userGenerationCostsTable.createdAt} AT TIME ZONE 'UTC')`,
      sql`EXTRACT(MONTH FROM ${userGenerationCostsTable.createdAt} AT TIME ZONE 'UTC')`,
    )
    .orderBy(
      desc(sql`EXTRACT(YEAR FROM ${userGenerationCostsTable.createdAt} AT TIME ZONE 'UTC')`),
      desc(sql`EXTRACT(MONTH FROM ${userGenerationCostsTable.createdAt} AT TIME ZONE 'UTC')`),
    );

  const now = new Date();
  const currentYear = now.getUTCFullYear();
  const currentMonth = now.getUTCMonth() + 1;

  const history = rows.map((r) => ({
    year: r.year,
    month: r.month,
    totalUsd: parseFloat(r.totalUsd),
    isCurrent: r.year === currentYear && r.month === currentMonth,
  }));

  const lifetimeTotal = rows.reduce((sum, r) => sum + parseFloat(r.totalUsd), 0);

  const current = history.find((h) => h.isCurrent) ?? {
    year: currentYear,
    month: currentMonth,
    totalUsd: 0,
    isCurrent: true,
  };

  res.json({ current, history, lifetimeTotal });
});

// The static ADMIN_API_KEY that once also opened the routes below is gone
// (#455; David, 2026-11-21: admin actions need a signed-in admin). Every one
// of them takes an admin session, like the rest of this router.

// POST /admin/users/set-password — reset a user's password by email
router.post("/admin/users/set-password", requireAdmin, async (req: Request, res: Response) => {
  const { email, password } = req.body as { email?: string; password?: string };
  if (!email || typeof email !== "string") { res.status(400).json({ error: "email is required" }); return; }
  const normalizedEmail = email.trim().toLowerCase();
  // Require a well-formed, length-bounded email in addition to the password rules.
  if (!z.string().email().max(320).safeParse(normalizedEmail).success) {
    res.status(400).json({ error: "a valid email is required" });
    return;
  }
  if (!password || typeof password !== "string") { res.status(400).json({ error: "password is required" }); return; }
  // Keep these explicit, message-specific checks (the C7 regression asserts the
  // "at least 8" wording) rather than folding them into a generic zod 400.
  if (password.length < 8) { res.status(400).json({ error: "password must be at least 8 characters" }); return; }
  if (password.length > 128) { res.status(400).json({ error: "password must be at most 128 characters" }); return; }
  const [user] = await db.select({ id: usersTable.id, email: usersTable.email })
    .from(usersTable).where(eq(usersTable.email, normalizedEmail)).limit(1);
  if (!user) { res.status(404).json({ error: "User not found" }); return; }
  const passwordHash = await bcrypt.hash(password, 12);
  // A password set by an operator ends every session the user holds, in the
  // same transaction (launch Phase 5, increment 2): the account's old
  // credential may be the reason it is being reset.
  await db.transaction(async (tx) => {
    await tx.update(usersTable).set({ passwordHash }).where(eq(usersTable.id, user.id));
    await revokeUserSessions(tx, user.id);
  });
  res.json({ success: true, email: user.email });
});

router.post("/admin/users/enable-notifications", requireAdmin, async (_req: Request, res: Response) => {
  // The canonical reachable-admin predicate, not the raw is_admin column —
  // an env- or bootstrap-only admin was silently skipped by this bulk
  // opt-in. Round 2 of PR #425's review caught this.
  const updated = await db
    .update(usersTable)
    .set({ adminNotifications: true })
    .where(isReachableAdminSql())
    .returning({ id: usersTable.id, email: usersTable.email, adminNotifications: usersTable.adminNotifications });
  res.json({ success: true, updated });
});

router.post("/admin/facts/backfill-embeddings", requireAdmin, async (_req: Request, res: Response) => {
  try {
    const result = await backfillEmbeddings();
    res.json({ success: true, ...result });
  } catch (err) {
    logger.error({ err }, "[admin] Backfill embeddings error");
    res.status(500).json({ error: "Backfill failed", details: String(err) });
  }
});

// ─── Config ───────────────────────────────────────────────────────────────────

router.get("/config/public", async (_req: Request, res: Response) => {
  try {
    const config = await getPublicConfig();
    res.json(config);
  } catch (err) {
    res.status(500).json({ error: "Failed to load public config" });
  }
});

router.get("/admin/config", requireAdmin, async (_req: Request, res: Response) => {
  try {
    // AI settings live in code and are not shown (decisions.md 2026-11-14).
    // The read-only switch has its own surface and rules (Operations page,
    // lib/readOnlyMode.ts): it is never listed or edited here.
    res.json(withoutCodeOwnedAiSettings(await getAllConfig()).filter((r) => r.key !== READ_ONLY_CONFIG_KEY));
  } catch (err) {
    res.status(500).json({ error: "Failed to load config" });
  }
});

/**
 * Verify the account behind the TARGET mode's credential before the stored mode
 * is written. Returns a refusal to send, or null to proceed.
 *
 * Verify-before-write is the only permitted shape here, and the alternative is
 * not merely less tidy — it is unsafe. The update below is
 * `.set(patch).where(eq(adminConfigTable.key, key))`: keyed on the config key
 * alone, with no row version and no expected prior value. So a
 * write-then-roll-back on refusal has no compare-and-swap to roll back against:
 * with two admins toggling, request A writes an invalid target, request B
 * writes a valid one and succeeds, then A's verification fails and A restores
 * the value it remembered — silently undoing B's successful change. The guard
 * would have manufactured the mode inconsistency it exists to prevent. And in
 * the window between write and rollback the stored mode names an unverified
 * target, so payment requests reading it are refused.
 *
 * Nothing is committed that has to be taken back: the stored mode changes only
 * if the target mode's account verifies.
 *
 * This is a UX gate, not the safety mechanism — safety lives at the client
 * construction boundary, which refuses whatever this route does. What it buys
 * is an operator who is told the toggle failed, and why, instead of one who
 * sees a successful toggle and payments that quietly stop working.
 */
async function refuseUnverifiedStripeModeToggle(
  targetLiveMode: boolean,
): Promise<{ status: number; error: string } | null> {
  const { getStripeSecretKey } = await import("../lib/stripeClient");
  const { verifyStripeAccount } = await import("../lib/stripeAccountGuard");
  const { isDefiniteVerificationFailure } = await import("../lib/stripeVerificationErrors");

  let targetSecretKey: string;
  try {
    targetSecretKey = await getStripeSecretKey(targetLiveMode);
  } catch (err) {
    // The target mode has no credentials. Refuse rather than switch payments
    // into a mode that cannot work; the message already names the variable.
    return { status: 400, error: err instanceof Error ? err.message : String(err) };
  }

  try {
    await verifyStripeAccount({ liveMode: targetLiveMode, secretKey: targetSecretKey, force: true });
    return null;
  } catch (err) {
    // This is an admin-only route, so the operator gets the diagnostic message
    // — which names both account ids and the variable to correct, and is the
    // whole value of the refusal. It is not the string end users ever see.
    logger.error({ err, targetLiveMode }, "[admin] refused stripe_live_mode toggle — target account not verified");
    return {
      status: isDefiniteVerificationFailure(err) ? 409 : 503,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

router.patch("/admin/config/:key", requireAdmin, async (req: Request, res: Response) => {
  const key = String(req.params["key"]);

  // Refused BEFORE the body is inspected: a reserved key is off-limits to this
  // route regardless of what the request is trying to do with it, and a
  // 400 "value is required" for a key that could never have been written here
  // would tell the caller the wrong thing about why.
  //
  // This route validates data type and min/max and nothing else, so an NCMEC
  // filing switch reaching it is an activation gate with a door beside an open
  // window. The keys are owned by the safety admin surface instead.
  if (isNcmecReservedConfigKey(key)) {
    res.status(403).json({ error: NCMEC_RESERVED_KEY_REFUSAL });
    return;
  }
  // Read-only mode is set only on the Operations page, whose save keeps its
  // safety rules (lib/readOnlyMode.ts); a write here would bypass them.
  if (key === READ_ONLY_CONFIG_KEY) {
    res.status(403).json({ error: "Read-only mode is set on the Operations page." });
    return;
  }
  // AI settings (the six system prompts and the engine choices) are set in
  // code (codeOwnedPrompts.ts; decisions.md 2026-11-14).
  if (isCodeOwnedAiConfigKey(key)) {
    res.status(403).json({ error: CODE_OWNED_AI_SETTING_REFUSAL });
    return;
  }

  const body = req.body as {
    value?: unknown;
    valueLabel?: unknown;
  };

  const hasValue = body.value !== undefined && body.value !== null && String(body.value).trim() !== "";

  if (!hasValue) {
    res.status(400).json({ error: "value is required" });
    return;
  }

  const [existing] = await db
    .select()
    .from(adminConfigTable)
    .where(eq(adminConfigTable.key, key))
    .limit(1);

  if (!existing) {
    res.status(404).json({ error: "Config key not found" });
    return;
  }

  let newValue: string | undefined;
  let newValueLabel: string | null | undefined;
  /**
   * The membership-config value this request writes, checked INSIDE the write
   * transaction against the locked config set — never against a cached read
   * taken before it.
   */
  let relationalValue: number | undefined;

  if (hasValue) {
    const rawValue = String(body.value).trim();
    if (existing.dataType === "integer") {
      const parsed = parseInt(rawValue, 10);
      if (isNaN(parsed)) {
        res.status(400).json({ error: "Value must be an integer" });
        return;
      }
      if (existing.minValue !== null && parsed < existing.minValue) {
        res.status(400).json({ error: `Value must be at least ${existing.minValue}` });
        return;
      }
      if (existing.maxValue !== null && parsed > existing.maxValue) {
        res.status(400).json({ error: `Value must be at most ${existing.maxValue}` });
        return;
      }
    } else if (existing.dataType === "float") {
      const parsed = parseFloat(rawValue);
      if (isNaN(parsed)) {
        res.status(400).json({ error: "Value must be a number" });
        return;
      }
      if (existing.minValue !== null && parsed < existing.minValue) {
        res.status(400).json({ error: `Value must be at least ${existing.minValue}` });
        return;
      }
      if (existing.maxValue !== null && parsed > existing.maxValue) {
        res.status(400).json({ error: `Value must be at most ${existing.maxValue}` });
        return;
      }
    }
    // Some settings are only coherent against each other: the entitlement lease
    // must outlive the bounded Stripe retrieval plus the apply, a waiter must
    // not outlive the lease it waits for, and the sweep alert must not fire
    // before the sweep could have run again. Every individual range can pass
    // while the SET is broken, and a relational invariant enforced on one side
    // only is not enforced — so this runs on a write to ANY component.
    if (isMembershipConfigKey(key)) {
      // Parsed the way RUNTIME parses it, not the way JavaScript would like to.
      // `getConfigInt` uses `parseInt`, so "1e5" resolves to 1 at runtime while
      // `Number` reads it as 100000 — the validator would approve a relationship
      // the running system then violates, from a value stored verbatim.
      const parsed = parseMembershipConfigValue(rawValue, existing.dataType);
      if (parsed === null) {
        res.status(400).json({ error: "Value must be a number" });
        return;
      }
      // Deferred to the write transaction below, where the set it is checked
      // against is locked — see `lockAndLoadMembershipConfig`.
      relationalValue = parsed;
    }

    newValue = rawValue;
    newValueLabel = body.valueLabel !== undefined && body.valueLabel !== null
      ? String(body.valueLabel).trim() || null
      : undefined;
  }

  const patch = {
    ...(newValue !== undefined ? { value: newValue } : {}),
    ...(newValueLabel !== undefined ? { valueLabel: newValueLabel } : {}),
    updatedAt: new Date(),
    updatedById: req.user?.id ?? null,
  };

  // The Stripe mode toggle verifies BEFORE it writes — see
  // refuseUnverifiedStripeModeToggle below, and the post-write invalidate +
  // resync for this same key further down this handler.
  if (key === "stripe_live_mode" && newValue !== undefined) {
    const refusal = await refuseUnverifiedStripeModeToggle(newValue === "true");
    if (refusal) {
      res.status(refusal.status).json({ error: refusal.error });
      return;
    }
  }

  let updated: typeof adminConfigTable.$inferSelect | undefined;

  const proposed = relationalValue;
  if (proposed === undefined) {
    [updated] = await db
      .update(adminConfigTable)
      .set(patch)
      .where(eq(adminConfigTable.key, key))
      .returning();
  } else {
    // The relational check and the write it authorises share one transaction, so
    // the set the check read cannot move before the write lands. Rejections
    // travel out as a thrown message rather than a mid-transaction `res.json`,
    // which would respond while the transaction was still open.
    try {
      updated = await db.transaction(async (tx) => {
        const current = await lockAndLoadMembershipConfig(tx);
        const error = validateMembershipConfigWrite(key as MembershipConfigKey, proposed, current);
        if (error) throw new RelationalConfigError(error);
        const [row] = await tx
          .update(adminConfigTable)
          .set(patch)
          .where(eq(adminConfigTable.key, key))
          .returning();
        return row;
      });
    } catch (error) {
      if (error instanceof RelationalConfigError) {
        res.status(400).json({ error: error.message });
        return;
      }
      throw error;
    }
  }

  bustConfigCache();

  // When stripe_live_mode changes, invalidate the cached Stripe instance and
  // kick off a FULL resync so every mode-scoped resource (products, prices,
  // plans, customers, subscriptions, invoices, charges, payment methods) lands
  // for the new mode without waiting for webhook traffic. Shares the same
  // in-process lock as the manual scoped sync, so a concurrent admin click on
  // "Sync Stripe data" will see alreadyRunning and short-circuit with 409.
  if (key === "stripe_live_mode") {
    const { invalidateStripeSync, getStripeSync } = await import("../lib/stripeClient");
    const { runFullSync } = await import("../lib/stripeSyncRunner");
    const { startStripeInitializationForActiveMode } = await import("../lib/stripeInit");
    invalidateStripeSync();
    // The newly active mode is a different Stripe account, and this process may
    // never have registered its managed webhook or run its schema migrations —
    // without this, its events never arrive until a restart. Started, not
    // awaited: the response must not wait on Stripe, and a failure arms the
    // retry loop rather than surfacing here.
    startStripeInitializationForActiveMode();
    try {
      const sync = await getStripeSync();
      runFullSync(sync);
    } catch (err) {
      logger.error({ err }, "[admin] Stripe full sync error after mode toggle");
    }
    // A membership recorded under the other mode grants nothing (#454), but the
    // stored tier only moves when a user is recomputed. Awaited, so a failure
    // reaches the operator; saving the mode again retries it.
    try {
      const { recomputeMembershipsForModeChange } = await import("../lib/membershipSources");
      const result = await recomputeMembershipsForModeChange();
      logger.info(result, "[admin] memberships recomputed after Stripe mode change");
    } catch (err) {
      logger.error({ err }, "[admin] membership recompute failed after Stripe mode change");
      res.status(500).json({
        error: "The Stripe mode was switched, but memberships could not all be recalculated. Save the mode again to retry.",
      });
      return;
    }
  }

  res.json(updated);
});

// ─── Admin Stripe Endpoints ───────────────────────────────────────────────────

router.get("/admin/stripe/summary", requireAdmin, async (_req: Request, res: Response) => {
  try {
    // Active legendary subscribers = users with legendary tier and an active subscription
    // Registered members = users with registered tier (no payment)
    // ONE statement with conditional aggregation, not two in a Promise.all.
    // `now()` is the TRANSACTION timestamp, so two implicit transactions get two
    // different instants, and a user crossing their grace horizon between them
    // is counted twice or not at all. Sharing the expression makes the counts
    // agree on the RULE; only one statement makes them agree on the INSTANT.
    const [tierCounts] = await db
      .select({
        legendary: sql<number>`count(*) FILTER (WHERE ${effectiveTierExpr()} = 'legendary')::int`,
        registered: sql<number>`count(*) FILTER (WHERE ${effectiveTierExpr()} = 'registered')::int`,
      })
      .from(usersTable)
      .where(eq(usersTable.isActive, true));

    // Boolean-only presence checks for the Stripe env vars. We never echo the
    // values themselves — only whether each one is configured.
    const stripeEnv = stripeDriver().credentialPresence();
    const webhookSecretConfigured =
      stripeEnv.webhookSecretTest || stripeEnv.webhookSecretLive;

    const webhookUrl = `${getSiteBaseUrl()}/api/stripe/webhook`;

    // The account guard's live state, so the operator can see payments as
    // unavailable-pending-verification rather than having to infer it from a
    // failing checkout. A state the server can be in that an operator would act
    // on is shown, not logged.
    //
    // It is reported PER MODE (verification state is per mode, never one global
    // flag) and PER INSTANCE. The instance label is not decoration: `.replit:29`
    // is `deploymentTarget = "autoscale"` with the server in every instance, so
    // this value is process-local and this response comes from whichever
    // instance the router picked. An unlabelled value would let one healthy
    // instance report recovery for a fleet that has not recovered. A fleet-wide
    // aggregate needs shared state, which this increment may not add — it is a
    // named gap, not an implied capability.
    const { getVerificationStatus, readStripeLiveModeStrict } = await import("../lib/stripeAccountGuard");
    const { ensureVerificationArmedFor, getStripeSetupStatus } = await import("../lib/stripeInit");
    const { WORKER_INSTANCE_ID } = await import("../lib/workerHeartbeats");

    const [duplicateSuppressedRows, recentFailures, verificationLiveMode] = await Promise.all([
      db.select({ cnt: sql<number>`count(*)::int` }).from(stripeWebhookAuditTable).where(eq(stripeWebhookAuditTable.state, "ignored_duplicate")),
      db.select().from(stripeWebhookAuditTable)
        .where(eq(stripeWebhookAuditTable.state, "failed"))
        .orderBy(desc(stripeWebhookAuditTable.createdAt))
        .limit(20),
      // Nothing above depends on this, so it rides along rather than adding a
      // third serial round-trip to an endpoint the Billing page polls. An
      // unreadable mode is itself an indefinite answer: getVerificationStatus
      // renders null as pending with that reason rather than guessing a mode.
      readStripeLiveModeStrict().catch(() => null),
    ]);

    // Reading the status is not enough on its own. If another autoscale
    // instance committed a mode toggle, this process has never verified the
    // newly active mode and — on a normally successful boot — has nothing
    // scheduled to. Without this the panel would poll a permanently
    // transitional state, reporting active verification with nothing in
    // flight. Idempotent and a no-op once any outcome is recorded.
    ensureVerificationArmedFor(verificationLiveMode);

    const guardStatus = getVerificationStatus(verificationLiveMode, WORKER_INSTANCE_ID);
    // `verified` alone overclaims: checkout opens on verification, but Stripe's
    // events reach this instance only once setup has registered the webhook. So
    // a verified mode carries its setup state, and a setup that keeps failing
    // shows on the panel rather than only in the log.
    const verification =
      guardStatus.state === "verified" && verificationLiveMode !== null
        ? { ...guardStatus, setup: getStripeSetupStatus(verificationLiveMode) }
        : guardStatus;

    res.json({
      activeSubscribers: tierCounts?.legendary ?? 0,
      registeredMembers: tierCounts?.registered ?? 0,
      webhookSecretConfigured,
      webhookUrl,
      stripeEnv,
      // Which Stripe driver this process runs (#566). The Billing page shows a
      // persistent notice for "fake", so fixture data is never mistaken for a
      // real test-mode account. Reported by the server, never inferred.
      stripeDriver: stripeDriver().kind,
      verification,
      webhookAudit: {
        duplicateSuppressedCount: duplicateSuppressedRows[0]?.cnt ?? 0,
        recentFailures,
      },
    });
  } catch (err) {
    logger.error({ err }, "[admin] stripe/summary error");
    res.status(500).json({ error: "Failed to load stripe summary" });
  }
});

// POST /admin/stripe/full-sync — trigger a full backfill of every tracked
// resource (products, prices, plans, customers, subscriptions, invoices,
// charges, payment_methods). Shares the same in-process lock as the scoped
// sync — a concurrent scoped run returns 409 alreadyRunning.
//
// This is the same backfill that runs automatically after a live/test mode
// toggle, exposed here so admins can run it on demand without toggling modes.
router.post("/admin/stripe/full-sync", requireAdmin, async (_req: Request, res: Response) => {
  try {
    const { getStripeSync } = await import("../lib/stripeClient");
    const { runFullSync } = await import("../lib/stripeSyncRunner");
    const sync = await getStripeSync();
    const result = runFullSync(sync);
    if (result.alreadyRunning) {
      res.status(409).json({
        success: false,
        alreadyRunning: true,
        message: "Sync already in progress — current run will finish shortly.",
      });
      return;
    }
    res.json({
      success: true,
      message: "Full sync started — all resources will be refreshed.",
    });
  } catch (err) {
    logger.error({ err }, "[admin] POST /admin/stripe/full-sync error");
    res.status(500).json({ error: "Failed to start full sync" });
  }
});

// POST /admin/stripe/sync — trigger a scoped resync of products/prices/plans.
//
// Scoped intentionally: customers/subscriptions/invoices/etc. are kept fresh
// by webhooks already, so the admin button only refreshes what it actually
// affects (the Plans block + checkout price IDs).
//
// Returns immediately after kicking off the background sync. The UI polls
// /admin/stripe/sync/status to render real-time progress per resource.
//
// If a sync is already running, this returns HTTP 409 + alreadyRunning:true
// rather than starting a duplicate concurrent sync.
router.post("/admin/stripe/sync", requireAdmin, async (_req: Request, res: Response) => {
  try {
    const { getStripeSync } = await import("../lib/stripeClient");
    const { runScopedSync } = await import("../lib/stripeSyncRunner");
    const sync = await getStripeSync();
    const result = runScopedSync(sync);
    if (result.alreadyRunning) {
      res.status(409).json({
        success: false,
        alreadyRunning: true,
        message: "Sync already in progress — current run will finish shortly.",
      });
      return;
    }
    res.json({
      success: true,
      message: "Stripe sync started — watch progress below.",
    });
  } catch (err) {
    logger.error({ err }, "[admin] POST /admin/stripe/sync error");
    res.status(500).json({ error: "Failed to start sync" });
  }
});

// POST /admin/stripe/sync/_test/simulate — test-only hook used by the UI test
// for the per-resource progress panel. Drives the same `runScopedSync`
// machinery the real button uses, but with a stub driver that writes status
// rows directly so we can deterministically exercise success and failure paths
// without depending on what's in the test Stripe account at the moment.
//
// Disabled in production (returns 404) and gated behind requireAdmin like the
// real sync routes.
router.post("/admin/stripe/sync/_test/simulate", requireAdmin, async (req: Request, res: Response) => {
  if (process.env.NODE_ENV === "production") {
    res.status(404).end();
    return;
  }
  try {
    const body = (req.body ?? {}) as { failResource?: string; delayMs?: number };
    const failResource = body.failResource;
    const delayMs = typeof body.delayMs === "number" && body.delayMs >= 0 ? body.delayMs : 250;
    const allowed = ["products", "prices", "plans"] as const;
    type Res = (typeof allowed)[number];
    if (failResource !== undefined && !allowed.includes(failResource as Res)) {
      res.status(400).json({ error: "failResource must be one of products|prices|plans" });
      return;
    }

    const { getStripeSync } = await import("../lib/stripeClient");
    const { runScopedSync } = await import("../lib/stripeSyncRunner");
    const sync = await getStripeSync();
    const accountId = await sync.getAccountId();

    const makeStub = (resource: Res, shouldFail: boolean) => async (): Promise<{ synced: number }> => {
      await db.execute(sql`
        INSERT INTO stripe._sync_status (resource, account_id, status)
        VALUES (${resource}, ${accountId}, 'running')
        ON CONFLICT (resource, account_id) DO UPDATE
          SET status = 'running', error_message = NULL, updated_at = now()
      `);
      await new Promise(resolve => setTimeout(resolve, delayMs));
      if (shouldFail) {
        await db.execute(sql`
          UPDATE stripe._sync_status
          SET status = 'error', error_message = ${"Simulated failure for testing"}, updated_at = now()
          WHERE resource = ${resource} AND account_id = ${accountId}
        `);
        throw new Error("Simulated failure for testing");
      }
      await db.execute(sql`
        UPDATE stripe._sync_status
        SET status = 'complete', error_message = NULL, last_synced_at = now(), updated_at = now()
        WHERE resource = ${resource} AND account_id = ${accountId}
      `);
      return { synced: 0 };
    };

    // Reset existing _sync_status rows for these three resources so the UI
    // observes a true pending → running → complete transition. Without this,
    // a previous successful run leaves rows as "complete" and the UI would
    // show "N synced · X ago" for resources that haven't started yet in the
    // simulated run, defeating intermediate-state assertions.
    await db.execute(sql`
      DELETE FROM stripe._sync_status
      WHERE account_id = ${accountId}
        AND resource IN ('products', 'prices', 'plans')
    `);

    // SyncRunnerDriver requires every resource method, but `runScopedSync`
    // only invokes products/prices/plans. The customer-graph methods are
    // unreachable from this path; we stub them with a no-op resolving to 0
    // so the type is satisfied without changing simulate behaviour.
    const unreachable = async (): Promise<{ synced: number }> => ({ synced: 0 });
    const stub = {
      getAccountId: async () => accountId,
      syncProducts: makeStub("products", failResource === "products"),
      syncPrices: makeStub("prices", failResource === "prices"),
      syncPlans: makeStub("plans", failResource === "plans"),
      syncCustomers: unreachable,
      syncSubscriptions: unreachable,
      syncInvoices: unreachable,
      syncCharges: unreachable,
      syncPaymentMethods: unreachable,
    };

    const result = runScopedSync(stub);
    if (result.alreadyRunning) {
      res.status(409).json({ alreadyRunning: true, message: "Sync already in progress" });
      return;
    }
    res.json({ success: true, failResource: failResource ?? null, delayMs });
  } catch (err) {
    logger.error({ err }, "[admin] POST /admin/stripe/sync/_test/simulate error");
    res.status(500).json({ error: "Failed to simulate sync" });
  }
});

// GET /admin/stripe/sync/status — read per-resource sync state for the UI poller.
router.get("/admin/stripe/sync/status", requireAdmin, async (_req: Request, res: Response) => {
  try {
    const { getStripeSync } = await import("../lib/stripeClient");
    const { readSyncStatus } = await import("../lib/stripeSyncRunner");
    const sync = await getStripeSync();
    const accountId = await sync.getAccountId();
    const status = await readSyncStatus(accountId);
    res.json(status);
  } catch (err) {
    logger.error({ err }, "[admin] GET /admin/stripe/sync/status error");
    res.status(500).json({ error: "Failed to read sync status" });
  }
});

router.post("/admin/stripe/test-event", requireAdmin, async (req: Request, res: Response) => {
  try {
    // The gate and the client come from ONE operation, deliberately.
    //
    // This used to check the mode through getConfigStringRaw — the lenient,
    // config-cached read — while the client it later built resolved the mode
    // through the guard's strict row read. On an autoscale instance that did not
    // handle a toggle those two disagree for the config cache's TTL, so this
    // route could pass its "test mode only" gate and then create a real customer
    // on the LIVE account. That divergence is a consequence of this increment:
    // before it, both reads went through the same cached path and always agreed.
    //
    // So the mode this refuses on is the mode the client was actually verified
    // for. There is no second read to disagree with.
    const { getVerifiedStripeClient } = await import("../lib/stripeClient");
    const { client: stripe, liveMode } = await getVerifiedStripeClient();

    if (liveMode) {
      res.status(403).json({ error: "Test events are only available in test mode" });
      return;
    }

    const { userId } = req.body as { userId?: string };
    if (!userId) {
      res.status(400).json({ error: "userId is required" });
      return;
    }

    const [targetUser] = await db.select({ id: usersTable.id, stripeCustomerId: usersTable.stripeCustomerId, email: usersTable.email })
      .from(usersTable)
      .where(and(eq(usersTable.id, userId), eq(usersTable.isActive, true)))
      .limit(1);

    if (!targetUser) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const { stripeStorage } = await import("../lib/stripeStorage");

    let customerId = targetUser.stripeCustomerId;
    if (!customerId) {
      // The same client the gate above refused on — not a fresh construction,
      // which could resolve a different mode than the one just authorized.
      const customer = await stripe.customers.create({
        email: targetUser.email ?? undefined,
        metadata: { userId },
      });
      await stripeStorage.updateUserStripeCustomerId(userId, customer.id);
      customerId = customer.id;
    }

    // Build a minimal checkout.session.completed event with an embedded subscription object
    // (not a string ID) so the handler can process it without additional Stripe API calls.
    const { WebhookHandlers } = await import("../lib/webhookHandlers");

    const fakeSubId = `sub_test_${Date.now()}`;
    const embeddedSub = {
      id: fakeSubId,
      object: "subscription",
      customer: customerId,
      status: "active",
      cancel_at_period_end: false,
      current_period_end: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
      items: {
        object: "list",
        data: [
          {
            id: `si_test_${Date.now()}`,
            object: "subscription_item",
            price: {
              id: `price_test_${Date.now()}`,
              object: "price",
              type: "recurring",
              recurring: { interval: "month", interval_count: 1, usage_type: "licensed", aggregate_usage: null },
              product: {
                id: "prod_test",
                object: "product",
                active: true,
                metadata: {},
              },
            },
          },
        ],
        has_more: false,
        total_count: 1,
        url: "/v1/subscription_items",
      },
    };

    const fakeEvent = {
      id: `evt_test_${Date.now()}`,
      object: "event",
      type: "checkout.session.completed",
      api_version: "2022-11-15",
      created: Math.floor(Date.now() / 1000),
      livemode: false,
      pending_webhooks: 0,
      request: { id: null, idempotency_key: null },
      data: {
        object: {
          id: `cs_test_${Date.now()}`,
          object: "checkout.session",
          customer: customerId,
          mode: "subscription",
          payment_status: "paid",
          status: "complete",
          subscription: embeddedSub,
          payment_intent: null,
          amount_total: 499,
          currency: "usd",
          metadata: {},
        },
      },
    };

    // processEventDirectly routes through the same domain switch as real webhooks,
    // with only Stripe sync + signature verification skipped (test mode only).
    await WebhookHandlers.processEventDirectly(fakeEvent as unknown as import("stripe").Stripe.Event);

    res.json({ success: true, message: `Test webhook processed — user ${userId} upgraded to legendary via checkout.session.completed domain handler` });
  } catch (err) {
    logger.error({ err }, "[admin] stripe/test-event error");
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: "Test event failed", details: msg });
  }
});

// ── Feature Flag Admin Endpoints ──────────────────────────────────────────────

router.get("/admin/feature-flags", requireAdmin, async (_req: Request, res: Response) => {
  const matrix = await getAllTierFeatureMatrix();
  res.json(matrix);
});

router.patch("/admin/feature-flags", requireAdmin, async (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;
  const tier = typeof body["tier"] === "string" ? body["tier"].trim() : null;
  const featureKey = typeof body["featureKey"] === "string" ? body["featureKey"].trim() : null;
  const enabled = typeof body["enabled"] === "boolean" ? body["enabled"] : null;

  if (!tier || !featureKey || enabled === null) {
    res.status(400).json({ error: "tier, featureKey, and enabled are required" });
    return;
  }

  // Validation lives in setTierFeature, server-side: the API is reachable
  // directly, so a client-side constraint is not a control. The tier is checked
  // against the real column set — it previously accepted any string, silently
  // writing rows no resolver would ever read.
  try {
    const { gridRevision } = await setTierFeature(tier, featureKey, enabled, req.user?.id ?? null);
    res.json({ tier, featureKey, enabled, gridRevision });
  } catch (err) {
    if (err instanceof UnknownFeatureError) {
      res.status(404).json({ error: "Feature flag not found" });
      return;
    }
    if (err instanceof UnknownTierError) {
      res.status(400).json({ error: "Unknown tier", tier });
      return;
    }
    throw err;
  }
});

router.post("/admin/_debug/sentry", requireAdmin, (req: Request, res: Response) => {
  const userId = req.user?.id ?? "unknown";
  Sentry.getIsolationScope().setTag("debug", "sentry-test");
  Sentry.getIsolationScope().setUser({ id: userId });
  throw new Error(`Sentry test error triggered by admin user ${userId}`);
});

// Reports whether the backend Sentry SDK is configured, and with which
// environment / release. Used by the admin "Sentry diagnostics" card.
// The DSN value itself is never returned — only a boolean — so this is
// safe to expose behind requireAdmin.
router.get("/admin/sentry-status", requireAdmin, (_req: Request, res: Response) => {
  const dsnConfigured = Boolean(process.env.SENTRY_DSN_BACKEND);
  const environment = process.env.NODE_ENV === "production" ? "production" : "development";
  const release =
    process.env.REPLIT_DEPLOYMENT_ID ??
    process.env.REPLIT_GIT_COMMIT_SHA?.slice(0, 7) ??
    "dev";
  res.json({ dsnConfigured, environment, release });
});

// GET /admin/email-queue — paginated list of email outbox rows, filterable by status
// Admin email queue is a typed projection of the shared async_jobs table
// filtered to queue = "email". The status vocabulary is the generic one
// (pending / processing / done / failed) — the legacy email-only values
// (sending / delivered / abandoned) were normalized in migration 0063.
// ─── Queue health (Phase 1 of the async-queue hardening plan) ───────────────
//
// Read-only. Derives everything by query from async_jobs + worker_lane_heartbeats
// and stores nothing, so async_jobs stays the single source of truth for job
// state. /admin/email-queue below is left exactly as it is — it remains the
// email-specific working view.

/**
 * GET /admin/queue-health — the AGGREGATE altitude.
 *
 * Per queue: the four raw tallies plus the two derived ones (`skipped`,
 * `abandonedNoRetry`) that `status` alone cannot express, oldest-pending age,
 * and 24h throughput. Per lane: live instance count, last-scheduled and
 * last-completed ages, in-flight count, and whether it is stalled fleet-wide.
 *
 * **Phase 1 carries no alert fields at all** — not even an empty array.
 * `job_alerts` does not exist until Phase 2's migration, so including the field
 * here would be either unbuildable or a lie: an empty `activeAlerts: []` reads
 * as "no alerts" on the very page whose job is to reveal problems, when the
 * truth is "alerting does not exist yet". Phase 2 adds it alongside the table.
 */
router.get("/admin/queue-health", requireAdmin, async (req: Request, res: Response) => {
  try {
    // The page polls this every 5s (see the UAT doc); 60/60s per (ip, admin
    // user) comfortably covers one client's steady polling plus several open
    // tabs.
    const rateLimit = await checkSharedRateLimit(
      { endpoint: "admin.queue-health", ip: req.ip ?? null, userId: req.user?.id ?? null },
      { limit: 60, windowMs: 60_000 },
    );
    if (!rateLimit.allowed) { res.status(429).json({ error: "Too many requests" }); return; }

    const [queues, lanes] = await Promise.all([queueHealth(db), laneHealth(db)]);
    const now = Date.now();
    res.json({
      ts: new Date(now).toISOString(),
      queues,
      lanes: lanes.map((l) => ({
        ...l,
        lastScheduledAt: l.lastScheduledAt?.toISOString() ?? null,
        lastTickCompletedAt: l.lastTickCompletedAt?.toISOString() ?? null,
        lastScheduledAgeSeconds: l.lastScheduledAt
          ? Math.max(0, Math.round((now - l.lastScheduledAt.getTime()) / 1000))
          : null,
      })),
    });
  } catch (err) {
    logger.error({ err }, "[admin] queue-health error");
    const msg = err instanceof Error ? err.message : "Failed to load queue health";
    res.status(500).json({ error: msg });
  }
});

/**
 * GET /admin/queue-health/jobs — the PER-ITEM altitude.
 *
 * Bounded and paginated on purpose: the aggregate endpoint above is polled
 * continuously and must never be able to carry a 50,000-row backlog, so per-item
 * detail lives behind its own `limit` (capped at 100).
 *
 * Returns **all four** raw statuses, never just failures — a per-item view
 * limited to failures would leave `pending` and `processing` items with no
 * per-item state at all, which is the two-altitude contract violation this
 * endpoint exists to prevent. Each row also carries the derived `displayStatus`
 * and a **sanitized** `skipReason` from a closed set, so "skipped" and
 * "never retried" are reachable by the page rather than being collapsed into a
 * generic success and a generic failure.
 */
router.get("/admin/queue-health/jobs", requireAdmin, async (req: Request, res: Response) => {
  try {
    // Only fetched on-demand (a queue row expanding), but shares the endpoint's
    // rate-limit family so a runaway client can't dump the table via repeated
    // paginated requests either.
    const rateLimit = await checkSharedRateLimit(
      { endpoint: "admin.queue-health.jobs", ip: req.ip ?? null, userId: req.user?.id ?? null },
      { limit: 60, windowMs: 60_000 },
    );
    if (!rateLimit.allowed) { res.status(429).json({ error: "Too many requests" }); return; }

    const page = await queueHealthJobs(
      {
        queue: String(req.query["queue"] ?? "").trim() || undefined,
        status: String(req.query["status"] ?? "").trim() || undefined,
        page: parseInt(String(req.query["page"] ?? "1"), 10),
        limit: parseInt(String(req.query["limit"] ?? "50"), 10),
      },
      db,
    );
    res.json(page);
  } catch (err) {
    logger.error({ err }, "[admin] queue-health/jobs error");
    const msg = err instanceof Error ? err.message : "Failed to load queue jobs";
    res.status(500).json({ error: msg });
  }
});

router.get("/admin/email-queue", requireAdmin, async (req: Request, res: Response) => {
  const VALID_STATUSES = ["pending", "recovering", "processing", "done", "failed"] as const;
  type JobStatus = typeof VALID_STATUSES[number];

  const page = Math.max(1, parseInt(String(req.query["page"] ?? "1"), 10));
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query["limit"] ?? "50"), 10)));
  const offset = (page - 1) * limit;

  const rawStatus = String(req.query["status"] ?? "").trim();
  const queueFilter = eq(asyncJobsTable.queue, "email");
  const statusFilter = rawStatus && (VALID_STATUSES as readonly string[]).includes(rawStatus)
    ? and(queueFilter, eq(asyncJobsTable.status, rawStatus as JobStatus))
    : queueFilter;

  try {
    const [rows, [{ total }]] = await Promise.all([
      db
        .select({
          id: asyncJobsTable.id,
          payload: asyncJobsTable.payload,
          status: asyncJobsTable.status,
          attempts: asyncJobsTable.attempts,
          maxAttempts: asyncJobsTable.maxAttempts,
          lastError: asyncJobsTable.lastError,
          nextAttemptAt: asyncJobsTable.nextAttemptAt,
          createdAt: asyncJobsTable.createdAt,
          updatedAt: asyncJobsTable.updatedAt,
          result: asyncJobsTable.result,
        })
        .from(asyncJobsTable)
        .where(statusFilter)
        .orderBy(desc(asyncJobsTable.createdAt))
        .limit(limit)
        .offset(offset),
      db.select({ total: count() }).from(asyncJobsTable).where(statusFilter),
    ]);

    // Flatten the payload back into the per-row shape the admin UI expects.
    const flattened = rows.map((r) => {
      const p = (r.payload ?? {}) as { to?: string; subject?: string; text?: string; html?: string | null; kind?: string | null };
      return {
        id: r.id,
        to: p.to ?? "",
        subject: p.subject ?? "",
        text: p.text ?? "",
        html: p.html ?? null,
        kind: p.kind ?? null,
        status: r.status,
        attempts: r.attempts,
        maxAttempts: r.maxAttempts,
        lastError: r.lastError,
        nextAttemptAt: r.nextAttemptAt,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        // A finished row that sent nothing on purpose (Issue #1212): never "Delivered".
        skipReason: skipReasonOf(r),
      };
    });

    res.json({ rows: flattened, total, page, limit, validStatuses: VALID_STATUSES });
  } catch (err) {
    logger.error({ err }, "[admin] email-queue error");
    const msg = err instanceof Error ? err.message : "Failed to load email queue";
    res.status(500).json({ error: msg });
  }
});

// DELETE /admin/email-queue?status=done|failed|pending — bulk-delete email-queue rows with the given status
router.delete("/admin/email-queue", requireAdmin, async (req: Request, res: Response) => {
  const CLEARABLE_STATUSES = ["done", "failed", "pending"] as const;
  type ClearableStatus = typeof CLEARABLE_STATUSES[number];

  const rawStatus = String(req.query["status"] ?? "").trim();
  if (!rawStatus || !(CLEARABLE_STATUSES as readonly string[]).includes(rawStatus)) {
    res.status(400).json({
      error: `status query param must be one of: ${CLEARABLE_STATUSES.join(", ")}`,
    });
    return;
  }

  const status = rawStatus as ClearableStatus;

  try {
    const deleted = await db
      .delete(asyncJobsTable)
      .where(and(eq(asyncJobsTable.queue, "email"), eq(asyncJobsTable.status, status)))
      .returning({ id: asyncJobsTable.id });

    res.json({ success: true, deleted: deleted.length });
  } catch (err) {
    logger.error({ err }, "[admin] email-queue delete error");
    const msg = err instanceof Error ? err.message : "Delete failed";
    res.status(500).json({ error: msg });
  }
});

// POST /admin/email-queue/:id/retry — reset a failed row for one more send (into recovery, Issue #1000)
router.post("/admin/email-queue/:id/retry", requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params["id"] ?? ""), 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid email outbox id" });
    return;
  }

  try {
    // Atomic conditional update: only resets the row if it is still failed.
    // This prevents a race where two concurrent admin retries both pass a
    // read-then-check and then both reset the same row to pending.
    //
    // maxAttempts is reset to the sentinel here too. Since PR288's finalize
    // change, a row that exhausted or terminally failed carries the ceiling
    // RESOLVED at that moment, persisted as a positive per-row value — correct
    // for a dead row, but wrong for one an admin is deliberately reopening: a
    // manual retry should follow whatever the queue's LIVE config says right
    // now (which may have been raised or lowered since this row first failed),
    // not the historical value frozen at the original failure.
    const [updated] = await db
      .update(asyncJobsTable)
      .set({
        attempts: 0,
        maxAttempts: USE_CONFIGURED_MAX_ATTEMPTS,
        nextAttemptAt: new Date(),
        updatedAt: new Date(),
        // A person retrying a failed email means "send it", including one held
        // back because it may already have gone out (Issue #1000, Q14: 2). The
        // reset also puts the row in recovery, so only a worker that sends
        // under the no-duplicate key may take it.
        ...emailRetryReset(),
      })
      .where(and(
        eq(asyncJobsTable.id, id),
        eq(asyncJobsTable.queue, "email"),
        eq(asyncJobsTable.status, "failed"),
      ))
      .returning();

    if (!updated) {
      const [current] = await db
        .select({ id: asyncJobsTable.id, status: asyncJobsTable.status })
        .from(asyncJobsTable)
        .where(and(eq(asyncJobsTable.id, id), eq(asyncJobsTable.queue, "email")))
        .limit(1);

      if (!current) {
        res.status(404).json({ error: "Email outbox row not found" });
        return;
      }
      res.status(400).json({
        error: `Cannot retry a row with status "${current.status}" — only failed rows can be retried`,
      });
      return;
    }

    res.json({ success: true, row: updated });
  } catch (err) {
    logger.error({ err }, "[admin] email-queue retry error");
    const msg = err instanceof Error ? err.message : "Retry failed";
    res.status(500).json({ error: msg });
  }
});


router.get("/admin/users/:id/data-export", requireAdmin, async (req: Request, res: Response) => {
  const id = String(req.params["id"] ?? "");
  const payload = await exportUserData(id);
  res.json({ success: true, ...payload });
});

router.post("/admin/retention/run", requireAdmin, async (_req: Request, res: Response) => {
  const result = await runRetentionWindowJobs();
  res.json({ success: true, result });
});

export default router;

import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import * as Sentry from "@sentry/node";
import { db, usersTable, sessionsTable } from "@workspace/db";
import { factsTable, commentsTable, adminConfigTable, featureFlagsTable, userGenerationCostsTable, membershipEntitlementsTable, entitlementSourceDisputesTable, membershipHistoryTable, asyncJobsTable, stripeWebhookAuditTable, enrichmentOverrideHistoryTable, factTextEditHistoryTable, factEnrichmentVersionsTable, pendingReviewsTable, type InsertEnrichmentOverrideHistory } from "@workspace/db/schema";
import { eq, desc, count, ilike, sql, and, or, inArray, isNull, asc, gt, getTableColumns } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { requireRole } from "../middlewares/tierMiddleware";
import { backfillEmbeddings } from "../lib/embeddings";
import { enrichFact, materializeEnrichment } from "../lib/factEnrichment";
import { writeBulkReenrichKeepingCharacterCorrection } from "../lib/factEnrichmentBackfillJob";
import { recordOverrideHistory } from "../lib/enrichmentOverrideHistory";
import {
  applyOverrideReset,
  applyOverrideUpsert,
  loadFactOverrideState,
  serializeResolved,
  type OverrideLayers,
} from "../lib/enrichmentOverrideLayers";
import { enqueueJob, USE_CONFIGURED_MAX_ATTEMPTS } from "../lib/asyncJobs";
import { emailRetryReset } from "../lib/email";
import { laneHealth, queueHealth, queueHealthJobs } from "../lib/queueHealth";
import { isNcmecReservedConfigKey, NCMEC_RESERVED_KEY_REFUSAL } from "../lib/moderation/ncmecConfig";
import { CODE_OWNED_AI_SETTING_REFUSAL, isCodeOwnedAiConfigKey, withoutCodeOwnedAiSettings } from "../lib/codeOwnedPrompts";
import { checkSharedRateLimit } from "../lib/sharedRateLimiter";
import { revokeUserSessions } from "../lib/auth";
import {
  validateEnrichment,
  computeBaselineChangedPaths,
  overrideValuesEqual,
  isOverridablePath,
  OVERRIDABLE_PATHS,
  OVERRIDABLE_PATH_KEYS,
  pathToField,
  checkPersonalName,
  FACT_TEXT_EDIT_CODES,
  UNRESOLVED_SUBMISSION_STAGE_VALUES,
  type FactEnrichment,
  type ManualOverride,
  type OverridablePath,
  type VisualPromptStrategyOverride,
} from "@workspace/api-zod";
import { type AuthenticatedRequest } from "../middlewares/authMiddleware";
import { normalizeFactTemplateForPendingReview, normalizeFactTemplateForStorage } from "../lib/normalizeFactTemplateForStorage";
import { createTriageReview } from "../lib/moderationStaging";
import { logActivity } from "../lib/activity";
import { recordAdminAction, recordAdminActions, type AdminActionRecord } from "../lib/adminActions";
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

  res.json({ users, total, page, limit });
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
  primaryArchetype: factsTable.primaryArchetype,
  enrichmentStatus: factsTable.enrichmentStatus,
  hasEmbedding: sql<boolean>`(${factsTable.embedding} IS NOT NULL)`,
  hasEnrichment: sql<boolean>`(${factsTable.enrichment} IS NOT NULL)`,
  hasEnrichmentOverrides: sql<boolean>`(${factsTable.enrichmentOverrides} <> '{}'::jsonb)`,
  enrichmentBaselineChanged: factsTable.enrichmentBaselineChanged,
  // Eval harness (Slice 2B): golden-set membership, so the Facts editor can show
  // + toggle it and reflect the saved state.
  evalGolden: factsTable.evalGolden,
  evalGoldenReason: factsTable.evalGoldenReason,
} as const;

// The Facts list, newest first, filtered by visibility, search, overrides and
// a changed baseline.
router.get("/admin/facts", requireAdmin, async (req: Request, res: Response) => {
  const page = Math.max(1, parseInt(String(req.query["page"] ?? "1"), 10));
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query["limit"] ?? "50"), 10)));
  const offset = (page - 1) * limit;
  const search = String(req.query["search"] ?? "").trim();
  const visibility = String(req.query["visibility"] ?? (req.query["inactive"] === "true" ? "both" : "active"));
  const onlyOverridden = req.query["hasOverrides"] === "true";
  const onlyBaselineChanged = req.query["baselineChanged"] === "true";
  const like = `%${search}%`;

  const visibilityFilter = visibility === "both" ? undefined : eq(factsTable.isActive, visibility !== "inactive");
  const overridesFilter = onlyOverridden ? sql`${factsTable.enrichmentOverrides} <> '{}'::jsonb` : undefined;
  const baselineChangedFilter = onlyBaselineChanged ? eq(factsTable.enrichmentBaselineChanged, true) : undefined;
  const searchFilter = search ? ilike(factsTable.text, like) : undefined;
  const where = and(...[visibilityFilter, searchFilter, overridesFilter, baselineChangedFilter].filter(Boolean));

  const [facts, [{ total }]] = await Promise.all([
    db.select(FACT_LIST_COLUMNS)
      .from(factsTable)
      .where(where)
      .orderBy(desc(factsTable.createdAt))
      .limit(limit)
      .offset(offset),
    db.select({ total: count() }).from(factsTable).where(where),
  ]);

  res.json({ facts, total, page, limit });
});

// Deactivate a fact: the only removal there is until the fact sheet's guarded
// delete (plan PLAN_FACT_LIFECYCLE_REBUILD.md, 1F). A deactivated fact keeps
// every member's memes, AI pictures and comments.
router.delete("/admin/facts/:id", requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params["id"] ?? ""), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid fact id" }); return; }

  try {
    const updated = await db.transaction(async (tx) => {
      const [row] = await tx.update(factsTable).set({ isActive: false }).where(and(eq(factsTable.id, id), eq(factsTable.isActive, true))).returning({ id: factsTable.id });
      if (row) await recordAdminAction({ factId: id }, req.user?.id, "deactivate", {}, tx);
      return row;
    });
    if (!updated) { res.status(404).json({ error: "Fact not found or already inactive" }); return; }
    res.json({ success: true, deleted: false });
  } catch (e) {
    logger.error({ err: e, factId: id }, "[DELETE /admin/facts/:id] failed");
    res.status(500).json({ error: "Failed to deactivate fact" });
  }
});

/** Shared success response — strips the raw embedding, adds the has* flags, and
 *  merges any extra fields. */
function respondFactUpdate(
  res: Response,
  updated: typeof factsTable.$inferSelect,
  extra: Record<string, unknown> = {},
): void {
  const { embedding: _emb, ...factRow } = updated;
  res.json({
    success: true,
    ...extra,
    fact: {
      ...factRow,
      hasEmbedding: updated.embedding !== null,
    },
  });
}

router.patch("/admin/facts/:id", requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params["id"] ?? ""), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid fact id" }); return; }

  const body = req.body as Record<string, unknown>;
  const { text, upvotes, downvotes, score, wilsonScore, commentCount, shareCount, submittedById, isActive } = body;

  // Coerce the column updates. Text/canonical/split are never set here: a
  // fact's wording is locked (plan PLAN_THREE_GAGS.md, increment 3).
  const nonTextUpdates: Record<string, unknown> = {};
  if (upvotes !== undefined) nonTextUpdates.upvotes = Number(upvotes);
  if (downvotes !== undefined) nonTextUpdates.downvotes = Number(downvotes);
  if (score !== undefined) nonTextUpdates.score = Number(score);
  if (wilsonScore !== undefined) nonTextUpdates.wilsonScore = Number(wilsonScore);
  if (commentCount !== undefined) nonTextUpdates.commentCount = Number(commentCount);
  if (shareCount !== undefined) nonTextUpdates.shareCount = Number(shareCount);
  if (submittedById !== undefined) nonTextUpdates.submittedById = submittedById ? String(submittedById) : null;
  if (isActive !== undefined) nonTextUpdates.isActive = Boolean(isActive);

  // Fetch current state once if either guard below needs it.
  let current: { isActive: boolean; text: string } | undefined;
  if (text !== undefined || nonTextUpdates.isActive === true) {
    [current] = await db.select({ isActive: factsTable.isActive, text: factsTable.text }).from(factsTable).where(eq(factsTable.id, id)).limit(1);
    if (!current) { res.status(404).json({ error: "Fact not found" }); return; }
  }

  // Activation is moderation-only (Phase 2 fact-lifecycle closure). The admin
  // Active toggle may DEACTIVATE a fact (true→false is always safe) but may NOT
  // ACTIVATE one: a false→true flip here would bypass the entire production gate
  // that approveForProduction/activateFact enforce (the approved-gag check,
  // the pending_reviews transition,
  // production-approval recording, submitter notification). To bring a
  // deactivated fact back, re-moderate it. So: reject any false→true request;
  // asserting isActive=true on an already-active fact is a harmless no-op that we
  // simply drop.
  if (nonTextUpdates.isActive === true) {
    if (current!.isActive === false) {
      res.status(400).json({
        error: "A fact can only be activated through moderation. Deactivated facts must be re-moderated to go live again.",
        code: "ACTIVATION_REQUIRES_MODERATION",
      });
      return;
    }
    delete nonTextUpdates.isActive;
  }

  // ── A fact's wording is locked (plan PLAN_THREE_GAGS.md, increment 3) ─────
  // It is edited only at triage, before the fact exists (POST
  // /admin/reviews/:id/wording); the database refuses any later change
  // (facts_text_is_locked). A request carrying the stored wording unchanged is
  // treated as a non-text PATCH; one that changes it is refused.
  if (text !== undefined) {
    const proposed = String(text);
    const stored = current!.text;
    // Normalised only when it differs, so an unchanged wording costs nothing.
    const normalized = proposed === stored ? null : normalizeFactTemplateForStorage(proposed);
    if (normalized && (!normalized.valid || normalized.text !== stored)) {
      res.status(409).json({
        error: "A fact's wording can't be changed once it is accepted. If the wording is wrong, deactivate this fact and submit the corrected wording as a new fact.",
        code: FACT_TEXT_EDIT_CODES.WORDING_LOCKED,
      });
      return;
    }
  }

  // ── The update ──────────────────────────────────────────────────────────
  if (Object.keys(nonTextUpdates).length === 0) {
    const [current] = await db.select().from(factsTable).where(eq(factsTable.id, id)).limit(1);
    if (!current) { res.status(404).json({ error: "Fact not found" }); return; }
    respondFactUpdate(res, current);
    return;
  }
  const row = await db.transaction(async (tx) => {
    const [updated] = await tx.update(factsTable).set(nonTextUpdates).where(eq(factsTable.id, id)).returning();
    if (updated) {
      // Turning Active off here is a deactivation like DELETE's; anything else is an edit.
      const { isActive: deactivating, ...edited } = nonTextUpdates;
      if (deactivating === false) await recordAdminAction({ factId: id }, req.user?.id, "deactivate", {}, tx);
      if (Object.keys(edited).length > 0) await recordAdminAction({ factId: id }, req.user?.id, "fact_edit", { changed: edited }, tx);
    }
    return updated;
  });
  if (!row) { res.status(404).json({ error: "Fact not found" }); return; }
  respondFactUpdate(res, row);
});

// GET /admin/facts/:id/text-edit-history — the edits of this fact's approved
// text made before a fact's wording locked at triage (plan PLAN_THREE_GAGS.md,
// increment 3); read-only history, no new entries are written. Admin-only,
// fact-scoped, newest-first, paginated. The actor is rendered from the joined
// user row, with a deleted/system fallback when performed_by was set null by a
// hard user deletion.
router.get("/admin/facts/:id/text-edit-history", requireAdmin, async (req: Request, res: Response) => {
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "Invalid fact id" }); return; }
  const limit = Math.min(Math.max(Number(req.query["limit"]) || 20, 1), 100);
  const offset = Math.max(Number(req.query["offset"]) || 0, 0);

  const [fact] = await db.select({ id: factsTable.id }).from(factsTable).where(eq(factsTable.id, id)).limit(1);
  if (!fact) { res.status(404).json({ error: "Fact not found" }); return; }

  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        id: factTextEditHistoryTable.id,
        oldText: factTextEditHistoryTable.oldText,
        newText: factTextEditHistoryTable.newText,
        reason: factTextEditHistoryTable.reason,
        createdAt: factTextEditHistoryTable.createdAt,
        performedById: factTextEditHistoryTable.performedBy,
        performedByName: usersTable.displayName,
        performedByEmail: usersTable.email,
      })
      .from(factTextEditHistoryTable)
      .leftJoin(usersTable, eq(usersTable.id, factTextEditHistoryTable.performedBy))
      .where(eq(factTextEditHistoryTable.factId, id))
      .orderBy(desc(factTextEditHistoryTable.createdAt), desc(factTextEditHistoryTable.id))
      .limit(limit)
      .offset(offset),
    db.select({ total: count() }).from(factTextEditHistoryTable).where(eq(factTextEditHistoryTable.factId, id)),
  ]);

  res.json({
    entries: rows.map((r) => ({
      id: r.id,
      oldText: r.oldText,
      newText: r.newText,
      reason: r.reason,
      createdAt: r.createdAt.toISOString(),
      // Deleted-admin fallback: performed_by went null on hard user deletion.
      actor: r.performedById == null ? null : { id: r.performedById, name: r.performedByName ?? null, email: r.performedByEmail ?? null },
    })),
    total,
    limit,
    offset,
  });
});

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
      // Eval golden-set membership, so the focused/deep-linked Facts editor
      // (e.g. /admin/facts?focus=<id>) reflects the saved state and can toggle it
      // — matching the list projection above.
      evalGolden: factsTable.evalGolden,
      evalGoldenReason: factsTable.evalGoldenReason,
    })
    .from(factsTable)
    .where(eq(factsTable.id, id))
    .limit(1);
  if (!row) { res.status(404).json({ error: "Fact not found" }); return; }

  res.json(row);
});

// The override-layer machinery (loadFactOverrideState, serializeResolved,
// applyOverrideUpsert/Reset, provenance stamping) lives in
// lib/enrichmentOverrideLayers.ts. This file keeps owning the fact-specific
// persistence: row locks, materialization onto facts.*, and override-history
// audit rows.
// GET /admin/facts/:id/enrichment-resolved — the AI baseline, the manual override
// map, the materialized effective blob, and the unified manual-intervention
// summary the editor uses to decorate diverged fields.
router.get("/admin/facts/:id/enrichment-resolved", requireAdmin, async (req: Request, res: Response) => {
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "Invalid fact id" }); return; }
  const state = await loadFactOverrideState(db, id);
  if (!state) { res.status(404).json({ error: "Fact not found" }); return; }
  res.json(serializeResolved(state));
});

// PUT /admin/facts/:id/enrichment-overrides — create/update a manual override for
// one allowlisted path. Runs in a transaction with a row lock and merges against
// the latest stored overrides so concurrent edits to different paths never clobber
// each other. Resetting to the AI value deletes the override (never stores
// override == AI). Validates the full effective before persisting.
router.put("/admin/facts/:id/enrichment-overrides", requireAdmin, async (req: Request, res: Response) => {
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "Invalid fact id" }); return; }
  const body = (req.body ?? {}) as { path?: unknown; value?: unknown; reason?: unknown; acknowledgeCurrentAiBaseline?: unknown };
  const path = String(body.path ?? "");
  if (!isOverridablePath(path)) { res.status(400).json({ error: `Path "${path}" is not an overridable field` }); return; }
  const adminId = (req as AuthenticatedRequest).user?.id ?? null;
  const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim() : undefined;
  const acknowledge = body.acknowledgeCurrentAiBaseline === true;

  try {
    const out = await db.transaction(async (tx): Promise<{ status: number; error?: string; body?: object; state?: OverrideLayers }> => {
      const state = await loadFactOverrideState(tx, id, true);
      if (!state) return { status: 404, error: "Fact not found" };
      if (!state.aiDerived) return { status: 409, error: "Fact has no enrichment baseline yet — classify it first" };
      const aiDerived = state.aiDerived;

      // Shared merge core: validation, reset-when-equal-AI, acknowledge
      // semantics, subtype auto-link, cross-field validation.
      const result = applyOverrideUpsert({
        layers: { ...state, aiDerived },
        path,
        value: body.value,
        ...(reason !== undefined ? { reason } : {}),
        acknowledge,
        adminId,
      });
      if (!result.ok) return { status: result.status, error: result.error };

      const { columns } = materializeEnrichment({ aiDerived, overrides: result.overrides });
      await tx.update(factsTable).set({ ...columns, enrichmentStatus: "ok" }).where(eq(factsTable.id, id));
      // Fact edits are the audited surface — map the change list to history rows.
      await recordOverrideHistory(
        result.changes.map((c): InsertEnrichmentOverrideHistory => ({
          factId: id, path: c.path, action: c.action, oldValue: c.oldValue, newValue: c.newValue,
          aiGenerationId: c.aiGenerationId, reason: c.reason, performedBy: adminId,
        })),
        tx,
      );
      await recordAdminAction({ factId: id }, adminId, "classification_edit", { changes: result.changes.map((c) => ({ path: c.path, action: c.action, newValue: c.newValue })) }, tx);
      return { status: 200, state: { ...state, overrides: result.overrides } };
    });

    if (out.status !== 200 || !out.state) { res.status(out.status).json(out.body ?? { error: out.error ?? "Error" }); return; }
    res.json({ success: true, ...serializeResolved({ ...out.state, enrichmentStatus: "ok" }) });
  } catch (e) {
    logger.error({ err: e, factId: id, path }, "[PUT /admin/facts/:id/enrichment-overrides] failed");
    res.status(500).json({ error: "Failed to save override" });
  }
});

// DELETE /admin/facts/:id/enrichment-overrides[?path=…] — reset one override (or
// ALL of them when no `path` is given) back to the AI baseline.
router.delete("/admin/facts/:id/enrichment-overrides", requireAdmin, async (req: Request, res: Response) => {
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "Invalid fact id" }); return; }
  const rawPath = req.query["path"];
  const path = rawPath !== undefined ? String(rawPath) : null;
  if (path !== null && !isOverridablePath(path)) { res.status(400).json({ error: `Path "${path}" is not an overridable field` }); return; }
  const adminId = (req as AuthenticatedRequest).user?.id ?? null;

  try {
    const out = await db.transaction(async (tx): Promise<{ status: number; error?: string; body?: object; state?: OverrideLayers }> => {
      const state = await loadFactOverrideState(tx, id, true);
      if (!state) return { status: 404, error: "Fact not found" };
      if (!state.aiDerived) return { status: 409, error: "Fact has no enrichment baseline yet" };
      const aiDerived = state.aiDerived;

      const result = applyOverrideReset({ layers: { ...state, aiDerived }, path: path as OverridablePath | null });

      const { columns } = materializeEnrichment({ aiDerived, overrides: result.overrides });
      await tx.update(factsTable).set({ ...columns, enrichmentStatus: "ok" }).where(eq(factsTable.id, id));
      await recordOverrideHistory(
        result.changes.map((c): InsertEnrichmentOverrideHistory => ({
          factId: id, path: c.path, action: c.action, oldValue: c.oldValue, newValue: c.newValue,
          aiGenerationId: c.aiGenerationId, reason: c.reason, performedBy: adminId,
        })),
        tx,
      );
      await recordAdminAction({ factId: id }, adminId, "classification_edit", { changes: result.changes.map((c) => ({ path: c.path, action: c.action, newValue: c.newValue })) }, tx);
      return { status: 200, state: { ...state, overrides: result.overrides } };
    });

    if (out.status !== 200 || !out.state) { res.status(out.status).json(out.body ?? { error: out.error ?? "Error" }); return; }
    res.json({ success: true, ...serializeResolved({ ...out.state, enrichmentStatus: "ok" }) });
  } catch (e) {
    logger.error({ err: e, factId: id, path }, "[DELETE /admin/facts/:id/enrichment-overrides] failed");
    res.status(500).json({ error: "Failed to reset override" });
  }
});

// GET /admin/facts/:id/enrichment-overrides/history — the audit trail.
router.get("/admin/facts/:id/enrichment-overrides/history", requireAdmin, async (req: Request, res: Response) => {
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "Invalid fact id" }); return; }
  const history = await db
    .select()
    .from(enrichmentOverrideHistoryTable)
    .where(eq(enrichmentOverrideHistoryTable.factId, id))
    .orderBy(desc(enrichmentOverrideHistoryTable.createdAt))
    .limit(200);
  res.json({ history });
});

// PATCH /admin/facts/:id/enrichment — persist admin edits to the NON-tracked
// enrichment fields only (suggested hashtags). Tracked taxonomy/notes paths are
// owned by the override endpoints (PUT/DELETE /enrichment-overrides); a PATCH
// that tries to CHANGE any tracked field is rejected with 400 so stale clients
// can't overwrite them in place. A fact's gags are not enrichment (migration
// 0139): they are saved through /admin/facts/:id/gags, and a PATCH carrying one
// is refused rather than silently dropped.
router.patch("/admin/facts/:id/enrichment", requireAdmin, async (req: Request, res: Response) => {
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "Invalid fact id" }); return; }

  const raw = (req.body as { enrichment?: unknown } | null | undefined)?.enrichment;
  if (raw && typeof raw === "object" && "visualPromptStrategyOverride" in raw) {
    res.status(400).json({
      error: "A fact's gags are saved through /admin/facts/:id/gags, not the enrichment.",
      code: "GAG_IN_ENRICHMENT",
    });
    return;
  }
  const result = validateEnrichment(raw);
  if (!result.ok) { res.status(400).json({ error: `Invalid enrichment: ${result.error}` }); return; }
  const submitted = result.data;

  const state = await loadFactOverrideState(db, id);
  if (!state) { res.status(404).json({ error: "Fact not found" }); return; }

  // Reject any attempt to change a tracked field through PATCH.
  if (state.effective) {
    const changed = OVERRIDABLE_PATH_KEYS.filter((p) => {
      const field = pathToField(p);
      return !overrideValuesEqual(
        (submitted as Record<string, unknown>)[field],
        (state.effective as unknown as Record<string, unknown>)[field],
      );
    });
    if (changed.length > 0) {
      res.status(400).json({
        error: `Tracked field(s) ${changed.map((p) => OVERRIDABLE_PATHS[p].label).join(", ")} must be changed via the override endpoints (PUT/DELETE /admin/facts/${id}/enrichment-overrides), not PATCH`,
        trackedPaths: changed,
      });
      return;
    }
  }

  // Apply only the non-tracked edits: suggestedHashtags is an AI field edited
  // in place on the baseline (not tracked).
  const baseline = state.aiDerived ?? submitted;
  if (!baseline) { res.status(409).json({ error: "Fact has no enrichment baseline yet" }); return; }
  const newAiDerived = { ...baseline, suggestedHashtags: submitted.suggestedHashtags } as FactEnrichment;

  const { columns } = materializeEnrichment({ aiDerived: newAiDerived, overrides: state.overrides });
  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(factsTable)
      .set({ ...columns, enrichmentStatus: "ok" })
      .where(eq(factsTable.id, id))
      .returning({ id: factsTable.id });
    if (row) await recordAdminAction({ factId: id }, req.user?.id, "classification_edit", { suggestedHashtags: submitted.suggestedHashtags ?? null }, tx);
    return row;
  });
  if (!updated) { res.status(404).json({ error: "Fact not found" }); return; }

  res.json({
    success: true,
    enrichment: columns.enrichment,
    projection: {
      primaryArchetype: columns.primaryArchetype,
      subtype: columns.subtype,
      overhypeFit: columns.overhypeFit,
      adultSuitability: columns.adultSuitability,
    },
  });
});

// POST /admin/facts/:id/enrich — re-run classification on a live fact. Marks
// enrichmentStatus "pending" and enqueues the (generalized) enrichment job for
// the fact target. The destructive "this overwrites admin-tuned metadata"
// confirmation is enforced client-side; this endpoint just enqueues.
router.post("/admin/facts/:id/enrich", requireAdmin, async (req: Request, res: Response) => {
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "Invalid fact id" }); return; }

  const [fact] = await db.select({ id: factsTable.id }).from(factsTable).where(eq(factsTable.id, id)).limit(1);
  if (!fact) { res.status(404).json({ error: "Fact not found" }); return; }

  await db.update(factsTable).set({ enrichmentStatus: "pending" }).where(eq(factsTable.id, id));
  await enqueueJob({
    queue: "enrichment",
    payload: { factId: id },
    dedupeKey: `enrichment:fact:${id}`,
  });
  await recordAdminAction({ factId: id }, req.user?.id, "classification_rerun", {});

  res.json({ success: true, enrichmentStatus: "pending" });
});

// GET /admin/facts/:id/enrichment-versions — the fact's versioned-enrichment
// history, METADATA ONLY (no jsonb blobs — the panel is for visibility, not
// rollback). "current" is derived from facts.* (the sole active truth — the
// version table never holds an active row).
router.get("/admin/facts/:id/enrichment-versions", requireAdmin, async (req: Request, res: Response) => {
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "Invalid fact id" }); return; }

  const [fact] = await db
    .select({
      enrichment: factsTable.enrichment,
      enrichmentStatus: factsTable.enrichmentStatus,
      enrichmentOverrides: factsTable.enrichmentOverrides,
    })
    .from(factsTable)
    .where(eq(factsTable.id, id))
    .limit(1);
  if (!fact) { res.status(404).json({ error: "Fact not found" }); return; }

  const createdByUsers = alias(usersTable, "created_by_users");
  const rows = await db
    .select({
      id: factEnrichmentVersionsTable.id,
      versionNo: factEnrichmentVersionsTable.versionNo,
      status: factEnrichmentVersionsTable.status,
      source: factEnrichmentVersionsTable.source,
      sourceReviewId: factEnrichmentVersionsTable.sourceReviewId,
      note: factEnrichmentVersionsTable.note,
      createdByDisplayName: createdByUsers.displayName,
      createdByEmail: createdByUsers.email,
      createdAt: factEnrichmentVersionsTable.createdAt,
      promotedAt: factEnrichmentVersionsTable.promotedAt,
      supersededAt: factEnrichmentVersionsTable.supersededAt,
      rejectedAt: factEnrichmentVersionsTable.rejectedAt,
      enrichmentReady: sql<boolean>`(${factEnrichmentVersionsTable.enrichment} IS NOT NULL)`,
    })
    .from(factEnrichmentVersionsTable)
    .leftJoin(createdByUsers, eq(factEnrichmentVersionsTable.createdBy, createdByUsers.id))
    .where(eq(factEnrichmentVersionsTable.factId, id))
    .orderBy(desc(factEnrichmentVersionsTable.createdAt));

  res.json({
    current: {
      hasEnrichment: fact.enrichment != null,
      enrichmentStatus: fact.enrichmentStatus ?? null,
      hasOverrides: Object.keys((fact.enrichmentOverrides ?? {}) as Record<string, unknown>).length > 0,
    },
    versions: rows.map((r) => ({
      ...r,
      createdAt: r.createdAt.toISOString(),
      promotedAt: r.promotedAt?.toISOString() ?? null,
      supersededAt: r.supersededAt?.toISOString() ?? null,
      rejectedAt: r.rejectedAt?.toISOString() ?? null,
    })),
  });
});

// Bound the batch so a single call can't insert an unbounded number of rows
// (or hold a huge payload in memory). 1000 rows / 2000 chars each is generous
// for a bulk import; split larger imports across calls.
export const FactsImportBody = z.object({
  facts: z.array(z.union([
    z.string().max(2000),
    z.object({ text: z.string().max(2000) }).passthrough(),
  ])).min(1).max(1000),
});

/**
 * Shared bulk-ingestion funnel (Phase 2 fact-lifecycle closure) for the two
 * session-admin import endpoints. Dedups each text against existing facts AND
 * unresolved reviews, then creates a Stage-1 triage review per new text
 * (submittedById = the acting admin). Bulk import LOADS the moderation queue — it
 * does NOT publish — so nothing here inserts an active fact; enrichment/hashtags/
 * embeddings are deferred to the pipeline. Returns queued/skipped counts.
 */
async function queueTextsForTriage(
  submittedById: string | null,
  texts: string[],
): Promise<{ queued: number; skipped: number }> {
  if (texts.length === 0) return { queued: 0, skipped: 0 };
  const [factRows, reviewRows] = await Promise.all([
    db.select({ text: factsTable.text }).from(factsTable).where(inArray(factsTable.text, texts)),
    db
      .select({ text: pendingReviewsTable.submittedText })
      .from(pendingReviewsTable)
      .where(
        and(
          inArray(pendingReviewsTable.submittedText, texts),
          inArray(pendingReviewsTable.workflowStage, [...UNRESOLVED_SUBMISSION_STAGE_VALUES]),
        ),
      ),
  ]);
  const seen = new Set<string>([...factRows.map((r) => r.text), ...reviewRows.map((r) => r.text)]);
  let queued = 0;
  let skipped = 0;
  await db.transaction(async (tx) => {
    const records: AdminActionRecord[] = [];
    for (const text of texts) {
      if (seen.has(text)) { skipped++; continue; }
      seen.add(text);
      const review = await createTriageReview(tx, { submittedText: text, submittedById, hashtags: [] });
      records.push({ target: { reviewId: review.id }, actorId: submittedById, action: "import" });
      queued++;
    }
    await recordAdminActions(records, tx);
  });
  return { queued, skipped };
}

router.post("/admin/facts/import", requireAdmin, async (req: Request, res: Response) => {
  const parsed = FactsImportBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
    return;
  }
  const { facts } = parsed.data;

  const texts: string[] = [];
  for (const item of facts) {
    if (typeof item === "string" && item.trim().length > 0) {
      texts.push(item.trim());
    } else if (typeof item === "object" && item !== null && "text" in item && typeof (item as Record<string, unknown>).text === "string") {
      const t = ((item as Record<string, unknown>).text as string).trim();
      if (t.length > 0) texts.push(t);
    }
  }

  if (texts.length === 0) {
    res.status(400).json({ error: "No valid fact texts found in import" });
    return;
  }

  // Normalize + validate each row through the SAME normalizer user submissions
  // use, then QUEUE valid rows for moderation (Stage-1 triage reviews) rather
  // than inserting active facts. Partial success: invalid rows are reported in
  // `failed` and skipped; valid rows are queued.
  const validTexts: string[] = [];
  const failed: { index: number; text: string; error: string }[] = [];
  texts.forEach((text, index) => {
    const normalized = normalizeFactTemplateForPendingReview(text);
    if (!normalized.valid) {
      failed.push({ index, text, error: `Template grammar validation failed: ${normalized.grammarResult.error}` });
      return;
    }
    validTexts.push(normalized.text);
  });

  const { queued, skipped } = await queueTextsForTriage((req as AuthenticatedRequest).user!.id, validTexts);

  res.json({ success: true, queued, skipped, failed });
});

// Cap the raw CSV size (≤2 MB) so an unbounded string can't exhaust memory.
export const ImportCsvBody = z.object({ csv: z.string().min(1).max(2_000_000) });
const IMPORT_CSV_MAX_ROWS = 2000;

router.post("/admin/facts/import-csv", requireAdmin, async (req: Request, res: Response) => {
  const parsed = ImportCsvBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
    return;
  }
  const { csv } = parsed.data;

  const lines = csv.split("\n")
    .map((l) => l.replace(/^["']|["']$/g, "").trim())
    .filter((l) => l.length > 5);

  if (lines.length === 0) {
    res.status(400).json({ error: "No valid lines found in CSV" });
    return;
  }
  // Reject (don't silently truncate) an over-large batch so the caller knows to split.
  if (lines.length > IMPORT_CSV_MAX_ROWS) {
    res.status(400).json({ error: `Too many rows (${lines.length}); import at most ${IMPORT_CSV_MAX_ROWS} per call` });
    return;
  }

  // Normalize + validate each row, then QUEUE valid rows for moderation (Stage-1
  // triage reviews) rather than inserting active facts. Partial success: invalid
  // rows are reported in `failed` and skipped; valid rows are queued.
  const validTexts: string[] = [];
  const failed: { index: number; text: string; error: string }[] = [];
  lines.forEach((text, index) => {
    const normalized = normalizeFactTemplateForPendingReview(text);
    if (!normalized.valid) {
      failed.push({ index, text, error: `Template grammar validation failed: ${normalized.grammarResult.error}` });
      return;
    }
    validTexts.push(normalized.text);
  });

  const { queued, skipped } = await queueTextsForTriage((req as AuthenticatedRequest).user!.id, validTexts);

  res.json({ success: true, queued, skipped, failed });
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

// POST /admin/facts/backfill-embeddings
// One-shot endpoint to generate pgvector embeddings for all facts that don't have one yet.
// Accepts either an authenticated admin session OR the ADMIN_API_KEY header.
export async function requireAdminOrApiKey(req: Request, res: Response, next: NextFunction): Promise<void> {
  const apiKey = req.headers["x-api-key"];
  const adminApiKey = process.env.ADMIN_API_KEY;
  if (adminApiKey && apiKey === adminApiKey) {
    next();
    return;
  }
  return requireAdmin(req, res, next) as unknown as void;
}

// POST /admin/users/set-password — reset a user's password by email (API key auth)
router.post("/admin/users/set-password", requireAdminOrApiKey, async (req: Request, res: Response) => {
  const { email, password } = req.body as { email?: string; password?: string };
  if (!email || typeof email !== "string") { res.status(400).json({ error: "email is required" }); return; }
  const normalizedEmail = email.trim().toLowerCase();
  // Reachable with only the static ADMIN_API_KEY (no admin session), so require
  // a well-formed, length-bounded email in addition to the password rules.
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

router.post("/admin/users/enable-notifications", requireAdminOrApiKey, async (_req: Request, res: Response) => {
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

// POST /admin/facts/backfill-ai-memes — retired with the legacy AI-background
// generator (compiler review, Phase 2: every picture starts from a photo). It
// answers 410 and starts nothing; the pictures it stored stay readable.
router.post("/admin/facts/backfill-ai-memes", requireAdminOrApiKey, (_req: Request, res: Response) => {
  res.status(410).json({ error: "The legacy AI-background generator is retired: every picture starts from a photo.", code: "AI_MEME_BACKFILL_RETIRED" });
});

router.post("/admin/facts/backfill-embeddings", requireAdminOrApiKey, async (_req: Request, res: Response) => {
  try {
    const result = await backfillEmbeddings();
    res.json({ success: true, ...result });
  } catch (err) {
    logger.error({ err }, "[admin] Backfill embeddings error");
    res.status(500).json({ error: "Backfill failed", details: String(err) });
  }
});

// Backfill visual-taxonomy enrichment onto existing facts (covers bulk-imported
// facts too). With ?force=true, re-enriches every active fact; otherwise only
// facts that have no enrichment yet. Runs sequentially in the background to
// respect OpenAI rate limits.
router.post("/admin/facts/backfill-enrichment", requireAdminOrApiKey, async (req: Request, res: Response) => {
  try {
    const force = String((req.query as Record<string, unknown>)["force"] ?? "") === "true";

    const rows = await db
      .select({
        id: factsTable.id,
        text: factsTable.text,
        enrichment: factsTable.enrichment,
        enrichmentAiDerived: factsTable.enrichmentAiDerived,
      })
      .from(factsTable)
      .where(force
        ? eq(factsTable.isActive, true)
        : and(eq(factsTable.isActive, true), isNull(factsTable.enrichment)));

    const total = rows.length;
    res.json({ success: true, queued: total, message: `Enriching ${total} facts sequentially in the background.` });

    void (async () => {
      logger.info({ total, force }, "[admin] backfill-enrichment: starting");
      let done = 0;
      let failed = 0;
      for (const fact of rows) {
        try {
          const enrichment = await enrichFact({
            factText: fact.text,
            priorCharacters: fact.enrichmentAiDerived as FactEnrichment | null,
          });
          // The fact's gags live in fact_gags (migration 0139): re-classifying
          // never touches them. Overrides reset, except a moderator's
          // character correction, re-read under the row lock
          // (PLAN_BUBBLE_SPEAKERS.md, E).
          await writeBulkReenrichKeepingCharacterCorrection(fact.id, enrichment);
          done++;
        } catch (err) {
          failed++;
          logger.warn({ err, factId: fact.id }, "[admin] backfill-enrichment: fact failed");
        }
      }
      logger.info({ total, done, failed }, "[admin] backfill-enrichment: done");
    })();
  } catch (err) {
    logger.error({ err }, "[admin] Backfill enrichment error");
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
    res.json(withoutCodeOwnedAiSettings(await getAllConfig()));
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
router.post("/admin/stripe/full-sync", requireAdminOrApiKey, async (_req: Request, res: Response) => {
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
router.post("/admin/stripe/sync", requireAdminOrApiKey, async (_req: Request, res: Response) => {
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
    // tabs, same shape as the taxonomy-health job-status limiter below.
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

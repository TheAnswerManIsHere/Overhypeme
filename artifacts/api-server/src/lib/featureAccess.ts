/**
 * The permission chokepoint.
 * ────────────────────────────────────────────────────────────────────────────
 * This module is the ONLY code permitted to read the Feature Permission Grid
 * (`tier_feature_permissions`). Everything else asks it a question about a
 * *principal*, never about a tier string.
 *
 * WHY THE TIER-KEYED LOOKUP IS PRIVATE. `hasFeature(tier, key)` used to be
 * exported and callable from route code. That is exactly how PR #402
 * reproduced: the meme builder mapped `admin → legendary` client-side and
 * offered a Private pill, while `createMemeRecord` resolved the same
 * entitlement from the tier column, found `registered`, and coerced the meme
 * public. Two surfaces, two vocabularies, no chokepoint. `hasFeature` is now
 * module-private and `scripts/check-permission-chokepoint.mjs` fails the build
 * if any file outside this one references it.
 *
 * UNION, NEVER OVERRIDE. A principal's feature set is
 *   features(their tier) ∪ (isAdmin ? features('admin') : ∅)
 * so an admin who also holds a paid Legendary entitlement never *loses* a
 * feature by being an admin.
 *
 * FAILS CLOSED. A missing row, an unknown feature key, or a database error
 * denies. `can()` never throws into route code.
 *
 * WHAT IS NOT HERE. Operational privileges (admin console, user management,
 * moderation, config editing) are NOT grid features — they stay on
 * `requireRole('admin')` over `realUserRole`. That separation is what makes
 * admin lockout impossible by configuration: nothing that grants console
 * access lives in the grid.
 *
 * @purpose The permission chokepoint: the only module that reads the tier feature grid, resolving a principal's features as the union of its tier and admin rows; the can and requireFeature gates fail closed, while the entitlement resolver behind the login payload throws on a database error; also the admin matrix read and write, and the grid revision.
 * @subsystem membership
 */

import { type Request, type Response, type NextFunction } from "express";
import crypto from "node:crypto";
import { db } from "@workspace/db";
import {
  featureFlagsTable,
  tierFeaturePermissionsTable,
  tierFeaturePermissionAuditTable,
  entitlementGridRevisionTable,
} from "@workspace/db/schema";
import { eq, and, sql } from "drizzle-orm";
import { logger } from "./logger";

// ── The feature vocabulary ───────────────────────────────────────────────────

/**
 * Every boolean product entitlement the grid governs.
 *
 * `engine_experiments` is deliberately absent: it has no grid rows and is
 * gated by a hardcoded admin-only predicate. Plan 3 replaces it wholesale, and
 * partially migrating it here is explicitly out of scope.
 *
 * `meme_upload_photo` is deliberately absent — a dead row no code ever read,
 * retired by this plan's migration. Its values encoded only the
 * registered-vs-unregistered distinction that authentication already enforces,
 * so photo-upload meme creation is an identity prerequisite, not an
 * entitlement. Every row in this grid should be a real dial.
 *
 * `meme_ai_background` nearly went the same way and should NOT. Its only
 * *reader* was an unreachable gate in `render.ts`, which makes it look dead —
 * but the capability is real and reachable: the AI Background Picker's generate
 * button hits four `requireLegendary` routes in `memes.ts`. A row whose reader
 * is dead is not the same as a row whose capability is dead, and the plan's
 * instruction to rewire it "to reachable routes" meant exactly those four.
 */
export const FEATURE_KEYS = [
  "comment_captcha_bypass",
  "meme_ai_background",
  "meme_private_visibility",
  "meme_rate_limit_high",
  "fact_submit_captcha_bypass",
  "fact_submit_rate_limit_bypass",
  "ads_free",
  "custom_avatar",
] as const;

export type FeatureKey = (typeof FEATURE_KEYS)[number];

const FEATURE_KEY_SET: ReadonlySet<string> = new Set(FEATURE_KEYS);

export function isFeatureKey(value: string): value is FeatureKey {
  return FEATURE_KEY_SET.has(value);
}

/** The four columns the grid is keyed on. */
export const GRID_TIERS = ["unregistered", "registered", "legendary", "admin"] as const;
export type GridTier = (typeof GRID_TIERS)[number];

export function isGridTier(value: string): value is GridTier {
  return (GRID_TIERS as readonly string[]).includes(value);
}

// ── Shapes ───────────────────────────────────────────────────────────────────

/**
 * `limit` is always `null` in this plan — every feature here is boolean. The
 * shape is typed this way from the start because a boolean feature is the
 * degenerate case of a metered one, so Plan 2 extends a working shape instead
 * of migrating one, with no client-side breaking change when metered rows
 * arrive.
 */
export interface Entitlement {
  allowed: boolean;
  limit: number | null;
}

/**
 * Who is asking. A principal object rather than a bare tier string is the seam
 * Plan 2 (`isTester`) and any future impersonation work slot into.
 */
export interface Principal {
  tier: string;
  isAdmin: boolean;
}

export const ANONYMOUS_PRINCIPAL: Principal = { tier: "unregistered", isAdmin: false };

/** Server-internal. The wire format is a plain object — see `toWireEntitlements`. */
export type EntitlementMap = Map<FeatureKey, Entitlement>;

export interface ResolvedEntitlements {
  entitlements: EntitlementMap;
  gridRevision: number;
}

// ── Principal construction ───────────────────────────────────────────────────

/**
 * Builds the principal for a request. Used EVERYWHERE a principal is built,
 * including the snapshot persisted with queued work.
 *
 * This deliberately does NOT copy `req.user`'s two fields. `req.user.membershipTier`
 * is never toggle-aware: "view as user" flips `isAdmin` to `false` but leaves
 * `membershipTier` at the account's real paid tier (`authMiddleware.ts:122-140`).
 * A naive `{ tier: req.user.membershipTier, isAdmin: req.user.isAdmin }` would
 * give a legendary-holding admin in preview mode `{tier: "legendary", isAdmin: false}`
 * — which still resolves every Legendary feature, defeating the whole point of
 * the preview.
 *
 * `adminModeDisabled` is derived rather than re-read from the session: an
 * account is previewing exactly when it is a real admin whose effective admin
 * flag is off. Deriving it also keeps the mode admin-only by construction — a
 * non-admin session carrying a stale `adminModeDisabled` must not have its tier
 * silently dropped to `registered`.
 */
export function principalFromRequest(req: Request): Principal {
  if (!req.isAuthenticated()) return ANONYMOUS_PRINCIPAL;
  return principalFromUser(req.user);
}

export function principalFromUser(user: {
  membershipTier?: string | null;
  isAdmin?: boolean | null;
  isRealAdmin?: boolean | null;
}): Principal {
  const isRealAdmin = !!user.isRealAdmin;
  const isAdmin = !!user.isAdmin;
  const previewingAsUser = isRealAdmin && !isAdmin;
  return {
    tier: previewingAsUser ? "registered" : (user.membershipTier ?? "unregistered"),
    isAdmin,
  };
}

/**
 * Identifies a principal for cache-revalidation purposes. Changes whenever the
 * principal changes — a lapsing entitlement, an admin grant/revoke, a
 * view-as-user toggle, or a different account entirely — none of which move the
 * grid revision.
 */
export function principalFingerprint(principal: Principal, userId: string | null): string {
  return crypto
    .createHash("sha256")
    .update(`${userId ?? "anon"}\0${principal.tier}\0${principal.isAdmin ? "1" : "0"}`)
    .digest("hex")
    .slice(0, 32);
}

// ── The grid snapshot ────────────────────────────────────────────────────────

const CACHE_TTL_MS = 60_000;

/** Exposed so the UI can state the real window rather than claiming "immediately". */
export const ENTITLEMENT_CACHE_TTL_MS = CACHE_TTL_MS;

interface GridSnapshot {
  /** tier → featureKey → enabled */
  byTier: Map<string, Map<string, boolean>>;
  gridRevision: number;
  fetchedAt: number;
}

let snapshot: GridSnapshot | null = null;
let inFlight: Promise<GridSnapshot> | null = null;

/**
 * Bumped on every bust. A load in flight when a bust happens captures the
 * generation it started under; if that generation has moved by the time the
 * load resolves, a write landed while it was in flight, and its result is
 * stale by construction, so it is discarded instead of being written back —
 * round 4 of PR #425's review found the load completing AFTER a bust
 * overwriting `snapshot` with pre-write data despite the bust, keeping a
 * revoked or newly-granted entitlement wrong for a full TTL in this process.
 */
let generation = 0;

/** Drops the cached snapshot in THIS process. Called by every grid write. */
export function bustEntitlementCache(): void {
  generation++;
  snapshot = null;
  inFlight = null;
}

/**
 * Loads the whole grid and the revision counter in ONE statement, so the two
 * can never come from different instants. Under READ COMMITTED each *statement*
 * gets its own snapshot; two separate selects could straddle a concurrent grid
 * write and hand back a row-set stamped with a revision that never described
 * it. The LEFT JOIN against the singleton keeps the revision present even when
 * the grid has no rows at all.
 */
async function loadSnapshot(): Promise<GridSnapshot> {
  const cached = snapshot;
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached;
  if (inFlight) return inFlight;

  const startedGeneration = generation;
  const thisLoad: Promise<GridSnapshot> = (async (): Promise<GridSnapshot> => {
    const { rows } = await db.execute<{
      revision: string | number;
      tier: string | null;
      feature_key: string | null;
      enabled: boolean | null;
    }>(sql`
      SELECT r.revision, p.tier, p.feature_key, p.enabled
      FROM (SELECT revision FROM entitlement_grid_revision WHERE id = 1) r
      LEFT JOIN tier_feature_permissions p ON true
    `);

    if (rows.length === 0) {
      // No revision row at all — the migration has not run. Fail closed rather
      // than serving an empty grid as if it were authoritative.
      throw new Error("entitlement_grid_revision is missing its singleton row");
    }

    const byTier = new Map<string, Map<string, boolean>>();
    for (const row of rows) {
      if (row.tier == null || row.feature_key == null) continue;
      let tierMap = byTier.get(row.tier);
      if (!tierMap) {
        tierMap = new Map<string, boolean>();
        byTier.set(row.tier, tierMap);
      }
      tierMap.set(row.feature_key, !!row.enabled);
    }

    const loaded: GridSnapshot = {
      byTier,
      gridRevision: Number(rows[0].revision),
      fetchedAt: Date.now(),
    };
    // Only cache if no bust happened while this query was running — a bust
    // mid-flight means `loaded` reflects pre-write state, and writing it into
    // `snapshot` now would resurrect exactly what the bust was trying to
    // clear. The caller that started this load still gets `loaded` back: it
    // asked before the write landed, same as any other read racing a write.
    if (generation === startedGeneration) {
      snapshot = loaded;
    }
    return loaded;
  })().finally(() => {
    // Only clear `inFlight` if it's still THIS load. A bust nulls it
    // synchronously; if a newer load has already started by the time this one
    // finishes, clearing here would drop the newer load's own in-flight
    // dedup, letting a third caller kick off a redundant query.
    if (inFlight === thisLoad) {
      inFlight = null;
    }
  });

  inFlight = thisLoad;
  return thisLoad;
}

/**
 * The tier-keyed lookup. PRIVATE ON PURPOSE — see the module header. Route code
 * asks `can(principal, key)`; nothing outside this module gets to pick a tier
 * string by hand.
 */
function hasFeature(snap: GridSnapshot, tier: string, featureKey: string): boolean {
  return snap.byTier.get(tier)?.get(featureKey) ?? false;
}

// ── Resolution ───────────────────────────────────────────────────────────────

/**
 * The full entitlement set for a principal, stamped with the revision it was
 * computed from.
 *
 * The map is TOTAL over `FEATURE_KEYS` regardless of what the database holds:
 * a key with no row resolves to `allowed: false`. That is what makes a missing
 * row deny rather than crash, and what lets the client render a complete lock
 * state without knowing which rows happen to exist.
 *
 * Throws on a database error. `can()` catches and denies; payload endpoints
 * surface it rather than serving an all-denied map as if it were the real
 * answer.
 */
export async function resolveEntitlements(principal: Principal): Promise<ResolvedEntitlements> {
  const snap = await loadSnapshot();

  const entitlements: EntitlementMap = new Map();
  for (const key of FEATURE_KEYS) {
    const ownTier = hasFeature(snap, principal.tier, key);
    const adminOverlay = principal.isAdmin ? hasFeature(snap, "admin", key) : false;
    entitlements.set(key, {
      // Union, never override: the admin overlay can only ADD.
      allowed: ownTier || adminOverlay,
      limit: null,
    });
  }

  return { entitlements, gridRevision: snap.gridRevision };
}

/**
 * The question every gate asks. Never throws — a database error, an unknown
 * key, or a missing row all deny.
 */
export async function can(principal: Principal, featureKey: string): Promise<boolean> {
  if (!isFeatureKey(featureKey)) {
    logger.warn({ featureKey }, "[featureAccess] unknown feature key — denying");
    return false;
  }
  try {
    const { entitlements } = await resolveEntitlements(principal);
    return entitlements.get(featureKey)?.allowed ?? false;
  } catch (err) {
    logger.error({ err, featureKey }, "[featureAccess] resolution failed — denying");
    return false;
  }
}

/**
 * Always `null` in this plan — every feature here is boolean. Plan 2 populates
 * it for metered rows. Present now so call sites and the wire format do not
 * change shape when it does.
 */
export async function limitFor(_principal: Principal, _featureKey: FeatureKey): Promise<number | null> {
  return null;
}

/** The wire format. `res.json()` serializes a native Map as `{}`. */
export function toWireEntitlements(entitlements: EntitlementMap): Record<string, Entitlement> {
  const out: Record<string, Entitlement> = {};
  for (const [key, value] of entitlements) out[key] = value;
  return out;
}

// ── The authorization snapshot for queued work ───────────────────────────────

/**
 * What authorized a piece of queued work, resolved at SUBMISSION time.
 *
 * Persisting only the principal would not be enough: calling `can()` again at
 * execution time resolves against whatever the grid says *then*, which is the
 * opposite of "authorized as of submission". So the resolved boolean DECISION
 * for each feature that job type gates travels with the job, and the background
 * path reads it rather than re-resolving.
 *
 * Accepted consequence, deliberately: a feature revoked while a job is in
 * flight still completes that one job.
 */
export interface AuthorizationSnapshot {
  tier: string;
  isAdmin: boolean;
  decisions: Record<string, boolean>;
  resolvedAt: string;
  /**
   * Only ever set by the backfill in migration 0099, for rows created before
   * this column existed. A live writer emitting this would be defeating the
   * column's purpose.
   */
  predatesPlan?: boolean;
}

export function buildAuthorizationSnapshot(
  principal: Principal,
  decisions: Record<string, boolean>,
): AuthorizationSnapshot {
  return {
    tier: principal.tier,
    isAdmin: principal.isAdmin,
    decisions,
    resolvedAt: new Date().toISOString(),
  };
}

/**
 * Reads one decision back out of a persisted snapshot. Fails closed: a row that
 * predates the column, a malformed snapshot, or a key the snapshot never
 * recorded all deny rather than falling back to a fresh resolution — falling
 * back is exactly the re-derivation this mechanism exists to prevent.
 */
export function decisionFromSnapshot(
  snapshot: unknown,
  featureKey: FeatureKey,
): boolean {
  if (typeof snapshot !== "object" || snapshot === null) return false;
  const decisions = (snapshot as AuthorizationSnapshot).decisions;
  if (typeof decisions !== "object" || decisions === null) return false;
  return decisions[featureKey] === true;
}

// ── Middleware ───────────────────────────────────────────────────────────────

export interface RequireFeatureOptions {
  /** Preserves each gate's existing client-facing error code. */
  errorCode?: string;
  message?: string;
  /** Set when the capability additionally requires being signed in. */
  requireAuth?: boolean;
}

/**
 * Express gate. The read gate and the write gate must be ONE expression
 * evaluated once — a control rendered from one check and validated by another
 * is precisely PR #402's shape.
 */
export function requireFeature(featureKey: FeatureKey, options: RequireFeatureOptions = {}) {
  const { errorCode = "feature_not_entitled", message, requireAuth = true } = options;

  return async function featureMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
    if (requireAuth && !req.isAuthenticated()) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const allowed = await can(principalFromRequest(req), featureKey);
    if (!allowed) {
      res.status(403).json({ error: errorCode, ...(message ? { message } : {}), feature: featureKey });
      return;
    }
    next();
  };
}

// ── The grid editor's read/write surface ─────────────────────────────────────
// Reads and writes for the admin console live here too, because this module is
// the only code permitted to touch the grid tables.

export async function getAllTierFeatureMatrix(): Promise<{
  features: Array<{ key: string; displayName: string; description: string | null }>;
  permissions: Array<{ tier: string; featureKey: string; enabled: boolean }>;
}> {
  const [features, permissions] = await Promise.all([
    db.select().from(featureFlagsTable).orderBy(featureFlagsTable.key),
    db.select().from(tierFeaturePermissionsTable).orderBy(tierFeaturePermissionsTable.tier),
  ]);

  return {
    features: features.map((f) => ({
      key: f.key,
      displayName: f.displayName,
      description: f.description ?? null,
    })),
    permissions: permissions.map((p) => ({
      tier: p.tier,
      featureKey: p.featureKey,
      enabled: p.enabled,
    })),
  };
}

export class UnknownTierError extends Error {}
export class UnknownFeatureError extends Error {}

/**
 * The single sanctioned grid write.
 *
 * Three things happen in ONE transaction: the cell change, the audit row, and
 * the revision bump. The prior value is read under a row lock (`FOR UPDATE`)
 * before being recorded, so two concurrent edits to the same cell produce two
 * honest transitions rather than both recording the same stale "before". A
 * failed write produces no audit row.
 *
 * Validation is server-side because the API is reachable directly; a
 * client-side constraint is not a control. `setTierFeature` previously accepted
 * any string as a tier, which silently wrote rows no resolver would ever read.
 *
 * Making this the ONLY possible write path — triggers, SECURITY DEFINER
 * functions, revoked privileges, the ownership runbook — is Plan 1b's scope
 * (PR #422). Until it ships this holds by convention.
 */
export async function setTierFeature(
  tier: string,
  featureKey: string,
  enabled: boolean,
  actorId: string | null,
): Promise<{ enabledBefore: boolean | null; gridRevision: number }> {
  if (!isGridTier(tier)) {
    throw new UnknownTierError(`Unknown tier: ${tier}`);
  }

  const result = await db.transaction(async (tx) => {
    const [feature] = await tx
      .select({ key: featureFlagsTable.key })
      .from(featureFlagsTable)
      .where(eq(featureFlagsTable.key, featureKey))
      .limit(1);
    if (!feature) {
      throw new UnknownFeatureError(`Unknown feature: ${featureKey}`);
    }

    // Row-locked read of the prior value — see the concurrency note above.
    const { rows: priorRows } = await tx.execute<{ enabled: boolean }>(sql`
      SELECT enabled FROM tier_feature_permissions
      WHERE tier = ${tier} AND feature_key = ${featureKey}
      FOR UPDATE
    `);
    const enabledBefore = priorRows.length > 0 ? !!priorRows[0].enabled : null;

    await tx
      .insert(tierFeaturePermissionsTable)
      .values({ tier, featureKey, enabled })
      .onConflictDoUpdate({
        target: [tierFeaturePermissionsTable.tier, tierFeaturePermissionsTable.featureKey],
        set: { enabled, updatedAt: new Date() },
      });

    await tx.insert(tierFeaturePermissionAuditTable).values({
      actorId,
      tier,
      featureKey,
      enabledBefore,
      enabledAfter: enabled,
    });

    const { rows: revisionRows } = await tx.execute<{ revision: string | number }>(sql`
      UPDATE entitlement_grid_revision SET revision = revision + 1 WHERE id = 1 RETURNING revision
    `);

    return {
      enabledBefore,
      gridRevision: Number(revisionRows[0]?.revision ?? 0),
    };
  });

  // Bust in the writing process so an operator toggling a cell sees it take
  // effect immediately here; other processes converge within the cache TTL.
  bustEntitlementCache();
  return result;
}

/** The current grid revision, without resolving anything. */
export async function getGridRevision(): Promise<number> {
  const snap = await loadSnapshot();
  return snap.gridRevision;
}

// ── Test seams ───────────────────────────────────────────────────────────────

/** Integration tests reach past the TTL rather than sleeping through it. */
export function _resetEntitlementCacheForTest(): void {
  bustEntitlementCache();
}

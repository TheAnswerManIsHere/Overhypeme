/**
 * Budget Gate
 *
 * Pre-generation budget check and post-generation cost ledger recording.
 * All limits come from the admin_config table, never from hardcoded values.
 *
 * `checkBudget` FAILS CLOSED: if the check itself cannot complete, it throws
 * `BudgetGateError` rather than granting the generation. It previously
 * returned `{ allowed: true, limit: Infinity }` on any internal error, which
 * lifted the spend ceiling for the duration of a database hiccup and made it
 * the only permission function in this codebase that failed open (#409).
 */

import { db } from "@workspace/db";
import { userGenerationCostsTable, usersTable } from "@workspace/db/schema";
import { eq, sql } from "drizzle-orm";
import { getConfigStringWithSource, getConfigFloatWithSource } from "./adminConfig";
import { logger } from "./logger";
import { effectiveTierExpr } from "./membershipState";
import { isRealAdminRow } from "./adminIdentity";

export interface BudgetStatus {
  allowed: boolean;
  currentSpend: number;
  limit: number;
  remainingBudget: number;
}

/**
 * Thrown when a generation job would exceed the user's period budget.
 * Catch this in route handlers to return HTTP 429.
 */
export class BudgetExceededError extends Error {
  public readonly budgetStatus: BudgetStatus;
  public readonly upgradePath: string;
  constructor(status: BudgetStatus, upgradePath = "/upgrade") {
    super("BUDGET_EXCEEDED");
    this.name = "BudgetExceededError";
    this.budgetStatus = status;
    this.upgradePath = upgradePath;
  }
}

/**
 * Thrown when the budget check itself could not complete — a config read,
 * tier lookup, or ledger sum failed.
 *
 * This is NOT "you are out of budget"; it means we could not determine
 * whether you are. Callers must deny the generation and surface a retry-able
 * error, and must never conflate it with `BudgetExceededError`, which is a
 * definitive over-limit answer that should send the user to the upgrade path.
 *
 * The message is deliberately user-safe and carries no internals: it reaches
 * end users verbatim through the async job paths, which surface `err.message`
 * as the failure reason. The underlying error travels in `cause` for logs.
 */
export class BudgetGateError extends Error {
  constructor(cause: unknown) {
    super("Budget check unavailable. Please try again.", { cause });
    this.name = "BudgetGateError";
  }
}

export interface RecordCostParams {
  userId: string;
  jobType: "image" | "video";
  endpointId: string;
  unitPriceAtCreation: number;
  billingUnits: number;
  computedCostUsd: number;
  pricingFetchedAt: Date;
  jobReferenceId?: string | null;
}

/** Resolve the start-of-period date based on budget_period config. */
function getPeriodStart(budgetPeriod: string): Date {
  if (budgetPeriod === "rolling_30d") {
    return new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  }
  // "monthly" — first day of current month at midnight UTC
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
}

/**
 * Check whether a user has budget remaining for a proposed generation cost.
 *
 * Fails CLOSED: throws `BudgetGateError` if the check cannot complete.
 * Determining spend is a precondition for spending money, so a gate that
 * cannot answer denies rather than grants.
 */
export async function checkBudget(
  userId: string,
  proposedCostUsd: number,
): Promise<BudgetStatus> {
  try {
    // Look up user tier and per-user override
    const [user] = await db
      // Effective tier: this decides which SPENDING limit applies, from its
      // own select, so it bypasses the authMiddleware chokepoint too.
      .select({
        id: usersTable.id,
        email: usersTable.email,
        membershipTier: effectiveTierExpr(),
        isAdmin: usersTable.isAdmin,
        monthlyGenerationLimitOverrideUsd: usersTable.monthlyGenerationLimitOverrideUsd,
      })
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .limit(1);

    const tier = user?.membershipTier ?? "unregistered";
    // The canonical three-mechanism check, not the raw column — an env- or
    // bootstrap-granted admin (no `is_admin` row) was silently paying like a
    // regular user. Round 2 of PR #425's review caught this.
    const isAdmin = !!user && isRealAdminRow(user);

    // Admins are exempt from budget limits — resolved before any config read,
    // so a transient config-read failure never denies an admin who doesn't
    // need the limit at all.
    if (isAdmin) {
      return { allowed: true, currentSpend: 0, limit: Infinity, remainingBudget: Infinity };
    }

    // Fetch config values WITH provenance: `fallback_default` means the read
    // itself failed, not that the key is legitimately unset. A non-admin's
    // limit must come from a real read or a real intentional default — never
    // silently from the emergency code default, which could be far more
    // permissive than what the operator actually configured (#409 round 1).
    const [budgetPeriodRes, registeredLimitRes, legendaryLimitRes] = await Promise.all([
      getConfigStringWithSource("budget_period", "monthly"),
      getConfigFloatWithSource("budget_limit_registered_usd", 0.50),
      getConfigFloatWithSource("budget_limit_legendary_usd", 10.00),
    ]);
    for (const res of [budgetPeriodRes, registeredLimitRes, legendaryLimitRes]) {
      if (res.source === "fallback_default") {
        throw new Error(`admin_config read failed while resolving budget limits for user ${userId}`);
      }
    }
    const budgetPeriod = budgetPeriodRes.value;
    const registeredLimitStr = registeredLimitRes.value;
    const legendaryLimitStr = legendaryLimitRes.value;

    const globalLimit = tier === "legendary" ? legendaryLimitStr : registeredLimitStr;
    const perUserOverride = user?.monthlyGenerationLimitOverrideUsd != null
      ? parseFloat(String(user.monthlyGenerationLimitOverrideUsd))
      : null;
    const limit = (perUserOverride !== null && !isNaN(perUserOverride))
      ? perUserOverride
      : globalLimit;
    const periodStart = getPeriodStart(budgetPeriod);

    // Sum spend for this user in the current period
    const [{ total }] = await db
      .select({ total: sql<string>`COALESCE(SUM(${userGenerationCostsTable.computedCostUsd}), 0)` })
      .from(userGenerationCostsTable)
      .where(
        sql`${userGenerationCostsTable.userId} = ${userId}
         AND ${userGenerationCostsTable.createdAt} >= ${periodStart.toISOString()}`,
      );

    const currentSpend = parseFloat(total ?? "0");
    const remainingBudget = Math.max(0, limit - currentSpend);
    const allowed = currentSpend + proposedCostUsd <= limit;

    return { allowed, currentSpend, limit, remainingBudget };
  } catch (err) {
    // Fail closed (#409). A gate that cannot determine spend must not grant it.
    logger.error({ err, userId }, "[budgetGate] checkBudget failed — denying generation");
    throw new BudgetGateError(err);
  }
}

/**
 * Record a completed generation job's cost into the ledger.
 * Call this AFTER successful fal.ai submission — not before.
 * Never throws.
 */
export async function recordCost(params: RecordCostParams): Promise<void> {
  try {
    await db.insert(userGenerationCostsTable).values({
      userId: params.userId,
      jobType: params.jobType,
      endpointId: params.endpointId,
      unitPriceAtCreation: String(params.unitPriceAtCreation),
      billingUnits: String(params.billingUnits),
      computedCostUsd: String(params.computedCostUsd),
      pricingFetchedAt: params.pricingFetchedAt,
      jobReferenceId: params.jobReferenceId ?? null,
    });
  } catch (err) {
    logger.warn({ err }, "[budgetGate] recordCost failed (non-fatal)");
  }
}

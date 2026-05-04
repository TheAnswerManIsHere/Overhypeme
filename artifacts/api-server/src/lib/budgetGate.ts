/**
 * Budget Gate
 *
 * Pre-generation budget check and post-generation cost ledger recording.
 * Never throws — the caller decides how to handle a denied request.
 * All limits come from the admin_config table, never from hardcoded values.
 */

import { db } from "@workspace/db";
import { userGenerationCostsTable, usersTable } from "@workspace/db/schema";
import { eq, sql } from "drizzle-orm";
import { getConfigString, getConfigFloat } from "./adminConfig";
import { logger } from "./logger";

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
 * Returns a BudgetStatus object — never throws.
 * On any error, fails open (allowed: true) with a warning so a DB hiccup
 * doesn't block all generation.
 */
export async function checkBudget(
  userId: string,
  proposedCostUsd: number,
): Promise<BudgetStatus> {
  try {
    // Fetch config values
    const [budgetPeriod, registeredLimitStr, legendaryLimitStr] = await Promise.all([
      getConfigString("budget_period", "monthly"),
      getConfigFloat("budget_limit_registered_usd", 0.50),
      getConfigFloat("budget_limit_legendary_usd", 10.00),
    ]);

    // Look up user tier and per-user override
    const [user] = await db
      .select({ membershipTier: usersTable.membershipTier, isAdmin: usersTable.isAdmin, monthlyGenerationLimitOverrideUsd: usersTable.monthlyGenerationLimitOverrideUsd })
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .limit(1);

    const tier = user?.membershipTier ?? "unregistered";
    const isAdmin = user?.isAdmin ?? false;

    // Admins are exempt from budget limits
    if (isAdmin) {
      return { allowed: true, currentSpend: 0, limit: Infinity, remainingBudget: Infinity };
    }

    const globalLimit = tier === "legendary" ? legendaryLimitStr : registeredLimitStr;
    const perUserOverride = user?.monthlyGenerationLimitOverrideUsd != null
      ? parseFloat(String(user.monthlyGenerationLimitOverrideUsd))
      : null;
    const limit = (perUserOverride !== null && !isNaN(perUserOverride))
      ? perUserOverride
      : globalLimit;
    const periodStart = getPeriodStart(budgetPeriod as string);

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
    logger.warn({ err }, "[budgetGate] checkBudget error — failing open");
    // Fail open: don't block generation if the gate itself errors
    return { allowed: true, currentSpend: 0, limit: Infinity, remainingBudget: Infinity };
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

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
import { getConfigStringWithSource } from "./adminConfig";
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
  /**
   * Cost provenance, REQUIRED — deliberately not optional and deliberately not
   * defaulted. Every call site knows which branch produced its figure, and a
   * default would silently record the wrong provenance for whichever site
   * forgot to pass it. `false` = derived from fal's published rate; `true` =
   * derived from an operator-configured estimate or a hard-coded fallback.
   *
   * NOT measured-vs-estimated: no row here holds an actual provider charge.
   */
  isEstimated: boolean;
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
 * Resolve a numeric budget limit via `getConfigStringWithSource`, throwing
 * when the read itself failed rather than silently substituting the code
 * default. Private to this module — not a new export, per the round-3
 * finding that `getConfigFloatWithSource` was itself a Tier C new-abstraction
 * trigger despite mirroring an existing pattern.
 *
 * A non-numeric stored value degrades to `defaultValue` exactly as
 * `getConfigFloat` always has — that is a corrupted row, not a failed read,
 * and preserving that existing behavior is deliberate, not an omission.
 */
async function resolveBudgetFloat(
  key: string,
  defaultValue: number,
  userId: string,
): Promise<number> {
  const res = await getConfigStringWithSource(key, String(defaultValue));
  if (res.source === "fallback_default") {
    throw new Error(`admin_config read failed while resolving ${key} for user ${userId}`);
  }
  const parsed = parseFloat(res.value);
  return isNaN(parsed) ? defaultValue : parsed;
}

/**
 * Check whether a user has budget remaining for a proposed generation cost.
 *
 * Fails CLOSED: throws `BudgetGateError` if the check cannot complete.
 * Determining spend is a precondition for spending money, so a gate that
 * cannot answer denies rather than grants.
 *
 * `proposedCost` may be a number or a thunk. Pass a THUNK when determining the
 * cost is itself expensive or fallible — it is invoked only after the admin
 * exemption, so an exempt admin never triggers a lookup their request does not
 * need, and a failure in that lookup cannot deny them. A thunk that throws is
 * caught by this function's own handler and surfaces as `BudgetGateError`,
 * which is the correct classification: the cost could not be determined, so
 * the check could not complete. That is NOT the same as being over limit, and
 * callers must keep treating the two differently (#409).
 */
export async function checkBudget(
  userId: string,
  proposedCost: number | (() => Promise<number>),
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

    // Resolve the proposed cost only now, AFTER the exemption. A caller whose
    // cost is itself expensive or fallible to determine passes a thunk rather
    // than a number, so an exempt admin never pays for — or gets denied by —
    // a lookup their request does not need. Round 4 of PR #474's review caught
    // the eager form: `checkBudget(userId, await resolveCost())` evaluates its
    // argument before this function is entered, so a throwing resolver
    // preempted the exemption above and rejected admins outright.
    const proposedCostUsd = typeof proposedCost === "function" ? await proposedCost() : proposedCost;

    // Fetch config values WITH provenance: `fallback_default` means the read
    // itself failed, not that the key is legitimately unset. A non-admin's
    // limit must come from a real read or a real intentional default — never
    // silently from the emergency code default, which could be far more
    // permissive than what the operator actually configured (#409 round 1).
    // `resolveBudgetFloat` reuses the existing `getConfigStringWithSource`
    // rather than adding a float-typed sibling export — a new abstraction is
    // a Tier C trigger regardless of how closely it mirrors an existing one
    // (#409 round 3, the same class of finding as `gateGeneration`).
    const [budgetPeriodRes, registeredLimit, legendaryLimit] = await Promise.all([
      getConfigStringWithSource("budget_period", "monthly"),
      resolveBudgetFloat("budget_limit_registered_usd", 0.50, userId),
      resolveBudgetFloat("budget_limit_legendary_usd", 10.00, userId),
    ]);
    if (budgetPeriodRes.source === "fallback_default") {
      throw new Error(`admin_config read failed while resolving budget_period for user ${userId}`);
    }
    const budgetPeriod = budgetPeriodRes.value;
    const registeredLimitStr = registeredLimit;
    const legendaryLimitStr = legendaryLimit;

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
 * Call this AFTER a successful fal.ai call — not before.
 * Never throws: it runs after the provider has already been paid, so failing
 * the user's generation here would punish them for our bookkeeping.
 *
 * A swallowed failure is NOT harmless, and the plan is explicit that this is
 * accepted rather than solved (David, 2026-08-17): the enforcement SUM stays
 * permanently low, so the ceiling is measured against an understated total from
 * that moment on. `noteLedgerWriteFailure` is what makes that visible instead
 * of silent — it does not make it correct.
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
      isEstimated: params.isEstimated,
    });
  } catch (err) {
    logger.warn(
      { err, userId: params.userId, jobType: params.jobType, endpointId: params.endpointId },
      "[budgetGate] recordCost failed (non-fatal) — this user's recorded spend is now permanently understated",
    );
    // NOT awaited. The bounds inside `noteLedgerWriteFailure` cover the SQL,
    // but `db.transaction` first waits for a client from the shared pool, and
    // that pool sets no `connectionTimeoutMillis` — so under saturation the
    // checkout queues with no deadline and none of the SQL-level timeouts have
    // been installed yet. Awaiting it can therefore still delay a response
    // whose provider has already completed and been paid.
    //
    // Detaching is the right bound rather than a JS-side race on the whole
    // call: abandoning a pending `pool.connect()` does not cancel it, so the
    // client is still acquired and would have to be released by someone —
    // racing it leaks a connection instead of freeing one.
    //
    // Raising `connectionTimeoutMillis` on the pool would also fix this, and is
    // deliberately not done here: that pool serves every query in the process,
    // so bounding checkout globally is a real behaviour change for unrelated
    // paths and deserves its own consideration rather than riding along with a
    // diagnostic counter.
    //
    // Losing the counter write at process exit is acceptable and already
    // documented below: the structured log line above is the floor.
    void noteLedgerWriteFailure();
  }
}

/**
 * Record that a ledger write was lost, so a human can see it without reading
 * logs. Counter plus most-recent timestamp in `admin_config`; deliberately not
 * a per-failure table, because an unbounded second write path on a database
 * that is already failing makes things worse rather than better.
 *
 * ITS OWN FAILURE IS EXPECTED AND ACCEPTED. If `recordCost`'s insert failed
 * because the database is unavailable, this write fails for the same reason —
 * so the structured log line above is the floor and this counter is a
 * best-effort improvement on it. Specifying a signal that survives its own
 * dependency's outage would produce an implementation that quietly doesn't.
 *
 * What it does catch is the quiet case: a constraint violation, a
 * serialization failure, one lost insert against an otherwise-healthy database
 * — where nothing else is on fire and no other alarm would ever sound. A total
 * outage is already loud through every failing request.
 *
 * Also incremented when an admin-path estimate lookup fails and the row is
 * skipped (see aiMemePipeline), which is the other way a generation can end up
 * unrecorded.
 */
export async function noteLedgerWriteFailure(): Promise<void> {
  try {
    // ONE statement, in ONE transaction, under a hard database-side time bound.
    //
    // Both keys are single rows that every concurrent failure contends for, and
    // this runs on the synchronous path of a request whose provider has already
    // been paid. Two things follow, and neither is optional:
    //
    //  * The two upserts are one multi-row statement rather than two round
    //    trips. Concurrent callers therefore lock the two rows in the same
    //    order (VALUES order), so a burst serialises instead of deadlocking,
    //    and a failure costs one round trip rather than two.
    //  * `lock_timeout` / `statement_timeout` bound the wait *in Postgres*.
    //    A JS-side race on the SQL would not help: it abandons the promise
    //    while the connection stays blocked, so the pool — the resource
    //    actually under pressure — is still consumed. `SET LOCAL` reverts at
    //    commit, so neither setting leaks onto the pooled connection.
    //
    // These bound the SQL only. They cannot bound the pool checkout that
    // `db.transaction` performs first, which is why `recordCost` detaches this
    // call rather than awaiting it — see the comment at that call site.
    //
    // The bound is short on purpose. This counter is a diagnostic; a user's
    // response must not wait seconds on it while the database is already
    // struggling. Timing out here lands in the catch below, which is the
    // documented expected outcome, not a new failure mode.
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL lock_timeout = '500ms'`);
      await tx.execute(sql`SET LOCAL statement_timeout = '2s'`);
      await tx.execute(sql`
        INSERT INTO admin_config (key, value, data_type, label, description, min_value, is_public)
        VALUES
          -- 'integer', not 'number'. The /admin/config PATCH route validates
          -- 'integer' and 'float' and has NO else branch, so an unrecognised
          -- data_type silently skips validation entirely and the row accepts
          -- arbitrary text through the generic config UI. One decimal or one
          -- stray character then fails the ::bigint cast below, rolling back
          -- both keys — permanently disabling the very signal this exists to
          -- preserve. min_value 0 additionally refuses a negative count.
          ('ledger_write_failures', '1', 'integer',
           'Lost ledger writes',
           'Count of generation-cost rows that could not be written. Each one permanently understates that user''s recorded spend, so the ceiling binds against a low total. Non-zero warrants investigation.',
           0, false),
          ('ledger_write_failure_last_at', now()::text, 'string',
           'Last lost ledger write',
           'Timestamp of the most recent generation-cost row that could not be written.',
           NULL, false)
        ON CONFLICT (key) DO UPDATE
          SET value = CASE admin_config.key
            WHEN 'ledger_write_failures'
              -- Total, not merely null-safe. A non-numeric value here would
              -- fail the cast and roll the whole statement back on every
              -- subsequent failure — the counter would be permanently dead,
              -- and silently, since this function swallows its own errors.
              -- Validating at the admin edge (above) does not cover a value
              -- that arrived any other way, so the increment refuses to depend
              -- on it: anything non-numeric restarts from zero rather than
              -- taking the signal down with it.
              THEN (CASE WHEN admin_config.value ~ '^[0-9]+$'
                         THEN admin_config.value::bigint ELSE 0 END + 1)::text
            ELSE now()::text
          END,
          -- Self-healing: repairs the metadata on a row created by an earlier
          -- build of this code, which ON CONFLICT would otherwise leave at its
          -- original unvalidated data_type forever.
          data_type = EXCLUDED.data_type,
          min_value = EXCLUDED.min_value
      `);
    });
  } catch (err) {
    // The floor. See the doc comment: this failing is an expected outcome of
    // the failure it reports, not a defect to guard against.
    logger.warn({ err }, "[budgetGate] could not record the ledger-write failure counter");
  }
}

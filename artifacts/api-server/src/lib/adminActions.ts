/**
 * @purpose Write one admin-action record (plan PLAN_FACT_LIFECYCLE_REBUILD.md 1I and 3C).
 * @subsystem moderation
 *
 * Every admin mutation of a fact or a review records who did what, and enough
 * detail to read what changed. Pass the mutation's own transaction when it has
 * one, so the record commits or rolls back with the change it describes; a
 * failure then fails the change. A route whose change commits inside a helper
 * records right after that helper returns, without a transaction: the change
 * has already happened, so a failed record is logged and swallowed rather than
 * turned into an error for a change that did commit, or allowed to skip the
 * work after it (PR #1033's build report). A triage action names the review
 * only, since no fact exists yet.
 */
import { db, adminActionsTable } from "@workspace/db";
import { logger } from "./logger";
import type { AdminAction } from "@workspace/api-zod";
import type { Executor } from "./visualConceptOwner";

export type AdminActionTarget =
  | { factId: number; reviewId?: number | null }
  | { factId?: number | null; reviewId: number };

export interface AdminActionRecord {
  target: AdminActionTarget;
  actorId: string | null | undefined;
  action: AdminAction;
  detail?: Record<string, unknown>;
}

/**
 * Several records in one statement (a bulk action: an import, a Taxonomy
 * Health run). With an executor the insert joins that transaction and throws
 * on failure; without one it runs after the change committed and only logs.
 */
export async function recordAdminActions(records: AdminActionRecord[], executor?: Executor): Promise<void> {
  if (records.length === 0) return;
  const rows = records.map((r) => ({
    factId: r.target.factId ?? null,
    reviewId: r.target.reviewId ?? null,
    actorId: r.actorId ?? null,
    action: r.action,
    detail: r.detail ?? {},
  }));
  if (executor) { await executor.insert(adminActionsTable).values(rows); return; }
  try {
    await db.insert(adminActionsTable).values(rows);
  } catch (err) {
    logger.error({ err, actions: records.map((r) => r.action), targets: records.map((r) => r.target) }, "[admin-actions] could not record an action after its change committed");
  }
}

export async function recordAdminAction(
  target: AdminActionTarget,
  actorId: string | null | undefined,
  action: AdminAction,
  detail: Record<string, unknown> = {},
  executor?: Executor,
): Promise<void> {
  await recordAdminActions([{ target, actorId, action, detail }], executor);
}

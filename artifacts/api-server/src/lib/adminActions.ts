/**
 * @purpose Write one admin-action record (plan PLAN_FACT_LIFECYCLE_REBUILD.md 1I and 3C).
 * @subsystem moderation
 *
 * Every admin mutation of a fact or a review records who did what, and enough
 * detail to read what changed. Pass the mutation's own transaction when it has
 * one, so the record commits or rolls back with the change it describes; a
 * route whose change commits inside a helper records right after that helper
 * returns successfully. A triage action names the review only, since no fact
 * exists yet.
 */
import { db, adminActionsTable } from "@workspace/db";
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

/** Several records in one statement (a bulk action: an import, a Taxonomy Health run). */
export async function recordAdminActions(records: AdminActionRecord[], executor: Executor = db): Promise<void> {
  if (records.length === 0) return;
  await executor.insert(adminActionsTable).values(records.map((r) => ({
    factId: r.target.factId ?? null,
    reviewId: r.target.reviewId ?? null,
    actorId: r.actorId ?? null,
    action: r.action,
    detail: r.detail ?? {},
  })));
}

export async function recordAdminAction(
  target: AdminActionTarget,
  actorId: string | null | undefined,
  action: AdminAction,
  detail: Record<string, unknown> = {},
  executor: Executor = db,
): Promise<void> {
  await recordAdminActions([{ target, actorId, action, detail }], executor);
}

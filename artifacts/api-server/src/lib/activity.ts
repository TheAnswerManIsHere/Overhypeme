/**
 * Helper to log entries to the activity_feed table.
 * Writes are best-effort: an error is logged and swallowed, never thrown. Each
 * caller chooses whether to await the insert or fire and forget it.
 *
 * @purpose logActivity and the ActivityType union for the per-user activity feed; a best-effort write that logs and swallows errors and never throws, which callers either await or fire and forget.
 * @subsystem community
 */
import { db } from "@workspace/db";
import { activityFeedTable } from "@workspace/db/schema";
import { logger } from "./logger";

export type ActivityType =
  | "fact_submitted"
  | "fact_approved"
  | "duplicate_flagged"
  | "review_submitted"
  | "review_approved"
  | "review_rejected"
  | "comment_posted"
  | "comment_approved"
  | "comment_rejected"
  | "vote_cast"
  | "system_message";

export interface LogActivityOptions {
  userId: string;
  actionType: ActivityType;
  message: string;
  metadata?: Record<string, unknown>;
}

export async function logActivity(opts: LogActivityOptions): Promise<void> {
  try {
    await db.insert(activityFeedTable).values({
      userId: opts.userId,
      actionType: opts.actionType,
      message: opts.message,
      metadata: opts.metadata,
    });
  } catch (err) {
    logger.error({ err }, "[activity] Failed to log activity");
  }
}

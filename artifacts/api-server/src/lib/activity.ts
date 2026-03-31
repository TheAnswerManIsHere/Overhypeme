/**
 * Helper to log entries to the activity_feed table.
 * All writes are fire-and-forget — errors are logged but never surface to callers.
 */
import { db } from "@workspace/db";
import { activityFeedTable } from "@workspace/db/schema";

export type ActivityType =
  | "fact_submitted"
  | "fact_approved"
  | "duplicate_flagged"
  | "review_submitted"
  | "review_approved"
  | "review_rejected"
  | "comment_posted"
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
    console.error("[activity] Failed to log activity:", err);
  }
}

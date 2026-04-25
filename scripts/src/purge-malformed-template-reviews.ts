/**
 * One-time cleanup: deletes all pending_reviews rows where
 *   reason = 'malformed_template' AND status = 'pending'
 *
 * These records were created before the "Malformed Template" review path was
 * removed. They now appear in the admin moderation queue without a recognisable
 * reason badge, causing confusion. Purging them keeps the queue clean.
 *
 * Run with:
 *   pnpm --filter @workspace/scripts exec tsx src/purge-malformed-template-reviews.ts
 */

import { db } from "@workspace/db";
import { pendingReviewsTable } from "@workspace/db/schema";
import { and, eq } from "drizzle-orm";

async function main() {
  const deleted = await db
    .delete(pendingReviewsTable)
    .where(
      and(
        eq(pendingReviewsTable.reason, "malformed_template"),
        eq(pendingReviewsTable.status, "pending"),
      ),
    )
    .returning({ id: pendingReviewsTable.id });

  console.log(`Deleted ${deleted.length} malformed-template pending review(s).`);
  if (deleted.length > 0) {
    console.log("Deleted IDs:", deleted.map((r) => r.id).join(", "));
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Error purging malformed-template reviews:", err);
    process.exit(1);
  });

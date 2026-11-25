/**
 * @purpose When every render approval began to be recorded with its pick: the boundary the render history reads to tell "Not approved" from "Approval history not recorded".
 * @subsystem visual-pipeline
 *
 * Plan docs/plans/PLAN_RENDER_HISTORY.md D4 and D8 (Issue #1304; David, Q51;
 * Astra C1). Before this release, an approval's record was written after the
 * pick committed and a failed write was logged and swallowed, so a render
 * drawn then with no record may still have been approved. From this release
 * the record is written in the pick's own transaction.
 *
 * A migration's time cannot mark that: the previous release keeps serving
 * after migrations run and before promotion (docs/engineering/
 * deploy-and-rollback.md, steps 6 and "What a publish does to work in
 * flight"). So this release sets the boundary itself, the first time it
 * boots, at its boot time plus a margin of one hour. Promotion follows the
 * boot by the startup health check and the old process gets ten seconds to
 * finish, so an hour covers the overlap with room to spare. Set once and never
 * moved: a later boot leaves it. A render drawn before the boundary with no
 * approval evidence reads "Approval history not recorded".
 *
 * Stored in admin_config, kept off the settings page and refused there.
 */
import { eq } from "drizzle-orm";
import { db, adminConfigTable } from "@workspace/db";
import { logger } from "./logger";
import type { Executor } from "./visualConceptOwner";

export const RENDER_APPROVAL_AUDIT_KEY = "render_approval_audit_complete_since";

/** The margin past this release's first boot (see the header). */
export const RENDER_APPROVAL_AUDIT_MARGIN_MS = 60 * 60 * 1000;

/** At boot: set the boundary if it is not set. Best-effort; a failure is logged and tried at the next boot. */
export async function markRenderApprovalAuditBoundary(now = new Date(), executor: Executor = db): Promise<void> {
  try {
    await executor.insert(adminConfigTable).values({
      key: RENDER_APPROVAL_AUDIT_KEY,
      value: new Date(now.getTime() + RENDER_APPROVAL_AUDIT_MARGIN_MS).toISOString(),
      dataType: "text",
      label: "Render approvals recorded with their pick since",
      description: "Set by the release that began recording every render approval in the pick's own transaction (Issue #1304). Not edited.",
    }).onConflictDoNothing();
  } catch (err) {
    logger.warn({ err }, "[render-approval-audit] could not set the boundary; the next boot tries again");
  }
}

/** The boundary, or null when it is not set yet (every render then reads "not recorded" when it has no evidence). */
export async function renderApprovalAuditBoundary(executor: Executor = db): Promise<Date | null> {
  const [row] = await executor.select({ value: adminConfigTable.value }).from(adminConfigTable)
    .where(eq(adminConfigTable.key, RENDER_APPROVAL_AUDIT_KEY)).limit(1);
  if (!row) return null;
  const at = new Date(row.value);
  return Number.isNaN(at.getTime()) ? null : at;
}

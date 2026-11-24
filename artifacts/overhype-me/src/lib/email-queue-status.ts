/**
 * @purpose The Email Queue's status wording (Issue #1212): a finished row that sent nothing on purpose reads as skipped, with its reason, never "Delivered".
 * @subsystem email
 */

/** The reasons the server sends for a skipped email row (`EMAIL_SKIP_REASONS`, api-server lib/queueHealth.ts). */
const SKIP_REASON_LABEL: Record<string, string> = {
  recipient_suspended: "Skipped — recipient suspended",
};

/** What a row's status badge says. */
export function emailQueueStatusLabel(row: { status: string; skipReason?: string | null }): string {
  if (row.status === "done" && row.skipReason) return SKIP_REASON_LABEL[row.skipReason] ?? "Skipped";
  return row.status;
}

/** Whether a row is a deliberate skip, which gets its own badge colour. */
export function isSkippedRow(row: { status: string; skipReason?: string | null }): boolean {
  return row.status === "done" && !!row.skipReason;
}

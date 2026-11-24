/**
 * @purpose The Email Queue's status wording (Issue #1212): a finished row that sent nothing on purpose reads as skipped, with its reason, never "Delivered".
 * @subsystem email
 */

/** The reasons the server sends for a skipped email row (`skipReasonOf`, api-server lib/queueHealth.ts). */
const SKIP_REASON_LABEL: Record<string, string> = {
  recipient_suspended: "Skipped — recipient suspended",
};

type Row = { status: string; skipReason?: string | null };

/** Whether a row is a deliberate skip, which gets its own badge colour. The server sets `skipReason` only on finished rows. */
export function isSkippedRow(row: Row): boolean {
  return !!row.skipReason;
}

/** What a row's status badge says. */
export function emailQueueStatusLabel(row: Row): string {
  return isSkippedRow(row) ? SKIP_REASON_LABEL[row.skipReason!] ?? "Skipped" : row.status;
}

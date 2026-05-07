/**
 * Quarantine helpers.
 *
 * Centralizes the side-effects every moderation reject must perform:
 *
 *   1. Persist the bytes into the `restricted/quarantine/{yyyy}/{mm}/{uuid}.{ext}`
 *      prefix (private ACL, blocked from `/storage/objects/*` and
 *      `/storage/public-objects/*`).
 *   2. INSERT a `quarantined_memes` row (audit trail).
 *   3. For Arachnid hits — and any other reportable signal — INSERT an
 *      `ncmec_reports` row via {@link submitNcmecReport}, which schedules
 *      90-day preservation and emails admins.
 *
 * Soft-delete only. Rows live forever in the DB; the bytes survive at least
 * `quarantine_evidence_retention_days` per `objectStorage.deleteObject`'s
 * restricted-prefix guard.
 */

import { randomUUID } from "node:crypto";
import { db } from "@workspace/db";
import { quarantinedMemesTable, type QuarantineSource } from "@workspace/db/schema";
import { ObjectStorageService } from "../objectStorage";
import { logger } from "../logger";
import { submitNcmecReport } from "./ncmec";
import type { ScanEvidence } from "./types";

const objectStorageService = new ObjectStorageService();

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

function pickExt(mimeType: string): string {
  const normalized = mimeType.split(";")[0]?.trim().toLowerCase() ?? "image/jpeg";
  return EXT_BY_MIME[normalized] ?? "bin";
}

function quarantineSubPath(ext: string): string {
  const now = new Date();
  const yyyy = now.getUTCFullYear().toString();
  const mm = (now.getUTCMonth() + 1).toString().padStart(2, "0");
  return `restricted/quarantine/${yyyy}/${mm}/${randomUUID()}.${ext}`;
}

export interface QuarantineImageInput {
  source: QuarantineSource;
  bytes: Buffer;
  mimeType: string;
  userId?: string | null;
  memeId?: number | null;
  evidence: ScanEvidence;
  /** When true (default for Arachnid), also writes an ncmec_reports row. */
  reportToNcmec?: boolean;
  /** Audit metadata persisted on the NCMEC row when applicable. */
  ncmecMetadata?: Record<string, unknown>;
}

export interface QuarantineImageResult {
  quarantineId: number;
  evidenceObjectPath: string;
  ncmecReportId?: number;
}

/**
 * Write the bytes to the restricted prefix, create the quarantine row, and
 * (when applicable) trigger an NCMEC stub. Throws on storage failure so the
 * caller can fail-closed and refuse the upload.
 */
export async function quarantineImage(input: QuarantineImageInput): Promise<QuarantineImageResult> {
  const ext = pickExt(input.mimeType);
  const subPath = quarantineSubPath(ext);

  await objectStorageService.uploadRestrictedObjectBuffer({
    subPath,
    buffer: input.bytes,
    contentType: input.mimeType,
  });

  const evidenceObjectPath = `/objects/${subPath}`;

  const [row] = await db
    .insert(quarantinedMemesTable)
    .values({
      memeId: input.memeId ?? null,
      userId: input.userId ?? null,
      evidenceObjectPath,
      source: input.source,
      matchType: input.evidence.matchType ?? null,
      classification: input.evidence.classification ?? null,
      classifierScore:
        input.evidence.classifierScore != null ? input.evidence.classifierScore.toFixed(4) : null,
      classifierModel: input.evidence.classifierModel ?? null,
      rawResponse: (input.evidence.raw ?? null) as object | null,
    })
    .returning({ id: quarantinedMemesTable.id });

  let ncmecReportId: number | undefined;
  const shouldReport = input.reportToNcmec ?? input.source === "arachnid";
  if (shouldReport) {
    try {
      const matchSource = input.source === "arachnid" ? "arachnid" : "classifier";
      const { id } = await submitNcmecReport({
        matchSource,
        evidenceUri: evidenceObjectPath,
        userId: input.userId ?? null,
        requestMetadata: {
          ...(input.ncmecMetadata ?? {}),
          source: input.source,
          classification: input.evidence.classification ?? null,
          matchType: input.evidence.matchType ?? null,
          classifierScore: input.evidence.classifierScore ?? null,
          classifierModel: input.evidence.classifierModel ?? null,
          quarantineId: row?.id,
        },
      });
      ncmecReportId = id;
    } catch (err) {
      // Don't let the report path block the upload rejection — the
      // quarantine row already preserves the evidence link.
      logger.error({ err, quarantineId: row?.id }, "[quarantine] NCMEC stub submission failed");
    }
  }

  return {
    quarantineId: row?.id ?? 0,
    evidenceObjectPath,
    ncmecReportId,
  };
}

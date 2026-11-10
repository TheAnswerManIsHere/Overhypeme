/**
 * @purpose The engine workbench's generated images, routed through the finishing step and our storage before an admin sees them (plan PLAN_IMAGE_TRACING.md, "The engine workbench"): every image URL in a completed fal result is downloaded, recorded, stamped and stored, and the result handed back names our stamped copy (an admin-only provenance image URL) in place of the vendor's. Idempotent per vendor request, so a repeated poll reuses the records it made.
 */
import { and, eq } from "drizzle-orm";
import { db, imageProvenanceTable, imageGenerationRequestsTable, type Engine } from "@workspace/db";
import { downloadToBuffer } from "../imageEngineRequest";
import { ObjectStorageService } from "../objectStorage";
import { finishImage, storedObjectPath, SYSTEM_ACTOR, type ProvenanceActor } from "./records";
import { sniffImage } from "./imageFile";

/** The admin-only URL that serves a record's stored picture. */
export function provenanceImageUrl(provenanceId: number): string {
  return `/api/admin/provenance/images/${provenanceId}`;
}

interface FoundUrl { holder: Record<string, unknown>; url: string }

/** Every `url` held under an image-shaped key (`images[]`, `image`) in a fal result. */
function imageUrls(value: unknown, underImage = false, out: FoundUrl[] = []): FoundUrl[] {
  if (Array.isArray(value)) {
    for (const v of value) imageUrls(v, underImage, out);
  } else if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (underImage && typeof obj["url"] === "string" && /^https?:\/\//.test(obj["url"] as string)) {
      out.push({ holder: obj, url: obj["url"] as string });
    }
    for (const [k, v] of Object.entries(obj)) {
      if (k === "url") continue;
      imageUrls(v, underImage || /image/i.test(k), out);
    }
  }
  return out;
}

export interface WorkbenchStorage {
  uploadObjectBuffer(args: { subPath: string; buffer: Buffer; contentType: string }): Promise<string>;
}

/**
 * The completed result with each vendor image replaced by our stamped,
 * recorded, stored copy. A result with no image (a classifier) is returned
 * unchanged.
 */
export async function finishWorkbenchResult(
  engine: Pick<Engine, "id" | "label">,
  vendorRequestId: string,
  falResult: unknown,
  deps: { storage?: WorkbenchStorage; download?: (url: string) => Promise<Buffer> } = {},
): Promise<unknown> {
  const result = structuredClone(falResult);
  const found = imageUrls(result);
  if (found.length === 0) return result;
  const storage = deps.storage ?? new ObjectStorageService();
  const download = deps.download ?? downloadToBuffer;

  const [request] = await db.select().from(imageGenerationRequestsTable)
    .where(and(
      eq(imageGenerationRequestsTable.vendorRequestId, vendorRequestId),
      eq(imageGenerationRequestsTable.producer, "engine_workbench"),
    )).limit(1);
  const actor: ProvenanceActor = request
    ? { kind: request.actorKind, userId: request.actorUserId, email: request.actorEmail }
    : SYSTEM_ACTOR;
  const existing = request
    ? await db.select({ id: imageProvenanceTable.id, snapshot: imageProvenanceTable.snapshot })
        .from(imageProvenanceTable)
        .where(and(eq(imageProvenanceTable.generationRequestId, request.id), eq(imageProvenanceTable.kind, "workbench")))
    : [];
  const byIndex = new Map(existing.map((r) => [(r.snapshot as { index?: number }).index, r.id]));

  for (let i = 0; i < found.length; i++) {
    const f = found[i]!;
    let provenanceId = byIndex.get(i);
    if (provenanceId === undefined) {
      const raw = await download(f.url);
      const subPath = `engine-workbench/${engine.id}/${vendorRequestId}-${i}.${sniffImage(raw).ext}`;
      const finished = await finishImage({
        bytes: raw,
        kind: "workbench",
        actor,
        stamp: true,
        stampEngine: engine.label,
        generationRequestId: request?.id ?? null,
        factId: request?.factId ?? null,
        engineId: engine.id,
        objectPath: storedObjectPath(subPath),
        snapshot: { index: i, vendorRequestId, requestCaptured: request != null },
      });
      await storage.uploadObjectBuffer({ subPath, buffer: finished.bytes, contentType: finished.mime });
      provenanceId = finished.provenanceId;
    }
    f.holder["url"] = provenanceImageUrl(provenanceId);
    f.holder["provenance_id"] = String(provenanceId);
  }
  return result;
}

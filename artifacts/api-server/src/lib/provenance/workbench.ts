/**
 * @purpose The engine workbench's generated images, routed through the finishing step and our storage before an admin sees them (plan PLAN_IMAGE_TRACING.md, "The engine workbench"): every image URL in a completed fal result is downloaded, recorded, stamped and stored, and the result handed back names our stamped copy (an admin-only provenance image URL) in place of the vendor's. Idempotent per vendor request, so a repeated poll reuses the records it made.
 */
import { and, eq } from "drizzle-orm";
import { vendorContext } from "./vendorContext";
import { db, imageProvenanceTable, imageGenerationRequestsTable, type Engine } from "@workspace/db";
import { downloadToBuffer } from "../imageEngineRequest";
import { ObjectStorageService, ObjectNotFoundError } from "../objectStorage";
import { actorOf, finishAndStore, SYSTEM_ACTOR, type ImageStore } from "./records";

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

/**
 * The completed result with each vendor image replaced by our stamped,
 * recorded, stored copy. A result with no image (a classifier) is returned
 * unchanged.
 */
export async function finishWorkbenchResult(
  engine: Pick<Engine, "id" | "label">,
  vendorRequestId: string,
  falResult: unknown,
  deps: {
    storage?: ImageStore;
    download?: (url: string) => Promise<Buffer>;
    /** Whether a stored object exists: a record is reused only when its picture was stored. */
    exists?: (objectPath: string) => Promise<boolean>;
  } = {},
): Promise<unknown> {
  const result = structuredClone(falResult);
  const found = imageUrls(result);
  if (found.length === 0) return result;
  const live = new ObjectStorageService();
  const storage = deps.storage ?? live;
  const exists = deps.exists ?? (async (objectPath: string) => {
    try {
      await live.getObjectEntityFile(objectPath);
      return true;
    } catch (err) {
      if (err instanceof ObjectNotFoundError) return false;
      throw err;
    }
  });
  const download = deps.download ?? downloadToBuffer;

  const [request] = await db.select().from(imageGenerationRequestsTable)
    .where(and(
      eq(imageGenerationRequestsTable.vendorRequestId, vendorRequestId),
      eq(imageGenerationRequestsTable.producer, "engine_workbench"),
    )).limit(1);
  const actor = request ? actorOf(request) : SYSTEM_ACTOR;
  const existing = request
    ? await db.select({ id: imageProvenanceTable.id, snapshot: imageProvenanceTable.snapshot, objectPath: imageProvenanceTable.objectPath })
        .from(imageProvenanceTable)
        .where(and(eq(imageProvenanceTable.generationRequestId, request.id), eq(imageProvenanceTable.kind, "workbench")))
    : [];
  // A repeated poll reuses a record only when its picture reached storage; a
  // store that failed after its record was committed is finished again (a new
  // record — the old one stays, naming a picture that was never stored).
  const byIndex = new Map<number, number>();
  for (const r of existing) {
    const index = (r.snapshot as { index?: number }).index;
    if (typeof index === "number" && r.objectPath && await exists(r.objectPath)) byIndex.set(index, r.id);
  }

  // What the vendor returned and a fingerprint of each reference the request named, shared by the run's pictures.
  // Read only when a picture still needs a record: a repeated poll whose pictures are all stored reads nothing.
  const context = found.some((_f, i) => !byIndex.has(i)) ? await vendorContext(request?.request ?? null, falResult) : {};
  for (let i = 0; i < found.length; i++) {
    const f = found[i]!;
    let provenanceId = byIndex.get(i);
    if (provenanceId === undefined) {
      const finished = await finishAndStore({
        store: storage,
        // Each store attempt has its own key (the store is write-once), so a
        // failed attempt's record and a retry's never name the same file.
        subPathFor: (ext) => `engine-workbench/${engine.id}/${vendorRequestId}-${i}-${Date.now()}.${ext}`,
        bytes: await download(f.url),
        kind: "workbench",
        actor,
        stamp: true,
        stampEngine: engine.label,
        generationRequestId: request?.id ?? null,
        factId: request?.factId ?? null,
        engineId: engine.id,
        snapshot: { index: i, vendorRequestId, requestCaptured: request != null, ...context },
      });
      provenanceId = finished.provenanceId;
    }
    f.holder["url"] = provenanceImageUrl(provenanceId);
    f.holder["provenance_id"] = String(provenanceId);
  }
  return result;
}

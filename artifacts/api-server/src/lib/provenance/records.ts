/**
 * @purpose Image provenance (plan docs/plans/PLAN_IMAGE_TRACING.md): the generation request persisted before a vendor is called, and `finishImage`, the one finishing step every picture passes through before it is stored or sent — it settles the true format, stamps the opaque id into the file, hashes the final bytes and commits the record, in that order, so no picture leaves without a committed record of exactly those bytes.
 *
 * A record is a snapshot of what was true when the picture was made, never a
 * join to today's rows; it names everything by plain value, so no deletion
 * reaches it (Settled Decisions 2 and 5).
 */
import { createHash, randomBytes } from "node:crypto";
import sharp from "sharp";
import { desc, eq } from "drizzle-orm";
import {
  db,
  usersTable,
  imageGenerationRequestsTable,
  imageProvenanceTable,
  type GenerationProducer,
  type ProvenanceActorKind,
  type ProvenanceKind,
  type ImageGenerationRequest,
} from "@workspace/db";
import { codeVersionColumns } from "../codeVersion";
import { sniffImage, stampImage } from "./imageFile";
import { logger } from "../logger";
import type { ObjectAclPolicy } from "../objectAcl";

/** Who started the work, as recorded. The email is the account's contact address at the time. */
export interface ProvenanceActor {
  kind: ProvenanceActorKind;
  userId: string | null;
  email: string | null;
}

export const SYSTEM_ACTOR: ProvenanceActor = { kind: "system", userId: null, email: null };

/**
 * The account as it is now, frozen into the record (David, 2026-11-10,
 * Question 1: keep the account id and its email at the time). An id that no
 * longer resolves is still recorded, with no email. A caller with no person
 * passes SYSTEM_ACTOR itself; that choice is never made here.
 */
export async function actorForUser(userId: string, kind: "member" | "admin"): Promise<ProvenanceActor> {
  const [u] = await db.select({ email: usersTable.email }).from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  return { kind, userId, email: u?.email ?? null };
}

/** The actor a captured generation request recorded: what a later stage reuses. */
export function actorOf(row: Pick<ImageGenerationRequest, "actorKind" | "actorUserId" | "actorEmail">): ProvenanceActor {
  return { kind: row.actorKind, userId: row.actorUserId, email: row.actorEmail };
}

function actorColumns(a: ProvenanceActor) {
  return { actorKind: a.kind, actorUserId: a.userId, actorEmail: a.email };
}

/**
 * A random 52-bit id: unique by primary key, unguessable from another, exact
 * in JavaScript. 52 uniform bits are taken in one draw (no arithmetic on the
 * random value, which CodeQL flags as a bias); an all-zero draw is redrawn.
 */
export function newProvenanceId(): number {
  for (;;) {
    const id = Number(BigInt.asUintN(52, randomBytes(8).readBigUInt64BE()));
    if (id !== 0) return id;
  }
}

// ─── Generation requests ──────────────────────────────────────────────────────

export interface GenerationRequestInput {
  producer: GenerationProducer;
  engineId: string | null;
  endpointId: string;
  /** The input exactly as it will be submitted. */
  request: Record<string, unknown>;
  actor: ProvenanceActor;
  attemptId?: number | null;
  comparisonCellId?: number | null;
  factId?: number | null;
}

/** Persist the request a vendor is about to receive. Call BEFORE submitting. */
export async function recordGenerationRequest(input: GenerationRequestInput): Promise<number> {
  const [row] = await db.insert(imageGenerationRequestsTable).values({
    producer: input.producer,
    engineId: input.engineId,
    endpointId: input.endpointId,
    request: input.request,
    attemptId: input.attemptId ?? null,
    comparisonCellId: input.comparisonCellId ?? null,
    factId: input.factId ?? null,
    ...actorColumns(input.actor),
    ...codeVersionColumns(),
  }).returning({ id: imageGenerationRequestsTable.id });
  return row!.id;
}

/** Add the vendor's own request id once it returns. */
export async function setVendorRequestId(generationRequestId: number, vendorRequestId: string | null | undefined): Promise<void> {
  if (!vendorRequestId) return;
  await db.update(imageGenerationRequestsTable)
    .set({ vendorRequestId })
    .where(eq(imageGenerationRequestsTable.id, generationRequestId));
}

/** The latest request captured for a comparison cell: what a storage-only retry reads. */
export async function latestCellGenerationRequest(comparisonCellId: number): Promise<ImageGenerationRequest | null> {
  const [row] = await db.select().from(imageGenerationRequestsTable)
    .where(eq(imageGenerationRequestsTable.comparisonCellId, comparisonCellId))
    .orderBy(desc(imageGenerationRequestsTable.id)).limit(1);
  return row ?? null;
}

// ─── The finishing step ───────────────────────────────────────────────────────

export interface FinishImageInput {
  bytes: Buffer;
  kind: ProvenanceKind;
  actor: ProvenanceActor;
  /** Stamp the id into the file (every kind but a member's upload, which is theirs). */
  stamp: boolean;
  /** The engine's name in the stamp: AI renders only, never a comparison picture. */
  stampEngine?: string | null;
  generationRequestId?: number | null;
  sourceProvenanceId?: number | null;
  memeSlug?: string | null;
  objectPath?: string | null;
  attemptId?: number | null;
  comparisonCellId?: number | null;
  factId?: number | null;
  engineId?: string | null;
  snapshot?: Record<string, unknown>;
}

export interface FinishedImage {
  bytes: Buffer;
  mime: string;
  ext: string;
  provenanceId: number;
}

let insertOverride: ((row: typeof imageProvenanceTable.$inferInsert) => Promise<void>) | null = null;
/** Test seam: capture records instead of writing them. */
export function __setProvenanceInsertForTest(impl: typeof insertOverride): void {
  insertOverride = impl;
}

/**
 * The one finishing step. Returns the bytes to store or send — stamped where
 * the format allows — after their record is committed. Throws if the record
 * cannot be written: a picture never leaves untraced to save a request
 * (plan, Runtime Behavior).
 */
export async function finishImage(input: FinishImageInput): Promise<FinishedImage> {
  const id = newProvenanceId();
  const stamped = input.stamp
    ? stampImage(input.bytes, { id, engine: input.stampEngine ?? null }) ?? input.bytes
    : input.bytes;
  const { mime, ext } = sniffImage(stamped);
  let width: number | null = null;
  let height: number | null = null;
  try {
    const meta = await sharp(stamped).metadata();
    width = meta.width ?? null;
    height = meta.height ?? null;
  } catch {
    // Unreadable dimensions are recorded as unknown; the hash still identifies the bytes.
  }
  const row: typeof imageProvenanceTable.$inferInsert = {
    id,
    kind: input.kind,
    generationRequestId: input.generationRequestId ?? null,
    sourceProvenanceId: input.sourceProvenanceId ?? null,
    ...actorColumns(input.actor),
    memeSlug: input.memeSlug ?? null,
    objectPath: input.objectPath ?? null,
    attemptId: input.attemptId ?? null,
    comparisonCellId: input.comparisonCellId ?? null,
    factId: input.factId ?? null,
    engineId: input.engineId ?? null,
    snapshot: input.snapshot ?? {},
    sha256: createHash("sha256").update(stamped).digest("hex"),
    mime,
    byteSize: stamped.length,
    width,
    height,
    ...codeVersionColumns(),
  };
  if (insertOverride) await insertOverride(row);
  else await db.insert(imageProvenanceTable).values(row);
  return { bytes: stamped, mime, ext, provenanceId: id };
}

/** The store a finished picture goes to: `ObjectStorageService`, or a test fake. */
export interface ImageStore {
  uploadObjectBuffer(args: { subPath: string; buffer: Buffer; contentType: string; aclPolicy?: ObjectAclPolicy }): Promise<string>;
}

/**
 * The path `uploadObjectBuffer` returns for a sub-path, known before the
 * store so the record names its object and is never edited.
 */
function storedObjectPath(subPath: string): string {
  return `/objects/${subPath}`;
}

/**
 * Finish a picture and store it, as one step: the sub-path takes the true
 * format's extension, the record (naming that stored object) is committed,
 * then exactly the recorded bytes are stored. Every producer that stores a
 * picture goes through here, so none can record one path and store another.
 */
export async function finishAndStore(
  input: Omit<FinishImageInput, "objectPath"> & {
    store: ImageStore;
    /** The sub-path for a given extension, e.g. (ext) => `ai-bg-v2/5/9-1.${ext}`. */
    subPathFor: (ext: string) => string;
    aclPolicy?: ObjectAclPolicy;
  },
): Promise<FinishedImage & { objectPath: string }> {
  const { store, subPathFor, aclPolicy, ...finish } = input;
  const subPath = subPathFor(sniffImage(finish.bytes).ext);
  const recordedPath = storedObjectPath(subPath);
  const finished = await finishImage({ ...finish, objectPath: recordedPath });
  const objectPath = await store.uploadObjectBuffer({
    subPath,
    buffer: finished.bytes,
    contentType: finished.mime,
    ...(aclPolicy ? { aclPolicy } : {}),
  });
  if (objectPath !== recordedPath) {
    logger.error({ recordedPath, objectPath, provenanceId: finished.provenanceId }, "[provenance] the store returned a different path than the record names");
  }
  return { ...finished, objectPath };
}

/**
 * @purpose Image provenance (plan docs/plans/PLAN_IMAGE_TRACING.md): the generation request persisted before a vendor is called, and `finishImage`, the one finishing step every picture passes through before it is stored or sent — it settles the true format, stamps the opaque id into the file, hashes the final bytes and commits the record, in that order, so no picture leaves without a committed record of exactly those bytes.
 *
 * A record is a snapshot of what was true when the picture was made, never a
 * join to today's rows; it names everything by plain value, so no deletion
 * reaches it (Settled Decisions 2 and 5).
 */
import { createHash, randomBytes } from "node:crypto";
import sharp from "sharp";
import { eq } from "drizzle-orm";
import {
  db,
  usersTable,
  imageGenerationRequestsTable,
  imageProvenanceTable,
  type GenerationProducer,
  type ProvenanceActorKind,
  type ProvenanceKind,
  type ImageProvenance,
} from "@workspace/db";
import { codeVersionColumns } from "../codeVersion";
import { sniffImage, stampImage } from "./imageFile";

/** Who started the work, as recorded. The email is the account's contact address at the time. */
export interface ProvenanceActor {
  kind: ProvenanceActorKind;
  userId: string | null;
  email: string | null;
}

export const ANONYMOUS_ACTOR: ProvenanceActor = { kind: "anonymous", userId: null, email: null };
export const SYSTEM_ACTOR: ProvenanceActor = { kind: "system", userId: null, email: null };

/**
 * The account as it is now, frozen into the record (David, 2026-11-10,
 * Question 1: keep the account id and its email at the time). An id that no
 * longer resolves is still recorded, with no email.
 */
export async function actorForUser(userId: string | null | undefined, kind: "member" | "admin"): Promise<ProvenanceActor> {
  if (!userId) return kind === "admin" ? SYSTEM_ACTOR : ANONYMOUS_ACTOR;
  const [u] = await db.select({ email: usersTable.email }).from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  return { kind, userId, email: u?.email ?? null };
}

/** A random 52-bit id: unique by primary key, unguessable from another, exact in JavaScript. */
export function newProvenanceId(): number {
  const b = randomBytes(7);
  // 52 bits: the top nibble of the 7th byte is dropped; never zero.
  const hi = b.readUIntBE(0, 3) & 0x0fffff; // 20 bits
  const lo = b.readUInt32BE(3); // 32 bits
  return hi * 2 ** 32 + lo || 1;
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
    actorKind: input.actor.kind,
    actorUserId: input.actor.userId,
    actorEmail: input.actor.email,
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

/** The latest request captured for an attempt or a comparison cell: what a recovery reads. */
export async function latestGenerationRequest(
  by: { attemptId: number } | { comparisonCellId: number },
): Promise<typeof imageGenerationRequestsTable.$inferSelect | null> {
  const where = "attemptId" in by
    ? eq(imageGenerationRequestsTable.attemptId, by.attemptId)
    : eq(imageGenerationRequestsTable.comparisonCellId, by.comparisonCellId);
  const rows = await db.select().from(imageGenerationRequestsTable).where(where)
    .orderBy(imageGenerationRequestsTable.id);
  return rows.at(-1) ?? null;
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
    actorKind: input.actor.kind,
    actorUserId: input.actor.userId,
    actorEmail: input.actor.email,
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

/**
 * The path `ObjectStorageService.uploadObjectBuffer` returns for a sub-path,
 * known before the store, so the record names its object and is never edited.
 */
export function storedObjectPath(subPath: string): string {
  return `/objects/${subPath}`;
}

export type { ImageProvenance };

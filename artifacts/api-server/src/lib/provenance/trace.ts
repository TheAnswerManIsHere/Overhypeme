/**
 * @purpose The trace behind the admin "Trace an image" screen (plan PLAN_IMAGE_TRACING.md, Product Intent): from an id or a link to every matching provenance record, with its generation request, the record of the picture it was made from, and whether the meme, the stored picture and the account still exist — reading only records, never rebuilding a gap from today's rows. It says which lookup matched, and what it tried when nothing did.
 */
import { eq, inArray } from "drizzle-orm";
import {
  db,
  imageProvenanceTable,
  imageGenerationRequestsTable,
  memesTable,
  usersTable,
  type ImageProvenance,
  type ImageGenerationRequest,
} from "@workspace/db";

/** Increment 2 adds the lookups from a picture itself (metadata, exact hash, watermark). */
export type TraceMethod = "id" | "link";

export interface TracedRecord {
  record: ImageProvenance;
  generationRequest: ImageGenerationRequest | null;
  /** The record of the picture this one was made from, one level up. */
  source: ImageProvenance | null;
  stillExists: { account: boolean | null; meme: boolean | null };
}

export interface TraceResult {
  method: TraceMethod | null;
  matches: TracedRecord[];
  /** Lookups tried, in order, and what each found. */
  tried: string[];
  /** A recognised picture that predates tracing, explained in words. */
  note: string | null;
}

/** What a pasted string can be: a record id, a meme slug, or a stored object path. */
type ParsedTraceInput =
  | { kind: "id"; id: number }
  | { kind: "meme"; slug: string }
  | { kind: "object"; objectPath: string }
  | { kind: "provenanceImage"; id: number }
  | { kind: "unrecognised" };

const SLUG = "[A-Za-z0-9_-]{4,16}";

/** Read an id or a link the way an admin would paste one. */
export function parseTraceInput(raw: string): ParsedTraceInput {
  const input = raw.trim();
  if (/^\d{1,16}$/.test(input)) {
    const id = Number(input);
    return Number.isSafeInteger(id) && id > 0 ? { kind: "id", id } : { kind: "unrecognised" };
  }
  let path = input;
  try {
    if (/^https?:\/\//i.test(input)) path = new URL(input).pathname;
  } catch {
    return { kind: "unrecognised" };
  }
  path = decodeURIComponent(path.split(/[?#]/)[0] ?? "");
  let m: RegExpExecArray | null;
  if ((m = /^\/api\/admin\/provenance\/images\/(\d{1,16})$/.exec(path))) return { kind: "provenanceImage", id: Number(m[1]) };
  if ((m = new RegExp(`^(?:/api)?/(?:og/)?m/(${SLUG})/?$`).exec(path))) return { kind: "meme", slug: m[1]! };
  if ((m = new RegExp(`^/api/memes/(${SLUG})/image$`).exec(path))) return { kind: "meme", slug: m[1]! };
  if ((m = /^(?:\/api\/storage)?\/(?:public-)?objects\/(.+)$/.exec(path))) return { kind: "object", objectPath: `/objects/${m[1]}` };
  return { kind: "unrecognised" };
}

/** Pictures stored before tracing, recognised by where they live. */
export function preTracingNote(objectPath: string): string | null {
  if (/^\/objects\/ai-backgrounds\//.test(objectPath)) {
    return "Legacy path, settings not recorded: an AI background from the old FLUX backfill, made before image tracing.";
  }
  if (/^\/objects\/(ai-bg-v2|comparison|uploads|memes)\//.test(objectPath)) {
    return "This picture was stored before image tracing began, so it has no provenance record.";
  }
  return null;
}

async function expand(records: ImageProvenance[]): Promise<TracedRecord[]> {
  if (records.length === 0) return [];
  const requestIds = [...new Set(records.map((r) => r.generationRequestId).filter((v): v is number => v != null))];
  const sourceIds = [...new Set(records.map((r) => r.sourceProvenanceId).filter((v): v is number => v != null))];
  const userIds = [...new Set(records.map((r) => r.actorUserId).filter((v): v is string => !!v))];
  const slugs = [...new Set(records.map((r) => r.memeSlug).filter((v): v is string => !!v))];
  const [requests, sources, users, memes] = await Promise.all([
    requestIds.length ? db.select().from(imageGenerationRequestsTable).where(inArray(imageGenerationRequestsTable.id, requestIds)) : [],
    sourceIds.length ? db.select().from(imageProvenanceTable).where(inArray(imageProvenanceTable.id, sourceIds)) : [],
    userIds.length ? db.select({ id: usersTable.id }).from(usersTable).where(inArray(usersTable.id, userIds)) : [],
    slugs.length ? db.select({ slug: memesTable.permalinkSlug }).from(memesTable).where(inArray(memesTable.permalinkSlug, slugs)) : [],
  ]);
  const reqById = new Map(requests.map((r) => [r.id, r]));
  const srcById = new Map(sources.map((r) => [r.id, r]));
  const liveUsers = new Set(users.map((u) => u.id));
  const liveMemes = new Set(memes.map((m) => m.slug));
  return records.map((record) => ({
    record,
    generationRequest: record.generationRequestId != null ? reqById.get(record.generationRequestId) ?? null : null,
    source: record.sourceProvenanceId != null ? srcById.get(record.sourceProvenanceId) ?? null : null,
    stillExists: {
      account: record.actorUserId ? liveUsers.has(record.actorUserId) : null,
      meme: record.memeSlug ? liveMemes.has(record.memeSlug) : null,
    },
  }));
}

const NEWEST_FIRST = (a: ImageProvenance, b: ImageProvenance) => b.createdAt.getTime() - a.createdAt.getTime();

/** Trace a pasted id or link. Every match is returned; none is picked silently. */
export async function traceIdOrLink(raw: string): Promise<TraceResult> {
  const parsed = parseTraceInput(raw);
  const tried: string[] = [];
  if (parsed.kind === "id" || parsed.kind === "provenanceImage") {
    const rows = await db.select().from(imageProvenanceTable).where(eq(imageProvenanceTable.id, parsed.id));
    tried.push(`record id ${parsed.id}: ${rows.length ? "found" : "no record"}`);
    return { method: rows.length ? "id" : null, matches: await expand(rows), tried, note: null };
  }
  if (parsed.kind === "meme") {
    const rows = (await db.select().from(imageProvenanceTable).where(eq(imageProvenanceTable.memeSlug, parsed.slug))).sort(NEWEST_FIRST);
    tried.push(`meme link ${parsed.slug}: ${rows.length} record${rows.length === 1 ? "" : "s"}`);
    const note = rows.length === 0 && (await db.select({ id: memesTable.id }).from(memesTable).where(eq(memesTable.permalinkSlug, parsed.slug)).limit(1)).length > 0
      ? "This meme was made before image tracing began, so it has no provenance record."
      : null;
    return { method: rows.length ? "link" : null, matches: await expand(rows), tried, note };
  }
  if (parsed.kind === "object") {
    const rows = (await db.select().from(imageProvenanceTable).where(eq(imageProvenanceTable.objectPath, parsed.objectPath))).sort(NEWEST_FIRST);
    tried.push(`stored picture ${parsed.objectPath}: ${rows.length} record${rows.length === 1 ? "" : "s"}`);
    return {
      method: rows.length ? "link" : null,
      matches: await expand(rows),
      tried,
      note: rows.length ? null : preTracingNote(parsed.objectPath),
    };
  }
  tried.push("not an id or a link this screen recognises");
  return { method: null, matches: [], tried, note: null };
}

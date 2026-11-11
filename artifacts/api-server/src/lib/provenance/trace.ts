/**
 * @purpose The trace behind the admin "Trace an image" screen (plan PLAN_IMAGE_TRACING.md, Product Intent): from an id, a link or a picture file to every matching provenance record, with its generation request, the record of the picture it was made from, and whether the meme, the stored picture and the account still exist — reading what it shows only from records — a live row is used only to find a record or to say a pre-tracing picture has none, never to fill a gap. It says which lookup matched, and what it tried when nothing did.
 */
import { createHash } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import {
  db,
  imageProvenanceTable,
  imageGenerationRequestsTable,
  memesTable,
  usersTable,
  imagePromptAttemptsTable,
  type ImageProvenance,
  type ImageGenerationRequest,
} from "@workspace/db";
import { blindImagePath } from "../comparison/judging";
import { readStampedId } from "./imageFile";
import { readWatermark } from "./watermark";

/** How a record was found: from a typed id or link, or from a picture itself (its stamp, its exact bytes, its watermark). */
export type TraceMethod = "id" | "link" | "metadata" | "hash" | "watermark";

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
  | { kind: "attempt"; attemptId: number }
  | { kind: "moderationRender"; renderJobId: string }
  | { kind: "comparisonImage"; panelId: number; token: string }
  | { kind: "unrecognised" };

const SLUG = "[A-Za-z0-9_-]{4,16}";

/** Read an id or a link the way an admin would paste one. */
export function parseTraceInput(raw: string): ParsedTraceInput {
  const input = raw.trim();
  if (/^\d{1,16}$/.test(input)) {
    const id = Number(input);
    return Number.isSafeInteger(id) && id > 0 ? { kind: "id", id } : { kind: "unrecognised" };
  }
  let url: URL;
  let path: string;
  try {
    url = new URL(input, "https://overhype.me");
    path = decodeURIComponent(url.pathname);
  } catch {
    return { kind: "unrecognised" };
  }
  let m: RegExpExecArray | null;
  // The links the admin and member screens actually show for a recorded
  // picture, each resolved to the picture it serves (Codex, PR #911).
  if (path === "/api/memes/ai-user/image") {
    const storagePath = url.searchParams.get("storagePath") ?? "";
    return /^\/objects\/.+/.test(storagePath) ? { kind: "object", objectPath: storagePath } : { kind: "unrecognised" };
  }
  if ((m = /^\/api\/admin\/reviews\/\d+\/renders\/([^/]{1,64})\/image$/.exec(path))) return { kind: "moderationRender", renderJobId: m[1]! };
  if ((m = /^\/api\/admin\/comparison\/panels\/(\d+)\/images\/([0-9a-f]{16})$/.exec(path))) return { kind: "comparisonImage", panelId: Number(m[1]), token: m[2]! };
  if ((m = /^\/api\/admin\/eval\/attempts\/(\d+)\/image$/.exec(path))) return { kind: "attempt", attemptId: Number(m[1]) };
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
  if (parsed.kind === "comparisonImage") {
    // The record holds the panel and blind token it was judged under, so the
    // link traces after the panel is gone; the live panel is only a fallback
    // for a picture stored before tracing.
    const rows = (await db.select().from(imageProvenanceTable).where(sql`${imageProvenanceTable.snapshot}->>'panelId' = ${String(parsed.panelId)} AND ${imageProvenanceTable.snapshot}->>'blindToken' = ${parsed.token}`)).sort(NEWEST_FIRST);
    tried.push(`comparison picture (panel ${parsed.panelId}): ${rows.length} record${rows.length === 1 ? "" : "s"}`);
    if (rows.length) return { method: "link", matches: await expand(rows), tried, note: null };
    const objectPath = await blindImagePath(parsed.panelId, parsed.token);
    if (!objectPath) return { method: null, matches: [], tried, note: "This comparison picture's panel no longer exists and no record names it." };
    return traceObjectPath(objectPath, tried);
  }
  if (parsed.kind === "attempt" || parsed.kind === "moderationRender") {
    // The record names its attempt and render job itself, so the link traces
    // after the attempt row is gone.
    const rows = (parsed.kind === "attempt"
      ? await db.select().from(imageProvenanceTable).where(eq(imageProvenanceTable.attemptId, parsed.attemptId))
      : await db.select().from(imageProvenanceTable).where(sql`${imageProvenanceTable.snapshot}->>'renderJobId' = ${parsed.renderJobId}`)
    ).sort(NEWEST_FIRST);
    const label = parsed.kind === "attempt" ? `render attempt ${parsed.attemptId}` : `moderation render ${parsed.renderJobId}`;
    tried.push(`${label}: ${rows.length} record${rows.length === 1 ? "" : "s"}`);
    let note: string | null = null;
    if (!rows.length) {
      const where = parsed.kind === "attempt"
        ? eq(imagePromptAttemptsTable.id, parsed.attemptId)
        : eq(imagePromptAttemptsTable.renderJobId, parsed.renderJobId);
      const [attempt] = await db.select({ id: imagePromptAttemptsTable.id }).from(imagePromptAttemptsTable).where(where).limit(1);
      if (attempt) note = "This render was made before image tracing began, so it has no provenance record.";
    }
    return { method: rows.length ? "link" : null, matches: await expand(rows), tried, note };
  }
  if (parsed.kind === "object") return traceObjectPath(parsed.objectPath, tried);
  tried.push("not an id or a link this screen recognises (a record id, a meme link, or an image link from the admin or member screens)");
  return { method: null, matches: [], tried, note: null };
}

async function traceObjectPath(objectPath: string, tried: string[]): Promise<TraceResult> {
  const rows = (await db.select().from(imageProvenanceTable).where(eq(imageProvenanceTable.objectPath, objectPath))).sort(NEWEST_FIRST);
  tried.push(`stored picture ${objectPath}: ${rows.length} record${rows.length === 1 ? "" : "s"}`);
  return {
    method: rows.length ? "link" : null,
    matches: await expand(rows),
    tried,
    note: rows.length ? null : preTracingNote(objectPath),
  };
}

/**
 * Trace a picture file (increment 2): by the id stamped in its metadata, by the exact hash of its bytes, and by the
 * id in its invisible watermark — every one is tried, so a stamp and a watermark that disagree are both shown, and
 * every record any of them finds is returned. `method` names the first that matched, in that order.
 */
export async function traceImageFile(file: Buffer): Promise<TraceResult> {
  const tried: string[] = [];
  const found = new Map<number, ImageProvenance>();
  let method: TraceMethod | null = null;
  const take = (m: TraceMethod, rows: ImageProvenance[]) => {
    for (const r of rows) found.set(r.id, r);
    if (rows.length && !method) method = m;
  };

  const stamped = readStampedId(file);
  if (stamped == null) tried.push("metadata: no Overhype.me id in the file (stripped, or never stamped)");
  else {
    const rows = await db.select().from(imageProvenanceTable).where(eq(imageProvenanceTable.id, stamped));
    tried.push(`metadata: id ${stamped}, ${rows.length ? "found" : "no record with that id"}`);
    take("metadata", rows);
  }

  // The hash lookup and the watermark reading are independent; the reading is the slow one.
  const sha256 = createHash("sha256").update(file).digest("hex");
  const [byHash, reading] = await Promise.all([
    db.select().from(imageProvenanceTable).where(eq(imageProvenanceTable.sha256, sha256)),
    readWatermark(file).then((r) => ({ ok: true as const, r }), (err: unknown) => ({ ok: false as const, err })),
  ]);
  tried.push(`exact bytes: ${byHash.length ? `${byHash.length} record${byHash.length === 1 ? "" : "s"}` : "no record of these exact bytes (the file has been re-saved, resized or edited)"}`);
  take("hash", byHash);

  if (!reading.ok) {
    tried.push(`watermark: could not be read (${reading.err instanceof Error ? reading.err.message : String(reading.err)})`);
  } else if (!reading.r) {
    tried.push("watermark: none found (a picture made before memes were watermarked, one cropped too hard, or not ours)");
  } else {
    const { id, trimmed, corrected } = reading.r;
    const rows = await db.select().from(imageProvenanceTable).where(eq(imageProvenanceTable.id, id));
    const how = [trimmed ? "after cutting away bars round the picture" : null, corrected ? `${corrected} damaged bit${corrected === 1 ? "" : "s"} repaired` : null].filter(Boolean).join(", ");
    tried.push(`watermark: id ${id}${how ? ` (${how})` : ""}, ${rows.length ? "found" : "no record with that id"}`);
    if (stamped != null && stamped !== id) tried.push(`the metadata and the watermark name different records (${stamped} and ${id}): the file's metadata may have been copied from another picture`);
    take("watermark", rows);
  }

  return { method, matches: await expand([...found.values()].sort(NEWEST_FIRST)), tried, note: null };
}

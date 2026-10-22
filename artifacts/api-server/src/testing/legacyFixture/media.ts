/**
 * The legacy fixture's media map (plan D5, Astra rounds 1–3).
 *
 * One source object maps to exactly one synthetic object, wherever it is
 * referenced: a gallery slot, a tracking row, an upload-metadata row and the
 * attempt that produced it all receive the same rewritten path, so equality
 * across rows survives. Gallery membership, tracking type and upload metadata
 * are overlapping ROLES of one object, not exclusive kinds; placement and ACL
 * come from the producing storage path and its writer.
 *
 * Bytes are never copied. The loader writes a generated image of the recorded
 * size at each synthetic path, through the real storage service, with the ACL
 * recorded here.
 */
import { aiBackgroundKey, memeKey, uploadKey } from "../../lib/storageKeys";
import type { Scrubber } from "./scrub";

export type MediaRole =
  | "profile-image"
  | "upload-metadata"
  | "upload-metadata-profile"
  | "upload-metadata-source"
  | "ai-tracking-generic"
  | "ai-tracking-reference"
  | "fact-gallery"
  | "attempt-output"
  | "meme-image-url"
  | "meme-upload-source"
  | "render-reference"
  | "catalogue-asset";

/**
 * External pictures replaced by the inline stock image, by host and (when the host alone is not enough) role.
 * Any other external reference stops the export.
 */
const EXTERNAL_IMAGES: ReadonlyArray<{ host: RegExp; roles?: readonly MediaRole[] }> = [
  // Stock photos.
  { host: /^https:\/\/(images\.)?pexels\.com\//i },
  // An OAuth provider's avatar: a picture of a person.
  { host: /^https:\/\//i, roles: ["profile-image"] },
  // The face photo uploaded to fal's storage for an i2i render (defaultReferenceResolver.ts:118-122, aiMemePipeline.ts:622).
  { host: /^https:\/\/([a-z0-9-]+\.)*fal\.media\//i, roles: ["render-reference"] },
];

/**
 * Roles whose row may have lost its owner: every upload writer records the uploader (userImageUpload.ts:286-307,
 * aiMemePipeline.ts:950-960, imagePromptJobs.ts:694), and upload_image_metadata.user_id
 * empties only when that account is deleted (ON DELETE SET NULL).
 */
const OWNER_OPTIONAL: ReadonlySet<MediaRole> = new Set(["upload-metadata", "upload-metadata-source"]);

export type MediaKind = "upload" | "ai-background" | "ai-bg-v2" | "meme" | "catalogue" | "stock";

export interface MediaAcl {
  owner: string;
  visibility: "public" | "private";
}

export interface MediaPlaceholder {
  /** The rewritten reference as it appears in the fixture's rows. */
  path: string;
  kind: MediaKind;
  ext: string;
  /** The ACL the producing writer sets, or null when that writer sets none. */
  acl: MediaAcl | null;
  width: number;
  height: number;
  /** Every role this object plays, with the table and row that holds it. */
  roles: Array<{ role: MediaRole; table: string; row: string }>;
}

/** Thrown for a reference the map cannot place; names the shape, never the value. */
export class MediaPlacementError extends Error {}

/** Path words the storage layout itself uses (storageKeys.ts, objectStorage.ts): kept, so a shape stays legible. */
const STRUCTURAL_SEGMENTS = new Set(["api", "storage", "objects", "uploads", "ai-backgrounds", "ai-bg-v2", "memes", "restricted", "photos", "files", "a"]);
/** Vendor hosts the fixture already recognises; any other host is `<host>`. */
const KNOWN_HOSTS: ReadonlyArray<[RegExp, string]> = [
  [/^(images\.)?pexels\.com$/i, "pexels.com"],
  [/^([a-z0-9-]+\.)*fal\.media$/i, "fal.media"],
  [/^([a-z0-9-]+\.)*googleusercontent\.com$/i, "googleusercontent.com"],
  [/^example\.test$/i, "example.test"],
];
const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "gif", "avif", "mp4"]);

function segmentCategory(segment: string): string {
  if (STRUCTURAL_SEGMENTS.has(segment)) return segment;
  const dot = segment.lastIndexOf(".");
  const ext = dot > 0 ? segment.slice(dot + 1).toLowerCase() : "";
  const stem = IMAGE_EXTENSIONS.has(ext) ? segment.slice(0, dot) : segment;
  const kind = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(stem)
    ? "<uuid>"
    : /^[0-9a-f]{2}$/i.test(stem)
      ? "<h2>"
      : /^\d+$/.test(stem)
        ? "<n>"
        : "<seg>";
  return IMAGE_EXTENSIONS.has(ext) ? `${kind}.${ext}` : kind;
}

/**
 * The shape of a reference, built from fixed categories — safe to print. Nothing of the source survives but
 * known vendor hosts, the storage layout's own words and an image extension; every other host, path
 * component, query and fragment becomes a category token (Codex round 1: inferring privacy from a
 * component's length let short ones through).
 */
export function referencePattern(value: string): string {
  if (/^data:/i.test(value)) return "<data-url>";
  const url = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/i.exec(value);
  const pathOf = (p: string) => p.split("/").map((seg) => (seg === "" ? "" : segmentCategory(seg))).join("/");
  if (url) {
    const host = KNOWN_HOSTS.find(([re]) => re.test(url[2]!))?.[1] ?? "<host>";
    return `${url[1]!.toLowerCase()}://${host}${pathOf(url[3]!)}${url[4] ? "?<query>" : ""}${url[5] ? "#<fragment>" : ""}`;
  }
  if (value.startsWith("/")) {
    const [pathPart, query] = value.split(/[?#]/, 2);
    return `${pathOf(pathPart!)}${query !== undefined ? "?<query>" : ""}`;
  }
  return "<other>";
}

/** Generated JPEG of 8×8 pixels, as a data URL under 1,100 characters (plan D5). */
export type DataUrlFactory = () => string;

interface Pending {
  source: string;
  roles: Array<{ role: MediaRole; table: string; row: string; ownerSourceId: string | null; isProfile: boolean }>;
  size?: { width: number; height: number };
}

export class MediaMap {
  private readonly bySource = new Map<string, Pending>();
  private resolved: Map<string, MediaPlaceholder> | null = null;
  private counter = 0;

  constructor(
    private readonly scrubber: Scrubber,
    private readonly stockDataUrl: DataUrlFactory,
  ) {}

  /**
   * Record one reference. Call for every reference in the export before
   * `resolve()`; the rewritten value is read back with `rewrite()`.
   */
  note(
    source: string,
    role: MediaRole,
    where: { table: string; row: string },
    ownerSourceId: string | null,
    opts: { isProfile?: boolean; size?: { width: number; height: number } } = {},
  ): void {
    if (this.resolved) throw new Error("[legacy-fixture] media map already resolved");
    if (source === "") return; // a deleted gallery slot stays "" (plan D4)
    const objectPath = objectPathOf(source);
    if (objectPath && objectPath.startsWith("/objects/restricted/")) {
      throw new MediaPlacementError(`${where.table}: a reference into restricted/ (child-safety evidence) — refused`);
    }
    const p = this.bySource.get(source) ?? { source, roles: [] };
    p.roles.push({ role, table: where.table, row: where.row, ownerSourceId, isProfile: opts.isProfile === true });
    if (opts.size) p.size = opts.size;
    this.bySource.set(source, p);
  }

  /** The two-pass protocol in one call: note the reference on the first pass, rewrite it on the second. */
  noteOrRewrite(
    value: string,
    role: MediaRole,
    mode: "note" | "emit",
    where: { table: string; row: string },
    ownerSourceId: string | null,
    opts: { isProfile?: boolean; size?: { width: number; height: number } } = {},
  ): string {
    if (mode === "emit") return this.rewrite(value);
    this.note(value, role, where, ownerSourceId, opts);
    return value;
  }

  /** Place every noted object. Throws on a reference no rule covers. */
  resolve(): Map<string, MediaPlaceholder> {
    if (this.resolved) return this.resolved;
    const out = new Map<string, MediaPlaceholder>();
    for (const p of this.bySource.values()) out.set(p.source, this.place(p));
    this.resolved = out;
    return out;
  }

  /** The rewritten reference for a noted source value ("" and null pass through). */
  rewrite<T extends string | null | undefined>(source: T): T {
    if (source == null || source === "") return source;
    const placed = this.resolve().get(source);
    if (!placed) throw new Error("[legacy-fixture] media reference rewritten before it was noted");
    return placed.path as T;
  }

  placeholders(): MediaPlaceholder[] {
    return [...this.resolve().values()].filter((p) => p.kind !== "stock");
  }

  private nextKey(): string {
    this.counter += 1;
    return `fixture-${String(this.counter).padStart(4, "0")}`;
  }

  private ownerOf(p: Pending): string | null {
    const owner = p.roles.find((r) => r.ownerSourceId)?.ownerSourceId ?? null;
    return owner ? this.scrubber.userId(owner) : null;
  }

  private place(p: Pending): MediaPlaceholder {
    const roles = p.roles.map(({ role, table, row }) => ({ role, table, row }));
    const size = p.size ?? { width: 64, height: 64 };

    // An external picture becomes the inline stock image: no server, no port, no vendor, no person.
    if (EXTERNAL_IMAGES.some((x) => x.host.test(p.source) && (!x.roles || p.roles.every((r) => x.roles!.includes(r.role))))) {
      return { path: this.stockDataUrl(), kind: "stock", ext: "jpg", acl: null, roles, ...size };
    }

    const objectPath = objectPathOf(p.source);
    if (!objectPath) {
      throw new MediaPlacementError(`unplaceable media reference of shape ${referencePattern(p.source)} (${p.roles.map((r) => `${r.table}:${r.role}`).join(", ")})`);
    }
    const sub = objectPath.slice("/objects/".length);
    const prefixOf = (path: string) => (p.source.startsWith("/objects/") ? path : p.source.replace(objectPath, path));
    const owner = this.ownerOf(p);

    // uploads/<h2>/<uuid>.<ext> — the user upload writer (userImageUpload.ts:376-385).
    let m = /^uploads\/[0-9a-f]{2}\/([^/]+)\.([a-z0-9]+)$/i.exec(sub) ?? /^uploads\/[0-9a-f]{2}\/([^/.]+)$/i.exec(sub);
    if (m) {
      const ext = m[2] ?? "";
      const id = this.scrubber.uuid("media", p.source);
      const isProfile = p.roles.some((r) => r.isProfile || r.role === "profile-image" || r.role === "upload-metadata-profile");
      // An orphan (OWNER_OPTIONAL) keeps its shape: private to a person who exists nowhere.
      const orphan = !owner && p.roles.every((r) => OWNER_OPTIONAL.has(r.role)) && !isProfile;
      if (!owner && !orphan) throw new MediaPlacementError(`an upload with no owning user (${roles.map((r) => r.table).join(", ")})`);
      return {
        path: prefixOf(`/objects/${uploadKey(id, ext || undefined)}`),
        kind: "upload",
        ext: ext || "jpg",
        acl: { owner: owner ?? this.scrubber.uuid("orphaned-upload-owner", p.source), visibility: isProfile ? "public" : "private" },
        roles,
        ...size,
      };
    }

    // ai-backgrounds/<h2>/<factId>-<gender>[-ref]-<key>.<ext> — the legacy AI pipeline (aiMemePipeline.ts:459-461, 783-795).
    m = /^ai-backgrounds\/[0-9a-f]{2}\/(\d+)-([a-z]+)(-ref)?-([^/]+)\.([a-z0-9]+)$/i.exec(sub);
    if (m) {
      const [, factId, gender, ref, , ext] = m;
      const key = aiBackgroundKey(Number(factId), gender!, this.nextKey(), ext!, Boolean(ref));
      return { path: prefixOf(`/objects/${key}`), kind: "ai-background", ext: ext!, acl: { owner: "system", visibility: "public" }, roles, ...size };
    }

    // ai-bg-v2/<factId>/<attemptId>-<ts>.png — the newer pipeline, which sets no ACL (imagePromptJobs.ts:382-390).
    m = /^ai-bg-v2\/(\d+)\/(\d+)-(\d+)\.([a-z0-9]+)$/i.exec(sub);
    if (m) {
      const [, factId, attemptId, , ext] = m;
      return {
        path: prefixOf(`/objects/ai-bg-v2/${factId}/${attemptId}-${this.nextKey().replace(/\D/g, "")}.${ext}`),
        kind: "ai-bg-v2",
        ext: ext!,
        acl: null,
        roles,
        ...size,
      };
    }

    // memes/<h2>/<slug>.<ext> — derived from the meme's slug, which the fixture keeps (routes/memes.ts:609-633).
    m = /^memes\/[0-9a-f]{2}\/([^/]+)\.([a-z0-9]+)$/i.exec(sub);
    if (m) {
      const [, slug, ext] = m;
      if (memeKey(slug!, ext) !== sub) {
        throw new MediaPlacementError(`a meme key whose hash prefix does not match its slug (${referencePattern(p.source)})`);
      }
      return { path: p.source, kind: "meme", ext: ext!, acl: owner ? { owner, visibility: "public" } : null, roles, ...size };
    }

    // Catalogue assets (style previews, hero examples): written by admin routes as system/public (routes/admin.ts:3256).
    if (p.roles.every((r) => r.role === "catalogue-asset")) {
      m = /^(.*\/)?[^/]+\.([a-z0-9]+)$/i.exec(sub);
      if (m) {
        const dir = m[1] ?? "";
        return { path: prefixOf(`/objects/${dir}${this.nextKey()}.${m[2]}`), kind: "catalogue", ext: m[2]!, acl: { owner: "system", visibility: "public" }, roles, ...size };
      }
    }

    throw new MediaPlacementError(`unplaceable object path of shape ${referencePattern(p.source)} (${p.roles.map((r) => `${r.table}:${r.role}`).join(", ")})`);
  }
}

/** The `/objects/...` form of a reference, or null when it is not one. */
export function objectPathOf(value: string): string | null {
  if (value.startsWith("/objects/")) return value.split("?")[0]!;
  const m = /\/objects\/[^?#]+/.exec(value);
  if (m && /^(https?:\/\/[^/]+)?\/api\/storage\/objects\//.test(value)) return m[0];
  return null;
}

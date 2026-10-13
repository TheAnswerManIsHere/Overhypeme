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
import { aiBackgroundKey, hashPrefix, uploadKey } from "../../lib/storageKeys";
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

/** The shape of a reference with its private parts collapsed — safe to print. */
export function referencePattern(value: string): string {
  return value
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
    .replace(/\/[0-9a-f]{2}\//g, "/<h2>/")
    .replace(/[A-Za-z0-9_-]{12,}/g, "<id>")
    .replace(/\d+/g, "<n>");
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

    // Pexels and other third-party stock URLs become data URLs: no server, no port, no vendor.
    if (/^https:\/\/(images\.)?pexels\.com\//i.test(p.source)) {
      return { path: this.stockDataUrl(), kind: "stock", ext: "jpg", acl: null, roles, ...size };
    }

    // A third-party profile photo (an OAuth provider's avatar URL) is a picture of a person: replaced the same way.
    if (/^https:\/\//i.test(p.source) && p.roles.every((r) => r.role === "profile-image")) {
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
      if (!owner) throw new MediaPlacementError(`an upload with no owning user (${roles.map((r) => r.table).join(", ")})`);
      return {
        path: prefixOf(`/objects/${uploadKey(id, ext || undefined)}`),
        kind: "upload",
        ext: ext || "jpg",
        acl: { owner, visibility: isProfile ? "public" : "private" },
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
      const filename = `${slug}.${ext}`;
      if (`memes/${hashPrefix(filename)}/${filename}` !== sub) {
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

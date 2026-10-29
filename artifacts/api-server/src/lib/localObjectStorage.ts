/**
 * The local object-storage double (Launch Phase 2, increment 3; #631).
 *
 * Selected only by `STORAGE_BACKEND=local-double` (see `doubleSelection.ts`,
 * which refuses it in a production boot), it stands in for the one client
 * `objectStorage.ts` talks to: `Storage#bucket(name).file(objectName)`. It
 * implements exactly the File surface the codebase uses — `exists`,
 * `getMetadata`, `setMetadata`, `save`, `copy`, `download`,
 * `createReadStream`, `delete`, `name` and a listing's `metadata` — plus the
 * bucket's `getFiles`, and nothing else, so an unexpected call fails loudly
 * rather than silently succeeding. Generations, metagenerations and the
 * `ifGenerationMatch`/`ifMetagenerationMatch` preconditions behave as GCS's
 * do (412 on a mismatch), because the media backup (`lib/mediaBackup/`) rests
 * on them (Launch Phase 3, increment 5).
 *
 * Bytes live under `${STORAGE_DOUBLE_DIR}/data/<bucket>/<object>`, metadata
 * (content type, size, custom metadata such as the ACL policy) under
 * `${STORAGE_DOUBLE_DIR}/meta/<bucket>/<object>.json`. Everything above this —
 * `ObjectStorageService`, the ACL in `objectAcl.ts`, the access checks in
 * `objectAccess.ts` — runs unchanged, so the double never serves an object the
 * real access layer would not.
 *
 * Signed URLs are not provided: `signObjectURL` refuses under the double (see
 * `objectStorage.ts`), because no browser flow uses one and the one vendor
 * consumer (the fal NSFW classifier) belongs to the AI doubles.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { File } from "@google-cloud/storage";

interface StoredMeta {
  contentType?: string;
  size: number;
  metadata: Record<string, string>;
  /** As GCS: a new generation per write of the bytes, a new metageneration per metadata change. */
  generation?: string;
  metageneration?: string;
  timeCreated?: string;
  updated?: string;
}

/** The shape @google-cloud/storage throws for a missing object, which callers may check. */
function notFound(objectName: string): Error & { code: number } {
  return Object.assign(new Error(`No such object: ${objectName}`), { code: 404 });
}

/** The shape GCS returns when a generation or metageneration precondition fails. */
function preconditionFailed(objectName: string): Error & { code: number } {
  return Object.assign(new Error(`Precondition failed: ${objectName}`), { code: 412 });
}

// Generations only need to be unique and increasing within a double's life;
// microseconds since the epoch, bumped on a tie, give both.
let lastGeneration = 0;
function nextGeneration(): string {
  lastGeneration = Math.max(lastGeneration + 1, Date.now() * 1000);
  return String(lastGeneration);
}

type Preconditions = { ifGenerationMatch?: number | string; ifMetagenerationMatch?: number | string };

class LocalFile {
  constructor(
    readonly name: string,
    private readonly dataPath: string,
    private readonly metaPath: string,
    /** A file handle pinned to one generation (`bucket.file(name, { generation })`). */
    private readonly generation?: string,
  ) {}

  /** The stored metadata; a missing object, or a pinned generation that is no longer current, is 404. */
  private async readMeta(): Promise<StoredMeta> {
    let meta: StoredMeta;
    try {
      meta = JSON.parse(await fsp.readFile(this.metaPath, "utf8")) as StoredMeta;
    } catch {
      throw notFound(this.name);
    }
    // The real bucket keeps no old generations (no object versioning), so a pinned
    // read of a replaced generation finds nothing.
    if (this.generation !== undefined && meta.generation !== this.generation) throw notFound(this.name);
    return meta;
  }

  private async check(pre: Preconditions | undefined): Promise<void> {
    if (pre?.ifGenerationMatch === undefined && pre?.ifMetagenerationMatch === undefined) return;
    let meta: StoredMeta | null = null;
    try {
      meta = await this.readMeta();
    } catch {
      meta = null;
    }
    if (pre.ifGenerationMatch !== undefined) {
      const want = String(pre.ifGenerationMatch);
      if (want === "0" ? meta !== null : meta?.generation !== want) throw preconditionFailed(this.name);
    }
    if (pre.ifMetagenerationMatch !== undefined && meta?.metageneration !== String(pre.ifMetagenerationMatch)) {
      throw preconditionFailed(this.name);
    }
  }

  get metadata(): StoredMeta {
    return this.listed ?? { size: 0, metadata: {} };
  }
  /** Set by `getFiles`, as the real client fills `File#metadata` from a listing. */
  listed?: StoredMeta;

  async exists(): Promise<[boolean]> {
    try {
      await this.readMeta();
      await fsp.access(this.dataPath);
      return [true];
    } catch {
      return [false];
    }
  }

  async getMetadata(): Promise<[StoredMeta]> {
    return [await this.readMeta()];
  }

  async setMetadata(update: { metadata?: Record<string, string | null> }, options?: Preconditions): Promise<[StoredMeta]> {
    await this.check(options);
    const meta = await this.readMeta();
    const merged: Record<string, string> = { ...meta.metadata };
    for (const [k, v] of Object.entries(update.metadata ?? {})) {
      if (v === null) delete merged[k];
      else merged[k] = v;
    }
    meta.metadata = merged;
    meta.metageneration = String(Number(meta.metageneration ?? "1") + 1);
    meta.updated = new Date().toISOString();
    await fsp.writeFile(this.metaPath, JSON.stringify(meta), { mode: 0o600 });
    return [meta];
  }

  /** Like a GCS upload, a save replaces the object and its custom metadata, unless a precondition refuses it. */
  async save(
    data: Buffer,
    options: { contentType?: string; metadata?: { metadata?: Record<string, string> }; preconditionOpts?: Preconditions } = {},
  ): Promise<void> {
    // Request-derived values reach here; refuse anything but bytes and a string type.
    if (!Buffer.isBuffer(data)) throw new TypeError("storage double: save() takes a Buffer");
    const contentType = options.contentType;
    if (contentType !== undefined && typeof contentType !== "string") {
      throw new TypeError("storage double: contentType must be a string");
    }
    await this.check(options.preconditionOpts);
    await this.write(data, contentType, options.metadata?.metadata ?? {});
  }

  private async write(data: Buffer, contentType: string | undefined, metadata: Record<string, string>): Promise<void> {
    await fsp.mkdir(path.dirname(this.dataPath), { recursive: true, mode: 0o700 });
    await fsp.mkdir(path.dirname(this.metaPath), { recursive: true, mode: 0o700 });
    await fsp.writeFile(this.dataPath, data, { mode: 0o600 });
    const now = new Date().toISOString();
    const meta: StoredMeta = {
      contentType,
      size: data.byteLength,
      metadata: { ...metadata },
      generation: nextGeneration(),
      metageneration: "1",
      timeCreated: now,
      updated: now,
    };
    await fsp.writeFile(this.metaPath, JSON.stringify(meta), { mode: 0o600 });
  }

  /**
   * A server-side copy, as GCS's rewrite: this file's bytes (its pinned
   * generation, if any) to `destination`, possibly in another bucket. Explicit
   * `metadata`/`contentType` replace the source's, as a rewrite with a
   * destination resource does; the destination's precondition is honoured.
   */
  async copy(
    destination: File,
    options: { contentType?: string; metadata?: Record<string, string>; preconditionOpts?: Preconditions } = {},
  ): Promise<[File]> {
    const meta = await this.readMeta();
    let bytes: Buffer;
    try {
      bytes = await fsp.readFile(this.dataPath);
    } catch {
      throw notFound(this.name);
    }
    const dest = destination as unknown as LocalFile;
    await dest.check(options.preconditionOpts);
    await dest.write(bytes, options.contentType ?? meta.contentType, options.metadata ?? meta.metadata);
    return [destination];
  }

  async download(): Promise<[Buffer]> {
    await this.readMeta();
    try {
      return [await fsp.readFile(this.dataPath)];
    } catch {
      throw notFound(this.name);
    }
  }

  createReadStream(): fs.ReadStream {
    return fs.createReadStream(this.dataPath);
  }

  async delete(options?: Preconditions & { ignoreNotFound?: boolean }): Promise<void> {
    await this.check(options);
    try {
      await this.readMeta();
      await fsp.unlink(this.dataPath);
    } catch {
      if (options?.ignoreNotFound) return;
      throw notFound(this.name);
    }
    await fsp.rm(this.metaPath, { force: true });
  }
}

/**
 * A key the filesystem cannot hold opaquely (an empty, `.` or `..` segment).
 * GCS stores such a key verbatim, so it is simply absent here: reads are
 * not-found, as they would be from the real bucket, and writes are refused.
 */
class AbsentFile {
  constructor(readonly name: string) {}
  async exists(): Promise<[boolean]> {
    return [false];
  }
  async getMetadata(): Promise<never> {
    throw notFound(this.name);
  }
  async setMetadata(): Promise<never> {
    throw notFound(this.name);
  }
  async download(): Promise<never> {
    throw notFound(this.name);
  }
  async delete(): Promise<never> {
    throw notFound(this.name);
  }
  createReadStream(): never {
    throw notFound(this.name);
  }
  async save(): Promise<never> {
    throw new Error(`storage double: refusing a key with an empty, "." or ".." segment: ${this.name}`);
  }
  async copy(): Promise<never> {
    throw notFound(this.name);
  }
}

/** Resolve `segment` under `base`, refusing anything that would escape it. */
function inside(base: string, ...segments: string[]): string {
  const resolved = path.resolve(base, ...segments);
  if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) {
    throw new Error(`storage double: path escapes its root: ${segments.join("/")}`);
  }
  return resolved;
}

/** The part of the GCS `Storage` client `objectStorage.ts` calls; both backends satisfy it. */
export type BucketClient = {
  bucket(name: string): {
    file(objectName: string, options?: { generation?: number | string }): File;
    getFiles(options?: { prefix?: string }): Promise<[File[], ...unknown[]]>;
  };
};

export class LocalObjectStorage implements BucketClient {
  private readonly root: string;

  constructor(root: string) {
    if (!path.isAbsolute(root)) {
      throw new Error(`storage double: STORAGE_DOUBLE_DIR must be absolute (got ${JSON.stringify(root)})`);
    }
    this.root = path.resolve(root);
  }

  bucket(bucketName: string): {
    file(objectName: string, options?: { generation?: number | string }): File;
    getFiles(options?: { prefix?: string }): Promise<[File[]]>;
  } {
    if (!bucketName || bucketName.includes("/") || bucketName === "." || bucketName === "..") {
      throw new Error(`storage double: invalid bucket name ${JSON.stringify(bucketName)}`);
    }
    const file = (objectName: string, options?: { generation?: number | string }): File => {
      // GCS keys are opaque: `public/../private/x` names no object there. A
      // filesystem would collapse it onto `private/x`, so refuse such keys.
      if (objectName.split("/").some((seg) => seg === "" || seg === "." || seg === "..")) {
        return new AbsentFile(objectName) as unknown as File;
      }
      const dataPath = inside(this.root, "data", bucketName, objectName);
      const metaPath = `${inside(this.root, "meta", bucketName, objectName)}.json`;
      const generation = options?.generation === undefined ? undefined : String(options.generation);
      // The callers are typed against @google-cloud/storage's File; this
      // implements the subset they use (asserted in the double's tests).
      return new LocalFile(objectName, dataPath, metaPath, generation) as unknown as File;
    };
    return {
      file,
      /** Every object under `prefix`, with `metadata` filled from the listing, in name order. */
      getFiles: async (options?: { prefix?: string }): Promise<[File[]]> => {
        const metaRoot = inside(this.root, "meta", bucketName);
        const names: string[] = [];
        const walk = async (dir: string): Promise<void> => {
          let entries: fs.Dirent[];
          try {
            entries = await fsp.readdir(dir, { withFileTypes: true });
          } catch {
            return;
          }
          for (const e of entries) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) await walk(full);
            else if (e.name.endsWith(".json")) names.push(path.relative(metaRoot, full).slice(0, -".json".length).split(path.sep).join("/"));
          }
        };
        await walk(metaRoot);
        const out: File[] = [];
        for (const name of names.sort()) {
          if (options?.prefix && !name.startsWith(options.prefix)) continue;
          const f = file(name) as unknown as LocalFile;
          try {
            [f.listed] = await f.getMetadata();
          } catch {
            continue; // removed between the walk and the read
          }
          out.push(f as unknown as File);
        }
        return [out];
      },
    };
  }
}

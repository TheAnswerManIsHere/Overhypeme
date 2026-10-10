/**
 * The local object-storage double (Launch Phase 2, increment 3; #631).
 *
 * Selected only by `STORAGE_BACKEND=local-double` (see `doubleSelection.ts`,
 * which refuses it in a production boot), it stands in for the one client
 * `objectStorage.ts` talks to: `Storage#bucket(name).file(objectName)`. It
 * implements exactly the File surface the codebase uses — `exists`,
 * `getMetadata`, `setMetadata`, `save`, `download`, `createReadStream`,
 * `delete` and `name` — and nothing else, so an unexpected call fails loudly
 * rather than silently succeeding.
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
}

/** The shape @google-cloud/storage throws for a missing object, which callers may check. */
function notFound(objectName: string): Error & { code: number } {
  return Object.assign(new Error(`No such object: ${objectName}`), { code: 404 });
}

class LocalFile {
  constructor(
    readonly name: string,
    private readonly dataPath: string,
    private readonly metaPath: string,
  ) {}

  async exists(): Promise<[boolean]> {
    try {
      await fsp.access(this.dataPath);
      return [true];
    } catch {
      return [false];
    }
  }

  private async readMeta(): Promise<StoredMeta> {
    try {
      return JSON.parse(await fsp.readFile(this.metaPath, "utf8")) as StoredMeta;
    } catch {
      throw notFound(this.name);
    }
  }

  async getMetadata(): Promise<[StoredMeta]> {
    return [await this.readMeta()];
  }

  async setMetadata(update: { metadata?: Record<string, string> }): Promise<[StoredMeta]> {
    const meta = await this.readMeta();
    meta.metadata = { ...meta.metadata, ...(update.metadata ?? {}) };
    await fsp.writeFile(this.metaPath, JSON.stringify(meta), { mode: 0o600 });
    return [meta];
  }

  /** Like a GCS upload, a save replaces the object and its custom metadata. */
  async save(data: Buffer, options: { contentType?: string } = {}): Promise<void> {
    // Request-derived values reach here; refuse anything but bytes and a string type.
    if (!Buffer.isBuffer(data)) throw new TypeError("storage double: save() takes a Buffer");
    const contentType = options.contentType;
    if (contentType !== undefined && typeof contentType !== "string") {
      throw new TypeError("storage double: contentType must be a string");
    }
    await fsp.mkdir(path.dirname(this.dataPath), { recursive: true, mode: 0o700 });
    await fsp.mkdir(path.dirname(this.metaPath), { recursive: true, mode: 0o700 });
    await fsp.writeFile(this.dataPath, data, { mode: 0o600 });
    const meta: StoredMeta = { contentType, size: data.byteLength, metadata: {} };
    await fsp.writeFile(this.metaPath, JSON.stringify(meta), { mode: 0o600 });
  }

  async download(): Promise<[Buffer]> {
    try {
      return [await fsp.readFile(this.dataPath)];
    } catch {
      throw notFound(this.name);
    }
  }

  createReadStream(): fs.ReadStream {
    return fs.createReadStream(this.dataPath);
  }

  async delete(): Promise<void> {
    try {
      await fsp.unlink(this.dataPath);
    } catch {
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
export type BucketClient = { bucket(name: string): { file(objectName: string): File } };

export class LocalObjectStorage implements BucketClient {
  private readonly root: string;

  constructor(root: string) {
    if (!path.isAbsolute(root)) {
      throw new Error(`storage double: STORAGE_DOUBLE_DIR must be absolute (got ${JSON.stringify(root)})`);
    }
    this.root = path.resolve(root);
  }

  bucket(bucketName: string): { file(objectName: string): File } {
    if (!bucketName || bucketName.includes("/") || bucketName === "." || bucketName === "..") {
      throw new Error(`storage double: invalid bucket name ${JSON.stringify(bucketName)}`);
    }
    return {
      file: (objectName: string): File => {
        // GCS keys are opaque: `public/../private/x` names no object there. A
        // filesystem would collapse it onto `private/x`, so refuse such keys.
        if (objectName.split("/").some((seg) => seg === "" || seg === "." || seg === "..")) {
          return new AbsentFile(objectName) as unknown as File;
        }
        const dataPath = inside(this.root, "data", bucketName, objectName);
        const metaPath = `${inside(this.root, "meta", bucketName, objectName)}.json`;
        // The callers are typed against @google-cloud/storage's File; this
        // implements the subset they use (asserted in the double's tests).
        return new LocalFile(objectName, dataPath, metaPath) as unknown as File;
      },
    };
  }
}

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
import type { File, Storage } from "@google-cloud/storage";

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
    await fsp.mkdir(path.dirname(this.dataPath), { recursive: true, mode: 0o700 });
    await fsp.mkdir(path.dirname(this.metaPath), { recursive: true, mode: 0o700 });
    await fsp.writeFile(this.dataPath, data, { mode: 0o600 });
    const meta: StoredMeta = { contentType: options.contentType, size: data.length, metadata: {} };
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

/** Resolve `segment` under `base`, refusing anything that would escape it. */
function inside(base: string, ...segments: string[]): string {
  const resolved = path.resolve(base, ...segments);
  if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) {
    throw new Error(`storage double: path escapes its root: ${segments.join("/")}`);
  }
  return resolved;
}

export class LocalObjectStorage {
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
        const dataPath = inside(this.root, "data", bucketName, objectName);
        const metaPath = `${inside(this.root, "meta", bucketName, objectName)}.json`;
        // The callers are typed against @google-cloud/storage's File; this
        // implements the subset they use (asserted in the double's tests).
        return new LocalFile(objectName, dataPath, metaPath) as unknown as File;
      },
    };
  }
}

/** The client `objectStorage.ts` uses under the double, typed as the part of `Storage` it calls. */
export type BucketClient = Pick<Storage, "bucket">;

export function localObjectStorageClient(root: string): BucketClient {
  return new LocalObjectStorage(root) as unknown as BucketClient;
}

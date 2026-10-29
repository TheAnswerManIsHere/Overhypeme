import { File } from "@google-cloud/storage";
import { Readable } from "stream";
import { storageClient } from "./storageClient";
import { ACL_POLICY_METADATA_KEY, ObjectAclPolicy, ObjectPermission, canAccessObject, getObjectAclPolicy } from "./objectAcl";
import { deletePreserved, setMetadataPreserved } from "./mediaBackup/preserve";

export { objectStorageClient } from "./storageClient";

export class ObjectNotFoundError extends Error {
  constructor() {
    super("Object not found");
    this.name = "ObjectNotFoundError";
    Object.setPrototypeOf(this, ObjectNotFoundError.prototype);
  }
}

export class ObjectStorageService {
  constructor() {}

  getPublicObjectSearchPaths(): Array<string> {
    const pathsStr = process.env.PUBLIC_OBJECT_SEARCH_PATHS || "";
    const paths = Array.from(
      new Set(
        pathsStr
          .split(",")
          .map((path) => path.trim())
          .filter((path) => path.length > 0)
      )
    );
    if (paths.length === 0) {
      throw new Error(
        "PUBLIC_OBJECT_SEARCH_PATHS not set. Create a bucket in 'Object Storage' " +
          "tool and set PUBLIC_OBJECT_SEARCH_PATHS env var (comma-separated paths)."
      );
    }
    return paths;
  }

  getPrivateObjectDir(): string {
    const dir = process.env.PRIVATE_OBJECT_DIR || "";
    if (!dir) {
      throw new Error(
        "PRIVATE_OBJECT_DIR not set. Create a bucket in 'Object Storage' " +
          "tool and set PRIVATE_OBJECT_DIR env var."
      );
    }
    return dir;
  }

  async searchPublicObject(filePath: string): Promise<File | null> {
    for (const searchPath of this.getPublicObjectSearchPaths()) {
      const fullPath = `${searchPath}/${filePath}`;

      const { bucketName, objectName } = parseObjectPath(fullPath);
      const bucket = storageClient().bucket(bucketName);
      const file = bucket.file(objectName);

      const [exists] = await file.exists();
      if (exists) {
        return file;
      }
    }

    return null;
  }

  async downloadObject(file: File, cacheTtlSec: number = 3600): Promise<Response> {
    const [metadata] = await file.getMetadata();
    const aclPolicy = await getObjectAclPolicy(file);
    const isPublic = aclPolicy?.visibility === "public";

    const nodeStream = file.createReadStream();
    const webStream = Readable.toWeb(nodeStream) as ReadableStream;

    const headers: Record<string, string> = {
      "Content-Type": (metadata.contentType as string) || "application/octet-stream",
      "Cache-Control": `${isPublic ? "public" : "private"}, max-age=${cacheTtlSec}`,
    };
    if (metadata.size) {
      headers["Content-Length"] = String(metadata.size);
    }

    return new Response(webStream, { headers });
  }

  /** The bucket and object name an `/objects/...` path names, or ObjectNotFoundError for anything else. */
  private resolveObjectEntity(objectPath: string): { bucketName: string; objectName: string } {
    if (!objectPath.startsWith("/objects/")) {
      throw new ObjectNotFoundError();
    }

    const parts = objectPath.slice(1).split("/");
    if (parts.length < 2) {
      throw new ObjectNotFoundError();
    }

    const entityId = parts.slice(1).join("/");
    let entityDir = this.getPrivateObjectDir();
    if (!entityDir.endsWith("/")) {
      entityDir = `${entityDir}/`;
    }
    return parseObjectPath(`${entityDir}${entityId}`);
  }

  async getObjectEntityFile(objectPath: string): Promise<File> {
    const { bucketName, objectName } = this.resolveObjectEntity(objectPath);
    const bucket = storageClient().bucket(bucketName);
    const objectFile = bucket.file(objectName);
    const [exists] = await objectFile.exists();
    if (!exists) {
      throw new ObjectNotFoundError();
    }
    return objectFile;
  }

  normalizeObjectEntityPath(rawPath: string): string {
    if (!rawPath.startsWith("https://storage.googleapis.com/")) {
      return rawPath;
    }

    const url = new URL(rawPath);
    const rawObjectPath = url.pathname;

    let objectEntityDir = this.getPrivateObjectDir();
    if (!objectEntityDir.endsWith("/")) {
      objectEntityDir = `${objectEntityDir}/`;
    }

    if (!rawObjectPath.startsWith(objectEntityDir)) {
      return rawObjectPath;
    }

    const entityId = rawObjectPath.slice(objectEntityDir.length);
    return `/objects/${entityId}`;
  }

  async trySetObjectEntityAclPolicy(
    rawPath: string,
    aclPolicy: ObjectAclPolicy
  ): Promise<string> {
    const normalizedPath = this.normalizeObjectEntityPath(rawPath);
    if (!normalizedPath.startsWith("/")) {
      return normalizedPath;
    }

    // Preserve-before-change: the state this rewrite replaces is copied to the
    // media backup first, and the rewrite is conditional on that state
    // (lib/mediaBackup/preserve.ts). A retryable error means nothing changed.
    const { bucketName, objectName } = this.resolveObjectEntity(normalizedPath);
    const outcome = await setMetadataPreserved(bucketName, objectName, {
      [ACL_POLICY_METADATA_KEY]: JSON.stringify(aclPolicy),
    });
    if (outcome === "absent") throw new ObjectNotFoundError();
    return normalizedPath;
  }

  async canAccessObjectEntity({
    userId,
    objectFile,
    requestedPermission,
  }: {
    userId?: string;
    objectFile: File;
    requestedPermission?: ObjectPermission;
  }): Promise<boolean> {
    return canAccessObject({
      userId,
      objectFile,
      requestedPermission: requestedPermission ?? ObjectPermission.READ,
    });
  }

  /**
   * Delete an object from storage by its /objects/... path.
   * Silently succeeds if the object does not exist (already gone = success).
   * Throws other errors as-is so callers can fail fast and abort DB mutations;
   * a `MediaBackupUnavailableError` or `MediaChangeConflictError` means the
   * object is untouched and the caller may retry shortly.
   *
   * The deleted state is copied to the media backup first, where it stays for
   * the retention window (lib/mediaBackup/preserve.ts); quarantined evidence is
   * never copied there.
   *
   * Refuses to delete `restricted/...` paths unless `force: true` is passed.
   * Quarantined evidence is preserved by `ncmec_reports.evidence_retention_until`
   * — only a future retention worker should ever pass `force`.
   */
  async deleteObject(objectPath: string, opts: { force?: boolean } = {}): Promise<void> {
    if (objectPath.includes("/restricted/") && !opts.force) {
      throw new Error(
        `Refusing to delete restricted/quarantine evidence at "${objectPath}". ` +
          `Pass { force: true } only from the retention worker after preservation expiry.`,
      );
    }
    let target: { bucketName: string; objectName: string };
    try {
      target = this.resolveObjectEntity(objectPath);
    } catch (err) {
      if (err instanceof ObjectNotFoundError) {
        return; // not an object path — nothing to delete
      }
      throw err;
    }
    await deletePreserved(target.bucketName, target.objectName);
  }

  /**
   * Upload bytes into the restricted moderation prefix. NEVER routes through
   * the public/private object handlers — `routes/storage.ts` 404's any
   * request that begins with `restricted/`. ACL is private with a synthetic
   * `system:quarantine` owner so no end-user is the legal "owner" of CSAM
   * evidence.
   */
  async uploadRestrictedObjectBuffer({
    subPath,
    buffer,
    contentType,
  }: {
    subPath: string;
    buffer: Buffer;
    contentType: string;
  }): Promise<string> {
    if (!subPath.startsWith("restricted/")) {
      throw new Error(`uploadRestrictedObjectBuffer requires a subPath beginning with "restricted/" (got "${subPath}")`);
    }
    return this.uploadObjectBuffer({ subPath, buffer, contentType });
  }

  /**
   * Store a new object. Write-once: a key that already holds an object is
   * refused (412 from the storage service) rather than replaced, so a retried
   * or repeated write can never destroy a state the media backup has not
   * preserved. An intended replacement deletes first, through the preserving
   * path. `aclPolicy` is set in the same write, so a new object's first state
   * is its final one and needs no preservation.
   */
  async uploadObjectBuffer({
    subPath,
    buffer,
    contentType,
    aclPolicy,
  }: {
    subPath: string;
    buffer: Buffer;
    contentType: string;
    aclPolicy?: ObjectAclPolicy;
  }): Promise<string> {
    const privateObjectDir = this.getPrivateObjectDir();
    if (!privateObjectDir) {
      throw new Error(
        "PRIVATE_OBJECT_DIR not set. Create a bucket in 'Object Storage' " +
          "tool and set PRIVATE_OBJECT_DIR env var."
      );
    }

    let dir = privateObjectDir;
    if (!dir.endsWith("/")) dir = `${dir}/`;
    const fullPath = `${dir}${subPath}`;

    const { bucketName, objectName } = parseObjectPath(fullPath);
    const bucket = storageClient().bucket(bucketName);
    const file = bucket.file(objectName);

    await file.save(buffer, {
      contentType,
      resumable: false,
      ...(aclPolicy ? { metadata: { metadata: { [ACL_POLICY_METADATA_KEY]: JSON.stringify(aclPolicy) } } } : {}),
      preconditionOpts: { ifGenerationMatch: 0 },
    });

    return `/objects/${subPath}`;
  }
}

function parseObjectPath(path: string): {
  bucketName: string;
  objectName: string;
} {
  if (!path.startsWith("/")) {
    path = `/${path}`;
  }
  const pathParts = path.split("/");
  if (pathParts.length < 3) {
    throw new Error("Invalid path: must contain at least a bucket name");
  }

  const bucketName = pathParts[1];
  const objectName = pathParts.slice(2).join("/");

  return {
    bucketName,
    objectName,
  };
}

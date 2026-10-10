/**
 * The local object-storage double (lib/localObjectStorage.ts), driven through
 * the real ObjectStorageService, ACL (objectAcl.ts) and access check
 * (objectAccess.ts) — the layers that run unchanged above it.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "storage-double-"));
process.env.STORAGE_BACKEND = "local-double";
process.env.STORAGE_DOUBLE_DIR = ROOT;
process.env.PRIVATE_OBJECT_DIR = "/test-bucket/private";
process.env.PUBLIC_OBJECT_SEARCH_PATHS = "/test-bucket/public";

const { ObjectStorageService, ObjectNotFoundError } = await import("../lib/objectStorage.js");
const { ObjectPermission } = await import("../lib/objectAcl.js");
const { LocalObjectStorage } = await import("../lib/localObjectStorage.js");

const svc = new ObjectStorageService();
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

describe("local storage double", () => {
  after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

  it("stores bytes under its own directory and returns the /objects path", async () => {
    const objectPath = await svc.uploadObjectBuffer({ subPath: "uploads/ab/one", buffer: PNG, contentType: "image/png" });
    assert.equal(objectPath, "/objects/uploads/ab/one");
    assert.deepEqual(fs.readFileSync(path.join(ROOT, "data/test-bucket/private/uploads/ab/one")), PNG);
  });

  it("serves the object with its stored type and size, and reads back the same bytes", async () => {
    const file = await svc.getObjectEntityFile("/objects/uploads/ab/one");
    const [bytes] = await file.download();
    assert.deepEqual(bytes, PNG);
    await svc.trySetObjectEntityAclPolicy("/objects/uploads/ab/one", { owner: "user-a", visibility: "private" });
    const response = await svc.downloadObject(file, 60);
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.equal(response.headers.get("content-length"), String(PNG.length));
    assert.equal(response.headers.get("cache-control"), "private, max-age=60");
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), PNG);
  });

  it("applies the real ACL: the owner reads a private object, nobody else does", async () => {
    const file = await svc.getObjectEntityFile("/objects/uploads/ab/one");
    assert.equal(await svc.canAccessObjectEntity({ userId: "user-a", objectFile: file }), true);
    assert.equal(await svc.canAccessObjectEntity({ userId: "user-b", objectFile: file }), false);
    assert.equal(await svc.canAccessObjectEntity({ objectFile: file }), false);
  });

  it("a public object is readable by anyone, writable only by its owner", async () => {
    await svc.uploadObjectBuffer({ subPath: "exports/pub", buffer: PNG, contentType: "image/png" });
    await svc.trySetObjectEntityAclPolicy("/objects/exports/pub", { owner: "user-a", visibility: "public" });
    const file = await svc.getObjectEntityFile("/objects/exports/pub");
    assert.equal(await svc.canAccessObjectEntity({ objectFile: file }), true);
    assert.equal(
      await svc.canAccessObjectEntity({ userId: "user-b", objectFile: file, requestedPermission: ObjectPermission.WRITE }),
      false,
    );
  });

  it("an object with no ACL policy is unreadable, as with the real bucket", async () => {
    await svc.uploadObjectBuffer({ subPath: "uploads/no-acl", buffer: PNG, contentType: "image/png" });
    const file = await svc.getObjectEntityFile("/objects/uploads/no-acl");
    assert.equal(await svc.canAccessObjectEntity({ userId: "user-a", objectFile: file }), false);
  });

  it("a re-upload replaces the bytes and clears the old ACL", async () => {
    await svc.uploadObjectBuffer({ subPath: "uploads/ab/one", buffer: Buffer.from("new"), contentType: "text/plain" });
    const file = await svc.getObjectEntityFile("/objects/uploads/ab/one");
    assert.equal(await svc.canAccessObjectEntity({ userId: "user-a", objectFile: file }), false);
  });

  it("a missing object is ObjectNotFoundError, and deleting it is a no-op", async () => {
    await assert.rejects(svc.getObjectEntityFile("/objects/uploads/never"), ObjectNotFoundError);
    await svc.deleteObject("/objects/uploads/never");
  });

  it("deletes bytes and metadata", async () => {
    await svc.deleteObject("/objects/exports/pub");
    await assert.rejects(svc.getObjectEntityFile("/objects/exports/pub"), ObjectNotFoundError);
    assert.equal(fs.existsSync(path.join(ROOT, "meta/test-bucket/private/exports/pub.json")), false);
  });

  it("still refuses to delete quarantine evidence without force", async () => {
    await assert.rejects(svc.deleteObject("/objects/restricted/x"), /Refusing to delete restricted/);
  });

  it("finds public objects under the search paths", async () => {
    const client = new LocalObjectStorage(ROOT);
    await client.bucket("test-bucket").file("public/logo.png").save(PNG, { contentType: "image/png" });
    const found = await svc.searchPublicObject("logo.png");
    assert.ok(found, "the public object is found");
    assert.equal(await svc.searchPublicObject("absent.png"), null);
  });

  it("refuses a path that would escape its directory", () => {
    const client = new LocalObjectStorage(ROOT);
    assert.throws(() => client.bucket("test-bucket").file("../../../etc/passwd"), /escapes its root/);
    assert.throws(() => client.bucket(".."), /invalid bucket name/);
  });

  it("refuses to sign URLs, visibly", async () => {
    await assert.rejects(svc.getObjectEntityUploadURL(), /signed URLs are not available/);
    await assert.rejects(svc.getObjectEntityDownloadURL("uploads/ab/one"), /signed URLs are not available/);
  });

  it("is refused at the point of use in a production environment", async () => {
    const saved = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      await assert.rejects(svc.getObjectEntityFile("/objects/uploads/ab/one"), /production boot refuses/);
    } finally {
      process.env.NODE_ENV = saved;
    }
  });
});

describe("the double implements the File surface the codebase calls", () => {
  let root: string;
  before(() => (root = fs.mkdtempSync(path.join(os.tmpdir(), "storage-double-surface-"))));
  after(() => fs.rmSync(root, { recursive: true, force: true }));

  it("has every method objectStorage.ts, objectAcl.ts and the routes use", () => {
    const file = new LocalObjectStorage(root).bucket("b").file("o") as unknown as Record<string, unknown>;
    for (const method of ["exists", "getMetadata", "setMetadata", "save", "download", "createReadStream", "delete"]) {
      assert.equal(typeof file[method], "function", `File.${method}`);
    }
    assert.equal(file.name, "o");
  });
});

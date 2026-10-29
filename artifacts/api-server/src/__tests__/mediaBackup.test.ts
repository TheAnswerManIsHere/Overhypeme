/**
 * The media backup (Launch Phase 3, increment 5; plan §4 and its Testing Plan,
 * "The recurring recovery, exercised"), on the local storage double, whose
 * generations and preconditions behave as GCS's do:
 *
 *   - preserve-before-change: a delete or ACL change copies the state it
 *     destroys first, conditional on that same state, and is refused with a
 *     retryable error when it cannot be copied;
 *   - pairs: make a pair, change one existing object's ACL, delete another,
 *     make another pair; each supported pair restores with its own bytes and
 *     access rules;
 *   - a failed capture and an unpreserved change inside a window neither
 *     produce a falsely completed pair nor advance the recovery point;
 *   - expiry keeps what retained pairs need and removes the rest.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "media-backup-"));
const LIVE = "live-bucket";
const BACKUP = "backup-bucket";
const ENV = {
  STORAGE_BACKEND: "local-double",
  STORAGE_DOUBLE_DIR: ROOT,
  PRIVATE_OBJECT_DIR: `/${LIVE}/private`,
  PUBLIC_OBJECT_SEARCH_PATHS: `/${LIVE}/public`,
  MEDIA_BACKUP_BUCKET: BACKUP,
};

const { ObjectStorageService, ObjectNotFoundError } = await import("../lib/objectStorage.js");
const { LocalObjectStorage } = await import("../lib/localObjectStorage.js");
const { getObjectAclPolicy } = await import("../lib/objectAcl.js");
const { changeObject, MediaBackupUnavailableError, MediaChangeConflictError, stateKey, tombstoneKey, isExcludedFromBackup } = await import(
  "../lib/mediaBackup/preserve.js"
);
const { backupStatus, capturePair, latestCompletedPair, pickState } = await import("../lib/mediaBackup/capture.js");
const { restorePairMedia, restoreTargetRefusal } = await import("../lib/mediaBackup/restore.js");
const { runBackupExpiry } = await import("../lib/mediaBackup/expiry.js");
const { backupBucket, preservation } = await import("../lib/mediaBackup/config.js");

const svc = new ObjectStorageService();
const storage = new LocalObjectStorage(ROOT);
const bytes = (s: string) => Buffer.from(s);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const live = (name: string) => storage.bucket(LIVE).file(`private/${name}`);
async function state(name: string) {
  const [m] = await live(name).getMetadata();
  return { generation: String(m.generation), metageneration: String(m.metageneration) };
}
async function backupHas(key: string) {
  return (await storage.bucket(BACKUP).file(key).exists())[0];
}
const capture = (extra: Partial<Parameters<typeof capturePair>[0]> = {}) =>
  capturePair({ backupBucket: BACKUP, sourceBucket: LIVE, environment: "test", databaseUrl: process.env.DATABASE_URL, dump: false, ...extra });

describe("media backup", () => {
  const saved: Record<string, string | undefined> = {};
  before(() => {
    for (const [k, v] of Object.entries(ENV)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
  });
  after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(ROOT, { recursive: true, force: true });
  });

  describe("configuration", () => {
    it("is enforced when a backup bucket is named, off in development without one, unavailable in production without one", () => {
      assert.deepEqual(preservation(), { mode: "enforced", bucket: BACKUP });
      assert.deepEqual(preservation({ PRIVATE_OBJECT_DIR: `/${LIVE}/private` }), { mode: "off" });
      assert.equal(preservation({ NODE_ENV: "production" }).mode, "unavailable");
      assert.equal(preservation({ REPLIT_DEPLOYMENT: "1" }).mode, "unavailable");
    });

    it("refuses the live bucket, or a malformed name, as the backup", () => {
      assert.throws(() => backupBucket({ ...ENV, MEDIA_BACKUP_BUCKET: LIVE }), /names the live bucket/);
      assert.throws(() => backupBucket({ ...ENV, MEDIA_BACKUP_BUCKET: "a/b" }), /not a bucket name/);
    });

    it("never backs up child-safety evidence, snapshots or rehearsal restores", () => {
      assert.equal(isExcludedFromBackup("private/restricted/q/1.jpg"), true);
      assert.equal(isExcludedFromBackup("private/_snapshots/x/database.dump"), true);
      assert.equal(isExcludedFromBackup("_restores/r1/private/uploads/a"), true);
      assert.equal(isExcludedFromBackup("private/uploads/a"), false);
    });
  });

  describe("preserve-before-change", () => {
    it("an ACL change copies the state it replaces, bytes and ACL, before changing it", async () => {
      await svc.uploadObjectBuffer({ subPath: "uploads/p1", buffer: bytes("one"), contentType: "image/png", aclPolicy: { owner: "u1", visibility: "private" } });
      const before = await state("uploads/p1");
      await svc.trySetObjectEntityAclPolicy("/objects/uploads/p1", { owner: "u1", visibility: "public" });
      const key = stateKey(LIVE, "private/uploads/p1", before.generation, before.metageneration);
      const copy = storage.bucket(BACKUP).file(key);
      assert.deepEqual((await copy.download())[0], bytes("one"));
      const [meta] = await copy.getMetadata();
      assert.deepEqual(JSON.parse(String(meta.metadata?.["backup:sourceMetadata"])), {
        "custom:aclPolicy": JSON.stringify({ owner: "u1", visibility: "private" }),
      });
      assert.equal(meta.metadata?.["custom:aclPolicy"], undefined, "the backup copy carries no ACL of its own");
      assert.equal((await getObjectAclPolicy(live("uploads/p1")))?.visibility, "public");
    });

    it("a delete copies the state first, then deletes it and leaves a tombstone", async () => {
      await svc.uploadObjectBuffer({ subPath: "uploads/p2", buffer: bytes("two"), contentType: "image/png", aclPolicy: { owner: "u1", visibility: "private" } });
      const s = await state("uploads/p2");
      await svc.deleteObject("/objects/uploads/p2");
      assert.equal((await live("uploads/p2").exists())[0], false);
      assert.equal(await backupHas(stateKey(LIVE, "private/uploads/p2", s.generation, s.metageneration)), true);
      assert.equal(await backupHas(tombstoneKey(LIVE, "private/uploads/p2", s.generation)), true);
    });

    it("deleting an object that does not exist is still a no-op", async () => {
      await svc.deleteObject("/objects/uploads/never-was");
      await assert.rejects(svc.trySetObjectEntityAclPolicy("/objects/uploads/never-was", { owner: "u", visibility: "public" }), ObjectNotFoundError);
    });

    it("refuses the change, untouched, when the prior state cannot be copied", async () => {
      await svc.uploadObjectBuffer({ subPath: "uploads/p3", buffer: bytes("three"), contentType: "image/png", aclPolicy: { owner: "u1", visibility: "private" } });
      // A backup bucket the double cannot write: its data directory is a file.
      fs.writeFileSync(path.join(ROOT, "data", "broken-backup"), "");
      process.env.MEDIA_BACKUP_BUCKET = "broken-backup";
      try {
        await assert.rejects(svc.deleteObject("/objects/uploads/p3"), MediaBackupUnavailableError);
        await assert.rejects(
          svc.trySetObjectEntityAclPolicy("/objects/uploads/p3", { owner: "u1", visibility: "public" }),
          MediaBackupUnavailableError,
        );
      } finally {
        process.env.MEDIA_BACKUP_BUCKET = BACKUP;
      }
      assert.equal((await live("uploads/p3").exists())[0], true, "the photo is still there");
      assert.equal((await getObjectAclPolicy(live("uploads/p3")))?.visibility, "private", "and still private");
    });

    it("acts on the state it preserved: a change in between fails the condition and is retried, every state preserved", async () => {
      await svc.uploadObjectBuffer({ subPath: "uploads/p4", buffer: bytes("four"), contentType: "image/png", aclPolicy: { owner: "u1", visibility: "private" } });
      let interfere = 2;
      await changeObject(LIVE, "private/uploads/p4", async (file, current) => {
        if (interfere-- > 0) await file.setMetadata({ metadata: { note: `meanwhile ${interfere}` } }); // another writer
        await file.setMetadata({ metadata: { done: "yes" } }, { ifMetagenerationMatch: current.metageneration } as never);
      });
      const [meta] = await live("uploads/p4").getMetadata();
      assert.equal(meta.metadata?.done, "yes");
      // Metagenerations 1, 2 (after the first interference) and 3 (after the second) were each preserved before an attempt.
      for (const m of ["1", "2", "3"]) {
        assert.equal(await backupHas(stateKey(LIVE, "private/uploads/p4", String(meta.generation), m)), true, `m${m}`);
      }
    });

    it("an ACL change never lands on a replacement at the same name: it is retried, and the replacement's first state preserved", async () => {
      await svc.uploadObjectBuffer({ subPath: "uploads/p6", buffer: bytes("old"), contentType: "image/png", aclPolicy: { owner: "u1", visibility: "private" } });
      const original = await state("uploads/p6");
      // Between preservation and the change, the object is deleted and recreated: metageneration 1 again.
      let replaced = false;
      const { setMetadataPreserved } = await import("../lib/mediaBackup/preserve.js");
      const file = live("uploads/p6");
      const origSetMetadata = Object.getPrototypeOf(file).setMetadata;
      Object.getPrototypeOf(file).setMetadata = async function (this: unknown, ...args: unknown[]) {
        if (!replaced) {
          replaced = true;
          await live("uploads/p6").delete();
          await live("uploads/p6").save(bytes("new"), { contentType: "image/png", metadata: { metadata: { "custom:aclPolicy": JSON.stringify({ owner: "u9", visibility: "private" }) } } });
        }
        return origSetMetadata.apply(this, args);
      };
      try {
        await setMetadataPreserved(LIVE, "private/uploads/p6", { "custom:aclPolicy": JSON.stringify({ owner: "u9", visibility: "public" }) });
      } finally {
        Object.getPrototypeOf(file).setMetadata = origSetMetadata;
      }
      const replacement = await state("uploads/p6");
      assert.notEqual(replacement.generation, original.generation);
      assert.equal(await backupHas(stateKey(LIVE, "private/uploads/p6", original.generation, "1")), true, "the original's state preserved");
      assert.equal(await backupHas(stateKey(LIVE, "private/uploads/p6", replacement.generation, "1")), true, "the replacement's first state preserved before the change");
      assert.equal((await getObjectAclPolicy(live("uploads/p6")))?.visibility, "public");
      assert.deepEqual((await live("uploads/p6").download())[0], bytes("new"));
    });

    it("gives up with a retryable conflict when the object keeps changing", async () => {
      await svc.uploadObjectBuffer({ subPath: "uploads/p5", buffer: bytes("five"), contentType: "image/png" });
      await assert.rejects(
        changeObject(LIVE, "private/uploads/p5", async (file, current) => {
          await file.setMetadata({ metadata: { meanwhile: String(Math.random()) } });
          await file.setMetadata({ metadata: { done: "yes" } }, { ifMetagenerationMatch: current.metageneration } as never);
        }),
        MediaChangeConflictError,
      );
    });

    it("leaves quarantined evidence out of the backup, and still refuses to delete it without force", async () => {
      await svc.uploadRestrictedObjectBuffer({ subPath: "restricted/q1.jpg", buffer: bytes("evidence"), contentType: "image/jpeg" });
      await assert.rejects(svc.deleteObject("/objects/restricted/q1.jpg"), /Refusing to delete restricted/);
      const [copies] = await storage.bucket(BACKUP).getFiles({ prefix: "states/" });
      assert.equal(copies.some((f) => f.name.includes("restricted")), false);
    });
  });

  describe("pairs and restores", () => {
    it("chooses the state current at the window's start, or an object's first state when it was created inside the window; a change between the marks is ambiguous", () => {
      const s = (gen: string, m: string, created: string, updated: string) => ({
        name: "n", generation: gen, metageneration: m, timeCreated: created, updated, contentType: null, size: 0, md5Hash: null, metadata: {},
      });
      const t = (sec: number) => new Date(Date.UTC(2026, 9, 29, 0, 0, sec)).toISOString();
      const start = t(10);
      const end = t(20);
      // A state at the start, then a change before the snapshot's mark: either could be the database's.
      assert.deepEqual(pickState([s("1", "1", t(0), t(0)), s("1", "2", t(0), t(15))], new Map(), start, end), { ambiguous: true });
      // The same change after the snapshot's mark: not in the snapshot, so the state at the start.
      assert.deepEqual(pickState([s("1", "1", t(0), t(0)), s("1", "2", t(0), t(25))], new Map(), start, end), { pick: s("1", "1", t(0), t(0)) });
      // Changed after the mark with the start state never preserved: unpreserved.
      assert.deepEqual(pickState([s("1", "2", t(0), t(25))], new Map(), start, end), { unpreserved: true });
      // Created and promoted inside the window: ambiguous; created alone inside it: its first state.
      assert.deepEqual(pickState([s("1", "1", t(12), t(12)), s("1", "2", t(12), t(14))], new Map(), start, end), { ambiguous: true });
      assert.deepEqual(pickState([s("1", "1", t(12), t(12))], new Map(), start, end), { pick: s("1", "1", t(12), t(12)) });
      // A new generation replacing one live at the start, inside the window: ambiguous.
      assert.deepEqual(pickState([s("1", "1", t(0), t(0)), s("2", "1", t(15), t(15))], new Map([["1", t(14)]]), start, end), { ambiguous: true });
      assert.equal(pickState([s("1", "1", t(25), t(25))], new Map(), start, end), null);
      assert.equal(pickState([s("1", "1", t(0), t(0))], new Map([["1", t(1)]]), start, end, 0), null, "deleted before the window");
      assert.ok(pickState([s("1", "1", t(0), t(0))], new Map([["1", t(9)]]), start, end, 5000), "deleted within the grace");
    });

    let pair1: Awaited<ReturnType<typeof capturePair>>;
    let pair2: Awaited<ReturnType<typeof capturePair>>;

    it("make a pair; change one object's ACL and delete another; make another pair; each restores as it was", async () => {
      await svc.uploadObjectBuffer({ subPath: "uploads/a", buffer: bytes("A"), contentType: "image/png", aclPolicy: { owner: "u1", visibility: "public" } });
      await svc.uploadObjectBuffer({ subPath: "uploads/b", buffer: bytes("B"), contentType: "image/png", aclPolicy: { owner: "u2", visibility: "private" } });
      await sleep(5);
      pair1 = await capture();
      assert.equal(pair1.status, "completed", pair1.reasons.join("; "));
      assert.ok(pair1.objects.some((o) => o.name === "private/uploads/a"));
      assert.ok(!pair1.objects.some((o) => o.name.includes("restricted")), "evidence excluded");

      await sleep(5);
      await svc.trySetObjectEntityAclPolicy("/objects/uploads/a", { owner: "u1", visibility: "private" });
      await svc.deleteObject("/objects/uploads/b");
      await sleep(5);
      pair2 = await capture({ deletionGraceMs: 0 });
      assert.equal(pair2.status, "completed", pair2.reasons.join("; "));
      assert.equal(pair2.objects.some((o) => o.name === "private/uploads/b"), false, "b was deleted before pair 2");

      const r1 = await restorePairMedia(BACKUP, pair1, { bucket: LIVE, prefix: "_restores/pair1" });
      const r2 = await restorePairMedia(BACKUP, pair2, { bucket: LIVE, prefix: "_restores/pair2" });
      assert.equal(r1.restored, pair1.objects.length);
      assert.equal(r2.restored, pair2.objects.length);
      // Each pair lands in its own folder under the root it was given.
      assert.equal(r1.target, `/${LIVE}/_restores/pair1/${pair1.pairId}`);
      const at = (prefix: string, name: string) =>
        storage.bucket(LIVE).file(`_restores/${prefix}/${(prefix === "pair1" ? pair1 : pair2).pairId}/private/uploads/${name}`);
      assert.deepEqual((await at("pair1", "a").download())[0], bytes("A"));
      assert.equal((await getObjectAclPolicy(at("pair1", "a")))?.visibility, "public", "pair 1: a was public");
      assert.deepEqual((await at("pair1", "b").download())[0], bytes("B"));
      assert.deepEqual(await getObjectAclPolicy(at("pair1", "b")), { owner: "u2", visibility: "private" });
      assert.equal((await getObjectAclPolicy(at("pair2", "a")))?.visibility, "private", "pair 2: a had become private");
      assert.equal((await at("pair2", "b").exists())[0], false);
      // The live objects are untouched by either restore.
      assert.equal((await getObjectAclPolicy(live("uploads/a")))?.visibility, "private");
      assert.equal((await live("uploads/b").exists())[0], false);
    });

    it("a change between the window opening and the database snapshot makes the pair incomplete; the recovery point does not advance", async () => {
      await svc.uploadObjectBuffer({ subPath: "uploads/c", buffer: bytes("C"), contentType: "image/png", aclPolicy: { owner: "u3", visibility: "private" } });
      await sleep(5);
      const settled = await capture();
      assert.equal(settled.status, "completed", settled.reasons.join("; "));
      const before = await latestCompletedPair(BACKUP, "test");
      await sleep(5);
      // A profile-photo promotion landing after the window opens and before the snapshot is fixed.
      const pair = await capture({
        beforeDatabasePoint: async () => {
          await sleep(5);
          await svc.trySetObjectEntityAclPolicy("/objects/uploads/c", { owner: "u3", visibility: "public" });
          await sleep(5);
        },
      });
      assert.equal(pair.status, "incomplete");
      assert.ok(pair.reasons.includes("changed while the database point was taken: private/uploads/c"), pair.reasons.join("; "));
      assert.deepEqual(await latestCompletedPair(BACKUP, "test"), before);
      // The next pair, with no change in its window, is whole and holds the change.
      await sleep(5);
      const next = await capture();
      assert.equal(next.status, "completed", next.reasons.join("; "));
      const c = next.objects.find((o) => o.name === "private/uploads/c")!;
      assert.equal(JSON.parse(c.metadata["custom:aclPolicy"]).visibility, "public");
    });

    it("a change after the database snapshot is not in the pair: it completes with the state the snapshot saw", async () => {
      await svc.uploadObjectBuffer({ subPath: "uploads/e", buffer: bytes("E"), contentType: "image/png", aclPolicy: { owner: "u5", visibility: "private" } });
      await sleep(5);
      await capture(); // e's private state is preserved
      await sleep(5);
      const pair = await capture({
        afterDatabasePoint: async () => {
          await sleep(5);
          await svc.trySetObjectEntityAclPolicy("/objects/uploads/e", { owner: "u5", visibility: "public" });
        },
      });
      assert.equal(pair.status, "completed", pair.reasons.join("; "));
      const e = pair.objects.find((o) => o.name === "private/uploads/e")!;
      assert.equal(JSON.parse(e.metadata["custom:aclPolicy"]).visibility, "private");
      const r = await restorePairMedia(BACKUP, pair, { bucket: LIVE, prefix: "_restores/after-snapshot" });
      const restored = storage.bucket(LIVE).file(`_restores/after-snapshot/${pair.pairId}/private/uploads/e`);
      assert.equal(r.restored, pair.objects.length);
      assert.equal((await getObjectAclPolicy(restored))?.visibility, "private", "restored as the snapshot saw it");
    });

    it("an unpreserved change inside a window makes the pair incomplete, and the recovery point does not advance", async () => {
      // An object no pair has copied yet, changed by a writer that skipped preservation.
      await svc.uploadObjectBuffer({ subPath: "uploads/d", buffer: bytes("D"), contentType: "image/png", aclPolicy: { owner: "u4", visibility: "private" } });
      const before = await latestCompletedPair(BACKUP, "test");
      await sleep(5);
      const pair = await capture({
        afterDatabasePoint: async () => {
          await sleep(5);
          await live("uploads/d").setMetadata({ metadata: { "custom:aclPolicy": JSON.stringify({ owner: "u4", visibility: "public" }) } });
        },
      });
      assert.equal(pair.status, "incomplete");
      assert.ok(pair.reasons.some((r) => r.includes("unpreserved change: private/uploads/d")), pair.reasons.join("; "));
      assert.deepEqual(await latestCompletedPair(BACKUP, "test"), before);
      await assert.rejects(restorePairMedia(BACKUP, pair, { bucket: LIVE, prefix: "_restores/never" }), /is incomplete/);
      // The next pair, whose window opens after the change, is whole again.
      await sleep(5);
      const next = await capture();
      assert.equal(next.status, "completed", next.reasons.join("; "));
    });

    it("a failed capture is recorded as incomplete and does not advance the recovery point", async () => {
      const before = await latestCompletedPair(BACKUP, "test");
      const pair = await capture({ databaseUrl: "postgres://nobody@127.0.0.1:1/none", dump: true });
      assert.equal(pair.status, "incomplete");
      assert.ok(pair.reasons.some((r) => r.startsWith("no database point")), pair.reasons.join("; "));
      assert.deepEqual(await latestCompletedPair(BACKUP, "test"), before);
      const status = await backupStatus(BACKUP, "test");
      assert.deepEqual(status.latestCompleted, before);
      assert.ok(status.failuresSince >= 1, "the failure is counted against the bound");
      assert.ok(status.dataLossBoundMs !== null && status.dataLossBoundMs >= 0);
    });

    it("a failing pg_dump never puts the database password in the manifest", { skip: !process.env.DATABASE_URL && "needs DATABASE_URL" }, async () => {
      const url = new URL(process.env.DATABASE_URL!);
      assert.ok(url.password, "the test database URL carries a password");
      // A pg_dump that fails after being handed its arguments, as a version mismatch would.
      const shim = fs.mkdtempSync(path.join(os.tmpdir(), "pg-dump-shim-"));
      fs.writeFileSync(path.join(shim, "pg_dump"), '#!/bin/sh\necho "pg_dump: error: server version mismatch" >&2\nexit 1\n', { mode: 0o755 });
      const savedPath = process.env.PATH;
      process.env.PATH = `${shim}:${savedPath}`;
      let pair: Awaited<ReturnType<typeof capturePair>>;
      try {
        pair = await capture({ dump: true });
      } finally {
        process.env.PATH = savedPath;
        fs.rmSync(shim, { recursive: true, force: true });
      }
      assert.match(String(pair.database.dumpError), /server version mismatch/, "the failure is still explained");
      const serialised = JSON.stringify(pair);
      assert.equal(serialised.includes(`:${url.password}@`), false, "no user:password@ in the manifest");
      assert.equal(serialised.includes(url.href), false, "the full URL is nowhere in the manifest");
      assert.equal(pair.status, "completed", "the pair still completes on the database time");
      assert.equal(pair.database.dump, null);
    });

    it("a failed listing is a recorded attempt: the pair is incomplete and counted, the recovery point unchanged", async () => {
      const before = await latestCompletedPair(BACKUP, "test");
      const proto = LocalObjectStorage.prototype as unknown as { bucket: (name: string) => Record<string, unknown> };
      const original = proto.bucket;
      proto.bucket = function (this: unknown, name: string) {
        const b = original.call(this, name);
        return name === LIVE ? { ...b, getFiles: async () => Promise.reject(new Error("listing unavailable")) } : b;
      };
      let pair: Awaited<ReturnType<typeof capturePair>>;
      try {
        pair = await capture();
      } finally {
        proto.bucket = original;
      }
      assert.equal(pair.status, "incomplete");
      assert.ok(pair.reasons.some((r) => r === "capture failed: listing unavailable"), pair.reasons.join("; "));
      assert.deepEqual(pair.objects, []);
      assert.deepEqual(await latestCompletedPair(BACKUP, "test"), before);
      const status = await backupStatus(BACKUP, "test");
      assert.ok(status.failuresSince >= 1, "the failed attempt is counted");
    });

    it("a pair always has a database point: without a database it is incomplete", async () => {
      const pair = await capture({ databaseUrl: undefined });
      assert.equal(pair.status, "incomplete");
      assert.ok(pair.reasons.includes("no database point: no database was given"));
    });

    it("every completed pair names its database time", async () => {
      const pair = await capture();
      assert.equal(pair.status, "completed", pair.reasons.join("; "));
      assert.ok(pair.database.at && Date.parse(pair.database.at) > 0);
      assert.equal(pair.database.dump, null);
    });

    it("refuses a restore that could land on live media or in the backup", () => {
      assert.match(String(restoreTargetRefusal({ bucket: LIVE, prefix: "private" })), /_restores/);
      assert.match(String(restoreTargetRefusal({ bucket: LIVE, prefix: "" })), /prefix is required/);
      assert.match(String(restoreTargetRefusal({ bucket: BACKUP, prefix: "_restores/x" })), /backup bucket/);
      assert.equal(restoreTargetRefusal({ bucket: "rehearsal-bucket", prefix: "r1" }), null);
      assert.equal(restoreTargetRefusal({ bucket: LIVE, prefix: "_restores/r1" }), null);
    });

    it("a restore never overwrites: re-running it finds its work present", async () => {
      const again = await restorePairMedia(BACKUP, pair1, { bucket: LIVE, prefix: "_restores/pair1" });
      assert.equal(again.restored, 0);
      assert.equal(again.alreadyPresent, pair1.objects.length);
    });

    it("another pair given the same root lands in its own folder: no blend, nothing of the first pair touched", async () => {
      const [beforeFiles] = await storage.bucket(LIVE).getFiles({ prefix: `_restores/pair1/${pair1.pairId}/` });
      const r = await restorePairMedia(BACKUP, pair2, { bucket: LIVE, prefix: "_restores/pair1" });
      assert.equal(r.target, `/${LIVE}/_restores/pair1/${pair2.pairId}`);
      assert.equal(r.restored, pair2.objects.length, "every object of pair 2 copied, none taken as present");
      assert.equal(r.alreadyPresent, 0);
      const [afterFiles] = await storage.bucket(LIVE).getFiles({ prefix: `_restores/pair1/${pair1.pairId}/` });
      assert.deepEqual(afterFiles.map((f) => f.name), beforeFiles.map((f) => f.name), "pair 1's folder unchanged");
      // b existed only in pair 1: it is not in pair 2's folder.
      assert.equal((await storage.bucket(LIVE).file(`_restores/pair1/${pair2.pairId}/private/uploads/b`).exists())[0], false);
      assert.equal((await getObjectAclPolicy(storage.bucket(LIVE).file(`_restores/pair1/${pair2.pairId}/private/uploads/a`)))?.visibility, "private");
    });

    it("takes a portable database dump inside the window when a database is given", { skip: !hasPgDump() && "pg_dump is not installed" }, async () => {
      const pair = await capture({ dump: true });
      assert.equal(pair.status, "completed", pair.reasons.join("; "));
      assert.ok(pair.database.dump && pair.database.dump.bytes > 0);
      assert.ok(pair.database.at);
      assert.ok(Date.parse(pair.database.at!) > 0);
    });

    it("expiry keeps what retained pairs need and the latest completed pair; removes older states, pairs and tombstones", async () => {
      const latest = (await latestCompletedPair(BACKUP, "test"))!;
      const dry = await runBackupExpiry({ backupBucket: BACKUP, now: new Date(Date.now() + 30 * 86_400_000), dryRun: true });
      assert.equal(dry.dryRun, true);
      assert.ok(dry.statesRemoved > 0);
      const [stillThere] = await storage.bucket(BACKUP).getFiles({ prefix: "states/" });
      assert.equal(stillThere.length, dry.statesKept + dry.statesRemoved, "a dry run deletes nothing");

      const result = await runBackupExpiry({ backupBucket: BACKUP, now: new Date(Date.now() + 30 * 86_400_000) });
      assert.equal(result.pairsKept, 1, "only the latest completed pair outlives the window");
      assert.deepEqual(await latestCompletedPair(BACKUP, "test"), latest);
      // The kept pair still restores in full.
      const { readManifest } = await import("../lib/mediaBackup/capture.js");
      const manifest = await readManifest(BACKUP, "test", latest.pairId);
      const r = await restorePairMedia(BACKUP, manifest, { bucket: LIVE, prefix: "_restores/after-expiry" });
      assert.equal(r.restored, manifest.objects.length);
      // Exactly the states the kept pair names survive; b's tombstone goes once no state of b is left.
      const named = new Set(manifest.objects.map((o) => o.backupKey));
      const [states] = await storage.bucket(BACKUP).getFiles({ prefix: "states/" });
      assert.deepEqual(states.map((f) => f.name).sort(), [...named].sort());
      const [stones] = await storage.bucket(BACKUP).getFiles({ prefix: "tombstones/" });
      const bKept = [...named].some((k) => k.includes("/private/uploads/b@"));
      assert.equal(stones.some((f) => f.name.includes("/private/uploads/b@")), bKept);
    });

    it("expiry inside the window removes nothing", async () => {
      const result = await runBackupExpiry({ backupBucket: BACKUP });
      assert.equal(result.statesRemoved + result.pairsRemoved + result.tombstonesRemoved, 0);
    });

    it("expiry refuses to run on the live bucket", async () => {
      await assert.rejects(runBackupExpiry({ backupBucket: LIVE }), /live bucket/);
    });
  });
});

function hasPgDump(): boolean {
  if (!process.env.DATABASE_URL) return false;
  try {
    execFileSync("pg_dump", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

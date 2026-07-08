/**
 * Security regression for C2 — the video-generator IDOR.
 *
 * `POST /videos/generate` accepted a caller-supplied `storagePath`, fetched that
 * private object, and re-hosted it on fal's public CDN with NO access check —
 * so a Legendary user could exfiltrate another user's private upload. The fix
 * routes every private-object read through the shared `userCanReadObject()`
 * (the same authorization `GET /storage/objects` uses).
 *
 * These tests exercise that shared authorization decision directly. The ACL
 * verdict (`canAccessObjectEntity`) reads GCS, so we pass a stub storage service
 * — the helper takes `svc` as a parameter — to isolate the security logic:
 * the ACL short-circuit, the DB-backed legacy upload-owner fallback (+ ACL
 * heal), and the deny paths that close the IDOR.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import type { Request } from "express";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db/schema";
import { sql, like } from "drizzle-orm";

import { userCanReadObject } from "../lib/objectAccess.js";
import type { ObjectStorageService } from "../lib/objectStorage.js";

const PREFIX = "tsec_vid_";
const OWNED_PATH = `/objects/uploads/${PREFIX}owned.jpg`;
const DUMMY_FILE = {} as unknown as Parameters<typeof userCanReadObject>[1];

// A stub ObjectStorageService with a controllable ACL verdict. userCanReadObject
// only calls canAccessObjectEntity and (on the heal path) trySetObjectEntityAclPolicy.
function stubSvc(aclVerdict: boolean, onHeal?: () => void): ObjectStorageService {
  return {
    canAccessObjectEntity: async () => aclVerdict,
    trySetObjectEntityAclPolicy: async (p: string) => { onHeal?.(); return p; },
  } as unknown as ObjectStorageService;
}

function reqAs(userId?: string): Request {
  return { user: userId ? { id: userId } : undefined } as unknown as Request;
}

let ownerId: string;
let otherId: string;

async function cleanup() {
  await db.execute(sql`DELETE FROM upload_image_metadata WHERE object_path LIKE ${`/objects/uploads/${PREFIX}%`}`);
  await db.delete(usersTable).where(like(usersTable.id, `${PREFIX}%`));
}

before(async () => {
  await cleanup();
  ownerId = `${PREFIX}${randomUUID()}`;
  otherId = `${PREFIX}${randomUUID()}`;
  await db.insert(usersTable).values([
    { id: ownerId, email: `${ownerId}@nope.test`, isActive: true },
    { id: otherId, email: `${otherId}@nope.test`, isActive: true },
  ]);
  await db.execute(sql`
    INSERT INTO upload_image_metadata (object_path, width, height, file_size_bytes, user_id)
    VALUES (${OWNED_PATH}, 100, 100, 1234, ${ownerId})
  `);
});
after(cleanup);

describe("C2: private-object read authorization", () => {
  it("allows when the object ACL grants read", async () => {
    // Public / ACL-owned objects are readable regardless of the upload table.
    const ok = await userCanReadObject(stubSvc(true), DUMMY_FILE, OWNED_PATH, reqAs(otherId));
    assert.equal(ok, true);
  });

  it("allows the legacy upload owner when the ACL denies, and heals the ACL", async () => {
    let healed = false;
    const ok = await userCanReadObject(stubSvc(false, () => { healed = true; }), DUMMY_FILE, OWNED_PATH, reqAs(ownerId));
    assert.equal(ok, true, "true owner must retain access via the legacy fallback");
    assert.equal(healed, true, "missing ACL should be healed for the true owner");
  });

  it("DENIES a different authenticated user when the ACL denies (IDOR closed)", async () => {
    const ok = await userCanReadObject(stubSvc(false), DUMMY_FILE, OWNED_PATH, reqAs(otherId));
    assert.equal(ok, false);
  });

  it("denies an unauthenticated caller when the ACL denies", async () => {
    const ok = await userCanReadObject(stubSvc(false), DUMMY_FILE, OWNED_PATH, reqAs(undefined));
    assert.equal(ok, false);
  });

  it("does not consult the upload-owner fallback for non-uploads paths", async () => {
    // The fallback is scoped to /objects/uploads/ — even the owner is denied for
    // a different prefix when the ACL denies.
    const ok = await userCanReadObject(stubSvc(false), DUMMY_FILE, `/objects/ai-backgrounds/${PREFIX}x.jpg`, reqAs(ownerId));
    assert.equal(ok, false);
  });
});

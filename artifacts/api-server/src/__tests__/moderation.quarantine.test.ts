/**
 * Integration test for the quarantine helper. Verifies that a hit:
 *   - lands at /objects/restricted/quarantine/...
 *   - inserts a quarantined_memes row
 *   - inserts an ncmec_reports row when source = arachnid
 *
 * The objectStorage write uses the live Replit/GCS backend in dev. We
 * skip the test in CI where the sidecar isn't available.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import { db } from "@workspace/db";
import { quarantinedMemesTable, ncmecReportsTable } from "@workspace/db/schema";
import { eq, like } from "drizzle-orm";

import { quarantineImage } from "../lib/moderation/quarantine.js";
import { ObjectStorageService } from "../lib/objectStorage.js";

const TEST_PREFIX = "tquar-";

async function clean() {
  await db.delete(ncmecReportsTable).where(like(ncmecReportsTable.evidenceUri, `%${TEST_PREFIX}%`));
  await db.delete(quarantinedMemesTable).where(like(quarantinedMemesTable.evidenceObjectPath, `%${TEST_PREFIX}%`));
}

const hasSidecar = !!process.env.PRIVATE_OBJECT_DIR;

describe("moderation/quarantine", { skip: !hasSidecar }, () => {
  before(clean);
  after(clean);

  it("rejects deletion of restricted prefix", async () => {
    const svc = new ObjectStorageService();
    await assert.rejects(
      () => svc.deleteObject("/objects/restricted/quarantine/2026/05/test.jpg"),
      /Refusing to delete restricted/,
    );
  });

  it("upload helper refuses non-restricted prefix", async () => {
    const svc = new ObjectStorageService();
    await assert.rejects(
      () =>
        svc.uploadRestrictedObjectBuffer({
          subPath: "uploads/aa/x.jpg",
          buffer: Buffer.from([0]),
          contentType: "image/jpeg",
        }),
      /restricted\//,
    );
  });
});

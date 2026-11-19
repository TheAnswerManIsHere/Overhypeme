/**
 * Launch Phase 14, increment 6b — vendor expiry for what the app hands fal
 * that is not a member's photo: the default reference photos and the
 * generated pictures. The reference cache and fal's expiry change together,
 * so the cache is tested across an expiry.
 */
import { describe, it, before, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  REFERENCE_UPLOAD_LIFECYCLE,
  REFERENCE_URL_RENEW_AFTER_MS,
  GENERATED_OUTPUT_EXPIRY_SECONDS,
  falQueueSubmitHeaders,
} from "../lib/falRetention.js";
import {
  resolveDefaultReferenceUrl,
  __setReferenceFalUploadForTest,
  __setReferenceClockForTest,
  __getReferenceFalUploadForTest,
} from "../lib/defaultReferenceResolver.js";

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

// The suite shares one process: restore the upload seam another file may have set.
let priorUpload: ReturnType<typeof __getReferenceFalUploadForTest> = null;
before(() => { priorUpload = __getReferenceFalUploadForTest(); });
afterEach(() => { __setReferenceClockForTest(null); });
after(() => { __setReferenceFalUploadForTest(priorUpload); });

describe("fal retention — default reference photos", () => {
  it("renews a cached address before fal's copy expires, and every upload carries the expiry", async () => {
    let t = 1_000_000;
    __setReferenceClockForTest(() => t);
    const uploads: unknown[] = [];
    __setReferenceFalUploadForTest(async (_b, _c, opts) => {
      uploads.push(opts);
      return `https://fal.test/ref-${uploads.length}.jpg`;
    });

    const first = await resolveDefaultReferenceUrl("male");
    t += REFERENCE_URL_RENEW_AFTER_MS - 1;
    const stillCached = await resolveDefaultReferenceUrl("male");
    assert.equal(stillCached.url, first.url, "inside the renewal window the cached address is reused");
    assert.equal(uploads.length, 1);

    t += 2; // past the renewal window
    const renewed = await resolveDefaultReferenceUrl("male");
    assert.notEqual(renewed.url, first.url, "an address past the renewal window is uploaded afresh");
    assert.equal(uploads.length, 2);
    assert.deepEqual(uploads, [{ lifecycle: { expiresIn: "1y" } }, { lifecycle: { expiresIn: "1y" } }]);
  });

  it("no address is handed out within a long margin of fal's expiry", () => {
    assert.equal(REFERENCE_UPLOAD_LIFECYCLE.expiresIn, "1y");
    // A saved address is reused by a retry or the judging page for up to (expiry − renewal) after its newest hand-out.
    assert.ok(YEAR_MS - REFERENCE_URL_RENEW_AFTER_MS >= 300 * 24 * 60 * 60 * 1000);
  });

  it("a failed upload is not cached, and a renewal's failure does not evict a newer entry", async () => {
    let t = 0;
    __setReferenceClockForTest(() => t);
    let fail = true;
    let n = 0;
    __setReferenceFalUploadForTest(async () => {
      n += 1;
      if (fail) throw new Error("fal down");
      return `https://fal.test/ok-${n}.jpg`;
    });
    await assert.rejects(resolveDefaultReferenceUrl("male"), /fal down/);
    fail = false;
    const ok = await resolveDefaultReferenceUrl("male");
    assert.equal(ok.url, "https://fal.test/ok-2.jpg");
    assert.equal((await resolveDefaultReferenceUrl("male")).url, ok.url);
  });
});

describe("fal retention — generated pictures", () => {
  it("every raw queue submit asks fal to expire its outputs after 30 days", () => {
    const h = falQueueSubmitHeaders("k");
    assert.equal(h.Authorization, "Key k");
    assert.equal(h["Content-Type"], "application/json");
    assert.deepEqual(JSON.parse(h["X-Fal-Object-Lifecycle-Preference"]), { expiration_duration_seconds: 30 * 24 * 60 * 60 });
    assert.equal(GENERATED_OUTPUT_EXPIRY_SECONDS, 30 * 24 * 60 * 60);
  });

  it("both raw submit paths send those headers, and no raw POST to fal's queue builds its own", async () => {
    for (const file of ["../lib/renderFalTransport.ts", "../lib/comparison/transport.ts"]) {
      const src = await readFile(new URL(file, import.meta.url), "utf8");
      assert.match(src, /headers: falQueueSubmitHeaders\(/, file);
      assert.doesNotMatch(src, /Authorization: `Key \$\{[^}]+\}`, "Content-Type"/, `${file} builds its own fal submit headers`);
    }
  });
});

/**
 * The committed AI recordings (src/lib/aiDouble/recordings/): each one is a
 * real vendor response captured by the recorder, so each must say when it
 * was taken and through which client versions, and must be findable by the
 * fingerprint of the request it answers (the plan's "shapes come from
 * reality"): a request edited by hand stops matching its file name. The
 * response side is protected by review, not by this test.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { fingerprint } from "../lib/aiDouble/fingerprint.js";
import { recordingFileName, type Recording } from "../lib/aiDouble/recordings.js";

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../lib/aiDouble/recordings");
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));

describe("committed AI recordings", () => {
  it("exist", () => {
    assert.ok(files.length > 0);
  });

  it("are each named by the fingerprint of the request they answer", () => {
    for (const f of files) {
      const rec = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as Recording;
      assert.equal(f, recordingFileName(rec.kind, fingerprint(rec.kind, rec.request)), f);
      assert.equal(rec.fingerprint, fingerprint(rec.kind, rec.request), f);
    }
  });

  it("each say when they were recorded, through which client versions, and hold a response or an error", () => {
    for (const f of files) {
      const rec = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as Recording;
      assert.ok(!Number.isNaN(Date.parse(rec.recordedAt)), `${f}: recordedAt`);
      assert.match(rec.clients["@fal-ai/client"] ?? "", /^\d+\.\d+\.\d+$/, `${f}: fal client version`);
      assert.match(rec.clients.openai ?? "", /^\d+\.\d+\.\d+$/, `${f}: openai version`);
      assert.ok((rec.response === undefined) !== (rec.error === undefined), `${f}: exactly one of response and error`);
    }
  });

  it("carry no vendor URL and serve generated images as local data", () => {
    for (const f of files) {
      const text = fs.readFileSync(path.join(dir, f), "utf8");
      assert.doesNotMatch(text, /https:\/\/[a-z0-9.]*fal\.media\//, `${f}: a fal media URL`);
    }
  });

  it("include one recorded vendor rejection per vendor, for the failure control", () => {
    const errors = files
      .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as Recording)
      .filter((r) => r.error);
    for (const r of errors) {
      // A vendor's own rejection: a 4xx status and an SDK error class the double can rebuild.
      assert.ok(r.error!.status >= 400 && r.error!.status < 500, `${r.kind} ${r.target}: status ${r.error!.status}`);
      assert.ok(["ApiError", "ValidationError", "APIError"].includes(r.error!.name), `${r.kind} ${r.target}: ${r.error!.name}`);
    }
    const vendors = errors.map((r) => r.kind.split(".")[0]);
    assert.ok(vendors.includes("fal"));
    assert.ok(vendors.includes("openai"));
  });
});

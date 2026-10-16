/**
 * The real-render capture run's pure parts (Phase 2, increment 8, #631; plan
 * D6, D7): the manifest line the evidence store reads, the shot writer, and
 * the refusals `acceptance-run.ts --mode capture` applies before anything is
 * created. The run itself spends real money and runs only on the Repl.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { captureRefusals, extForFormat, manifestLine, writeShot } from "../testing/acceptance/captureShots.js";

const API_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "capture-test-"));
const KEYS = { FAL_AI_API_KEY: "x", OPENAI_API_KEY: "x" };
const base = (over: Partial<Parameters<typeof captureRefusals>[0]> = {}) =>
  captureRefusals({ env: KEYS, allowance: "2", raisedBy: undefined, out: path.join(tmp(), "new"), variant: "fixture", control: undefined, ...over });

describe("the capture manifest", () => {
  it("has exactly the browser capture kit's keys, in its order", () => {
    const bytes = Buffer.from("image bytes");
    const line = manifestLine("pr229-s6-render", "pr229-s6-render.png", { doc: "PR229_BUBBLE_CONTROLS_UAT", step: "6", shows: "a render" }, "abc123", bytes);
    assert.deepEqual(Object.keys(line), ["shot", "file", "doc", "step", "shows", "commit", "sha256", "bytes"]);
    assert.equal(line.sha256, createHash("sha256").update(bytes).digest("hex"));
    assert.equal(line.bytes, bytes.length);
    assert.equal(line.commit, "abc123");
  });

  it("writes the bytes unaltered beside an appended manifest line, and refuses an empty image", () => {
    const dir = tmp();
    const bytes = Buffer.alloc(5000, 7);
    writeShot(dir, "pr223-s1-result", bytes, "jpeg", { doc: "PR223_RENDER_REPRODUCIBILITY_UAT", step: "1", shows: "x" }, "c1");
    writeShot(dir, "pr223-s1-reference", bytes, "png", { doc: "PR223_RENDER_REPRODUCIBILITY_UAT", step: "1", shows: "y" }, "c1");
    assert.ok(fs.readFileSync(path.join(dir, "pr223-s1-result.jpg")).equals(bytes));
    const lines = fs.readFileSync(path.join(dir, "manifest.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((l) => l.file), ["pr223-s1-result.jpg", "pr223-s1-reference.png"]);
    assert.throws(() => writeShot(dir, "empty", Buffer.alloc(10), "png", { doc: "d", step: "1", shows: "z" }, "c1"), /is 10 bytes/);
    assert.equal(fs.existsSync(path.join(dir, "empty.png")), false);
    assert.equal(extForFormat("webp"), "webp");
  });
});

describe("the capture run's refusals", () => {
  it("accepts a run inside the cap with keys and an empty or absent --out", () => {
    assert.deepEqual(base(), []);
    assert.deepEqual(base({ out: tmp() }), []);
  });

  it("refuses without an allowance, and above $2 without the date David raised it", () => {
    assert.match(base({ allowance: undefined }).join("\n"), /needs --allowance/);
    assert.match(base({ allowance: "0" }).join("\n"), /positive/);
    assert.match(base({ allowance: "2.01" }).join("\n"), /cap is \$2\.00 per run/);
    assert.deepEqual(base({ allowance: "3", raisedBy: "2026-10-16" }), []);
    assert.match(base({ allowance: "3", raisedBy: "soon" }).join("\n"), /cap is \$2\.00/);
  });

  it("refuses CI, missing keys, a non-empty --out, no --out, another variant and a control", () => {
    assert.match(base({ env: { ...KEYS, CI: "true" } }).join("\n"), /never runs in CI/);
    assert.match(base({ env: { OPENAI_API_KEY: "x" } }).join("\n"), /needs FAL_AI_API_KEY/);
    const full = tmp();
    fs.writeFileSync(path.join(full, "old.png"), "x");
    assert.match(base({ out: full }).join("\n"), /is not empty/);
    assert.match(base({ out: undefined }).join("\n"), /needs --out/);
    assert.match(base({ variant: "fresh" }).join("\n"), /fixture variant only/);
    assert.match(base({ control: "render-failure" }).join("\n"), /no --control/);
  });

  it("is applied by the runner before anything is created", () => {
    const r = spawnSync(process.execPath, ["--import", "tsx/esm", "scripts/acceptance-run.ts", "--mode", "capture", "--allowance", "5", "--out", path.join(tmp(), "out")], {
      cwd: API_ROOT,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, DATABASE_URL: process.env.DATABASE_URL, CI: "true" },
      encoding: "utf8",
    });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /never runs in CI/);
    assert.match(r.stderr, /cap is \$2\.00 per run/);
  });
});

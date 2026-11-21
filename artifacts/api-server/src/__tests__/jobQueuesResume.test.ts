// Every job queue resumes after a stop (plan PLAN_JOB_RESUME.md, Q12: 1, David
// 2026-11-17: "every queue, renders first"). #1129 found the Reading queue,
// added after that work, registered without it, so an interrupted Reading run
// waited about 30 minutes. This test reads every registration in the source,
// so a new queue that forgets the declaration fails here and names its file.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const LIB = join(import.meta.dirname, "..", "lib");

// Queues that deliberately do not resume, each with its reason.
const EXCEPTIONS: Record<string, string> = {
  "operationsDrill.ts": "the drill stands in for a wedged job, so it must not be reclaimed fast",
};

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return tsFiles(path);
    return name.endsWith(".ts") && !name.endsWith(".d.ts") ? [path] : [];
  });
}

/** Each `registerJobHandler(...)` call's text, from the call to its closing `);`. */
function registrations(source: string): string[] {
  const calls: string[] = [];
  let at = source.indexOf("registerJobHandler(");
  while (at !== -1) {
    const lineStart = source.lastIndexOf("\n", at) + 1;
    const line = source.slice(lineStart, at);
    const isDefinitionOrComment = /export function\s*$|^\s*(\*|\/\/)/.test(line);
    const end = source.indexOf(");", at);
    if (!isDefinitionOrComment && end !== -1) calls.push(source.slice(at, end + 2));
    at = source.indexOf("registerJobHandler(", at + 1);
  }
  return calls;
}

describe("every job queue resumes after a stop", () => {
  it("each registerJobHandler call declares a recovery protocol, or is a named exception", () => {
    const missing: string[] = [];
    let seen = 0;
    for (const file of tsFiles(LIB)) {
      const rel = relative(LIB, file);
      for (const call of registrations(readFileSync(file, "utf8"))) {
        seen += 1;
        if (/RESUMES_FROM_CHECKPOINTS|recoveryProtocol\s*:/.test(call)) continue;
        if (EXCEPTIONS[rel]) continue;
        missing.push(`${rel}: ${call.split("\n")[0]}`);
      }
    }
    assert.ok(seen >= 10, `found only ${seen} registrations; the scan is broken`);
    assert.deepEqual(missing, []);
  });
});

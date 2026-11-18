/**
 * No credential carried in a request header reaches backend monitoring
 * (PR #1063 round 1): a real request through the real SDK, searched by value
 * in every captured error and transaction event. Runs the probe in its own
 * process (testing/sentryLeakProbe.ts) because Sentry.init is global.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const probe = path.resolve(here, "../testing/sentryLeakProbe.ts");

describe("backend monitoring keeps no credential from a request", () => {
  it("drops the origin secret, the sid cookie, the dev preview key and authorization from errors and transactions, keeping the user agent", () => {
    const out = execFileSync(process.execPath, ["--import", "tsx/esm", probe], {
      cwd: path.resolve(here, "../.."),
      encoding: "utf8",
      timeout: 60_000,
    });
    const report = JSON.parse(out.trim().split("\n").pop()!) as Array<{ kind: string; leaks: Record<string, string[]>; userAgentKept: boolean }>;
    const kinds = report.map((r) => r.kind);
    assert.ok(kinds.includes("error"), `an error event was captured (${kinds.join(",")})`);
    assert.ok(kinds.includes("transaction"), `a transaction was captured (${kinds.join(",")})`);
    for (const r of report) {
      for (const [name, where] of Object.entries(r.leaks)) assert.deepEqual(where, [], `${name} survived in a ${r.kind} event at ${where.join(" | ")}`);
    }
    assert.ok(report.some((r) => r.userAgentKept), "a harmless header (user-agent) is still kept");
  });
});

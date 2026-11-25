import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { evaluateAudit, loadExceptions } from "../check-prod-audit.mjs";

const adv = (ghsa, pkg, severity) => ({
  github_advisory_id: ghsa, module_name: pkg, severity, title: `${pkg} issue`,
  vulnerable_versions: "<2.0.0", patched_versions: ">=2.0.0", findings: [{ paths: [`app>${pkg}`] }],
});
const report = (...advs) => ({ advisories: Object.fromEntries(advs.map((a, i) => [String(i), a])) });
const owned = (ghsa, pkg) => ({ ghsa, package: pkg, reason: "upgrade owned elsewhere", owner: "Phase X" });

test("a planted High with no exception blocks", () => {
  const r = evaluateAudit(report(adv("GHSA-aaaa-bbbb-cccc", "planted", "high")), []);
  assert.deepEqual(r.blocking.map((b) => b.ghsa), ["GHSA-aaaa-bbbb-cccc"]);
});

test("a Critical blocks; Moderate and Low never do", () => {
  const r = evaluateAudit(report(adv("GHSA-1", "a", "critical"), adv("GHSA-2", "b", "moderate"), adv("GHSA-3", "c", "low")), []);
  assert.deepEqual(r.blocking.map((b) => b.ghsa), ["GHSA-1"]);
});

test("an owned exception passes only its own advisory on its own package", () => {
  const r = evaluateAudit(
    report(adv("GHSA-x", "sharp", "high"), adv("GHSA-y", "sharp", "high"), adv("GHSA-x", "other", "high")),
    [owned("GHSA-x", "sharp")],
  );
  assert.deepEqual(r.excepted.map((e) => `${e.package}:${e.ghsa}`), ["sharp:GHSA-x"]);
  assert.deepEqual(r.blocking.map((b) => `${b.package}:${b.ghsa}`).sort(), ["other:GHSA-x", "sharp:GHSA-y"]);
});

test("an exception that no longer matches is reported stale, and blocks nothing", () => {
  const r = evaluateAudit(report(), [owned("GHSA-gone", "sharp")]);
  assert.equal(r.blocking.length, 0);
  assert.deepEqual(r.staleExceptions.map((s) => s.ghsa), ["GHSA-gone"]);
});

test("an unreadable report throws rather than passing", () => {
  assert.throws(() => evaluateAudit({ error: { code: "ENOTFOUND" } }, []), /no advisories/);
  assert.throws(() => evaluateAudit(null, []), /no advisories/);
});

test("an exception without an owner or a reason is refused", () => {
  const dir = mkdtempSync(join(tmpdir(), "prod-audit-"));
  const file = join(dir, "x.json");
  writeFileSync(file, JSON.stringify({ exceptions: [{ ghsa: "GHSA-x", package: "sharp", reason: "" , owner: "Phase X" }] }));
  assert.throws(() => loadExceptions(file), /"reason"/);
  writeFileSync(file, JSON.stringify({ exceptions: [{ ghsa: "GHSA-x", package: "sharp", reason: "r" }] }));
  assert.throws(() => loadExceptions(file), /"owner"/);
});

test("the committed exceptions file loads", () => {
  assert.ok(loadExceptions().length >= 0);
});

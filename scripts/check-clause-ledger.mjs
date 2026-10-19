#!/usr/bin/env node
// Checks docs/plans/reviews/phase2-inc7/clause-ledger.json against the tree:
// every evidence quote is found on its cited line, and the stored counts match
// the clauses. Not a CI gate; run by hand when the ledger changes (#631 7b).
// Usage: node scripts/check-clause-ledger.mjs
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ledger = JSON.parse(readFileSync(resolve(root, "docs/plans/reviews/phase2-inc7/clause-ledger.json"), "utf8"));

const fileCache = new Map();
const linesOf = (p) => {
  if (!fileCache.has(p)) {
    const abs = resolve(root, p);
    fileCache.set(p, existsSync(abs) ? readFileSync(abs, "utf8").split("\n") : null);
  }
  return fileCache.get(p);
};

const counts = { steps: 0, asserted: 0, gap: 0, live: 0 };
const problems = [];
for (const step of ledger.steps) {
  counts.steps++;
  for (const clause of step.clauses) {
    counts[clause.status] = (counts[clause.status] ?? 0) + 1;
    for (const ev of clause.evidence) {
      const lines = linesOf(ev.path);
      const where = `${step.doc} step ${step.id}: ${ev.path}:${ev.line}`;
      if (!lines) problems.push(`${where} — file missing`);
      else if (!(lines[ev.line - 1] ?? "").includes(ev.quote)) {
        const at = lines.findIndex((l) => l.includes(ev.quote));
        problems.push(`${where} — quote not on its line${at >= 0 ? ` (found at ${at + 1})` : " (not in file)"}`);
      }
    }
  }
}

for (const k of Object.keys(counts)) {
  if (ledger.counts[k] !== counts[k]) problems.push(`counts.${k}: stored ${ledger.counts[k]}, actual ${counts[k]}`);
}

console.log(`steps ${counts.steps}, asserted ${counts.asserted}, gap ${counts.gap}, live ${counts.live}`);
console.log(`quotes off their line or missing: ${problems.filter((p) => p.includes("quote") || p.includes("missing")).length}`);
for (const p of problems) console.log(`  ${p}`);
process.exit(problems.length ? 1 : 0);

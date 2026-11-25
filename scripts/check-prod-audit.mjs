#!/usr/bin/env node
/**
 * The dependency gate (launch Phase 15, increment 4; readiness row 5):
 * CI fails when `pnpm audit --prod` reports any High or Critical advisory
 * that is not a named, owned exception.
 * ────────────────────────────────────────────────────────────────────────────
 * WHY A SCRIPT AND NOT `pnpm audit --audit-level high`. The bare command can
 * only pass every High (useless today: `sharp` 0.34.5 carries three) or fail
 * every PR until the one lane that owns the upgrade lands. An exception has to
 * say which advisory, which package, why, and who clears it, so that a NEW High
 * still fails the build the day it appears.
 *
 * THE EXCEPTIONS (`scripts/prod-audit-exceptions.json`) are keyed by GHSA id
 * and package. An exception that no longer matches anything is reported, so
 * the entry is deleted once its owner's upgrade lands rather than lingering as
 * a blanket pass.
 *
 * FAILS CLOSED. If the audit cannot be read (registry down, malformed output),
 * the gate fails and says so: an audit that evaluated nothing is not a pass.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const BLOCKING = new Set(["high", "critical"]);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Pure decision over a `pnpm audit --json` report.
 * @returns {{ blocking: object[], excepted: object[], staleExceptions: object[] }}
 */
export function evaluateAudit(report, exceptions) {
  if (!report || typeof report !== "object" || typeof report.advisories !== "object" || report.advisories === null) {
    throw new Error("the audit report has no advisories object");
  }
  const blocking = [];
  const excepted = [];
  const matched = new Set();
  for (const adv of Object.values(report.advisories)) {
    if (!BLOCKING.has(String(adv.severity).toLowerCase())) continue;
    const found = {
      ghsa: adv.github_advisory_id,
      package: adv.module_name,
      severity: adv.severity,
      title: adv.title,
      vulnerable: adv.vulnerable_versions,
      patched: adv.patched_versions,
      paths: (adv.findings ?? []).flatMap((f) => f.paths ?? []).slice(0, 3),
    };
    const exception = exceptions.find((e) => e.ghsa === found.ghsa && e.package === found.package);
    if (exception) {
      matched.add(exception);
      excepted.push({ ...found, exception });
    } else {
      blocking.push(found);
    }
  }
  return { blocking, excepted, staleExceptions: exceptions.filter((e) => !matched.has(e)) };
}

export function loadExceptions(path = resolve(ROOT, "scripts/prod-audit-exceptions.json")) {
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  const list = parsed.exceptions;
  if (!Array.isArray(list)) throw new Error(`${path}: "exceptions" must be an array`);
  for (const e of list) {
    for (const field of ["ghsa", "package", "reason", "owner"]) {
      if (typeof e[field] !== "string" || e[field].trim() === "") {
        throw new Error(`${path}: every exception needs a non-empty "${field}" (${JSON.stringify(e)})`);
      }
    }
  }
  return list;
}

function runAudit() {
  const run = spawnSync("pnpm", ["audit", "--prod", "--json"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (run.error) throw run.error;
  try {
    return JSON.parse(run.stdout);
  } catch {
    throw new Error(`pnpm audit did not return JSON (exit ${run.status}): ${(run.stderr || run.stdout).slice(0, 400)}`);
  }
}

function main() {
  let result;
  try {
    result = evaluateAudit(runAudit(), loadExceptions());
  } catch (err) {
    console.error(`check:prod-audit FAILED: the production dependency audit could not be evaluated — ${err.message}`);
    process.exit(1);
  }
  for (const e of result.excepted) {
    console.log(`excepted  ${e.severity} ${e.package} ${e.ghsa} (${e.vulnerable} → ${e.patched}) — owner: ${e.exception.owner}`);
  }
  for (const s of result.staleExceptions) {
    console.log(`stale exception: ${s.package} ${s.ghsa} no longer appears in the audit — delete it from scripts/prod-audit-exceptions.json (owner: ${s.owner})`);
  }
  if (result.blocking.length > 0) {
    console.error(`check:prod-audit FAILED: ${result.blocking.length} High/Critical production advisory(ies) with no exception:`);
    for (const b of result.blocking) {
      console.error(`  ${b.severity} ${b.package} ${b.ghsa} ${b.title} (vulnerable ${b.vulnerable}, patched ${b.patched}) via ${b.paths.join(", ")}`);
    }
    console.error("Upgrade the package, or add an owned exception with its reason to scripts/prod-audit-exceptions.json.");
    process.exit(1);
  }
  console.log(`check:prod-audit: no unexcepted High or Critical production advisory (${result.excepted.length} excepted).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

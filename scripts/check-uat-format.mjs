#!/usr/bin/env node
// SYNCED FROM AI-Handbook — do not edit in a consumer repo. Local edits are overwritten by the next sync and their reasoning is lost; change the handbook instead.
// UAT format guard.
//
// `/uat` drives a run by enumerating `#### ` headings inside `### Steps` and
// `### Regression` of the pull request body's `## UAT` section. That rule is
// only safe if every section actually has that shape, so this checks it
// rather than trusting it.
//
// **Why this is a check and not a convention.** The UAT docs that used to
// live in docs/tests/UAT/ accumulated six-plus conventions for the regression
// section alone, eleven docs with no numbered steps, and several distinct
// naming schemes (Parts A-E, Tests 1-8, "The happy path"). A skill that tried
// to infer coverage from that spread failed in the worst available way --
// pass every feature step, declare Accepted, never run the sweep. The format
// (docs/tests/uat-doc-format.md) fixes the shape; this keeps it fixed.
//
// **Why it reads the pull request body.** The UAT script moved out of
// docs/tests/UAT/ and into the PR body on 2026-10-21 (David), the same move
// the TEST_RUN file made on 2026-08-15 and for the same reason: written with
// the diff and reviewed with it, with no file lifecycle of its own -- no
// PR-first naming dance, no deletion PR per completed run, no guard policing
// finished scripts whose cited files were since renamed. In CI the body comes
// from the `pull_request` event payload; locally and in tests it comes from
// `--body-file`. A push event has no body to check and says so. A body with
// no `## UAT` section is a PR that owes none -- whether one is owed is
// `pr-docs`' and `pr-watch`'s judgement, not this guard's.
//
// It checks STRUCTURE, not content. It cannot tell whether an `Expect:` is a
// real oracle or whether a regression check is worth running -- those stay
// human. It catches the one class that is regular: a section `/uat` cannot
// drive.
//
// It also checks LANES: every step names where it is verified (ci, scripted,
// live, capture, human), and a machine-lane step cites the check that runs
// it, unless it is Deferred to a named owner. It cannot tell whether the
// cited check really asserts what the step expects -- that stays with review
// -- but it does refuse a citation that points at a file that is not there.
//
// And it checks the JUDGEMENT line: a `human` step states, in one
// `**Judgement:**` line, what only David can judge or do and why no machine
// can; no other lane carries one. It cannot tell whether the statement is
// true. It turns an invisible lane choice into a written claim that review
// can test -- a `human` label over a screen fact is the failure the lanes
// exist to end, and until this line it left no trace to review.
//
// Dependency-free, like the other docs guards.
//
// Run in CI (a `pull_request` event; list `edited` among the trigger's types
// so a body edit re-runs it):  node scripts/check-uat-format.mjs
// Run locally:                 node scripts/check-uat-format.mjs --body-file <file>

import { readFileSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The PR-body section that holds the UAT script. Everything else in the body is not this guard's. */
export const UAT_HEADING = "## UAT";

const SETUP_TAGS = ["[claude]", "[david]", "[restore]"];

/**
 * The five verification lanes (uat-doc-format.md, *Lanes*). Every step names
 * exactly one. Only `human` reaches David; the other four are run by a
 * machine, so each must say which check runs it. `capture` is a machine
 * lane whose result is Claude's reading of the captured image, not the
 * script's exit status.
 */
export const LANES = ["ci", "scripted", "live", "capture", "human"];

/**
 * A `**Check:**` must cite something a reader can go and run: a backticked
 * repo path or a backticked command. A path-shaped citation (it contains a
 * slash and ends in a file extension, optionally followed by `:<anything>`
 * naming a test inside the file) must exist, so a check cannot quietly point
 * at a file that was renamed or never written.
 */
const PATHISH = /^([\w./@-]+\/[\w.@-]+\.[a-z0-9]+)(?::.*)?$/i;

/** Sub-sections of `## UAT`, in the order the format requires them. */
const REQUIRED = ["### Setup", "### Steps", "### Regression"];

/**
 * The `## UAT` section of a PR body: its lines, each paired with its
 * 1-based line number in the body, from the line after the heading to the
 * next `## ` heading or the end. `null` when the body has no such section.
 * Exact heading match, so `## UAT run` or `## UAT notes` is not it.
 */
export function uatSection(body) {
  const lines = body.split("\n");
  const start = lines.findIndex((l) => l.trim() === UAT_HEADING);
  if (start === -1) return null;
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) break;
    out.push([i + 1, lines[i]]);
  }
  return out;
}

/**
 * Structural findings for one PR body. `[]` when the body has no `## UAT`
 * section (nothing owed, or nothing this guard can see) and when the section
 * is drivable. Exported so the guard's own behaviour is testable without a
 * filesystem or an event payload, matching the other docs guards.
 */
export function scanBody(body, { exists = (rel) => existsSync(join(ROOT, rel)) } = {}) {
  const section = uatSection(body);
  if (section === null) return [];
  const problems = [];
  const say = (msg) => problems.push(msg);
  const lineNo = (i) => section[i][0];
  const text = (i) => section[i][1];

  // --- required sub-sections, present and in order ------------------------
  const at = (h) => section.findIndex(([, l]) => l.trim() === h);
  const idx = REQUIRED.map(at);
  REQUIRED.forEach((h, i) => {
    if (idx[i] === -1) say(`missing required section "${h}" under ${UAT_HEADING}`);
  });
  if (idx.every((i) => i !== -1)) {
    for (let i = 1; i < idx.length; i++) {
      if (idx[i] < idx[i - 1]) {
        say(`"${REQUIRED[i]}" must come after "${REQUIRED[i - 1]}"`);
      }
    }
  }

  // --- the region a heading scan would actually see ------------------------
  // A sub-section runs to the next `### ` heading. The `## UAT` section has
  // already been cut at the next `## ` heading, so prose in the body's other
  // sections is never read here.
  const sectionBody = (start) => {
    if (start === -1) return [];
    const out = [];
    for (let i = start + 1; i < section.length; i++) {
      if (/^### /.test(text(i))) break;
      out.push([lineNo(i), text(i)]);
    }
    return out;
  };

  // --- setup lines use the fixed vocabulary -------------------------------
  // Continuation lines of a wrapped bullet start with whitespace and belong
  // to the bullet above them, not to a tag of their own.
  const setup = sectionBody(at("### Setup")).filter(
    ([, l]) => l.trim() && !/^\s/.test(l),
  );
  if (setup.length) {
    const onlyNone = setup[0][1].trim().startsWith("None.");
    if (!onlyNone) {
      for (const [n, l] of setup) {
        const t = l.trim();
        if (!t.startsWith("- ")) {
          say(`${n}: Setup lines must be "- [tag] …" bullets or the single line "None."`);
        } else if (!SETUP_TAGS.some((tag) => t.startsWith(`- ${tag}`))) {
          say(`${n}: Setup bullet must start with one of ${SETUP_TAGS.join(" / ")}`);
        }
      }
    }
  }

  // --- steps and regression checks ----------------------------------------
  const headings = (start) =>
    sectionBody(start)
      .filter(([, l]) => /^#### /.test(l))
      .map(([n, l]) => [n, l.replace(/^#### /, "")]);

  // `None.` is a legitimate body for `### Regression`: a PR that genuinely
  // couldn't break anything says so rather than padding the sweep. The
  // sub-section stays required so its absence is never ambiguous. `### Steps`
  // has no such escape -- a UAT with nothing to test is not a UAT.
  // `None.` on the first non-blank line, optionally followed by a sentence
  // saying why. The reason is worth allowing: a bare `None.` reads as an
  // oversight and invites a later editor to "fix" it with filler, which is
  // the padding this escape exists to avoid.
  //
  // The escape covers ONLY a sub-section with no headings at all -- "None."
  // plus a later #### heading is not a legitimate use of it (a heading after
  // "None." is exactly the drift a stray edit would introduce, and /uat
  // would enumerate it as a step with no oracle behind it), so that shape
  // still runs the normal heading checks. (Codex, #561 round 2.)
  const isNone = (start) => {
    const body = sectionBody(start).filter(([, l]) => l.trim());
    return body.length > 0 && body[0][1].trim().startsWith("None.") && headings(start).length === 0;
  };

  const checkIds = (start, label, pattern, render, allowNone = false) => {
    if (allowNone && isNone(start)) return [];
    const hs = headings(start);
    if (start !== -1 && hs.length === 0) {
      say(`"${label}" contains no #### headings${allowNone ? ' (use the single line "None." if this PR could not break anything)' : ""}`);
    }
    hs.forEach(([n, h], i) => {
      const m = pattern.exec(h);
      if (!m) {
        say(`${n}: ${label} heading must look like "#### ${render(i + 1)} <title>" — got "${h}"`);
        return;
      }
      if (Number(m[1]) !== i + 1) {
        say(`${n}: ${label} headings must be numbered consecutively from 1 — expected ${render(i + 1)}, got "${h}"`);
      }
    });
    return hs;
  };

  const steps = checkIds(at("### Steps"), "### Steps", /^(\d+)\.\s+\S/, (i) => `${i}.`);
  const regs = checkIds(at("### Regression"), "### Regression", /^R(\d+)\.\s+\S/, (i) => `R${i}.`, true);

  // --- every step carries exactly one Do and one Expect -------------------
  // A step with two Do/Expect pairs is a compound step: the driver presents
  // one step per turn, so it would produce a compound answer and a muddy
  // record. A step with none cannot be presented at all.
  const byLine = new Map(section);
  const stepStarts = [...steps, ...regs].map(([n]) => n).sort((a, b) => a - b);
  const lastLine = section.length ? lineNo(section.length - 1) : 0;
  stepStarts.forEach((startLine, i) => {
    const end = i + 1 < stepStarts.length ? stepStarts[i + 1] - 1 : lastLine;
    let body = [];
    for (let n = startLine + 1; n <= end; n++) {
      const l = byLine.get(n);
      if (/^### /.test(l)) break;
      body.push(l);
    }
    const count = (marker) => body.filter((l) => l.trim().startsWith(marker)).length;
    const dos = count("**Do:**");
    const exps = count("**Expect:**");
    const heading = byLine.get(startLine).replace(/^#### /, "");
    if (dos !== 1) say(`${startLine}: step "${heading}" has ${dos} **Do:** lines, needs exactly 1`);
    if (exps !== 1) say(`${startLine}: step "${heading}" has ${exps} **Expect:** lines, needs exactly 1`);

    // --- the lane, and for a machine lane the check that runs it ----------
    // Without a lane the step defaults to David, which is the failure the
    // lanes exist to end: a mechanical step reaching the slowest verifier.
    const field = (marker) => body.filter((l) => l.trim().startsWith(marker)).map((l) => l.trim().slice(marker.length).trim());
    const lanes = field("**Lane:**");
    const checks = field("**Check:**");
    const deferred = field("**Deferred:**");
    if (lanes.length !== 1) {
      say(`${startLine}: step "${heading}" has ${lanes.length} **Lane:** lines, needs exactly 1 (one of ${LANES.join(" / ")})`);
      return;
    }
    const lane = lanes[0].replace(/[`.]/g, "").trim();
    if (!LANES.includes(lane)) {
      say(`${startLine}: step "${heading}" has lane "${lanes[0]}", must be one of ${LANES.join(" / ")}`);
      return;
    }
    // A human step says why it is human; no other step claims a judgement.
    const judgements = field("**Judgement:**");
    if (lane === "human") {
      if (judgements.length === 0) {
        say(`${startLine}: step "${heading}" is lane "human" with no **Judgement:** — say what only David can judge or do, and why no machine can; a step with no such judgement belongs in a machine lane`);
      } else if (judgements.length > 1) {
        say(`${startLine}: step "${heading}" has ${judgements.length} **Judgement:** lines, needs exactly 1`);
      } else if (!judgements[0]) {
        say(`${startLine}: step "${heading}" has an empty **Judgement:** line`);
      }
    } else if (judgements.length > 0) {
      say(`${startLine}: step "${heading}" is lane "${lane}" but carries a **Judgement:** line — only a human step states a judgement`);
    }
    if (checks.length > 1) say(`${startLine}: step "${heading}" has ${checks.length} **Check:** lines, needs at most 1`);
    if (deferred.length > 1) say(`${startLine}: step "${heading}" has ${deferred.length} **Deferred:** lines, needs at most 1`);
    if (deferred.length === 1 && !/#\d+/.test(deferred[0])) {
      say(`${startLine}: step "${heading}" is **Deferred:** without an owner — name the issue that owns it (#N)`);
    }
    // Two separate questions. Is a check REQUIRED? Only for a machine-lane
    // step that is not deferred -- a deferred step is not yet runnable in its
    // lane. Is a SUPPLIED check valid? Always, deferred or not: a deferred
    // step that keeps partial evidence for its owner must keep it pointing at
    // something that exists, or the evidence rots unnoticed.
    if (lane !== "human" && deferred.length === 0 && checks.length === 0) {
      say(`${startLine}: step "${heading}" is lane "${lane}" with no **Check:** — name the test, script or command that runs it`);
    }
    if (checks.length > 0) {
      const cited = [...checks[0].matchAll(/`([^`]*)`/g)].map((m) => m[1].trim()).filter(Boolean);
      if (cited.length === 0) {
        say(`${startLine}: step "${heading}" **Check:** must cite a non-empty backticked repo path or command`);
      }
      for (const c of cited) {
        const m = PATHISH.exec(c);
        if (m && !exists(m[1])) say(`${startLine}: step "${heading}" **Check:** cites \`${m[1]}\`, which does not exist`);
      }
    }
  });

  return problems;
}

/**
 * Where the body comes from, in order: `--body-file <path>` (local runs and
 * tests), then the `pull_request` event payload CI hands every job through
 * `GITHUB_EVENT_PATH`. A workflow run that is not a pull request event has no
 * body -- the guard says so and passes, having checked exactly that. No
 * source at all is a refusal, never a pass: a guard that reports success
 * having evaluated nothing is the worst available failure.
 */
export function readBody({ argv = process.argv.slice(2), env = process.env } = {}) {
  const flag = argv.indexOf("--body-file");
  if (flag !== -1) {
    const file = argv[flag + 1];
    if (!file) return { error: "--body-file needs a path" };
    return { body: readFileSync(file, "utf8"), source: file };
  }
  if (env.GITHUB_EVENT_PATH) {
    const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
    if (!event.pull_request) return { skip: `${env.GITHUB_EVENT_NAME ?? "this"} event carries no pull request` };
    return { body: event.pull_request.body ?? "", source: `pull request #${event.pull_request.number}` };
  }
  return { error: "no PR body to check: pass --body-file <file>, or run on a pull_request event (GITHUB_EVENT_PATH)" };
}

function main() {
  const read = readBody();
  if (read.error) {
    console.error(`✗ UAT format: ${read.error}`);
    process.exitCode = 1;
    return;
  }
  if (read.skip) {
    console.log(`✓ UAT format: ${read.skip}; nothing to check.`);
    return;
  }
  if (uatSection(read.body) === null) {
    console.log(`✓ UAT format: no ${UAT_HEADING} section in ${read.source} (none owed, or a legacy doc under docs/tests/UAT/).`);
    return;
  }
  const problems = scanBody(read.body);
  if (problems.length === 0) {
    console.log(`✓ UAT format: the ${UAT_HEADING} section of ${read.source} is drivable by /uat.`);
    return;
  }
  console.error(`\n✗ ${problems.length} UAT format problem(s) in ${read.source} — /uat cannot reliably drive this section.\n`);
  for (const p of problems) console.error(`      ${p}`);
  console.error(
    `\nThe format is docs/tests/uat-doc-format.md. The rule /uat depends on:\n` +
      `a step is any "#### " heading inside "### Steps" or "### Regression" of the PR body's "## UAT" section.\n`,
  );
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

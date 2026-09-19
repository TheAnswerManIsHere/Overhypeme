#!/usr/bin/env node
// SYNCED FROM AI-Handbook — do not edit in a consumer repo. Local edits are overwritten by the next sync and their reasoning is lost; change the handbook instead.
// UAT document format guard.
//
// `/uat` drives a run by enumerating `### ` headings inside `## Steps` and
// `## Regression`. That rule is only safe if every doc actually has that
// shape, so this checks it rather than trusting it.
//
// **Why this is a check and not a convention.** The docs in docs/tests/UAT/
// accumulated six-plus conventions for the regression section alone, eleven
// docs with no numbered steps, and several distinct naming schemes (Parts
// A-E, Tests 1-8, "The happy path"). A skill that tried to infer coverage
// from that spread failed in the worst available way -- pass every feature
// step, declare Accepted, never run the sweep. The format
// (docs/tests/uat-doc-format.md) fixes the shape; this keeps it fixed.
//
// It checks STRUCTURE, not content. It cannot tell whether an `Expect:` is a
// real oracle or whether a regression check is worth running -- those stay
// human. It catches the one class that is regular: a doc `/uat` cannot drive.
//
// Dependency-free, like the other docs guards.
//
// Run locally:  node scripts/check-uat-format.mjs

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const UAT_DIR = "docs/tests/UAT";

const SETUP_TAGS = ["[claude]", "[david]", "[restore]"];

/** Section boundaries, in the order the format requires them. */
const REQUIRED = ["## Setup", "## Steps", "## Regression"];

export function uatFiles(root = ROOT) {
  const dir = join(root, UAT_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md") && f !== "README.md")
    .sort()
    .map((f) => `${UAT_DIR}/${f}`);
}

/**
 * Structural findings for one doc. Exported so the guard's own behaviour is
 * testable without the filesystem, matching the other docs guards.
 */
export function scanDoc(filename, text) {
  const problems = [];
  const lines = text.split("\n");
  const say = (msg) => problems.push(msg);

  // --- filename shape, and the title's agreement with it ------------------
  // /uat discovers candidates by globbing PR<N>_*_UAT.md (uat-doc-format.md
  // and the /uat skill both require this exact shape). A doc that passes
  // every structural check below but sits outside that pattern -- a typo,
  // or a file the format's own filter (.md, not README.md) still admits --
  // would validate clean here and never be offered for a run. (Codex, #561
  // round 1.)
  const base = basename(filename);
  const fileMatch = /^PR(\d+)_[A-Za-z0-9]+(?:_[A-Za-z0-9]+)*_UAT\.md$/.exec(base);
  if (!fileMatch) {
    say(`filename must match "PR<N>_<FEATURE>_UAT.md" (SCREAMING_SNAKE feature) -- got "${base}"`);
  }
  const title = lines.find((l) => l.startsWith("# "));
  const titleMatch = title && /^# PR #(\d+) — .+ — UAT\s*$/.exec(title);
  if (!titleMatch) {
    say('first heading must be exactly "# PR #<N> — <Feature> — UAT"');
  } else if (fileMatch && titleMatch[1] !== fileMatch[1]) {
    say(`title says PR #${titleMatch[1]} but the filename says PR${fileMatch[1]}`);
  }

  // --- required sections, present and in order ----------------------------
  const at = (h) => lines.findIndex((l) => l.trim() === h);
  const idx = REQUIRED.map(at);
  REQUIRED.forEach((h, i) => {
    if (idx[i] === -1) say(`missing required section "${h}"`);
  });
  if (idx.every((i) => i !== -1)) {
    for (let i = 1; i < idx.length; i++) {
      if (idx[i] < idx[i - 1]) {
        say(`"${REQUIRED[i]}" must come after "${REQUIRED[i - 1]}"`);
      }
    }
  }

  // --- the region a heading scan would actually see ------------------------
  const sectionBody = (start) => {
    if (start === -1) return [];
    const out = [];
    for (let i = start + 1; i < lines.length; i++) {
      if (/^## /.test(lines[i])) break;
      out.push([i + 1, lines[i]]);
    }
    return out;
  };

  // --- setup lines use the fixed vocabulary -------------------------------
  // Continuation lines of a wrapped bullet start with whitespace and belong
  // to the bullet above them, not to a tag of their own -- these docs wrap at
  // 80 columns, so most real bullets have them.
  const setup = sectionBody(at("## Setup")).filter(
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
      .filter(([, l]) => /^### /.test(l))
      .map(([n, l]) => [n, l.replace(/^### /, "")]);

  // `None.` is a legitimate body for `## Regression`: a PR that genuinely
  // couldn't break anything says so rather than padding the sweep. The
  // section stays required so its absence is never ambiguous. `## Steps` has
  // no such escape -- a UAT with nothing to test is not a UAT.
  // `None.` on the first non-blank line, optionally followed by a sentence
  // saying why. The reason is worth allowing: a bare `None.` reads as an
  // oversight and invites a later editor to "fix" it with filler, which is
  // the padding this escape exists to avoid.
  //
  // The escape covers ONLY a section with no headings at all -- "None." plus
  // a later ### heading is not a legitimate use of it (a heading after
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
      say(`"${label}" contains no ### headings${allowNone ? ' (use the single line "None." if this PR could not break anything)' : ""}`);
    }
    hs.forEach(([n, h], i) => {
      const m = pattern.exec(h);
      if (!m) {
        say(`${n}: ${label} heading must look like "### ${render(i + 1)} <title>" — got "${h}"`);
        return;
      }
      if (Number(m[1]) !== i + 1) {
        say(`${n}: ${label} headings must be numbered consecutively from 1 — expected ${render(i + 1)}, got "${h}"`);
      }
    });
    return hs;
  };

  const steps = checkIds(at("## Steps"), "## Steps", /^(\d+)\.\s+\S/, (i) => `${i}.`);
  const regs = checkIds(at("## Regression"), "## Regression", /^R(\d+)\.\s+\S/, (i) => `R${i}.`, true);

  // --- every step carries exactly one Do and one Expect -------------------
  // A step with two Do/Expect pairs is a compound step: the driver presents
  // one step per turn, so it would produce a compound answer and a muddy
  // record. A step with none cannot be presented at all.
  const stepStarts = [...steps, ...regs].map(([n]) => n).sort((a, b) => a - b);
  stepStarts.forEach((startLine, i) => {
    const end = i + 1 < stepStarts.length ? stepStarts[i + 1] - 1 : lines.length;
    let body = lines.slice(startLine, end);
    const nextSection = body.findIndex((l) => /^## /.test(l));
    if (nextSection !== -1) body = body.slice(0, nextSection);
    const count = (marker) => body.filter((l) => l.trim().startsWith(marker)).length;
    const dos = count("**Do:**");
    const exps = count("**Expect:**");
    const heading = lines[startLine - 1].replace(/^### /, "");
    if (dos !== 1) say(`${startLine}: step "${heading}" has ${dos} **Do:** lines, needs exactly 1`);
    if (exps !== 1) say(`${startLine}: step "${heading}" has ${exps} **Expect:** lines, needs exactly 1`);
  });

  return problems;
}

function main() {
  const files = uatFiles();
  if (files.length === 0) {
    console.log("✓ UAT format: no UAT docs present (all runs complete).");
    return;
  }
  const all = [];
  for (const file of files) {
    for (const p of scanDoc(file, readFileSync(join(ROOT, file), "utf8"))) {
      all.push({ file, problem: p });
    }
  }
  if (all.length === 0) {
    console.log(`✓ UAT format: ${files.length} doc(s), all drivable by /uat.`);
    return;
  }
  console.error(`\n✗ ${all.length} UAT format problem(s) — /uat cannot reliably drive these.\n`);
  let last = null;
  for (const { file, problem } of all) {
    if (file !== last) {
      console.error(`  ${file}`);
      last = file;
    }
    console.error(`      ${problem}`);
  }
  console.error(
    `\nThe format is docs/tests/uat-doc-format.md. The rule /uat depends on:\n` +
      `a step is any "### " heading inside "## Steps" or "## Regression".\n`,
  );
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

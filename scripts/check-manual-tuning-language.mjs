#!/usr/bin/env node
// Manual tuning-language guard.
//
// `docs/manual/README.md` (the manual's charter) grants chapters whose subject
// IS machinery one bounded exception: they may name **what a component is, who
// it serves, and what is at stake**, and may never state **how it is
// configured** — not a number, and not a qualitative stand-in for one.
//
// **Why this is a CI check rather than a rule someone remembers.** The rule was
// written on 2026-07-30 after a de-fork PR spent three review rounds on the same
// boundary. It then took three MORE rounds, because each round the reviewer
// found another phrase that failed the rule while the author fixed the previous
// one: "polls every 2 seconds", "five lanes", "serialized", "about half an
// hour", "not promptly", "not quickly", "off by default", "arrives a little
// after". Every one of those is mechanically detectable. The repo's shared,
// cross-agent standing rule (docs/ai-context/decisions.md, "Recurring failure
// patterns become CI guards, not just doc updates") says that at that point
// the answer is a deterministic check, not a seventh promise to be more
// careful.
//
// **What this CANNOT do, stated so nobody mistakes a green check for
// compliance:** it is a lexical guard, not a semantic one. It cannot detect that
// a fact has two homes, that a chapter restated a spec section in its own words,
// or that a claim is simply false. Those stay human. This catches the one class
// that is regular enough to automate — values and their prose stand-ins.
//
// Dependency-free by design, like the other docs guards, so it runs in CI and
// locally with no install step.
//
// Escape hatch: a line carrying `<!-- tuning-ok -->`, or any line inside a
// `<!-- tuning-ok:start -->` / `<!-- tuning-ok:end -->` block, is skipped. The
// charter itself needs this — its own over/under table quotes the forbidden
// phrasings on purpose. Every use is a deliberate, visible decision.
//
// Fenced code blocks are NOT auto-exempt — a config sample formatted as code
// is still configuration, and blanking every fence would let a tuning value
// acquire a second home merely by being wrapped in ```. A chapter that
// genuinely needs to quote one uses the same explicit tuning-ok escape hatch
// as prose.
//
// Scanning tolerates concrete evasions found across PR #298's own review:
// inline emphasis/code/link markup splitting a value from its unit
// (`up to **50** eligible`, `up to *50* eligible`, `up to [50](../spec.md)
// eligible`), and this corpus's own ~80-column hard-wrap splitting a phrase
// across two physical lines (`3 send-back\nattempts`). Markdown emphasis,
// inline-code, and link markup are all normalized away before matching (see
// `stripMarkup`), and every line is scanned jointly with the line after it —
// see `scanText` for how a match is still attributed to exactly one line and
// the escape hatch still applies to a phrase that finishes on a
// deliberately-ignored continuation line.

import { readFileSync, readdirSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MANUAL_DIR = join(ROOT, "docs/manual");

// Spelled-out numbers a tuning constant might be written as, shared across
// every numeric rule so a fix to the vocabulary doesn't have to be repeated
// per rule (PR #298 round 3: round 2 added tens words to `elliptical-cap`
// only, so "up to fifty eligible" and "polls every five seconds" still
// passed). Round 4 added the teens after "which of eleven joke mechanisms"
// survived — the vocabulary jumped straight from "ten" to "twenty" and
// missed eleven..nineteen entirely. "one" is deliberately EXCLUDED
// everywhere: "the one queue whose failures reach a real person" is an
// idiom meaning *the singular*, not a count, and flagging it trains readers
// to ignore this guard.
const NUMBER_WORD =
  "two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred";
const NUMBER = `(?:\\d+|${NUMBER_WORD})`;

/**
 * Each rule is deliberately narrow. A false positive is more expensive than a
 * miss here: a noisy guard gets switched off, and then it protects nothing.
 * When in doubt the pattern is left out and the class stays human-reviewed.
 */
const RULES = [
  {
    id: "duration",
    // "2 seconds", "30 min", "60s", "five seconds" — a number (digit or
    // spelled out) bound to a time unit is a tuning constant almost without
    // exception in this corpus.
    //
    // Bare `s` is accepted only when ATTACHED to a DIGIT (`60s`, not `60 s`
    // or a spelled-out number + `s`). Spelled forms deliberately require the
    // full unit word with a space: "hundred" + attached "s" is just the
    // ordinary English word "hundreds" ("hundreds of facts"), not a
    // duration — round 3's number-word expansion flagged it as one until
    // this split was added. Digits have no such ambiguity: attached, a lone
    // "s" is unambiguously a duration. Caught by this guard's own test suite
    // before shipping — the first draft missed `60s` entirely.
    re: new RegExp(
      `\\b(?:\\d+(?:\\.\\d+)?(?:\\s*(?:ms|milliseconds?|secs?|seconds?|mins?|minutes?|hours?|days?)|s)|(?:${NUMBER_WORD})\\s+(?:ms|milliseconds?|secs?|seconds?|mins?|minutes?|hours?|days?))\\b`,
      "gi",
    ),
    why: "a duration is a tuning constant; state the intent, not the interval",
  },
  {
    id: "counted-component",
    // "five lanes", "three queues", "2 workers", "last 3 send-back attempts",
    // "fifty retries", "eleven joke mechanisms" — a count of a component,
    // allowing up to two modifier words (bare or hyphenated, e.g.
    // "independent scheduling", "send-back") between the number and the
    // noun.
    re: new RegExp(
      `\\b${NUMBER}\\s+(?:[a-z]+(?:-[a-z]+)?\\s+){0,2}(?:lanes?|queues?|workers?|handlers?|attempts?|retries|connections?|instances?|slots?|mechanisms?|archetypes?)\\b`,
      "gi",
    ),
    why: "a count of components is a value; say that they exist, not how many",
  },
  {
    id: "batch-cap",
    // "up to 50 at a time", "up to 50 eligible", "up to fifty eligible" — a
    // batch ceiling stated as a number, even with no noun from the
    // counted-component list attached.
    re: new RegExp(`\\bup to ${NUMBER}\\b|\\b${NUMBER}\\s+at a time\\b`, "gi"),
    why: "a batch ceiling is a tuning constant; say it's bounded, not by how much",
  },
  {
    id: "elliptical-cap",
    // "one fact or fifty" — restates a cap already given elsewhere as a
    // spelled-out alternative to "one", instead of a bare count with a noun
    // attached (which counted-component already catches — the verb is
    // elided here: "fifty" stands for "fifty facts").
    re: new RegExp(`\\bone\\s+[a-z]+\\s+or\\s+${NUMBER}\\b`, "gi"),
    why: "restating a cap as \"one X or N\" is still the value; say it's bounded, not by how much",
  },
  {
    id: "config-kv",
    // "intervalMs: 2000", "maxConcurrency: 3", "max_concurrency: 3" — a
    // code/config key-value pair is configuration regardless of surrounding
    // prose, camelCase or snake_case alike. Checked against the real corpus:
    // no chapter today uses a bare "Word: <number>" construction for
    // anything else, so this doesn't need a counted-component-style noun
    // whitelist.
    re: /\b[a-zA-Z][a-zA-Z0-9_]*\s*:\s*\d+\b/g,
    why: "a key:value pair is configuration; describe the behavior it controls, not its value",
  },
  {
    id: "magnitude-standin",
    // Qualitative words that encode a magnitude.
    //
    // Deliberately NOT included, after running this against the real corpus:
    // bare `slow`, `quickly`, `immediately`, `briefly`. Every occurrence in
    // docs/manual/ today is legitimate — "runs slow or external work" and "too
    // slow to do inline" describe the NATURE of the work, and moderation's
    // "always works, immediately" is a behavioural guarantee about takedown
    // being synchronous, not a tuning constant. Those words are too polysemous
    // to flag without a context model, and a guard that cries wolf gets
    // switched off. They stay human-reviewed.
    re: /\b(?:frequently|serialized|serialised|capped at|throttled to|roughly every|about half an hour|half an hour|not promptly|promptly|a few at a time|a little after)\b/gi,
    why: "a qualitative stand-in for a value drifts exactly as a number does",
  },
  {
    id: "default-value",
    // "off by default", "defaults to 3" — the charter reserves defaults.
    re: /\b(?:by default|defaults? to|default (?:is|of))\b/gi,
    why: "defaults are reserved for docs/ai-context/; say the behaviour is configurable",
  },
];

const IGNORE_LINE = "<!-- tuning-ok -->";
const IGNORE_START = "<!-- tuning-ok:start -->";
const IGNORE_END = "<!-- tuning-ok:end -->";

/**
 * Normalize markdown markup so it reads the same as the plain text it
 * decorates: `**50**`, `*50*`, `` `50` ``, and `[50](../spec.md)` all become
 * bare `50`. PR #298 round 3: an earlier version of this function only
 * stripped bold/code, on the claim that this corpus doesn't use single-
 * asterisk italics or links — both wrong (`docs/manual/moderation.md` uses
 * italics throughout; `docs/manual/README.md` is full of reference links).
 *
 * Order matters: links first (so a URL's own digits/colons — irrelevant to
 * whether the LINK TEXT states a tuning value — are dropped, not scanned),
 * then bold, then italics, then inline code.
 *
 * Single-asterisk/underscore italics require a non-whitespace character
 * immediately inside each marker and the marker itself not touching a word
 * character on the outside — the same shape CommonMark itself requires to
 * treat `*`/`_` as emphasis rather than a bullet or part of an identifier.
 * This is what keeps a snake_case identifier like `max_concurrency_limit`
 * intact: its inner underscores are each adjacent to a word character, so
 * neither one qualifies as an opening or closing marker.
 */
function stripMarkup(line) {
  return line
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?!\w)/g, "$1")
    .replace(/(?<![\w_])_(?!\s)(.+?)(?<!\s)_(?![\w_])/g, "$1")
    .replace(/`([^`]+?)`/g, "$1");
}

/**
 * Would `line` be skipped (not scanned) given the suppression state inherited
 * from prior lines? Mirrors the branch order in `scanText`'s own loop exactly,
 * so it can be used to check a line BEFORE its turn comes — a stray
 * (unmatched) `:end` is the one case where inheriting `suppressed=false`
 * does NOT mean skipped, since round 3 of PR #298's review found it must be
 * scanned and flagged, not silently exempted.
 */
function isSkippedLine(line, suppressedState) {
  if (line.includes(IGNORE_START)) return true;
  if (line.includes(IGNORE_END)) return suppressedState;
  if (suppressedState) return true;
  if (line.includes(IGNORE_LINE)) return true;
  return false;
}

export function scanText(text) {
  const raw = text.split("\n");
  const stripped = raw.map(stripMarkup);
  const findings = [];
  let suppressed = false;
  let suppressedFrom = null;

  raw.forEach((line, i) => {
    if (line.includes(IGNORE_START)) {
      suppressed = true;
      suppressedFrom = i + 1;
    }
    if (line.includes(IGNORE_END)) {
      if (suppressed) {
        suppressed = false;
        suppressedFrom = null;
        return;
      }
      // A stray `:end` with no preceding `:start` doesn't suppress anything
      // — silently returning here would exempt this line's own content for
      // no legitimate reason (PR #298 round 3). Flag it and fall through to
      // scan the line normally.
      findings.push({
        line: i + 1,
        rule: "malformed-ignore-marker",
        why: `${IGNORE_END} has no matching ${IGNORE_START} — remove the stray end marker; it does not suppress anything`,
        match: IGNORE_END,
      });
    }
    if (suppressed || line.includes(IGNORE_LINE)) return;

    // This corpus hard-wraps prose across physical lines, so a tuning phrase
    // can legitimately split at a line break ("3 send-back\nattempts").
    // Scan this line jointly with the next (blank next line = no join, since
    // a blank line is a real paragraph break; a next line that would itself
    // be skipped — suppressed, or carrying its own marker — is also not
    // joined, so the escape hatch still applies to a phrase that starts
    // clean and finishes on a deliberately-ignored continuation) — but only
    // count a match that STARTS within this line's own text. That attributes
    // every match to exactly one line: never double-reported once here and
    // once as the next line's own pass.
    const current = stripped[i];
    const nextRaw = i + 1 < raw.length ? raw[i + 1] : "";
    const joinable = nextRaw !== "" && !isSkippedLine(nextRaw, suppressed);
    const window = joinable ? `${current} ${stripped[i + 1]}` : current;

    for (const rule of RULES) {
      rule.re.lastIndex = 0;
      let m;
      while ((m = rule.re.exec(window)) !== null) {
        if (m.index >= current.length) continue;
        findings.push({ line: i + 1, rule: rule.id, why: rule.why, match: m[0].trim() });
      }
    }
  });

  // A `tuning-ok:start` with no matching `:end` suppresses every remaining
  // line — a typo or merge conflict must not silently disable the guard for
  // the rest of the file, so an unmatched marker is itself reported.
  if (suppressed) {
    findings.push({
      line: suppressedFrom,
      rule: "unterminated-ignore-block",
      why: `${IGNORE_START} has no matching ${IGNORE_END} — add the end marker or the rest of the file is left unscanned`,
      match: IGNORE_START,
    });
  }

  return findings;
}

// Recursive — a chapter added under a subdirectory (e.g. docs/manual/admin/)
// must not become an unchecked second home for configuration truth. Mirrors
// check-docs-accuracy.mjs's own `walk`.
export function markdownFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...markdownFiles(abs));
    else if (entry.name.endsWith(".md")) out.push(abs);
  }
  return out.sort();
}

function main() {
  const files = markdownFiles(MANUAL_DIR);
  const all = [];
  for (const file of files) {
    for (const f of scanText(readFileSync(file, "utf8"))) {
      all.push({ ...f, file: relative(ROOT, file) });
    }
  }

  if (all.length === 0) {
    console.log(
      `✓ manual tuning-language: ${files.length} file(s), no values or magnitude stand-ins outside docs/ai-context/.`,
    );
    return;
  }

  console.error(
    `\n✗ ${all.length} tuning-language finding(s) in docs/manual/ — the manual's charter\n` +
      `  reserves configuration for docs/ai-context/ (see "The one bounded exception").\n`,
  );
  for (const f of all) {
    console.error(`  ${f.file}:${f.line}  [${f.rule}]  “${f.match}”`);
    console.error(`      ${f.why}\n`);
  }
  console.error(
    "To resolve, either rewrite so the sentence survives any change to the underlying\n" +
      "constant, or — if the phrasing is a deliberate quotation, as in the charter's own\n" +
      `over/under table — mark the line with ${IGNORE_LINE} or wrap the block in\n` +
      `${IGNORE_START} … ${IGNORE_END}.\n\n` +
      "This guard is LEXICAL. A green result does not mean the chapter is correct or\n" +
      "free of duplicated facts — it means it contains no detectable tuning values.\n",
  );
  process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) main();

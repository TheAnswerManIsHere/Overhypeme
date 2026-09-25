#!/usr/bin/env node
// SYNCED FROM AI-Handbook — do not edit in a consumer repo. Local edits are overwritten by the next sync and their reasoning is lost; change the handbook instead.
/**
 * The `plan-provenance` block: its key tables, and the parser that reads one.
 *
 * WHY IT IS ITS OWN FILE NOW. It lived inside `review-loop-record.mjs`, which
 * generated the adjudicator's input record and refused a body whose block was
 * malformed. The #89 cut removed that script, and with it the only RUNTIME
 * reader of a PR body's block. The FORMAT did not go anywhere: `claude-core.md`
 * PR rule 4 still requires the block, `docs/ai-context/plan-provenance.md` is
 * still its defining statement, and the bugfix and plan-review-loop skills
 * still teach an author to write one.
 *
 * SO WHAT THIS STILL DOES, precisely, and it is one thing: it is the oracle
 * `scripts/__tests__/plan-provenance-producers.test.mjs` compares the producer
 * documents against. The format is taught in three places and stated in one,
 * and nothing else checks that a skill's template and the published grammar
 * still agree -- both sides can be self-consistently wrong, a skill teaching
 * `fix_reason` while the format says `fix_tier`, with every test on each side
 * passing.
 *
 * THAT MAKES IT A KNOWN ODDITY, named rather than hidden: production code
 * whose only caller is a test. It is kept because losing it loses the
 * consistency check on a live contract, and it is flagged on #103.
 *
 * AND THE VALIDATION IT USED TO PERFORM DID NOT VANISH -- IT MOVED TO A PERSON
 * (Codex, #102 round 2). `review-loop-record.mjs` read every PR body and
 * refused a malformed block by key name, so `docs/engineering/code-review.md`
 * told the reviewer that a malformed block could never reach them. With the
 * reader gone that sentence was false in the worst direction: it told the
 * reviewer not to check the one thing nothing else checked. That document now
 * says the shape check is theirs. If a runtime reader is ever restored, that
 * paragraph is the other half of the change.
 */

/**
 * Which lines sit inside a fenced code block. A fence opens on ``` or ~~~ with
 * any info string and closes on a fence of the SAME character at least as
 * long, per CommonMark -- so a ```` ```` ```` block containing ``` does not
 * close early. The fence lines themselves count as inside: neither is a
 * heading, and treating them as outside would let ```` ```## X ```` slip past.
 */
export function fenceRegions(lines) {
  const regions = [];
  let open = null; // { char, len, start, info }
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(lines[i]);
    if (!open) {
      // An opening fence's info string may not contain a backtick.
      if (m && !(m[1][0] === "`" && m[2].includes("`"))) {
        open = { char: m[1][0], len: m[1].length, start: i, info: m[2].trim() };
      }
      continue;
    }
    if (m && m[1][0] === open.char && m[1].length >= open.len && m[2].trim() === "") {
      regions.push({ start: open.start, end: i, info: open.info, closed: true });
      open = null;
    }
  }
  // AN UNCLOSED FENCE RUNS TO THE END OF THE DOCUMENT, per CommonMark, and
  // that is what the mask has always done. Recording it as a region keeps the
  // two derived views -- the mask and the opener list -- in agreement, so a
  // truncated body cannot make a line inert for one reader and live for the
  // other.
  if (open) regions.push({ start: open.start, end: lines.length - 1, info: open.info, closed: false });
  return regions;
}

function fenceMask(lines) {
  const mask = new Array(lines.length).fill(false);
  for (const { start, end } of fenceRegions(lines)) {
    for (let i = start; i <= end; i += 1) mask[i] = true;
  }
  return mask;
}

/**
 * WHICH LINES ARE INERT -- the one definition, with two consumers.
 *
 * A line is inert when it is not the author's own assertion: inside a fenced
 * block (markers included), inside a blockquote, inside an indented code
 * block, or inside an HTML comment. `outsideFences` drops those lines; the
 * declaration scan asks whether a fence OPENER sits at a live position. The
 * two must never disagree, so they read this and nothing else.
 *
 * Fences were masked in #38's rounds 8-10 and the two other literal contexts
 * were not: a four-space-indented Tier C template was accepted as a PR's
 * oracle, and a blockquoted provenance line resolved an unrelated commit. An
 * indented line inside a list item is list content, not code, so indentation
 * counts only when the previous live line is blank or absent -- the CommonMark
 * rule for where an indented code block can start. (Codex, #38 round 11.)
 *
 * HTML COMMENTS ARE THE FOURTH, and they are inert on BOTH paths -- David
 * settled that at #43's approval (2026-09-07). A PR-template placeholder IS an
 * HTML comment, and the placeholders carry the very strings this file scans
 * for: the template's own note under `**Fix tier:**` spells out "A or B". So a
 * body nobody filled in could be read as one that answered. Keeping the prose
 * path exempt would have preserved that as a guarantee. It was a defect.
 *
 * Comment spans are removed from a line rather than the line being dropped:
 * `Workstream: #<!-- issue number -->` is a real template line whose live half
 * matters. A line is inert only when comments leave nothing behind.
 *
 * ORDER MATTERS AND IS DELIBERATE: fences are resolved first, so a `<!--`
 * shown inside a fenced example cannot open a comment. The residue is the
 * reverse case -- an UNBALANCED fence inside a comment masks to the end of the
 * document. Stated rather than fixed: it is the same shape as an unbalanced
 * fence anywhere else, which this file has always treated that way.
 */
function inertScan(lines) {
  const fenced = fenceMask(lines);
  const mask = new Array(lines.length).fill(false);
  const live = new Array(lines.length).fill("");
  // Comment membership is tracked SEPARATELY as well as folded into `mask`,
  // because the declaration scan needs the one reason `mask` cannot give it:
  // a fence opener is always masked -- it is a fence -- so "is this opener
  // live?" can only be answered by asking whether something ELSE covers it.
  const comment = new Array(lines.length).fill(false);
  // Every line with its HTML comments removed and nothing else changed --
  // fences, blockquotes and indented code intact. `live` is not that: it is
  // empty for every masked line. (Codex, #46 round 4.)
  const stripped = lines.slice();
  let inComment = false;
  let prevBlank = true;
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    if (inComment) comment[i] = true;
    if (fenced[i] && !inComment) {
      mask[i] = true;
      continue;
    }
    let rest = raw;
    let kept = "";
    let touched = false;
    while (rest.length) {
      if (inComment) {
        touched = true;
        const end = rest.indexOf("-->");
        if (end === -1) {
          rest = "";
          break;
        }
        inComment = false;
        rest = rest.slice(end + 3);
        continue;
      }
      const open = rest.indexOf("<!--");
      if (open === -1) {
        kept += rest;
        break;
      }
      touched = true;
      kept += rest.slice(0, open);
      rest = rest.slice(open + 4);
      inComment = true;
      comment[i] = true;
    }
    if (touched) stripped[i] = kept;
    if (touched && kept.trim() === "") {
      mask[i] = true;
      continue;
    }
    const line = touched ? kept : raw;
    if (/^\s*>/.test(line)) {
      mask[i] = true;
      continue;
    }
    if (prevBlank && /^(?: {4,}|\t)\S/.test(line)) {
      mask[i] = true;
      continue;
    }
    live[i] = line;
    prevBlank = line.trim() === "";
  }
  return { mask, live, comment, stripped };
}

// ---------------------------------------------------------------------------
// The declared provenance block
//
// Plan-review PR #43, final plan commit fa59cce, approved by David on
// 2026-09-07. That plan's *The declaration, normatively* section is the wire
// format; the tables below are it, and a change to either belongs there first.
// The format is shared between five producer documents and this one parser,
// and nothing compares a skill's template against a parser's key set -- so
// both sides can be self-consistently wrong. That is why the format has a
// defining document at all.
// ---------------------------------------------------------------------------

/** Info string of the fence that carries a declaration. Not `yaml`: a `yaml`
 * block is ordinary content in a PR body, and a sentinel must not be. */
export const DECLARATION_INFO = "plan-provenance";

/** Each kind's required keys. Every key not listed is forbidden for that kind;
 * there are no optional keys, so present-or-absent is never ambiguous. */
export const DECLARATION_KINDS = {
  "approved-plan": ["plan_review_pr", "plan_commit", "plan_file", "approved_by", "approved_on"],
  "approved-plan-split": ["plan_review_prs", "combined_plan_commit", "combined_branch", "plan_file", "approved_by", "approved_on"],
  "private-plan": ["plan_filename", "plan_sha256", "approved_by", "approved_on"],
  bugfix: ["fix_tier"],
  trivial: [],
  "plan-review": [],
};

/**
 * `plan-review/<slug>-combined`, with the slug's four separate rules. Written
 * as clauses rather than one regex because the grammar HAS four clauses, and a
 * single "looks about right" pattern satisfies two of them while quietly
 * dropping the rest.
 */
function validCombinedBranch(value) {
  const PREFIX = "plan-review/";
  const SUFFIX = "-combined";
  if (!value.startsWith(PREFIX) || !value.endsWith(SUFFIX)) return false;
  const slug = value.slice(PREFIX.length, value.length - SUFFIX.length);
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(slug)) return false; // class and length
  if (/^[._-]|[._-]$/.test(slug)) return false; // no leading or trailing separator
  if (/[._-]{2}/.test(slug)) return false; // no two adjacent separators
  return true;
}

/** Every key this parser knows, and the shape its value must have. A key
 * absent from this table is an UNKNOWN key, which refuses -- a permissive
 * parser would read a misspelling as an absence, which is the fail-open
 * direction and the one this repository's failure record returns to most. */
export const DECLARATION_GRAMMARS = {
  plan_review_pr: { test: (v) => /^[1-9]\d*$/.test(v), says: "a positive integer, written without `#`" },
  plan_review_prs: { test: (v) => /^[1-9]\d*(?:,[1-9]\d*)+$/.test(v), says: "two or more positive integers, comma-separated" },
  plan_commit: { test: (v) => /^[0-9a-f]{7,40}$/.test(v), says: "7-40 lowercase hexadecimal characters" },
  combined_plan_commit: { test: (v) => /^[0-9a-f]{7,40}$/.test(v), says: "7-40 lowercase hexadecimal characters" },
  combined_branch: { test: validCombinedBranch, says: "`plan-review/<slug>-combined`, the slug non-empty, from `[A-Za-z0-9._-]`, neither beginning nor ending with a separator and carrying no two adjacent ones" },
  plan_file: { test: (v) => /^docs\/plans\/PLAN_[A-Z0-9_]{1,100}\.md$/.test(v), says: "a repository-relative `docs/plans/PLAN_*.md` path" },
  plan_filename: { test: (v) => /^PLAN_[A-Z0-9_]{1,100}\.md$/.test(v), says: "a bare `PLAN_*.md` filename with no path separators -- a private plan is handed to David as a file and never committed, so it has a name and no repository path" },
  plan_sha256: { test: (v) => /^[0-9a-f]{64}$/.test(v), says: "exactly 64 lowercase hexadecimal characters" },
  approved_by: { test: (v) => v === "David", says: "exactly `David`" },
  approved_on: { test: (v) => /^\d{4}-\d{2}-\d{2}$/.test(v), says: "`YYYY-MM-DD`" },
  fix_tier: { test: (v) => /^[ABC]$/.test(v), says: "one of `A`, `B` or `C`" },
};

/**
 * The declaration this PR body carries, or `null` when it carries none.
 *
 * Returns `{ refuse }` on anything malformed, and the caller turns that into a
 * refusal rather than falling back to prose: fall-through would let a typo
 * silently re-enter the class this block exists to close, which is the one
 * failure that would make the whole change worthless.
 *
 * The block is read only where the author ASSERTS it -- a fence opener at a
 * live position, per the shared inert-line boundary. A declaration inside a
 * blockquote, an indented block, another fence or an HTML comment is quoted,
 * not claimed, and this returns `null` for it.
 */
export function planProvenanceDeclaration(body) {
  const lines = String(body ?? "").split(/\r?\n/);
  const { comment } = inertScan(lines);
  // Blockquoted and four-space-indented fences are not fence openers at all --
  // the opener pattern allows at most three leading spaces and no `>` -- and
  // `fenceRegions` never reports a fence nested inside another. So the one
  // construct that has to be excluded here is the comment.
  const found = fenceRegions(lines).filter((r) => r.info === DECLARATION_INFO && !comment[r.start]);
  if (found.length === 0) return null;
  if (found.length > 1) {
    return {
      refuse:
        `the PR body carries ${found.length} \`${DECLARATION_INFO}\` blocks (lines ` +
        `${found.map((r) => r.start + 1).join(", ")}). Two declarations are a contradiction, and a ` +
        "contradiction the author can see is better than a winner they cannot predict -- first-wins is " +
        "how a sample declaration ahead of the real one silently became the oracle",
    };
  }
  const region = found[0];
  const values = {};
  const order = [];
  // A closed fence's `end` is its closing line; an unclosed one's `end` is the
  // document's last line, which IS content. (Codex, #46 round 4.)
  const stop = region.closed ? region.end : region.end + 1;
  for (let i = region.start + 1; i < stop; i += 1) {
    const line = lines[i];
    if (line.trim() === "") continue;
    const m = /^\s*([A-Za-z0-9_]+)\s*:\s*(.*?)\s*$/.exec(line);
    if (!m) {
      return { refuse: `line ${i + 1} of the \`${DECLARATION_INFO}\` block is not \`key: value\`: ${JSON.stringify(line)}. The block has no comments, nesting, quoting or multi-line values` };
    }
    const [, key, value] = m;
    if (Object.hasOwn(values, key)) {
      return { refuse: `the \`${DECLARATION_INFO}\` block repeats \`${key}\`. A repeated key has no defined winner, so it refuses rather than picking one` };
    }
    values[key] = value;
    order.push(key);
  }
  if (order[0] !== "kind") {
    return { refuse: `the \`${DECLARATION_INFO}\` block must open with \`kind\`${order.length ? `, not \`${order[0]}\`` : " and is empty"}` };
  }
  const kind = values.kind;
  // `Object.hasOwn`, NOT a truthiness test on the lookup. `kind: constructor`
  // (or `toString`, or `__proto__`) reaches an inherited property, which is
  // truthy and is not an array -- so the required-key loop below threw a
  // TypeError instead of producing the refusal this function promises for
  // every malformed body. A crash where a refusal was specified is the worst
  // shape available: the loop cannot obtain a verdict to continue OR to stop.
  // (Codex, #46 round 1.)
  const required = Object.hasOwn(DECLARATION_KINDS, kind) ? DECLARATION_KINDS[kind] : null;
  if (!required) {
    return { refuse: `\`kind: ${kind}\` is not a kind this contract defines (${Object.keys(DECLARATION_KINDS).join(", ")})` };
  }
  for (const key of required) {
    if (!Object.hasOwn(values, key)) {
      return { refuse: `the \`${DECLARATION_INFO}\` block declares \`kind: ${kind}\` but omits \`${key}\`, which that kind requires` };
    }
  }
  for (const key of order) {
    if (key === "kind") continue;
    if (!Object.hasOwn(DECLARATION_GRAMMARS, key)) {
      return { refuse: `\`${key}\` is not a key this contract defines. An unknown key refuses rather than being ignored, so a misspelling can never read as an absence` };
    }
    if (!required.includes(key)) {
      return { refuse: `\`${key}\` is forbidden for \`kind: ${kind}\`, which requires exactly ${required.length ? required.map((k) => `\`${k}\``).join(", ") : "no other keys"}` };
    }
    const grammar = DECLARATION_GRAMMARS[key];
    if (!grammar.test(values[key])) {
      return { refuse: `\`${key}: ${values[key]}\` is malformed -- it must be ${grammar.says}` };
    }
  }
  return { kind, values, line: region.start + 1 };
}

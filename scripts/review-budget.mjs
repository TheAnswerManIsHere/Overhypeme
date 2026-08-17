#!/usr/bin/env node
/**
 * The review-round budget: a mechanical stopping rule for review loops.
 *
 * WHY THIS IS A CHECK AND NOT A CONTRACT LINE
 * -------------------------------------------
 * PR #488 ran 22 Codex review rounds on a ~10-line guard change. The
 * post-mortem's finding was structural, not a diligence failure: **every
 * individual round was locally rational.** Each one had real findings, each
 * fix was correct, and nothing in the loop ever presented the aggregate --
 * "this is round 19 of a 10-line change" -- as a fact anyone had to look at.
 * The judgment-shaped stopping devices already in the contract (criticality
 * gate, count trend, growth tripwire, oscillation diagnosis) went 0-for-15 in
 * that loop. The two stops that did happen were both a **pre-registered flip
 * condition colliding with an event**, 2-for-2.
 *
 * Per the repo's standing rule -- a discipline broken twice becomes a check,
 * not another undertaking -- the fix is a guard on the action path. Not a
 * better reminder to notice: a refusal at the moment the next round would be
 * requested, which is the one moment the aggregate is unavoidable.
 *
 * WHAT IT ACTUALLY DOES
 * ---------------------
 * `guard-decision.mjs` routes any tool call that would POST an `@codex review`
 * comment here. This module answers one question -- may this round be
 * requested? -- from files on disk, never from the loop's own narration:
 *
 *   .agents/receipts/loop-budget-<pr>.json      the budget, declared before round 1
 *   .agents/receipts/loop-rounds-<pr>.json      the tally, appended on every allowed post
 *   .agents/receipts/loop-extension-<pr>-N.json an extension, from adjudication or David
 *
 * Three refusal shapes, in the order they bite:
 *
 *   1. NO BUDGET. Refused until a budget exists. This is what forces the
 *      declaration to happen *before* round 1 rather than being remembered
 *      at round 12 -- there is no "declare it later" path, because the first
 *      request is already blocked.
 *   2. AT BUDGET (tier-1 tripwire). Refused until a one-shot FRESH-CONTEXT
 *      adjudicator has ruled. Fresh context is the whole point and is not
 *      negotiable: a same-context "pause and re-evaluate" is the criticality
 *      gate again, and the criticality gate is one of the devices that went
 *      0-for-15. The adjudicator's input is a script-generated mechanical
 *      record (`review-loop-record.mjs`), never this loop's prose.
 *   3. EXTENSION EXHAUSTED (tier-2 tripwire). Hard stop to David. There is
 *      **no second self-service extension, ever** -- an adjudicator that
 *      could extend twice is a loop that can extend itself indefinitely two
 *      rounds at a time, which is the failure this exists to close.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * --------------------------------
 * It does not verify authorship. A David-authorization receipt is a file this
 * session writes, quoting his words, and nothing here can tell a quoted
 * authorization from an invented one. That is accepted rather than papered
 * over: fabricating a receipt is a *different failure class* from the one
 * being closed here (a loop that never notices its own length), and a guard
 * that pretends to defend against its own author is a false assurance. The
 * defense against fabrication is that the receipts are committed, reviewed,
 * and read back in the weekly maintenance digest.
 *
 * FAIL-CLOSED, in every direction it can be wrong:
 *   - Unreadable, malformed, or mismatched receipt -> refuse and name it.
 *     A budget guard that ignores a receipt it cannot parse is a budget guard
 *     that can be switched off with a syntax error.
 *   - Unknown PR number, missing body, unparseable payload -> refuse.
 *   - The tally is written BEFORE the post, so a post that then fails is
 *     counted anyway. Over-counting fails toward tripping earlier, which is
 *     the safe direction; under-counting is the failure mode being closed.
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const RECEIPTS_DIR = ".agents/receipts";
export const REPO_OWNER = "TheAnswerManIsHere";
export const REPO_NAME = "Overhypeme";

/**
 * Blast-radius tiers (David, 2026-08-17, issue #501).
 *
 * `budget` is the round cap; `null` means uncapped by design. `escalateAt` is
 * where an uncapped tier still owes David a mandatory stop -- uncapped is not
 * unattended.
 *
 * `selfServe` is the tier's answer to "may the first tripwire be cleared by an
 * adjudicator instead of by David?" Sensitive work says no: on auth, payments
 * and migrations the mandatory 🛑 at 5 IS the tripwire, and routing it to a
 * subagent would convert the one escalation the tier exists to guarantee into
 * one more thing decided in-house.
 */
export const TIERS = {
  internal: {
    budget: 3,
    escalateAt: null,
    selfServe: true,
    label: "internal tooling / docs / guards / agent contracts",
  },
  product: {
    budget: 5,
    escalateAt: null,
    selfServe: true,
    label: "product code",
  },
  sensitive: {
    budget: null,
    escalateAt: 5,
    selfServe: false,
    label: "auth / payments / migrations (uncapped, mandatory 🛑 at 5)",
  },
};

/** The cap a tier enforces before any extension: its budget, or its 🛑 point. */
export const tierCap = (tier) => TIERS[tier].budget ?? TIERS[tier].escalateAt;

/** The most rounds one adjudication may ever grant. */
export const MAX_ADJUDICATION_GRANT = 2;

/** Verdicts the adjudicator may return. Only `continue` grants rounds. */
export const ADJUDICATION_VERDICTS = new Set(["ship-with-gaps-recorded", "split", "continue", "escalate"]);

/**
 * Tool calls that can post a review request.
 *
 * Chosen by "can this call put a body on a PR that Codex will read as a
 * trigger", not by tool family -- `add_comment_to_pending_review` is
 * deliberately absent because an inline review comment is not how a re-request
 * is delivered here, and including it would refuse ordinary review-writing on
 * a PR that merely quotes the trigger phrase.
 */
export const REVIEW_REQUEST_TOOLS = new Set([
  "mcp__github__add_issue_comment",
  "mcp__github__add_reply_to_pull_request_comment",
  "mcp__github__pull_request_review_write",
]);

/**
 * The trigger phrase, as Codex's connector actually reads it.
 *
 * KNOWN AND ACCEPTED FALSE POSITIVE: a comment that merely *quotes* the phrase
 * -- explaining this very mechanism in a PR thread, say -- is refused too.
 * That is the safe direction (it blocks a comment, never a merge), and the
 * workaround is to not write the literal trigger inside a comment about the
 * trigger. Loosening it to exclude quoted/code-fenced occurrences would mean
 * judging raw text structure, which is the exact defect `guard-decision.mjs`'s
 * header argues against.
 */
export const REVIEW_REQUEST_RE = /@codex\s+review\b/i;

export function mentionsReviewRequest(body) {
  return typeof body === "string" && REVIEW_REQUEST_RE.test(body);
}

/**
 * The PR this call targets, or null when it cannot be read.
 *
 * `add_issue_comment` addresses the issue resource (`issue_number`) and the
 * other two address the pull resource (`pullNumber`); a PR's issue number and
 * PR number are the same integer, which is why one budget file serves both.
 */
export function prNumberFrom(toolInput) {
  const raw = toolInput?.pullNumber ?? toolInput?.issue_number;
  const n = typeof raw === "string" ? Number(raw) : raw;
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** True when the call targets this repo. Anything else is not our loop. */
export function targetsThisRepo(toolInput) {
  const owner = String(toolInput?.owner ?? "").toLowerCase();
  const repo = String(toolInput?.repo ?? "").toLowerCase();
  return owner === REPO_OWNER.toLowerCase() && repo === REPO_NAME.toLowerCase();
}

// ---------------------------------------------------------------------------
// Receipt paths
// ---------------------------------------------------------------------------

export const budgetPath = (pr) => `${RECEIPTS_DIR}/loop-budget-${pr}.json`;
export const roundsPath = (pr) => `${RECEIPTS_DIR}/loop-rounds-${pr}.json`;
export const extensionPath = (pr, seq) => `${RECEIPTS_DIR}/loop-extension-${pr}-${seq}.json`;

/**
 * The sequence in an extension filename for this PR, or null if the name is
 * not one. String slicing rather than a built regex: CodeQL flagged the
 * previous `new RegExp(...${pr}...)` as regex injection, and it was right in
 * principle even though `pr` is an integer by the time it arrives here.
 * Removing the dynamic pattern removes the question entirely, and the
 * canonical-name check below is clearer as an explicit comparison anyway.
 */
function extensionSequence(pr, name) {
  const prefix = `loop-extension-${pr}-`;
  const suffix = ".json";
  if (!name.startsWith(prefix) || !name.endsWith(suffix)) return null;
  const seq = name.slice(prefix.length, name.length - suffix.length);
  return /^\d+$/.test(seq) ? seq : null;
}

// ---------------------------------------------------------------------------
// I/O adapter. Injectable so the whole decision matrix is testable without
// touching the filesystem -- the same reason `guard-decision.mjs` keeps its
// judgement pure and its transport thin.
// ---------------------------------------------------------------------------

export function nodeIo(root = REPO_ROOT) {
  const abs = (rel) => path.join(root, rel);
  return {
    now: () => new Date().toISOString(),
    /**
     * `null` means the file is ABSENT. Anything else -- a permissions error, a
     * transient I/O failure -- throws, and `readJson` turns that into a
     * refusal. Collapsing the two (as this did until Codex round 1) makes an
     * unreadable tally indistinguishable from zero rounds spent, which
     * reopens an exhausted loop on an I/O error.
     */
    read(rel) {
      try {
        return fs.readFileSync(abs(rel), "utf8");
      } catch (err) {
        if (err.code === "ENOENT") return null;
        throw err;
      }
    },
    exists: (rel) => fs.existsSync(abs(rel)),
    listReceipts() {
      try {
        return fs.readdirSync(abs(RECEIPTS_DIR));
      } catch {
        return [];
      }
    },
    write(rel, text) {
      fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
      fs.writeFileSync(abs(rel), text);
    },
    /**
     * The tally as `main`'s history has it, so the guard can tell a round that
     * was recorded from a round that was recorded AND SURVIVES this container.
     * Throws when git cannot answer; the caller refuses rather than guessing.
     */
    committedRounds(rel) {
      let text;
      try {
        text = execFileSync("git", ["show", `HEAD:${rel}`], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      } catch {
        return 0; // not in HEAD yet -- a loop whose first round has not landed
      }
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed?.rounds)) throw new Error(`committed ${rel} has no rounds array`);
      return parsed.rounds.length;
    },
  };
}

/** Read + parse, distinguishing "absent" from "present but unreadable". */
function readJson(io, rel) {
  let text;
  try {
    text = io.read(rel);
  } catch (err) {
    return { state: "unreadable", error: err.message };
  }
  if (text === null) return { state: "absent" };
  try {
    return { state: "ok", value: JSON.parse(text) };
  } catch (err) {
    return { state: "malformed", error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Receipt validation. Every one of these returns a REASON STRING on failure,
// never a boolean -- the refusal has to say which file is wrong and what to do
// about it, or the guard is just a wall.
// ---------------------------------------------------------------------------

export function validateBudget(pr, receipt) {
  if (!receipt || typeof receipt !== "object") return "budget receipt is not an object";
  if (receipt.pr !== pr) return `budget receipt names PR ${receipt.pr}, not ${pr}`;
  if (!Object.hasOwn(TIERS, receipt.tier)) {
    return `budget receipt tier "${receipt.tier}" is not one of: ${Object.keys(TIERS).join(", ")}`;
  }
  const expected = TIERS[receipt.tier].budget;
  // The declared number must MATCH the tier's, not merely be present. A free
  // text budget field would let the loop pick its own cap, which is the
  // no-stopping-rule state wearing a receipt.
  if ((receipt.budget ?? null) !== expected) {
    return `budget receipt declares budget ${JSON.stringify(receipt.budget ?? null)} but tier "${receipt.tier}" is ${JSON.stringify(expected)}`;
  }
  if (!Number.isInteger(receipt.criticality) || receipt.criticality < 1 || receipt.criticality > 100) {
    return "budget receipt needs an integer criticality 1-100 (the shared criticality gate's rating)";
  }
  if (typeof receipt.artifact !== "string" || !receipt.artifact.trim()) {
    return "budget receipt needs a non-empty `artifact` naming what is under review";
  }
  // Codex auto-reviews every non-draft PR on open, with no trigger comment --
  // and `loop-metrics.mjs` counts that pass as round 1, because a round is a
  // completed reviewer PASS, not a trigger. A tally that counts only the posts
  // this guard sees would therefore enforce "3" as one automatic pass plus
  // three re-requests: four rounds by the repo's own definition, and the same
  // off-by-one on every tier. (Codex, round 1.) So the declaration states
  // whether this PR gets that opening pass, and it is counted.
  if (typeof receipt.autoOpeningReview !== "boolean") {
    return "budget receipt needs a boolean `autoOpeningReview` (true for a non-draft PR, which Codex reviews on open; false for a draft that gets no automatic pass)";
  }
  return null;
}

/** Whether the tally is a plausible round tally FOR THIS PR. */
export function validateRounds(pr, receipt) {
  if (!receipt || typeof receipt !== "object") return "rounds tally is not an object";
  // Same rule the budget and extension receipts already had, and its absence
  // here was a real hole: a tally copied or conflict-resolved from another PR
  // silently resets a long loop to that PR's smaller count. (Codex, round 1.)
  if (receipt.pr !== pr) return `rounds tally names PR ${receipt.pr}, not ${pr}`;
  if (!Array.isArray(receipt.rounds)) return '"rounds" must be an array';
  return null;
}

/**
 * The mechanical record a `continue` verdict claims to have ruled on must
 * actually exist, actually be one of ours, and actually describe THIS PR.
 *
 * Without this, any non-empty `recordPath` -- a typo, a stale path, another
 * loop's record -- reopens the guard for two more rounds with the
 * script-generated record never having existed. (Codex, round 1.) This is not
 * an anti-forgery check and cannot be one; it catches the accidental
 * malformation, which is a different and far likelier failure than the
 * fabrication this module's header already declines to defend against.
 */
function validateRecordReference(pr, recordPath, io) {
  if (!io) return null; // pure-validation callers; the guard always passes io
  const parsed = readJson(io, recordPath);
  if (parsed.state === "absent") return `cited mechanical record ${recordPath} does not exist`;
  if (parsed.state !== "ok") return `cited mechanical record ${recordPath} is unreadable (${parsed.error})`;
  if (parsed.value?.generator !== "scripts/review-loop-record.mjs") {
    return `${recordPath} was not produced by review-loop-record.mjs (generator: ${JSON.stringify(parsed.value?.generator)})`;
  }
  if (parsed.value?.pr !== pr) return `${recordPath} describes PR ${parsed.value?.pr}, not ${pr}`;
  return null;
}

export function validateExtension(pr, tier, receipt, { adjudicationsAlreadySeen, io }) {
  if (!receipt || typeof receipt !== "object") return "extension receipt is not an object";
  if (receipt.pr !== pr) return `extension receipt names PR ${receipt.pr}, not ${pr}`;

  if (receipt.kind === "adjudication") {
    if (!TIERS[tier].selfServe) {
      return `tier "${tier}" has no self-serve extension -- its tripwire is a mandatory 🛑 to David, not an adjudication`;
    }
    if (adjudicationsAlreadySeen > 0) {
      return "a SECOND adjudication extension is never valid (tier 2 is a hard stop to David, by design)";
    }
    if (!ADJUDICATION_VERDICTS.has(receipt.verdict)) {
      return `adjudication verdict "${receipt.verdict}" is not one of: ${[...ADJUDICATION_VERDICTS].join(", ")}`;
    }
    if (receipt.verdict !== "continue") return null; // valid, grants nothing
    if (!Number.isInteger(receipt.grant) || receipt.grant < 1 || receipt.grant > MAX_ADJUDICATION_GRANT) {
      return `a continue verdict grants 1-${MAX_ADJUDICATION_GRANT} rounds, not ${JSON.stringify(receipt.grant)}`;
    }
    // The named risk is the entire justification for continuing. Without it a
    // continue verdict is "keep going" with no content, which is what the loop
    // would have done unaided.
    if (typeof receipt.risk !== "string" || !receipt.risk.trim()) {
      return "a continue verdict must name the specific unaddressed BEHAVIORAL risk in `risk`";
    }
    if (typeof receipt.recordPath !== "string" || !receipt.recordPath.trim()) {
      return "adjudication receipt must cite the mechanical record it ruled on in `recordPath`";
    }
    return validateRecordReference(pr, receipt.recordPath, io);
  }

  if (receipt.kind === "david") {
    const uncapped = receipt.grant === "uncapped";
    if (!uncapped && (!Number.isInteger(receipt.grant) || receipt.grant < 1)) {
      return `David authorization must grant a positive integer of rounds or "uncapped", not ${JSON.stringify(receipt.grant)}`;
    }
    if (typeof receipt.authorization !== "string" || !receipt.authorization.trim()) {
      return "David authorization must quote his words in `authorization` (unverifiable by design -- see this file's header)";
    }
    return null;
  }

  return `extension receipt kind "${receipt.kind}" is not "adjudication" or "david"`;
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

/**
 * Load every receipt for one loop. Returns either a `problem` (fail closed,
 * with the reason already phrased for the refusal) or the loop's state.
 */
export function loadLoop(pr, io) {
  const budget = readJson(io, budgetPath(pr));
  if (budget.state === "absent") return { problem: "no-budget" };
  if (budget.state !== "ok") {
    return { problem: "bad-receipt", detail: `${budgetPath(pr)} could not be read (${budget.state}: ${budget.error})` };
  }
  const budgetError = validateBudget(pr, budget.value);
  if (budgetError) return { problem: "bad-receipt", detail: `${budgetPath(pr)}: ${budgetError}` };

  const tier = budget.value.tier;

  // Iterate the FILENAMES, never a number reconstructed from them.
  //
  // Normalizing `loop-extension-1-01.json` to sequence 1 and then rebuilding
  // the path from that number reads the canonical `-1.json` twice and never
  // opens the malformed file at all -- so a David receipt granting two rounds
  // silently grants four, and the extra grant comes from a file nobody
  // validated. (Codex, round 2.) A non-canonical name is refused outright
  // rather than tolerated: an ambiguous receipt set is exactly the input this
  // guard must not resolve in its own favour.
  const found = [];
  for (const name of io.listReceipts()) {
    const seq = extensionSequence(pr, name);
    if (seq === null) continue;
    if (String(Number(seq)) !== seq) {
      return {
        problem: "bad-receipt",
        detail: `${RECEIPTS_DIR}/${name} is not a canonical extension name (sequence "${seq}" is zero-padded or otherwise non-canonical)`,
      };
    }
    found.push({ seq: Number(seq), name });
  }
  found.sort((a, b) => a.seq - b.seq);
  for (let i = 1; i < found.length; i += 1) {
    if (found[i].seq === found[i - 1].seq) {
      return {
        problem: "bad-receipt",
        detail: `two extension receipts claim sequence ${found[i].seq} (${found[i - 1].name}, ${found[i].name})`,
      };
    }
  }

  const extensions = [];
  let adjudicationsSeen = 0;
  for (const { seq, name } of found) {
    const rel = `${RECEIPTS_DIR}/${name}`;
    const parsed = readJson(io, rel);
    if (parsed.state !== "ok") {
      return { problem: "bad-receipt", detail: `${rel} could not be read (${parsed.state}: ${parsed.error ?? "unreadable"})` };
    }
    const error = validateExtension(pr, tier, parsed.value, { adjudicationsAlreadySeen: adjudicationsSeen, io });
    if (error) return { problem: "bad-receipt", detail: `${rel}: ${error}` };
    if (parsed.value.kind === "adjudication") adjudicationsSeen += 1;
    extensions.push({ seq, ...parsed.value });
  }

  const rounds = readJson(io, roundsPath(pr));
  if (rounds.state !== "ok" && rounds.state !== "absent") {
    return { problem: "bad-receipt", detail: `${roundsPath(pr)} could not be read (${rounds.state}: ${rounds.error})` };
  }
  if (rounds.state === "ok") {
    const error = validateRounds(pr, rounds.value);
    if (error) return { problem: "bad-receipt", detail: `${roundsPath(pr)}: ${error}` };
  }

  return {
    budget: budget.value,
    tier,
    extensions,
    rounds: rounds.state === "ok" ? rounds.value.rounds : [],
  };
}

/**
 * Rounds this loop may request in total, given its tier, its extensions, and
 * how many rounds it has actually spent.
 *
 * EXTENSIONS ACTIVATE IN SEQUENCE, AND ONLY ONCE EVERYTHING BEFORE THEM IS
 * SPENT. That dependency on `roundsSpent` is the whole point and is why this
 * is not simply a sum. A `continue` receipt that raises the allowance the
 * moment it exists -- written early, or carried over by accident -- means the
 * loop sails past its cap and **tripwire 1 never fires**: no refusal, and the
 * aggregate never gets presented to anyone. That is precisely the failure this
 * module exists to prevent, arriving through the mechanism meant to prevent
 * it. (Codex, round 1.)
 *
 * So a dormant extension is not consumed and not counted; it activates at the
 * exact round the stage before it runs out, which is also the round the
 * adjudication was supposed to be about.
 */
export function allowance(tier, extensions, roundsSpent = Infinity) {
  let total = tierCap(tier);
  for (const ext of extensions) {
    if (roundsSpent < total) break; // this stage is not exhausted yet
    if (ext.kind === "david") {
      if (ext.grant === "uncapped") return Infinity;
      total += ext.grant;
    } else if (ext.kind === "adjudication" && ext.verdict === "continue") {
      total += ext.grant;
    }
  }
  return total;
}

/**
 * Rounds this loop has spent. The tally counts the trigger posts this guard
 * saw; the automatic opening pass has no trigger and is added here, so the cap
 * is enforced against the repo's definition of a round rather than against
 * "comments I posted".
 */
export const roundsSpent = (state) => state.rounds.length + (state.budget.autoOpeningReview ? 1 : 0);

/** Whether the loop has already spent its one self-serve extension. */
const hasAdjudication = (extensions) => extensions.some((e) => e.kind === "adjudication");

/**
 * The refusal text. This is the product, not a side note: it is read by the
 * one agent that can act on it, at the one moment it can act, and it has to
 * carry the aggregate the loop could not see for itself.
 */
function refusal(pr, state) {
  const { budget, tier, extensions } = state;
  const spent = roundsSpent(state);
  const cap = allowance(tier, extensions, spent);
  const opening = budget.autoOpeningReview ? " (including Codex's automatic opening pass)" : "";
  const head =
    `review round ${spent + 1} on PR #${pr} exceeds its declared budget ` +
    `(tier "${tier}" -- ${TIERS[tier].label}; ${spent} of ${cap} rounds already spent${opening}; ` +
    `criticality ${budget.criticality}).`;

  if (!hasAdjudication(extensions) && TIERS[tier].selfServe) {
    return (
      `${head}\n` +
      `TRIPWIRE 1 (self-serve). Do NOT re-evaluate this in the loop's own context -- that is the ` +
      `criticality gate again, and it has never stopped a loop. Instead:\n` +
      `  1. node scripts/review-loop-record.mjs --pr ${pr} --mcp-snapshot <file> --write\n` +
      `  2. Dispatch ONE fresh-context adjudicator subagent (.claude/agents/review-loop-adjudicator.md), ` +
      `giving it the generated record and nothing else from this session.\n` +
      `  3. Write its verdict to ${extensionPath(pr, extensions.length + 1)} ` +
      `(ship-with-gaps-recorded | split | continue+grant<=${MAX_ADJUDICATION_GRANT}+risk | escalate).\n` +
      `Default verdict is ship-with-gaps-recorded. Only "continue" reopens this guard, and only once.`
    );
  }

  return (
    `${head}\n` +
    `TRIPWIRE 2 (hard stop). The one self-serve extension is spent, and there is never a second one. ` +
    `Take this to David as a 🛑 NEED YOU with the adjudication record pre-written as the options, and record ` +
    `his answer in ${extensionPath(pr, extensions.length + 1)} as {"kind":"david","grant":<n|"uncapped">,` +
    `"authorization":"<his words>"}.`
  );
}

/**
 * Judge one review-request tool call. `{ blocked, reason }`, matching
 * `decide()`'s contract in `guard-decision.mjs`.
 *
 * Records the round as a side effect when it allows. Recording BEFORE the post
 * rather than after is deliberate: a PreToolUse hook has no "after", and the
 * alternative -- trusting a later step to record -- is exactly the kind of
 * remembered discipline this guard replaces.
 */
export function judgeReviewRequest({ toolName, toolInput }, io = nodeIo()) {
  if (!REVIEW_REQUEST_TOOLS.has(toolName)) return { blocked: false, reason: null };
  if (!mentionsReviewRequest(toolInput?.body)) return { blocked: false, reason: null };
  if (!targetsThisRepo(toolInput)) return { blocked: false, reason: null };

  const pr = prNumberFrom(toolInput);
  if (pr === null) {
    return {
      blocked: true,
      reason:
        "an @codex review post with no readable PR number -- the round budget cannot be checked, " +
        "so this is refused rather than waved through. Include pullNumber/issue_number.",
    };
  }

  const state = loadLoop(pr, io);

  if (state.problem === "no-budget") {
    return {
      blocked: true,
      reason:
        `no round budget declared for PR #${pr}. Declare it BEFORE round 1:\n` +
        `  node scripts/review-budget.mjs declare --pr ${pr} --tier <internal|product|sensitive> ` +
        `--criticality <1-100> --artifact "<what is under review>"\n` +
        `Tiers: internal=3 rounds, product=5, sensitive=uncapped with a mandatory 🛑 at 5. ` +
        `State the budget in the PR body too.`,
    };
  }
  if (state.problem === "bad-receipt") {
    return {
      blocked: true,
      reason: `round-budget receipt is unusable, so the budget cannot be checked: ${state.detail}`,
    };
  }

  const spent = roundsSpent(state);
  if (spent >= allowance(state.tier, state.extensions, spent)) {
    return { blocked: true, reason: refusal(pr, state) };
  }

  // The tally is only a stopping rule if it OUTLIVES the session that wrote
  // it. This container is ephemeral: a round recorded and never committed
  // vanishes with the container, and the next session reads the older
  // committed tally and re-grants the round already spent -- the exact reset
  // the receipt design claims to prevent. (Codex, round 1.) So durability is
  // on the action path too: the previous round must be committed before the
  // next one may be requested.
  let committed;
  try {
    committed = io.committedRounds(roundsPath(pr));
  } catch (err) {
    return {
      blocked: true,
      reason:
        `cannot read the committed round tally for PR #${pr} (${err.message}), so it cannot be verified as durable. ` +
        `Refusing rather than assuming -- an unverifiable tally is how a spent round comes back.`,
    };
  }
  if (committed !== state.rounds.length) {
    return {
      blocked: true,
      reason:
        `the round tally on disk (${state.rounds.length}) differs from the one in HEAD (${committed}). ` +
        `Commit ${roundsPath(pr)} before requesting the next round: an uncommitted tally dies with this ` +
        `container and silently re-grants the rounds it recorded.`,
    };
  }

  recordRound(pr, state, { toolName, io });
  return { blocked: false, reason: null };
}

export function recordRound(pr, state, { toolName, io }) {
  const rounds = [...state.rounds, { at: io.now(), tool: toolName }];
  io.write(roundsPath(pr), `${JSON.stringify({ pr, rounds }, null, 2)}\n`);
  return rounds.length;
}

// ---------------------------------------------------------------------------
// CLI -- declaration and inspection. The guard itself never writes a budget:
// declaring one is an act with a tier judgement in it, so it is a command run
// deliberately, not a file created as a side effect of being blocked.
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith("--")) throw new Error(`unexpected argument: ${token}`);
    const key = token.slice(2);
    const value = rest[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`--${key} needs a value`);
    flags[key] = value;
    i += 1;
  }
  return { command, flags };
}

const USAGE = `usage:
  review-budget.mjs declare --pr <n> --tier <internal|product|sensitive> --criticality <1-100> --artifact "<text>" [--draft true]
  review-budget.mjs status  --pr <n>

--draft true marks a PR that gets NO automatic opening review from Codex (a
[PLAN REVIEW] draft). Omit it for an ordinary PR, whose opening pass counts as
round 1.
`;

function declare(flags, io) {
  const pr = Number(flags.pr);
  if (!Number.isInteger(pr) || pr <= 0) throw new Error("--pr must be a positive integer");
  if (!Object.hasOwn(TIERS, flags.tier)) {
    throw new Error(`--tier must be one of: ${Object.keys(TIERS).join(", ")}`);
  }
  const criticality = Number(flags.criticality);
  // Default true: nearly every loop is a non-draft PR, which Codex reviews on
  // open. `--draft true` is for a `[PLAN REVIEW]` PR, which gets no automatic
  // pass. Defaulting the other way would understate every loop by one round.
  const receipt = {
    pr,
    tier: flags.tier,
    budget: TIERS[flags.tier].budget,
    criticality,
    artifact: flags.artifact ?? "",
    autoOpeningReview: flags.draft !== "true",
    declaredAt: io.now(),
  };
  const error = validateBudget(pr, receipt);
  if (error) throw new Error(error);
  // Never silently replace a live budget: overwriting one mid-loop resets the
  // cap without resetting the rounds already spent, which is the guard
  // defeating itself.
  if (io.exists(budgetPath(pr))) {
    throw new Error(`${budgetPath(pr)} already exists -- a declared budget is not re-declared mid-loop`);
  }
  io.write(budgetPath(pr), `${JSON.stringify(receipt, null, 2)}\n`);
  const cap = tierCap(flags.tier);
  return (
    `declared: PR #${pr}, tier "${flags.tier}" (${TIERS[flags.tier].label}), ` +
    `${TIERS[flags.tier].budget === null ? `uncapped with a mandatory 🛑 at ${cap}` : `${cap} rounds`}, ` +
    `criticality ${criticality}. Written to ${budgetPath(pr)} -- commit it, and state the budget in the PR body.`
  );
}

function status(flags, io) {
  const pr = Number(flags.pr);
  if (!Number.isInteger(pr) || pr <= 0) throw new Error("--pr must be a positive integer");
  const state = loadLoop(pr, io);
  if (state.problem === "no-budget") return `PR #${pr}: no budget declared.`;
  if (state.problem === "bad-receipt") return `PR #${pr}: unusable receipt -- ${state.detail}`;
  const spent = roundsSpent(state);
  const cap = allowance(state.tier, state.extensions, spent);
  return [
    `PR #${pr}: tier "${state.tier}", criticality ${state.budget.criticality}`,
    `rounds spent: ${spent} of ${cap === Infinity ? "uncapped" : cap}` +
      ` (${state.rounds.length} requested` +
      `${state.budget.autoOpeningReview ? " + 1 automatic opening pass" : ", no automatic opening pass"})`,
    `extensions: ${state.extensions.length ? state.extensions.map((e) => `${e.kind}/${e.verdict ?? e.grant}`).join(", ") : "none"}`,
  ].join("\n");
}

async function main() {
  const io = nodeIo();
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err.message}\n${USAGE}`);
    return 1;
  }
  try {
    if (parsed.command === "declare") process.stdout.write(`${declare(parsed.flags, io)}\n`);
    else if (parsed.command === "status") process.stdout.write(`${status(parsed.flags, io)}\n`);
    else {
      process.stderr.write(USAGE);
      return 1;
    }
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    return 1;
  }
  return 0;
}

const invokedDirectly = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  main().then((code) => process.exit(code));
}

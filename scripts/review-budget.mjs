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
 * not another undertaking -- the fix is a guard on the action path: a refusal
 * at the moment the next round would be requested, which is the one moment
 * the aggregate is unavoidable.
 *
 * WHY THERE IS NO TALLY (the first design, and how it died)
 * ---------------------------------------------------------
 * The first version of this module kept a persistent round tally the guard
 * incremented at post time. It was a cache of state GitHub already holds
 * authoritatively -- and in one evening of dogfooding on its own PR it
 * produced a double-count (two writers), a phantom round (a request Codex
 * never answered), a repair command for the phantom (`reconcile`), a
 * durability check for the cache (commit-before-next-round), and then a
 * review round in which six of thirteen findings were against the repair
 * mechanisms rather than the design. That is this repo's measured lesson --
 * recalled numbers wrong 3/3, counted numbers right 3/3 -- replayed inside
 * the very guard built on it: a tally is a recalled number.
 *
 * So rounds are now COUNTED FRESH, the way `pr-ready.mjs` counts merge
 * readiness: the session captures a snapshot of the PR's reviews and issue
 * comments, `check` validates it (bound to this PR and repo, attested
 * complete, recent) and counts rounds with `loop-metrics.mjs`'s own
 * `reviewerPasses()` -- the same function the ledger uses -- plus at most one
 * pending request visible in the comments themselves. The result is an
 * EPHEMERAL round-check receipt the PreToolUse hook demands, one post per
 * receipt. GitHub is the durable store; the receipt is evidence about a
 * moment and dies with the session (gitignored, per the receipts README).
 *
 * Two things ARE durable, because they are decisions rather than evidence:
 *
 *   .agents/receipts/loop-budget-<pr>.json      the budget, declared before round 1
 *   .agents/receipts/loop-extension-<pr>-N.json an extension, from adjudication or David
 *
 * Both are committed: "no second self-service extension, ever" has to survive
 * the container, or tripwire 2 never fires.
 *
 * THE THREE REFUSAL SHAPES, in the order they bite:
 *
 *   1. NO BUDGET. Refused until a budget exists -- there is no
 *      "declare it later" path, because the first request is already blocked.
 *   2. AT BUDGET (tier-1 tripwire). Refused until a one-shot FRESH-CONTEXT
 *      adjudicator, running ON FABLE, has ruled. Its input is a
 *      script-generated mechanical record (`review-loop-record.mjs`), never
 *      this loop's prose -- a same-context "pause and re-evaluate" is the
 *      criticality gate again, and the criticality gate went 0-for-15. A
 *      `continue` verdict must cite a record generated AT the cap, so an
 *      adjudication cannot precede the tripwire it answers.
 *   3. EXTENSION EXHAUSTED (tier-2 tripwire). Hard stop to David. There is
 *      **no second self-service extension, ever.**
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * --------------------------------
 * It does not verify authorship. A David-authorization receipt is a file this
 * session writes, quoting his words, and nothing here can tell a quoted
 * authorization from an invented one. That is accepted rather than papered
 * over -- fabrication is a different failure class from the one being closed
 * (a loop that never notices its own length), and a guard that pretends to
 * defend against its own author is a false assurance. The committed receipts
 * and the weekly digest are the control.
 *
 * FAIL-CLOSED, in every direction it can be wrong: an unreadable, malformed,
 * or mismatched receipt refuses and names the file; a missing, stale,
 * consumed, or foreign round-check receipt refuses; an unlistable receipts
 * directory refuses. A budget guard that ignores what it cannot read is a
 * budget guard a syntax error switches off.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const RECEIPTS_DIR = ".agents/receipts";
export const REPO_OWNER = "TheAnswerManIsHere";
export const REPO_NAME = "Overhypeme";

/**
 * How old a round-check receipt's evidence may be. Same figure as
 * `pr-ready.mjs`'s MAX_EVIDENCE_AGE_MS, for the same reason: reviews land and
 * requests get posted, and evidence past this age describes a loop that may
 * have moved on. Kept as its own constant rather than imported because the
 * two guards must be free to diverge deliberately -- but a change to either
 * should look at the other.
 */
export const MAX_CHECK_AGE_MS = 60 * 60 * 1000;

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
 * is refused too. That is the safe direction (it blocks a comment, never a
 * merge), and the workaround is to not write the literal trigger inside a
 * comment about the trigger. Loosening it to exclude quoted/code-fenced
 * occurrences would mean judging raw text structure, which is the exact
 * defect `guard-decision.mjs`'s header argues against.
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
// Receipt paths. Budget and extensions are committed (decisions); the round
// check is ephemeral (evidence) and covered by .gitignore.
// ---------------------------------------------------------------------------

export const budgetPath = (pr) => `${RECEIPTS_DIR}/loop-budget-${pr}.json`;
export const extensionPath = (pr, seq) => `${RECEIPTS_DIR}/loop-extension-${pr}-${seq}.json`;
export const checkPath = (pr) => `${RECEIPTS_DIR}/loop-round-check-${pr}.json`;

/**
 * The sequence in an extension filename for this PR, or null if the name is
 * not one. String slicing rather than a built regex: CodeQL flagged a
 * `new RegExp(...${pr}...)` here as regex injection, and removing the dynamic
 * pattern removes the question entirely.
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
// touching the filesystem.
// ---------------------------------------------------------------------------

export function nodeIo(root = REPO_ROOT) {
  const abs = (rel) => path.join(root, rel);
  return {
    now: () => new Date().toISOString(),
    /**
     * `null` means the file is ABSENT. Anything else -- a permissions error, a
     * transient I/O failure -- throws, and `readJson` turns that into a
     * refusal. Collapsing the two makes an unreadable receipt
     * indistinguishable from an absent one, which reopens an exhausted loop
     * on an I/O error. (Codex, #503 round 1.)
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
    /**
     * Same ENOENT-only tolerance as `read`. A directory that exists but
     * cannot be listed used to return [], which FORGOT every extension -- a
     * loop that had spent its adjudication was shown tripwire 1 again
     * instead of the hard stop. (Codex, #503 round 3.)
     */
    listReceipts() {
      try {
        return fs.readdirSync(abs(RECEIPTS_DIR));
      } catch (err) {
        if (err.code === "ENOENT") return [];
        throw err;
      }
    },
    write(rel, text) {
      fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
      fs.writeFileSync(abs(rel), text);
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
  return null;
}

/**
 * The mechanical record a `continue` verdict claims to have ruled on must
 * exist, be one of ours, describe THIS PR -- and show the loop AT ITS CAP
 * when it was generated.
 *
 * The last check is what makes an adjudication provably FOLLOW its tripwire
 * (Codex, #503 rounds 1 and 3): without it, a receipt written early -- before
 * the cap was ever reached -- activates the moment the arithmetic crosses the
 * boundary, and tripwire 1 never refuses or presents the aggregate at all.
 * The record's pass count is counted from GitHub, so "the tripwire state
 * existed when this was adjudicated" is evidence, not recollection.
 *
 * This is not an anti-forgery check and cannot be one; it catches accidental
 * malformation and premature adjudication, which are different and far
 * likelier failures than the fabrication this module's header declines to
 * defend against.
 */
function validateRecordReference(pr, tier, recordPath, io) {
  if (!io) return null; // pure-validation callers; the guard always passes io
  const parsed = readJson(io, recordPath);
  if (parsed.state === "absent") return `cited mechanical record ${recordPath} does not exist`;
  if (parsed.state !== "ok") return `cited mechanical record ${recordPath} is unreadable (${parsed.error})`;
  if (parsed.value?.generator !== "scripts/review-loop-record.mjs") {
    return `${recordPath} was not produced by review-loop-record.mjs (generator: ${JSON.stringify(parsed.value?.generator)})`;
  }
  if (parsed.value?.pr !== pr) return `${recordPath} describes PR ${parsed.value?.pr}, not ${pr}`;
  const passes = parsed.value?.rounds?.completedReviewerPasses;
  if (!Number.isInteger(passes) || passes < tierCap(tier)) {
    return (
      `${recordPath} was generated with ${JSON.stringify(passes)} completed reviewer passes, below tier ` +
      `"${tier}"'s cap of ${tierCap(tier)} -- an adjudication must follow its tripwire, not precede it`
    );
  }
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
    return validateRecordReference(pr, tier, receipt.recordPath, io);
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
// Loading a loop's durable state
// ---------------------------------------------------------------------------

/**
 * Load the budget and extensions for one loop. Returns either a `problem`
 * (fail closed, with the reason already phrased for the refusal) or the
 * loop's state.
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

  // Iterate the FILENAMES, never a number reconstructed from them: rebuilding
  // the path from a normalized number read one receipt twice and never opened
  // a zero-padded duplicate at all. (Codex, #503 round 2.)
  let names;
  try {
    names = io.listReceipts();
  } catch (err) {
    return { problem: "bad-receipt", detail: `${RECEIPTS_DIR} could not be listed (${err.message})` };
  }
  const found = [];
  for (const name of names) {
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

  // The next extension is written at max+1, NEVER at length+1: with a gap in
  // the sequence (1 and 3 on disk), length+1 points at 3 and OVERWRITES a
  // receipt -- destroying authorization history and possibly the active
  // grant. (Codex, #503 round 3.)
  const nextSeq = found.length ? found[found.length - 1].seq + 1 : 1;

  return { budget: budget.value, tier, extensions, nextSeq };
}

/**
 * Rounds this loop may request in total, given its tier, its extensions, and
 * how many rounds it has actually spent.
 *
 * EXTENSIONS ACTIVATE IN SEQUENCE, AND ONLY ONCE EVERYTHING BEFORE THEM IS
 * SPENT. A `continue` receipt that raises the allowance the moment it exists
 * -- written early, or carried over by accident -- would let the loop sail
 * past its cap with **tripwire 1 never firing**: no refusal, and the
 * aggregate never presented. So a dormant extension is not consumed and not
 * counted; it activates at the exact round the stage before it runs out.
 * (Codex, #503 round 1. The boundary-condition half -- proving the
 * adjudication actually followed a fired tripwire -- lives in
 * `validateRecordReference`, which requires the cited record to show the
 * loop at its cap; round 3.)
 */
export function allowance(tier, extensions, roundsSpent) {
  if (!Number.isInteger(roundsSpent) || roundsSpent < 0) {
    throw new Error(`allowance needs a non-negative integer roundsSpent, got ${JSON.stringify(roundsSpent)}`);
  }
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

/** Whether the loop has already spent its one self-serve extension. */
const hasAdjudication = (extensions) => extensions.some((e) => e.kind === "adjudication");

// ---------------------------------------------------------------------------
// Counting rounds from evidence
// ---------------------------------------------------------------------------

/**
 * Rounds spent, counted from a snapshot of the PR's reviews and issue
 * comments -- never from a ledger this module maintains.
 *
 * `delivered` is `reviewerPasses().length`: completed reviewer passes, the
 * repo's own definition of a round. The automatic opening review needs no
 * special flag under this model -- it is simply one of the passes.
 *
 * `pending` is 0 or 1: whether any `@codex review` trigger comment sits AFTER
 * the last completed pass. At most one round can be in flight, so multiple
 * trigger comments with no pass between them -- a stall and its retry -- are
 * ONE pending round, not several. This is what dissolves the first design's
 * phantom-round problem: a stalled request stops costing anything the moment
 * its retry's pass lands, with no reconciliation step, because nothing was
 * ever written down to reconcile.
 */
export function countRounds({ reviewerPasses, issueComments }) {
  const delivered = reviewerPasses.length;
  const lastPassAt = delivered ? Date.parse(reviewerPasses[delivered - 1].at) : -Infinity;
  const pending = (issueComments ?? []).some(
    (c) => mentionsReviewRequest(c.body) && Date.parse(c.created_at ?? "") > lastPassAt,
  )
    ? 1
    : 0;
  return { delivered, pending, spent: delivered + pending };
}

/** What the round-check CLI writes and the guard demands. */
export function validateCheckReceipt(pr, receipt, now) {
  if (!receipt || typeof receipt !== "object") return "round-check receipt is not an object";
  if (receipt.pr !== pr) return `round-check receipt names PR ${receipt.pr}, not ${pr}`;
  const target = `${REPO_OWNER}/${REPO_NAME}`;
  if (typeof receipt.repo !== "string" || receipt.repo.toLowerCase() !== target.toLowerCase()) {
    return `round-check receipt was minted for ${receipt.repo ?? "an unrecorded repository"}, not ${target}`;
  }
  if (!Number.isInteger(receipt.spent) || receipt.spent < 0) {
    return `round-check receipt carries no usable round count (spent: ${JSON.stringify(receipt.spent)})`;
  }
  // One receipt authorizes ONE post. Without this, a receipt minted before
  // round N still says N-1 spent when round N+1 is requested, and freshness
  // alone would let it authorize both.
  if (receipt.consumedAt) return `round-check receipt was already consumed at ${receipt.consumedAt} -- run check again`;
  const age = now - Date.parse(receipt.capturedAt ?? "");
  if (!Number.isFinite(age) || age < 0 || age > MAX_CHECK_AGE_MS) {
    return (
      `round-check receipt rests on evidence read at ${receipt.capturedAt ?? "an unrecorded time"} and is no ` +
      `longer current (older than ${MAX_CHECK_AGE_MS / 60000} minutes, or not in the past) -- run check again`
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

const CHECK_HOWTO = (pr) =>
  `Capture pull_request_read (get, get_reviews, get_comments) into a snapshot and run ` +
  `\`node scripts/review-budget.mjs check --pr ${pr} --mcp-snapshot <file>\`.`;

/**
 * The refusal text. This is the product, not a side note: it is read by the
 * one agent that can act on it, at the one moment it can act, and it has to
 * carry the aggregate the loop could not see for itself.
 */
function refusal(pr, state, spent) {
  const { budget, tier, extensions, nextSeq } = state;
  const cap = allowance(tier, extensions, spent);
  const head =
    `review round ${spent + 1} on PR #${pr} exceeds its declared budget ` +
    `(tier "${tier}" -- ${TIERS[tier].label}; ${spent} of ${cap} rounds already spent, counted from ` +
    `GitHub's own record of completed reviewer passes; criticality ${budget.criticality}).`;

  if (!hasAdjudication(extensions) && TIERS[tier].selfServe) {
    return (
      `${head}\n` +
      `TRIPWIRE 1 (self-serve). Do NOT re-evaluate this in the loop's own context -- that is the ` +
      `criticality gate again, and it has never stopped a loop. Instead:\n` +
      `  1. node scripts/review-loop-record.mjs --pr ${pr} --mcp-snapshot <file> --write\n` +
      `  2. Dispatch ONE fresh-context adjudicator subagent ON FABLE -- agent type ` +
      `"review-loop-adjudicator", and pass model: "fable" explicitly on the call rather than relying on ` +
      `its frontmatter, since a per-invocation model outranks frontmatter in the resolution order. ` +
      `Give it the generated record and NOTHING else from this session. Fable spends at double Opus, so ` +
      `say out loud that you are dispatching it (the announce-don't-sneak rule in the model-routing skill).\n` +
      `  3. Write its verdict to ${extensionPath(pr, nextSeq)} ` +
      `(ship-with-gaps-recorded | split | continue+grant<=${MAX_ADJUDICATION_GRANT}+risk | escalate), and commit it.\n` +
      `Default verdict is ship-with-gaps-recorded. Only "continue" reopens this guard, and only once.`
    );
  }

  return (
    `${head}\n` +
    `TRIPWIRE 2 (hard stop). The one self-serve extension is spent, and there is never a second one. ` +
    `Take this to David as a 🛑 NEED YOU with the adjudication record pre-written as the options, and record ` +
    `his answer in ${extensionPath(pr, nextSeq)} as {"kind":"david","grant":<n|"uncapped">,` +
    `"authorization":"<his words>"}, committed.`
  );
}

/**
 * Judge one review-request tool call. `{ blocked, reason }`, matching
 * `decide()`'s contract in `guard-decision.mjs`.
 *
 * The hook cannot reach GitHub, so it demands the evidence be brought to it:
 * a fresh round-check receipt written by `check` from a validated snapshot.
 * Missing, stale, consumed, or foreign receipts refuse -- the same posture as
 * the merge gate's readiness receipt, because it is the same problem.
 *
 * On allow, the receipt is marked consumed, so one check authorizes exactly
 * one post.
 */
export function judgeReviewRequest({ toolName, toolInput }, io = nodeIo(), now = Date.now()) {
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
        `Commit the receipt and state the budget in the PR body too.`,
    };
  }
  if (state.problem === "bad-receipt") {
    return {
      blocked: true,
      reason: `round-budget receipt is unusable, so the budget cannot be checked: ${state.detail}`,
    };
  }

  const check = readJson(io, checkPath(pr));
  if (check.state === "absent") {
    return {
      blocked: true,
      reason: `no round-check receipt for PR #${pr} -- the round count is evidence, not recollection. ${CHECK_HOWTO(pr)}`,
    };
  }
  if (check.state !== "ok") {
    return {
      blocked: true,
      reason: `round-check receipt for PR #${pr} could not be read (${check.state}: ${check.error}). ${CHECK_HOWTO(pr)}`,
    };
  }
  const checkError = validateCheckReceipt(pr, check.value, now);
  if (checkError) {
    return { blocked: true, reason: `${checkError}. ${CHECK_HOWTO(pr)}` };
  }

  const spent = check.value.spent;
  if (spent >= allowance(state.tier, state.extensions, spent)) {
    return { blocked: true, reason: refusal(pr, state, spent) };
  }

  // Consume the receipt: one check, one post. Written before the post goes
  // out (a PreToolUse hook has no "after"), so a post that then fails costs a
  // re-check, not a round -- the round count itself lives on GitHub.
  io.write(
    checkPath(pr),
    `${JSON.stringify({ ...check.value, consumedAt: new Date(now).toISOString() }, null, 2)}\n`,
  );
  return { blocked: false, reason: null };
}

// ---------------------------------------------------------------------------
// CLI -- declare, check, status. The guard itself never writes a budget:
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
  review-budget.mjs declare --pr <n> --tier <internal|product|sensitive> --criticality <1-100> --artifact "<text>"
  review-budget.mjs check   --pr <n> --mcp-snapshot <file>
  review-budget.mjs status  --pr <n> [--mcp-snapshot <file>]

declare writes the committed budget receipt (refuses to overwrite one).
check validates a fresh snapshot, counts rounds from it, and writes the
ephemeral round-check receipt the guard demands before an @codex review post.
`;

const requirePr = (flags) => {
  const pr = Number(flags.pr);
  if (!Number.isInteger(pr) || pr <= 0) throw new Error("--pr must be a positive integer");
  return pr;
};

function declare(flags, io) {
  const pr = requirePr(flags);
  if (!Object.hasOwn(TIERS, flags.tier)) {
    throw new Error(`--tier must be one of: ${Object.keys(TIERS).join(", ")}`);
  }
  const criticality = Number(flags.criticality);
  const receipt = {
    pr,
    tier: flags.tier,
    budget: TIERS[flags.tier].budget,
    criticality,
    artifact: flags.artifact ?? "",
    declaredAt: io.now(),
  };
  const error = validateBudget(pr, receipt);
  if (error) throw new Error(error);
  // Never silently replace a live budget: overwriting one mid-loop could move
  // the tier under a loop already in flight.
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

/**
 * Snapshot requirements for counting rounds. Mirrors the posture of
 * `pr-ready.mjs`'s assertSnapshot and `loop-metrics.mjs`'s completeness
 * assertions: bound to THIS pr, both collections present and attested
 * complete, and shaped well enough that `reviewerPasses` cannot silently
 * undercount. (Codex, #503 round 3: an attested-complete snapshot whose
 * entries lack the fields the counter reads is undercounted, not rejected --
 * so the load-bearing fields are checked here.)
 */
export function assertCountingSnapshot(pr, snapshot) {
  if (!snapshot || typeof snapshot !== "object") throw new Error("snapshot is not an object");
  if (snapshot.pr?.number !== pr) {
    throw new Error(`snapshot describes PR ${snapshot.pr?.number}, but --pr says ${pr}`);
  }
  for (const key of ["reviews", "issueComments"]) {
    if (!Array.isArray(snapshot[key])) throw new Error(`snapshot "${key}" must be an array`);
    if (snapshot.complete?.[key] !== true) {
      throw new Error(
        `snapshot must attest complete.${key} === true -- an unpaginated snapshot understates delivered ` +
          "passes, and the count would then be wrong in the guard's favour",
      );
    }
  }
  snapshot.reviews.forEach((r, i) => {
    if (r?.id === undefined || typeof r?.user?.login !== "string" || !Number.isFinite(Date.parse(r?.submitted_at ?? ""))) {
      throw new Error(
        `snapshot reviews[${i}] is missing id, user.login, or a parseable submitted_at -- ` +
          "reviewerPasses would silently undercount this shape rather than reject it",
      );
    }
  });
  snapshot.issueComments.forEach((c, i) => {
    if (c?.id === undefined || typeof c?.user?.login !== "string" || !Number.isFinite(Date.parse(c?.created_at ?? ""))) {
      throw new Error(
        `snapshot issueComments[${i}] is missing id, user.login, or a parseable created_at -- ` +
          "pass and pending detection would silently miscount this shape rather than reject it",
      );
    }
  });
}

async function check(flags, io) {
  const pr = requirePr(flags);
  if (!flags["mcp-snapshot"]) throw new Error(`--mcp-snapshot <file> is required. ${CHECK_HOWTO(pr)}`);
  const snapshot = JSON.parse(fs.readFileSync(flags["mcp-snapshot"], "utf8"));
  assertCountingSnapshot(pr, snapshot);

  const state = loadLoop(pr, io);
  if (state.problem === "no-budget") throw new Error(`no budget declared for PR #${pr} -- declare first`);
  if (state.problem) throw new Error(`cannot check: ${state.detail}`);

  const { reviewerPasses } = await import("./loop-metrics.mjs");
  const counted = countRounds({
    reviewerPasses: reviewerPasses(snapshot.reviews, snapshot.issueComments),
    issueComments: snapshot.issueComments,
  });

  const receipt = {
    pr,
    repo: `${REPO_OWNER}/${REPO_NAME}`,
    capturedAt: io.now(),
    ...counted,
  };
  io.write(checkPath(pr), `${JSON.stringify(receipt, null, 2)}\n`);

  const cap = allowance(state.tier, state.extensions, counted.spent);
  const verdict = counted.spent >= cap ? "the NEXT request will be refused (tripwire)" : "the next request is inside budget";
  return (
    `PR #${pr}: ${counted.delivered} completed reviewer pass(es)` +
    `${counted.pending ? " + 1 pending request" : ""} = ${counted.spent} of ` +
    `${cap === Infinity ? "uncapped" : cap} -- ${verdict}. Receipt written to ${checkPath(pr)} (ephemeral, one post).`
  );
}

async function status(flags, io) {
  const pr = requirePr(flags);
  const state = loadLoop(pr, io);
  if (state.problem === "no-budget") return `PR #${pr}: no budget declared.`;
  if (state.problem === "bad-receipt") return `PR #${pr}: unusable receipt -- ${state.detail}`;
  const lines = [
    `PR #${pr}: tier "${state.tier}", criticality ${state.budget.criticality}`,
    `extensions: ${state.extensions.length ? state.extensions.map((e) => `${e.kind}/${e.verdict ?? e.grant}`).join(", ") : "none"}`,
  ];
  const check = readJson(io, checkPath(pr));
  if (check.state === "ok") {
    const cap = allowance(state.tier, state.extensions, check.value.spent ?? 0);
    lines.push(
      `last round check: ${check.value.spent} of ${cap === Infinity ? "uncapped" : cap} spent, ` +
        `captured ${check.value.capturedAt}${check.value.consumedAt ? `, consumed ${check.value.consumedAt}` : ""}`,
    );
  } else {
    lines.push("no current round-check receipt (rounds are counted fresh -- run check with a snapshot)");
  }
  return lines.join("\n");
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
    else if (parsed.command === "check") process.stdout.write(`${await check(parsed.flags, io)}\n`);
    else if (parsed.command === "status") process.stdout.write(`${await status(parsed.flags, io)}\n`);
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

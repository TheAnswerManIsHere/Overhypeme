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
 * complete, recent) and counts rounds with `review-counting.mjs`'s own
 * `reviewerPasses()` -- plus at most one
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
 * Both are committed: which David gates have already been passed, and what he
 * granted at each, has to survive the container, or tripwire 2 never fires.
 *
 * AND BOTH ARE READ FROM THE COMMIT, NEVER FROM THE WORKING TREE (#526).
 * The distinction above was always declared and, for a while, only half
 * honoured: `loadLoop` read the decisions off the filesystem and then ran a
 * separate `extensionDurability` check to prove they matched git. That check
 * was a CACHE-COHERENCE check -- the working copy being a cache of the
 * committed one -- and every failure it produced was a coherence failure: two
 * reads that could disagree, a mis-identified backing store (`HEAD` is not
 * durable; only a pushed ref is), a reconciliation step with its own escaping
 * error path, bytes that are not comparable under `core.autocrlf`, and the
 * whole apparatus applied to extensions while the budget -- which sets the cap
 * -- went unchecked. Five separate findings, one shape.
 *
 * This is the round-tally story from round 3 repeated one layer down, and it
 * gets the same answer: READ THE AUTHORITATIVE COPY, delete the reconciliation.
 * `readDurableJson` and `listDurable` are the only way a decision enters this
 * module, so there is no window in which a local edit is what grants the
 * rounds. Evidence keeps reading the filesystem -- the round-check receipt is
 * SUPPOSED to be session-local -- and that asymmetry is the whole design.
 *
 * The practical consequence: a budget must be committed AND PUSHED before
 * round 1, not merely written. That is the same requirement extensions
 * already carried, and it is what "durable" has to mean in a container that
 * does not outlive the session.
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
 *      adjudication cannot precede the tripwire it answers. Adjudicator
 *      grants self-serve at most one LEASH (3 rounds) past the budget.
 *   3. DAVID GATE (tier-2 tripwire), at budget + leash and again each time a
 *      David grant is spent. The same fresh Fable adjudication runs first --
 *      committed as the RECOMMENDATION David reviews, granting nothing by
 *      itself -- and only a `david`-kind receipt (his decision, quoted)
 *      reopens the loop or endorses the stop. (David, 2026-08-26,
 *      superseding the 2026-08-20 2x-budget hard stop.)
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

import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { REVIEWER_LOGINS, normalizeLogin } from "./review-counting.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const RECEIPTS_DIR = ".agents/receipts";

// The canonical value lives in review-loop-record.mjs, which already imports
// FROM this file (loadLoop, allowance, countRounds, tierCap, ...) -- importing
// it back here would be circular. Duplicated as a literal instead, same
// posture as RECEIPTS_DIR above: a stable, well-known repo-relative path, not
// a value expected to drift.
const ADJUDICATIONS_DIR = ".agents/adjudications";
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
 * Blast-radius tiers (David, 2026-08-17, issue #501; revised 2026-08-20 and
 * 2026-08-26).
 *
 * `budget` is the round cap -- tripwire 1, where the Fable adjudicator takes
 * over. No tier is uncapped any more: sensitive's old uncapped-with-a-
 * mandatory-stop shape is gone with the two-tier tripwire below.
 *
 * THE WRITE-GATE RULE (David, 2026-08-22). The adjudicator decides BEFORE
 * code is written, not after it is pushed: a round returns findings, the
 * judge rules "write code for these" or "record them as gaps and stop", and
 * **any commit that does get written is unconditionally reviewed by another
 * round.** Two invariants follow, and they are the whole point: no commit
 * ever merges unreviewed, and a loop always terminates on a reviewed head
 * (because the stop happens before a new commit exists). The exit ramp from
 * eternal looping is the judge refusing to WRITE -- never anyone skipping
 * the review of something written.
 *
 * This replaced an earlier design (2026-08-21) whose internal tier ended by
 * stopping with the last fixes unreviewed, carried by an `adjudicatedStop` <!-- retired-ok -->
 * property, a mid-budget terminal receipt the merge gate consumed, and a
 * distinct-commit proof. All of that existed to make an unreviewed head
 * safe; under the write-gate rule an unreviewed head is simply never
 * mergeable, so the machinery is gone rather than fixed.
 *
 * THE `internal` TIER still exists and is still strict: it is the rubric
 * the adjudicator applies (write another round only for a very high chance
 * of a CRITICAL flaw -- see review-loop-adjudicator.md), on the smallest
 * budget (3). What it no longer is: an exemption from reviewing what was
 * written. Every measured runaway loop (#488's 22 rounds, #503, #531, #534,
 * #539) was internal tooling reviewed at product rigor, and the strictness
 * that answers it lives in the write decision, not in skipping review.
 *
 * THE TWO-TIER TRIPWIRE (David, 2026-08-26). Every tier -- sensitive and
 * internal included, superseding sensitive's mandatory-🛑-at-5 and
 * internal's David-in-person-at-3 -- runs the same two tripwires:
 *
 *   Tripwire 1, at the tier budget: the Fable adjudicator rules, and its
 *   grants self-serve the loop at most one LEASH (3 rounds) past the budget.
 *   Tripwire 2 (the David gate), at budget + leash and again wherever a
 *   David grant runs out: a fresh Fable adjudication is committed as the
 *   recommendation, and the loop stops for David's decision regardless of
 *   what it recommends.
 *
 * The one thing that always bypasses the leash: a PRODUCT decision. The
 * adjudicator's `escalate` verdict is terminal at any round, and a finding
 * the loop itself recognizes as product-not-mechanical goes to David
 * immediately without waiting for any tripwire.
 */
export const TIERS = {
  product: {
    budget: 5,
    label: "product code",
  },
  sensitive: {
    budget: 5,
    label: "auth / payments / migrations",
  },
  internal: {
    budget: 3,
    label: "internal tooling (strict write-gate adjudication rubric)",
  },
};

/** The cap a tier enforces before any extension: its budget. */
export const tierCap = (tier) => TIERS[tier].budget;

/**
 * The self-serve leash: how far past a David-authorized boundary the
 * adjudicator's own grants may carry the loop before the next David gate.
 * (David, 2026-08-26: "the second tripwire is an additional 3 loops after
 * the first".) The adjudicator still owns grant SIZE within it (David,
 * 2026-08-20); the leash bounds the aggregate, not each grant.
 *
 * Why a mechanical bound at all, when the adjudicator's record is good:
 * #488's post-mortem found that pure judgment, however well-positioned,
 * failed to bound a loop -- every round was locally rational. With unlimited
 * grant authority a pathological loop never mechanically reaches David; with
 * the leash, he is consulted every three rounds past the budget, with the
 * adjudicator's fresh recommendation in hand.
 */
export const LEASH = 3;

/**
 * Allowance and rail, staged together. EXTENSIONS ACTIVATE IN SEQUENCE, AND
 * ONLY ONCE EVERYTHING BEFORE THEM IS SPENT (see `allowance` below for why).
 * The rail -- the round count at which the next David gate stands -- starts
 * at budget + LEASH (the adjudicator's one self-serve leash), and each
 * activated `david` grant places it EXACTLY at the allowance that grant
 * establishes: "his grant opens exactly those rounds and the gate repeats
 * where they run out". Setting `rail = total` rather than `rail += grant`
 * is load-bearing for the direct-grant case (Codex, #574 round 1): a
 * product escalation can bring David in BEFORE the leash was spent, and
 * carrying the unused leash forward would let the adjudicator self-serve
 * rounds David never authorized on top of the ones he just did. The unused
 * leash is discarded instead; after any David grant, only he opens further
 * rounds. An uncapped David grant removes both bounds.
 *
 * A DIRECT grant -- one David makes mid-stage, before the current allowance
 * is spent, typically answering a product escalation -- carries `asOf`: the
 * completed-round count at the moment he granted. An anchored receipt
 * activates immediately (the ordinary dormancy rule would sleep it until
 * the stage it is meant to CUT SHORT ran to its end, and then stack his
 * rounds on top of the unspent ones -- Codex, #574 round 2) and opens
 * exactly `asOf + grant`: his rounds start where the loop stood when he
 * spoke, and the unspent remainder of the stage he interrupted is
 * discarded. A gate-written receipt needs no anchor -- at a gate the spent
 * count IS the stage boundary, so the two forms agree there.
 */
function staged(tier, extensions, roundsSpent) {
  if (!Number.isInteger(roundsSpent) || roundsSpent < 0) {
    throw new Error(`allowance needs a non-negative integer roundsSpent, got ${JSON.stringify(roundsSpent)}`);
  }
  let total = tierCap(tier);
  let rail = total + LEASH;
  for (const ext of extensions) {
    // An anchored receipt activates at ITS OWN anchor, not at the boundary
    // of the stage it cuts short; everything else stays stage-dormant.
    const anchor = ext.kind === "david" && Number.isInteger(ext.asOf) ? ext.asOf : null;
    if (roundsSpent < (anchor ?? total)) break; // this stage is not exhausted yet
    if (ext.kind === "david") {
      if (ext.grant === "uncapped") {
        // NOT an early return (Codex, #574 round 3): David can change his
        // mind, and a later receipt of his -- an anchored re-cap, or an
        // anchored grant-0 stop -- must be able to supersede an earlier
        // uncapped authorization. Returning here made his stop invisible
        // and left the guard permitting rounds forever.
        total = Infinity;
        rail = Infinity;
        continue;
      }
      total = (anchor ?? total) + ext.grant;
      rail = total;
    } else if (ext.kind === "adjudication" && ext.verdict === "continue") {
      // Adjudicator grants accumulate, but never past the current David
      // gate. David grants move the gate itself -- he is the authority the
      // gate escalates TO.
      total = Math.min(total + ext.grant, rail);
    }
  }
  return { total, rail };
}

/**
 * The round count at which the loop's next (or current) David gate stands,
 * given which extensions have activated at `roundsSpent`. With the default
 * `roundsSpent` every extension is treated as activated -- the fully-extended
 * gate, which is what a merge-time check wants.
 */
export const railFor = (tier, extensions = [], roundsSpent = Number.MAX_SAFE_INTEGER) =>
  staged(tier, extensions, roundsSpent).rail;

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
 * The ONE surface a review request may be posted on.
 *
 * The other two guarded tools store their body in a review thread or a review
 * body, NOT in `issueComments` -- and `countRounds` detects a pending round by
 * scanning issue comments. So a trigger posted through a thread reply is
 * invisible to the count: a check taken while it is in flight reports no
 * pending round and can authorize another request at the cap, landing two
 * passes where one round remained. (Codex, #503 round 4.)
 *
 * Two ways to close that. Widen counting to every surface -- which means every
 * `check` must also capture review threads and review bodies, and a snapshot
 * missing any one of them silently under-counts. Or narrow POSTING to the one
 * surface counting can see, which is what this does: with the trigger refused
 * everywhere else, no COMMENT can start a round the count cannot see.
 *
 * KNOWN GAP, stated because the first version of this comment claimed
 * "complete by construction" and that claim was too strong (Codex, #503 round
 * 5). Codex has three triggers, and only one of them is a comment: opening a
 * non-draft PR and marking a draft ready-for-review both start a review
 * through a lifecycle call this hook never sees. Those passes are COUNTED
 * correctly once they land -- a pass is a pass -- but while one is in flight
 * `pending` reads 0, so a loop that marks a PR ready and immediately requests
 * a round can land two passes against one. The overshoot is bounded at one
 * round and needs that specific sequence.
 *
 * Not closed here, deliberately. The honest fix is to guard the lifecycle
 * tools, which would mean refusing to OPEN a PR until a budget exists -- a
 * real behavioural change to every PR in the repo, not a last-round patch on
 * this one. Filed as follow-up rather than smuggled in.
 *
 * It also costs nothing real. The contract's re-request has always been an
 * issue comment; a trigger inside a thread reply was never the sanctioned
 * shape. What is refused here is a shape we do not use, and the refusal says
 * where to post instead.
 */
export const REVIEW_REQUEST_SURFACE = "mcp__github__add_issue_comment";

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
 * The claim marker for a round-check receipt.
 *
 * `consumedAt` alone is a read-then-write, and the guard runs as a separate
 * process per tool call: two guarded posts issued in one turn can both read
 * the unconsumed receipt, both validate, and both write, so one check
 * authorizes two rounds and the second write merely overwrites the first.
 * (Codex, #503 round 4.) The claim closes that window because creating it is
 * a single atomic syscall -- exactly one process can win, whatever the
 * interleaving. `consumedAt` stays as the human-readable record of when.
 *
 * THE CLAIM IS KEYED TO THE RECEIPT'S GENERATION, not to the PR. An earlier
 * version used one path per PR and had `check` delete it when writing a fresh
 * receipt -- so a `check` running while a post was mid-flight destroyed that
 * post's LIVE claim, and a second post could then claim the new receipt while
 * the first still proceeded on the one it had already read. Two requests from
 * one single-use authorization. (Codex, #503 head pass.)
 *
 * Keying by the receipt's `nonce` removes the race rather than narrowing it:
 * a new receipt's claim is a DIFFERENT FILE, so `check` never needs to delete
 * anything and cannot touch a claim it did not create. Claims for spent
 * generations are inert -- they are gitignored, and a stale one can only ever
 * refuse a post that quotes its own already-consumed generation, which is the
 * safe direction.
 */
export const claimPath = (pr, nonce) => {
  if (typeof nonce !== "string" || !/^[0-9a-f]{16}$/.test(nonce)) {
    // Fail closed on a receipt with no usable generation: without a nonce the
    // claim would fall back to a shared path, which is the collision this
    // keying exists to remove.
    throw new Error(`round-check receipt for PR #${pr} carries no usable nonce; run check again`);
  }
  return `${checkPath(pr)}.${nonce}.claim`;
};

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
    /**
     * Exclusive create: true for exactly one caller, false for every other,
     * decided by the filesystem rather than by a read-then-write this process
     * could lose a race on. Anything other than EEXIST rethrows, so an I/O
     * fault refuses the post instead of silently reading as "already claimed"
     * or "free" -- the same ENOENT-only discipline as `read` and
     * `listReceipts`.
     */
    claimOnce(rel) {
      fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
      try {
        fs.closeSync(fs.openSync(abs(rel), "wx"));
        return true;
      } catch (err) {
        if (err.code === "EEXIST") return false;
        throw err;
      }
    },
    releaseClaim(rel) {
      try {
        fs.unlinkSync(abs(rel));
      } catch (err) {
        if (err.code !== "ENOENT") throw err;
      }
    },
    /** A fresh receipt generation. Random, never derived from time: two checks
     * inside one second must not collide on a claim path. */
    nonce: () => crypto.randomBytes(8).toString("hex"),
    /**
     * The durable ref: the branch's upstream, or null when it has none.
     *
     * "Durable" means SURVIVES THIS CONTAINER, so the remote-tracking ref is
     * the only honest answer. `HEAD` is not a weaker version of it -- a commit
     * that never reached a remote dies with the checkout, which is precisely
     * the failure the durability rule exists to prevent, so there is no
     * fallback ladder here. No upstream means no durable ref, and the caller
     * refuses. (Codex, #526 finding 3.)
     *
     * Staleness runs one way only: `origin/<branch>` can lag a push made
     * elsewhere, which under-reports what is durable and therefore refuses.
     * A local `git push` updates this ref itself, so a receipt committed and
     * pushed in-session is visible immediately with no fetch (measured
     * 2026-08-19).
     *
     * KNOWN GAPS, tracked in #537 rather than patched a fourth time. This
     * function infers a property of the outside world (will this survive the
     * container) from local git CONFIGURATION, and configuration is a
     * description that can be wrong in unboundedly many ways. Three
     * independent counterexamples surfaced in one review round (#531 round
     * 3), which is the signal that stopped further patching here -- see
     * "when a predicate keeps failing, stop patching it" in
     * known-failure-patterns.md. Two fail OPEN (a receipt can be granted and
     * later vanish): a remote with an ordinary network fetch URL but a local
     * `pushurl` -- only the fetch URL is inspected here; and a local-path
     * remote whose backing repository is later deleted -- `durableRef`
     * returns `null` while it exists and accepts it once it is gone, which
     * is backwards, since the ref was already written when the path existed.
     * The third fails CLOSED (a legitimate loop is stranded, not bypassed): a
     * remote name containing `/` breaks the `abbrev.split("/")[0]` parse a
     * few lines below. #537 also records the direction judged likely correct:
     * stop asking git locally and prove durability from the GitHub snapshot
     * this module already captures for round-counting, rather than adding a
     * fourth clause to this predicate.
     */
    durableRef() {
      let full;
      try {
        full = execFileSync("git", ["rev-parse", "--symbolic-full-name", "@{upstream}"], {
          cwd: root,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
      } catch {
        return null;
      }
      // THE FULL REF, NOT THE ABBREVIATED ONE, because the abbreviated forms
      // are indistinguishable. `git branch --set-upstream-to=<local-branch>`
      // is supported and sets `branch.<name>.remote=.`, after which
      // `--abbrev-ref @{upstream}` prints a bare name that looks exactly like
      // a remote-tracking one -- while its receipts die with the checkout,
      // which is the very thing this ref is supposed to rule out. Measured
      // 2026-08-19: a remote upstream is `refs/remotes/origin/<branch>`, a
      // local one is `refs/heads/<branch>`. (Codex, #531 round 1.)
      const REMOTE = "refs/remotes/";
      if (!full.startsWith(REMOTE)) return null;
      // Stripping the prefix yields exactly what `--abbrev-ref` would have
      // printed, so the happy path stays cheap.
      const abbrev = full.slice(REMOTE.length);

      // ...BUT `refs/remotes/` IS NOT ITSELF PROOF OF DURABILITY. A remote
      // whose URL is a local repository produces exactly that namespace:
      // reproduced 2026-08-19 with `git remote add local ../origin-repo.git`,
      // which yields `refs/remotes/local/main` while both repositories die
      // with the container. (Codex, #531 round 2.)
      //
      // The test is on the property that actually matters -- does this remote
      // live on a disk that disappears with us -- rather than on URL syntax,
      // which is a swamp: `file://` has a scheme and is local, while
      // `git@github.com:owner/repo` has none and is not. So: resolve the URL
      // git would really use (honouring `insteadOf` rewrites) and reject it if
      // it names something on this filesystem.
      const remote = abbrev.split("/")[0];
      let url;
      try {
        url = execFileSync("git", ["ls-remote", "--get-url", remote], {
          cwd: root,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
      } catch {
        return null; // cannot tell what the remote is -- refuse
      }
      // `--get-url` echoes the name back when the remote is unknown.
      if (!url || url === remote) return null;
      if (/^file:\/\//i.test(url)) return null;
      // A bare path, absolute or relative to the repo. Anything reachable over
      // a network -- https://, ssh://, git://, or the scp-like
      // user@host:path -- will not exist as a path here. A local path that
      // does NOT exist is left alone deliberately: fetch and push against it
      // are already broken, so it cannot be how the ref got updated.
      if (fs.existsSync(path.resolve(root, url))) return null;
      return abbrev;
    },
    /**
     * The contents of `rel` AT `ref` -- the only way durable decisions are
     * ever read. Returns `{ state: "present", text }`, `{ state: "absent" }`,
     * or `{ state: "unknown" }` for "could not tell", which the caller treats
     * as a refusal rather than as absence: "I could not check" is not
     * evidence.
     */
    readDurable(ref, rel) {
      // TWO calls, because ONE cannot tell the two failures apart. Measured
      // 2026-08-19 in this repo: `git show HEAD:missing.md` and
      // `git show no-such-ref:CLAUDE.md` BOTH exit 128, and
      // `rev-parse --verify --quiet` returns 1 for both. So an exit code
      // alone can never distinguish "the ref exists and the path is not in
      // it" (an answer: absent) from "there is no such ref" (not an answer:
      // unknown). Resolving the ref first splits them cleanly.
      try {
        execFileSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
          cwd: root,
          stdio: "ignore",
        });
      } catch {
        return { state: "unknown" };
      }
      try {
        // stderr ignored: "path exists on disk, but not in <ref>" is an
        // EXPECTED state here (an uncommitted decision), not an error, and
        // letting git narrate it over the top of this module's own message
        // reads as a crash.
        const text = execFileSync("git", ["show", `${ref}:${rel}`], {
          cwd: root,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        });
        return { state: "present", text };
      } catch {
        return { state: "absent" };
      }
    },
    /**
     * The filenames under `dir` AT `ref`, or null when the ref cannot be read.
     * Null is distinct from an empty list for the same reason `listReceipts`
     * rethrows: a directory that cannot be listed reading as "no extensions"
     * would show a loop that had spent its adjudication the self-serve
     * tripwire again. (Codex, #503 round 3, carried onto the durable path.)
     */
    listDurable(ref, dir) {
      try {
        const out = execFileSync("git", ["ls-tree", "--name-only", ref, `${dir}/`], {
          cwd: root,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        });
        return out
          .split("\n")
          .filter(Boolean)
          .map((line) => line.slice(`${dir}/`.length));
      } catch {
        return null;
      }
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

/**
 * Read + parse a DURABLE decision, from the ref and never from the working
 * tree. Same result shape as `readJson`, plus `unknown` for a ref that could
 * not be read at all -- which refuses, because "I could not check" is not
 * evidence.
 *
 * THIS IS THE WHOLE POINT OF #526. The module has always said decisions are
 * committed and evidence is session-local, but `loadLoop` read the decisions
 * from the session's filesystem and then ran a separate check to prove they
 * matched git. That proof was a CACHE-COHERENCE check, and every one of its
 * failures was a coherence failure: two reads that could disagree, a
 * mis-identified backing store, a reconciliation step with its own error
 * path, bytes that are not comparable under `core.autocrlf`, and the whole
 * apparatus applied to extensions but not to the budget. Reading the
 * authoritative copy directly deletes the question instead of answering it --
 * the same move that deleted the round tally in #503 round 3, for the same
 * reason.
 */
function readDurableJson(io, ref, rel) {
  let shown;
  try {
    shown = io.readDurable(ref, rel);
  } catch (err) {
    return { state: "unreadable", error: err.message };
  }
  if (shown?.state === "absent") return { state: "absent" };
  if (shown?.state !== "present") {
    return { state: "unreadable", error: `${rel} could not be read from ${ref}` };
  }
  try {
    return { state: "ok", value: JSON.parse(shown.text) };
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
function validateRecordReference(pr, tier, recordPath, io, ref, preceding = []) {
  // pr-ready.mjs's merge-gate fallback requires every recordPath to live
  // under ADJUDICATIONS_DIR (never trusting an arbitrary path), so a
  // receipt this guard accepts as closing the loop must be one that gate
  // can also honor -- otherwise the same structural deadlock PR #534 hit
  // recurs under a different path. Checked here, not just there, so the
  // deadlock is impossible at the point the receipt is first accepted.
  // (Codex, #539 round 3.)
  if (typeof recordPath !== "string" || !recordPath.startsWith(`${ADJUDICATIONS_DIR}/`)) {
    return `recordPath ${JSON.stringify(recordPath)} is not under ${ADJUDICATIONS_DIR}/ -- pr-ready.mjs's merge gate will never accept it`;
  }
  if (!io) return null; // pure-validation callers; the guard always passes io
  // FROM THE DURABLE REF, like the receipt that cites it. The record is not
  // itself a decision, but it is the evidence a `continue` verdict rests on,
  // and it is committed (`.agents/adjudications/` is not gitignored -- checked
  // 2026-08-19). Leaving this one read on the filesystem would rebuild exactly
  // the split #526 is about: a durable receipt whose only justification exists
  // in a container that is about to disappear.
  const parsed = ref ? readDurableJson(io, ref, recordPath) : readJson(io, recordPath);
  const where = ref ? ` in ${ref}` : "";
  if (parsed.state === "absent") return `cited mechanical record ${recordPath} does not exist${where}`;
  if (parsed.state !== "ok") return `cited mechanical record ${recordPath} is unreadable${where} (${parsed.error})`;
  if (parsed.value?.generator !== "scripts/review-loop-record.mjs") {
    return `${recordPath} was not produced by review-loop-record.mjs (generator: ${JSON.stringify(parsed.value?.generator)})`;
  }
  if (parsed.value?.pr !== pr) return `${recordPath} describes PR ${parsed.value?.pr}, not ${pr}`;
  const passes = parsed.value?.rounds?.completedReviewerPasses;
  // AGAINST THE ALLOWANCE THIS RECEIPT'S OWN STAGE STARTS AT, never the base
  // tier cap. Repeat adjudications are valid as of 2026-08-20, and the base cap
  // stopped being the right threshold the moment they were: a second receipt
  // citing the record that answered the FIRST tripwire satisfies `>= tierCap`
  // forever, and `allowance` then activates it at the second tripwire -- so one
  // adjudication would silently cover two, and round 7 would open with nothing
  // having ruled on round 6. Every preceding extension is fully spent before
  // this one activates (see `allowance`'s staging), so the floor is the
  // allowance they establish. (Codex, #543.)
  const stageFloor = allowance(tier, preceding, Number.MAX_SAFE_INTEGER);
  if (!Number.isInteger(passes) || passes < stageFloor) {
    return (
      `${recordPath} was generated with ${JSON.stringify(passes)} completed reviewer passes, below this ` +
      `receipt's own stage floor of ${stageFloor} for tier "${tier}" ` +
      `(the allowance its ${preceding.length} preceding extension(s) establish) ` +
      `-- an adjudication must follow the tripwire it answers, not an earlier one`
    );
  }
  return null;
}

export function validateExtension(pr, tier, receipt, { io, ref, preceding = [] }) {
  if (!receipt || typeof receipt !== "object") return "extension receipt is not an object";
  if (receipt.pr !== pr) return `extension receipt names PR ${receipt.pr}, not ${pr}`;

  if (receipt.kind === "adjudication") {
    if (!ADJUDICATION_VERDICTS.has(receipt.verdict)) {
      return `adjudication verdict "${receipt.verdict}" is not one of: ${[...ADJUDICATION_VERDICTS].join(", ")}`;
    }
    // Every tier accepts adjudication receipts (David, 2026-08-26 -- the
    // two-tier tripwire). A KNOWN visibility gap survives from #553 round 5:
    // `validateRecordReference` holds every receipt to the tripwire floor,
    // so a blocking `split`/`escalate` verdict decided MID-budget cannot be
    // recorded as a receipt (it would be rejected as premature, and
    // `loadLoop` would then fail the whole loop). A mid-budget terminal
    // verdict is therefore covered by process rather than mechanism -- it
    // goes to David as a 🛑 by construction, and READY is not a merge.
    // A TERMINAL verdict decides. Refusing the next post (the guard's own
    // rule) is bypassable from this side: a later `continue` receipt would
    // become the last extension and read as reopening the loop. So the
    // receipt itself is invalid -- after a terminal adjudication, only a
    // `david`-kind receipt may follow. (Codex, #543 round 3.)
    const prev = preceding[preceding.length - 1];
    if (prev && prev.kind === "adjudication" && prev.verdict !== "continue") {
      return (
        `a terminal adjudication verdict ("${prev.verdict}") is standing on this loop -- a further ` +
        `adjudication receipt cannot follow it; only a "david"-kind receipt reopens the loop`
      );
    }
    // Every verdict cites the mechanical record it ruled on -- not just
    // `continue`. pr-ready.mjs's merge-gate fallback derives its diff
    // baseline from this record's own `sinceLastReview.head`, never from a
    // self-declared field on the receipt, so a ship-with-gaps-recorded
    // receipt with no recordPath can close this guard but can never satisfy
    // that gate -- exactly the deadlock PR #534 hit. (Codex, #539 round 2.)
    if (typeof receipt.recordPath !== "string" || !receipt.recordPath.trim()) {
      return "adjudication receipt must cite the mechanical record it ruled on in `recordPath`";
    }
    // The record's own `generatedAt` is written BEFORE the adjudicator is
    // even dispatched (step 1 of the tripwire procedure runs
    // review-loop-record.mjs, THEN step 2 dispatches Fable) -- so it
    // predates the actual decision and cannot stand in for "when was this
    // verdict decided". `decidedAt` is the moment this receipt itself was
    // written, which pr-ready.mjs's merge gate uses to order fresh evidence
    // against the real decision rather than its input's preparation time.
    // (Codex, #539 round 3.)
    if (!Number.isFinite(Date.parse(receipt.decidedAt ?? ""))) {
      return "adjudication receipt must carry a parseable `decidedAt` -- when the verdict was actually decided, not when its input record was generated";
    }
    // The adjudicator's documented output schema (review-loop-adjudicator.md)
    // always returns `reasoning` and `gaps`, for every verdict -- carrying
    // only pr/kind/verdict/recordPath/decidedAt into the committed receipt
    // discards the adjudicator's actual justification and, for
    // ship-with-gaps-recorded specifically, the durable record of what's
    // knowingly being left. (Codex, #539 round 3.)
    if (typeof receipt.reasoning !== "string" || !receipt.reasoning.trim()) {
      return "adjudication receipt must carry the adjudicator's `reasoning`, verbatim";
    }
    if (!Array.isArray(receipt.gaps)) {
      return "adjudication receipt must carry the adjudicator's `gaps` array, verbatim (empty is valid for a verdict with no known gaps)";
    }
    const recordError = validateRecordReference(pr, tier, receipt.recordPath, io, ref, preceding);
    if (recordError) return recordError;
    if (receipt.verdict !== "continue") return null; // ship-with-gaps-recorded / split / escalate grant nothing further
    // The adjudicator owns the SIZE of an extension (David, 2026-08-20); the
    // bound is the leash in `allowance`, not a per-grant ceiling here. A
    // continue receipt written AT a David gate is valid and simply grants
    // nothing (`allowance` clips it at the gate): it is the committed
    // recommendation David reviews, and only his receipt moves the gate.
    if (!Number.isInteger(receipt.grant) || receipt.grant < 1) {
      return `a continue verdict grants a positive integer of rounds, not ${JSON.stringify(receipt.grant)}`;
    }
    // The named risk is the entire justification for continuing. Without it a
    // continue verdict is "keep going" with no content, which is what the loop
    // would have done unaided.
    if (typeof receipt.risk !== "string" || !receipt.risk.trim()) {
      return "a continue verdict must name the specific unaddressed BEHAVIORAL risk in `risk`";
    }
    return null;
  }

  if (receipt.kind === "david") {
    const uncapped = receipt.grant === "uncapped";
    // Grant 0 is valid and meaningful: David reviewed the gate's Fable
    // recommendation and endorsed STOPPING. It moves the gate nowhere, but
    // it is the durable record that he was consulted -- which is what the
    // gate exists to guarantee, and what pr-ready.mjs's rail check reads.
    if (!uncapped && (!Number.isInteger(receipt.grant) || receipt.grant < 0)) {
      return `David authorization must grant a non-negative integer of rounds (0 endorses stopping) or "uncapped", not ${JSON.stringify(receipt.grant)}`;
    }
    // `asOf` -- the completed-round count at the moment David granted -- is
    // REQUIRED on every finite grant (Codex, #574 round 3, superseding round
    // 2's optional-by-trade design): his rounds open at `asOf + grant` and
    // anything the interrupted stage had left is discarded (see `staged`).
    // Round 2 kept it optional fearing a typo'd anchor would open unbounded
    // phantom rounds -- but the activation semantics bound that themselves:
    // an anchor ABOVE the spent count leaves the receipt dormant (allowance
    // unchanged, refusal repeats -- fail closed), an anchor too LOW drops
    // the allowance below what is spent (refusal repeats -- fail closed),
    // and the worst reachable overshoot is the gap between the typo and the
    // truth, inside the current stage. A FORGOTTEN anchor, by contrast,
    // silently re-created the stacking bug this field exists to prevent.
    // `"uncapped"` is exempt: it has no boundary arithmetic to anchor.
    if (!uncapped && (!Number.isInteger(receipt.asOf) || receipt.asOf < 0)) {
      return (
        `David authorization must carry "asOf" -- the completed-round count when he granted, a non-negative ` +
        `integer (got ${JSON.stringify(receipt.asOf)}). His rounds open at asOf + grant; at a gate, asOf is ` +
        `the gate's own round count`
      );
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
  // EVERY decision below is read from the durable ref, never from the working
  // tree. No upstream means nothing here can be durable at all, so there is
  // nothing to read and the answer is refuse -- see `durableRef`.
  const ref = typeof io.durableRef === "function" ? io.durableRef() : null;
  if (!ref) {
    return {
      problem: "bad-receipt",
      detail:
        "this branch has no REMOTE-tracking upstream, so there is no durable ref to read the budget and " +
        "extensions from. Push the branch (`git push -u origin <branch>`) before requesting a review: a " +
        "decision that exists only in this container dies with it, and the next session would be offered the " +
        "self-serve tripwire again. (A branch tracking another LOCAL branch reports the same way, and for the " +
        "same reason -- a local ref is not durable either.)",
    };
  }

  const budget = readDurableJson(io, ref, budgetPath(pr));
  if (budget.state === "absent") {
    // The DECISION is identical either way -- absent from the ref is absent.
    // Only the wording differs, and it matters: "declared but not pushed" is
    // the likeliest way anyone meets this rule for the first time, and
    // "no budget declared" would send them to re-run `declare`, which is
    // exactly the thing that already worked. The working tree is consulted
    // here to phrase a refusal, never to make one.
    const writtenLocally = typeof io.exists === "function" && io.exists(budgetPath(pr));
    if (writtenLocally) {
      return {
        problem: "bad-receipt",
        detail:
          `${budgetPath(pr)} exists in the working tree but is not in ${ref}. Commit and push it -- a budget ` +
          "that dies with this container is not a declared budget, and re-running `declare` will not help",
      };
    }
    return { problem: "no-budget" };
  }
  if (budget.state !== "ok") {
    return { problem: "bad-receipt", detail: `${budgetPath(pr)} could not be read from ${ref} (${budget.state}: ${budget.error})` };
  }
  const budgetError = validateBudget(pr, budget.value);
  if (budgetError) return { problem: "bad-receipt", detail: `${budgetPath(pr)} (in ${ref}): ${budgetError}` };

  const tier = budget.value.tier;

  // Iterate the FILENAMES, never a number reconstructed from them: rebuilding
  // the path from a normalized number read one receipt twice and never opened
  // a zero-padded duplicate at all. (Codex, #503 round 2.)
  //
  // Null, not [], when the ref cannot be listed: an unlistable tree reading as
  // "no extensions" would show a loop that had spent its adjudication the
  // self-serve tripwire a second time. (Round 3's finding, carried across.)
  const names = typeof io.listDurable === "function" ? io.listDurable(ref, RECEIPTS_DIR) : null;
  if (names === null) {
    return { problem: "bad-receipt", detail: `${RECEIPTS_DIR} could not be listed in ${ref}` };
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
  for (const { seq, name } of found) {
    const rel = `${RECEIPTS_DIR}/${name}`;
    // From the ref. There is no second read to disagree with this one, and no
    // byte comparison to get wrong -- the bytes being parsed ARE the durable
    // bytes. (#526 findings 1, 4, 5 and 7 all live in the gap this closes.)
    const parsed = readDurableJson(io, ref, rel);
    if (parsed.state !== "ok") {
      return { problem: "bad-receipt", detail: `${rel} could not be read from ${ref} (${parsed.state}: ${parsed.error ?? "unreadable"})` };
    }
    // Only the extensions already accepted, in sequence order: this receipt
    // must answer the tripwire THEY establish, not an earlier one.
    const error = validateExtension(pr, tier, parsed.value, { io, ref, preceding: extensions });
    if (error) return { problem: "bad-receipt", detail: `${rel} (in ${ref}): ${error}` };
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
  return staged(tier, extensions, roundsSpent).total;
}

/**
 * Whether self-serve extension is exhausted for this loop: the allowance has
 * reached the current David gate, so only David can grant further rounds.
 */
const railReached = (tier, extensions, roundsSpent) => {
  const { total, rail } = staged(tier, extensions, roundsSpent);
  return total >= rail;
};

/**
 * Whether a TERMINAL adjudication verdict is standing: the highest-sequence
 * extension is adjudication-kind with a non-continue verdict. The shared
 * contract says a dispatched verdict DECIDES -- so a committed
 * ship-with-gaps-recorded / split / escalate must not be answerable by simply
 * running another self-serve adjudication until one says continue (Codex,
 * #543 round 2). A later `david`-kind grant supersedes the terminal verdict
 * and reopens the loop; only he can.
 */
const terminalVerdictStanding = (extensions) => {
  if (!extensions.length) return false;
  const last = extensions[extensions.length - 1];
  return last.kind === "adjudication" && last.verdict !== "continue";
};

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
  const triggers = (issueComments ?? []).filter(
    (c) =>
      // A REVIEWER NEVER REQUESTS ITS OWN REVIEW. Codex's connector footer
      // quotes the trigger verbatim ("Reviews are triggered when you ... comment
      // \"@codex review\""), so a reviewer comment landing after the last pass
      // read as a pending request. That is not a cosmetic miscount: `pending`
      // now suppresses the tripwire, so a quoted trigger in a reviewer's own
      // footer would skip the refusal entirely -- and re-skip it every time a
      // later response carried a newer footer. `pr-ready.mjs` already filters
      // reviewer logins for the same reason. (Codex, #503 round 5.)
      !REVIEWER_LOGINS.has(normalizeLogin(c.user?.login)) && mentionsReviewRequest(c.body),
  );
  const pending = triggers.some((c) => Date.parse(c.created_at ?? "") > lastPassAt) ? 1 : 0;

  // GitHub timestamps have SECOND resolution, so a request posted in the same
  // second as the pass before it is genuinely unordered. A tie only matters
  // when it would DECIDE the answer: if some other trigger is strictly later,
  // `pending` is already 1 and the tie changes nothing.
  //
  // IT IS REPORTED, NOT RESOLVED, AND IT NEVER STOPS THE COUNT. The first fix
  // for this had `check` refuse to mint on a tie, which was safe and DEAD: if
  // the tied request came just before the pass that answered it, neither
  // timestamp ever changes, so the condition stayed true forever -- and the
  // one thing that would clear it, a later request, was itself refused. That
  // bricks review posting on the PR with no way out, not even David's
  // authorization, because the refusal happened at mint time before allowance
  // was ever consulted. (Codex, #526 finding 6.)
  //
  // `pending: 0` is the CAP-PRESERVING reading, so the tie is simply counted
  // that way and the loop stays live. Work through the guard's condition
  // (`pending === 0 && delivered >= allowance`):
  //
  //   AT the cap  -- 0 refuses, 1 would allow. Refusing is the safe half, and
  //                  it routes into the ordinary tripwire, which an extension
  //                  can release. A live escalation path, not a dead end.
  //   BELOW it    -- `pending` does not gate anything; the post is allowed
  //                  either way. What stops one authorization from becoming
  //                  two posts is the claim, never this number.
  //
  // So the worst case is one legitimate retry refused at the cap, escalating
  // through the path that already exists for "we are at the cap and cannot
  // tell." The flag rides along so the refusal can SAY that is why.
  const ambiguous =
    pending === 0 && triggers.some((c) => Date.parse(c.created_at ?? "") === lastPassAt);

  return { delivered, pending, spent: delivered + pending, ambiguous };
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
  // The generation the claim is keyed to. A receipt without it cannot be
  // claimed at all (claimPath throws), so refuse here with a message that says
  // what to do rather than letting the throw surface as an I/O failure.
  if (typeof receipt.nonce !== "string" || !/^[0-9a-f]{16}$/.test(receipt.nonce)) {
    return "round-check receipt carries no generation nonce -- it predates the per-generation claim; run check again";
  }
  // The gate reads these two directly (a retry of a stalled round is not a new
  // round), so neither may be absent or wrong-typed.
  if (!Number.isInteger(receipt.delivered) || receipt.delivered < 0) {
    return `round-check receipt carries no usable delivered count (${JSON.stringify(receipt.delivered)})`;
  }
  if (receipt.pending !== 0 && receipt.pending !== 1) {
    return `round-check receipt carries a pending value of ${JSON.stringify(receipt.pending)}; at most one round can be in flight, so it must be 0 or 1`;
  }
  if (receipt.delivered + receipt.pending !== receipt.spent) {
    return `round-check receipt does not add up (${receipt.delivered} delivered + ${receipt.pending} pending != ${receipt.spent} spent)`;
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
  `\`node scripts/review-budget.mjs check --pr ${pr} --mcp-snapshot <file>\`. The snapshot must carry ` +
  `repo: "${REPO_OWNER}/${REPO_NAME}", pr.number, a capturedAt timestamp from when GitHub was actually ` +
  `read, complete.reviews/complete.issueComments attestations, a body on every issue comment and on every ` +
  `reviewer-authored review, and must be re-captured rather than reused once it is an hour old.`;

/**
 * The refusal text. This is the product, not a side note: it is read by the
 * one agent that can act on it, at the one moment it can act, and it has to
 * carry the aggregate the loop could not see for itself.
 */
function refusal(pr, state, spent, tiedCount = false) {
  const { budget, tier, extensions, nextSeq } = state;
  const cap = allowance(tier, extensions, spent);
  const tie = tiedCount
    ? `\nNOTE: a review request on this PR carries the SAME second as the latest completed pass, and GitHub's ` +
      `timestamps stop at seconds, so whether that request is still in flight cannot be ordered from the ` +
      `evidence. It is counted as answered, which is the reading that cannot exceed the cap -- so if that ` +
      `request is in fact still unanswered, this refusal is blocking a RETRY rather than a new round. Say so ` +
      `in the adjudication or to David; do not work around it.`
    : "";
  // A standing terminal verdict can refuse MID-budget (internal tier), where
  // "exceeds its declared budget" would be false -- the head states the real
  // ground in that case rather than a wrong one. (Codex, #553 round 1.)
  const head = terminalVerdictStanding(extensions)
    ? `review round ${spent + 1} on PR #${pr} is refused with ${spent} of ${cap} rounds spent ` +
      `(tier "${tier}" -- ${TIERS[tier].label}; counted from GitHub's own record of completed ` +
      `reviewer passes; criticality ${budget.criticality}): a terminal verdict is standing.${tie}`
    : `review round ${spent + 1} on PR #${pr} exceeds its declared budget ` +
      `(tier "${tier}" -- ${TIERS[tier].label}; ${spent} of ${cap} rounds already spent, counted from ` +
      `GitHub's own record of completed reviewer passes; criticality ${budget.criticality}).${tie}`;

  if (terminalVerdictStanding(extensions)) {
    return (
      `${head}\n` +
      `TRIPWIRE 2 (hard stop). A TERMINAL adjudication verdict is standing on this loop ` +
      `("${extensions[extensions.length - 1].verdict}", ${extensionPath(pr, extensions[extensions.length - 1].seq)}) ` +
      `and a dispatched verdict decides -- another self-serve adjudication cannot overturn it. ` +
      `Take this to David as a 🛑 NEED YOU; only a "david"-kind extension receipt reopens the loop. Record ` +
      `his answer in ${extensionPath(pr, nextSeq)} as {"kind":"david","grant":<n|0|"uncapped">,` +
      `"asOf":<completed rounds when he granted -- REQUIRED on every finite grant; his rounds open at ` +
      `asOf+grant, so a mid-stage direct grant discards the interrupted stage's unspent remainder>,` +
      `"authorization":"<his words>"}, then COMMIT AND PUSH it.`
    );
  }

  if (!railReached(tier, extensions, spent)) {
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
      `(ship-with-gaps-recorded | split | continue+grant+risk | escalate). The adjudicator sizes its own ` +
      `grant -- a push whose last round revealed a real problem may need more than one round -- bounded ` +
      `by the self-serve leash: at the David gate of ${railFor(tier, extensions, spent)} rounds ` +
      `(the tier budget plus its ${LEASH}-round leash, or exactly where David's latest grant runs out) ` +
      `the loop stops for David regardless of verdict. ` +
      `Every verdict -- not just "continue" -- must also carry \`recordPath\` (citing the exact record path ` +
      `step 1 printed) and \`decidedAt\` (an ISO timestamp of when THIS receipt is being written, not when ` +
      `the record was generated in step 1). Carry the adjudicator's own \`reasoning\` and \`gaps\` fields ` +
      `into the receipt verbatim -- a receipt with only pr/kind/verdict/recordPath/decidedAt closes this ` +
      `guard but discards the adjudicator's actual justification. A ship-with-gaps-recorded receipt missing ` +
      `recordPath, decidedAt, reasoning, or gaps closes this guard but can never satisfy pr-ready.mjs's ` +
      `merge gate. Then COMMIT AND PUSH it -- extensions are read from the remote-tracking ref, so an ` +
      `unpushed one grants nothing and this refusal will simply repeat.\n` +
      `Default verdict is ship-with-gaps-recorded. Only "continue" reopens this guard. If the blocker is a ` +
      `PRODUCT decision -- the adjudicator returns "escalate", or the open findings are product-shaped ` +
      `rather than mechanical -- that goes to David immediately, leash or no leash.`
    );
  }

  return (
    `${head}\n` +
    `TRIPWIRE 2 (the David gate). This loop has reached ${railFor(tier, extensions, spent)} rounds -- ` +
    `${extensions.some((e) => e.kind === "david") ? "exactly where David's latest grant runs out" : `its budget plus the ${LEASH}-round self-serve leash`} ` +
    `-- so the next rounds are David's to authorize, whatever the adjudicator recommends. The sequence ` +
    `(David, 2026-08-26):\n` +
    `  1. node scripts/review-loop-record.mjs --pr ${pr} --mcp-snapshot <file> --write\n` +
    `  2. Dispatch ONE fresh-context adjudicator subagent ON FABLE (agent type "review-loop-adjudicator", ` +
    `model: "fable" explicit), record and nothing else -- its verdict here is the RECOMMENDATION David ` +
    `reviews, not a grant. Commit it to ${extensionPath(pr, nextSeq)} like any adjudication receipt ` +
    `(recordPath, decidedAt, reasoning, gaps verbatim); a "continue" written at the gate grants nothing ` +
    `by itself.\n` +
    `  3. Take the verdict to David as a 🛑 NEED YOU -- his call on Fable's recommendation, with a ` +
    `push notification -- and record his answer as the NEXT receipt: {"kind":"david",` +
    `"grant":<n|0|"uncapped">,"asOf":<this gate's round count>,"authorization":"<his words>"} ` +
    `(default leash ${LEASH}; 0 endorses stopping; "asOf" is REQUIRED on every finite grant). COMMIT AND PUSH both -- extensions are read from the remote-tracking ref, so an unpushed ` +
    `authorization grants nothing and this refusal will simply repeat.\n` +
    `A PRODUCT-shaped blocker skips step 2's framing entirely: it is David's decision, not a ` +
    `mechanical-convergence question, and goes to him directly.`
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

  // Refuse the trigger on any surface the count cannot see. This is what makes
  // `issueComments` a complete pending surface -- see REVIEW_REQUEST_SURFACE.
  if (toolName !== REVIEW_REQUEST_SURFACE) {
    return {
      blocked: true,
      reason:
        `a review request posted through ${toolName} lands in a review thread or review body, not in the ` +
        `issue comments the round count reads -- so it would be invisible as a pending round and could let ` +
        `an extra round through at the cap. Post the re-request as an issue comment ` +
        `(${REVIEW_REQUEST_SURFACE}) instead. If this comment only QUOTES the trigger rather than being one, ` +
        `reword it: the guard reads raw text and cannot tell the difference.`,
    };
  }

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
        `no round budget declared for PR #${pr}, so an @codex review re-request is refused.\n` +
        `IF THIS IS INTERNAL TOOLING -- a guard, a script, a skill, CLAUDE.md, a process doc, a ` +
        `harvest -- and round 1 (the automatic pass) found NOTHING, no request is needed: merge on ` +
        `the automatic pass. If round 1 found things and the fixes are pushed, declare the ` +
        `internal tier and re-request -- the fixes get reviewed (David, 2026-08-21, superseding ` +
        `the 2026-08-20 no-rounds carve-out):\n` +
        `  node scripts/review-budget.mjs declare --pr ${pr} --tier internal ` +
        `--criticality <1-100> --artifact "<what is under review>"\n` +
        `IF THIS IS PRODUCT CODE, declare the budget BEFORE round 1:\n` +
        `  node scripts/review-budget.mjs declare --pr ${pr} --tier <product|sensitive> ` +
        `--criticality <1-100> --artifact "<what is under review>"\n` +
        `Tiers: product=5 rounds; sensitive=5 (auth/payments/migrations); internal=3, strict ` +
        `adjudication rubric. Every tier runs the two-tier tripwire: Fable adjudication from the ` +
        `budget, self-serve leash of ${LEASH} rounds past it, then the David gate. ` +
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

  // A RETRY OF A STALLED ROUND IS NOT A NEW ROUND, and refusing it was a real
  // deadlock. With `spent = delivered + pending`, a loop sitting at
  // cap-1 delivered + 1 stalled equals the cap, so the retry was refused --
  // while the documented recovery could not clear it either, since the
  // adjudication record would show fewer completed passes. A reviewer
  // outage at the cap became a hard stop until the original pass arrived or
  // David intervened. (Codex, #503 round 4.)
  //
  // The distinction is exact, not approximate. `pending` is defined as a
  // trigger sitting AFTER the last completed pass, so if it is 1 then nothing
  // has been answered since that request, and any request now is a retry of
  // the same unanswered round rather than a new one. Gate on `delivered`, and
  // only when nothing is in flight.
  //
  // Staging still reads `spent`: a pending round is budget already committed,
  // so an extension must not activate early just because the round in flight
  // has not landed yet.
  const { delivered, pending, spent } = check.value;
  // A STANDING TERMINAL VERDICT REFUSES THE NEXT REQUEST AT ANY ALLOWANCE
  // AND REGARDLESS OF `pending` (Codex, #553 rounds 1-2). The contract says
  // a dispatched verdict DECIDES, and with the internal tier a terminal
  // receipt can now stand MID-budget -- where the allowance test below would
  // happily allow another round on the loop's remaining nominal allowance.
  // The stalled-round retry exception does not apply either: a retry posts
  // a fresh trigger and spawns a fresh round, which is exactly what only a
  // "david"-kind receipt may authorize once a terminal verdict stands -- so
  // a request racing in around the adjudication must not convert into a
  // permitted retry. Product loops are unaffected in behavior (their
  // terminal receipts only exist at exhaustion); this makes the rule hold
  // everywhere the receipt can exist, in every pending state.
  if (terminalVerdictStanding(state.extensions)) {
    return { blocked: true, reason: refusal(pr, state, spent, check.value.ambiguous === true) };
  }
  if (pending === 0 && delivered >= allowance(state.tier, state.extensions, spent)) {
    // `ambiguous` rides along so the refusal can say WHY the count might be
    // one low: a same-second tie is counted as `pending: 0` (the
    // cap-preserving reading -- see countRounds), which can refuse a
    // legitimate retry. Naming it turns a confusing refusal into an ordinary
    // tripwire the adjudicator or David can act on. (#526 finding 6.)
    return { blocked: true, reason: refusal(pr, state, spent, check.value.ambiguous === true) };
  }

  // Claim the receipt ATOMICALLY before allowing anything, and CONSUME it --
  // both inside one try, because an escaping exception here does not fail
  // closed, it fails OPEN.
  //
  // `main()` is `main().then((code) => process.exit(code))`: a throw rejects
  // that promise, `.then` never runs, node exits 1, and `guard.sh` forwards
  // `exit $?`. The blocking code is 2, so exit 1 reads to the harness as a
  // hook ERROR rather than a denial and the post proceeds. The precise
  // filesystem faults these comments promise will fail closed -- EACCES on the
  // claim, ENOSPC on the write -- were therefore the ones that let a request
  // through. (Codex, #503 round 5.)
  try {
    if (!io.claimOnce(claimPath(pr, check.value.nonce))) {
      return {
        blocked: true,
        reason:
          `the round-check receipt for PR #${pr} has already been claimed by another post in flight -- one ` +
          `check authorizes one request. ${CHECK_HOWTO(pr)}`,
      };
    }
    // Consume the receipt: one check, one post. Written before the post goes
    // out (a PreToolUse hook has no "after"), so a post that then fails costs a
    // re-check, not a round -- the round count itself lives on GitHub.
    io.write(
      checkPath(pr),
      `${JSON.stringify({ ...check.value, consumedAt: new Date(now).toISOString() }, null, 2)}\n`,
    );
  } catch (err) {
    return {
      blocked: true,
      reason:
        `the round-check receipt for PR #${pr} could not be claimed or consumed (${err.message}), so this ` +
        `post cannot be recorded as spending its round. Refusing rather than proceeding on an unrecorded ` +
        `round. ${CHECK_HOWTO(pr)}`,
    };
  }
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
  review-budget.mjs declare --pr <n> --tier <product|sensitive|internal> --criticality <1-100> --artifact "<text>"
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
    `declared: PR #${pr}, tier "${flags.tier}" (${TIERS[flags.tier].label}), ${cap} rounds ` +
    `(Fable adjudication from the cap, David gate at ${cap + LEASH}), ` +
    `criticality ${criticality}. Written to ${budgetPath(pr)} -- COMMIT AND PUSH it (a budget is read from the ` +
    `branch's remote-tracking ref, so an unpushed one reads as no budget at all), and state the budget in the ` +
    `PR body.`
  );
}

/**
 * Snapshot requirements for counting rounds. Mirrors the posture of
 * `pr-ready.mjs`'s assertSnapshot and `review-counting.mjs`'s completeness
 * assertions: bound to THIS pr, both collections present and attested
 * complete, and shaped well enough that `reviewerPasses` cannot silently
 * undercount. (Codex, #503 round 3: an attested-complete snapshot whose
 * entries lack the fields the counter reads is undercounted, not rejected --
 * so the load-bearing fields are checked here.)
 */
/**
 * A usable record identity. `reviewerPasses` DEDUPLICATES by id, so two
 * records sharing one is two records collapsing into one delivered pass --
 * an undercount, which is the direction that hands the loop free rounds.
 * `!== undefined` let `null` through, and every `null` is equal to every
 * other. (Codex, #503 round 5.)
 */
const hasStableId = (record) =>
  (typeof record?.id === "number" && Number.isFinite(record.id)) ||
  (typeof record?.id === "string" && record.id.length > 0);

export function assertCountingSnapshot(pr, snapshot, now = Date.now()) {
  if (!snapshot || typeof snapshot !== "object") throw new Error("snapshot is not an object");
  if (snapshot.pr?.number !== pr) {
    throw new Error(`snapshot describes PR ${snapshot.pr?.number}, but --pr says ${pr}`);
  }
  // A PR number alone does not identify a pull request. Every repository has a
  // #503, so a snapshot captured elsewhere -- with fewer passes -- would be
  // laundered into a valid-looking lower count and buy an unearned round,
  // while `check` stamped the receipt with THIS repo's name regardless of
  // where the data came from. (Codex, #503 round 4. `pr-ready.mjs` already
  // binds its readiness snapshot this way; this path did not.)
  const target = `${REPO_OWNER}/${REPO_NAME}`;
  if (typeof snapshot.repo !== "string" || snapshot.repo.toLowerCase() !== target.toLowerCase()) {
    throw new Error(
      `snapshot must name its source repository as "repo": "${target}" -- it says ` +
        `${JSON.stringify(snapshot.repo ?? null)}, and a PR number alone does not identify a pull request`,
    );
  }
  // FRESHNESS IS A PROPERTY OF THE EVIDENCE, NOT OF THE COMMAND.
  //
  // The receipt used to stamp `capturedAt` with the time `check` ran, so a
  // snapshot saved hours earlier -- after which more passes landed -- minted a
  // receipt that looked current for another hour while carrying the older,
  // lower count. The one-hour cap measured how recently the command was typed,
  // which is not a fact about anything. It now measures how recently GitHub
  // was actually read. (Codex, #503 round 4 -- and they were right that this
  // is the dissolved reconciliation-staleness finding reappearing in its
  // replacement, which is exactly why it needed closing rather than noting.)
  const capturedAt = Date.parse(snapshot.capturedAt ?? "");
  if (!Number.isFinite(capturedAt)) {
    throw new Error(
      'snapshot must carry a parseable "capturedAt" -- the moment GitHub was read. Without it the ' +
        "receipt's freshness would measure when the command ran, which a reused snapshot satisfies trivially",
    );
  }
  const age = now - capturedAt;
  if (age < 0) throw new Error(`snapshot capturedAt (${snapshot.capturedAt}) is in the future`);
  if (age > MAX_CHECK_AGE_MS) {
    throw new Error(
      `snapshot was captured ${Math.round(age / 60000)} minutes ago, older than the ` +
        `${MAX_CHECK_AGE_MS / 60000}-minute limit -- re-capture it rather than re-stamping stale evidence`,
    );
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
    if (!hasStableId(r) || typeof r?.user?.login !== "string" || !Number.isFinite(Date.parse(r?.submitted_at ?? ""))) {
      throw new Error(
        `snapshot reviews[${i}] is missing a stable id, user.login, or a parseable submitted_at -- ` +
          "reviewerPasses would silently undercount this shape rather than reject it",
      );
    }
    // A REVIEWER's review is counted by its body: `reviewerPasses` keys on the
    // "Reviewed commit:" announcement, and with the body absent it silently
    // falls back to one-pass-per-record. Demanded only of reviewer-authored
    // records, because those are the only ones the body is load-bearing for --
    // requiring it of every record would mean inventing empty bodies for the
    // dozens of my own replies a real snapshot carries, which is fabricating
    // data to satisfy a validator. (Codex, #503 round 4.)
    if (REVIEWER_LOGINS.has(normalizeLogin(r.user.login)) && typeof r.body !== "string") {
      throw new Error(
        `snapshot reviews[${i}] is a reviewer record with no string body -- the pass count keys on the ` +
          "\"Reviewed commit:\" announcement in that body, so an omitted one silently changes the count",
      );
    }
  });
  snapshot.issueComments.forEach((c, i) => {
    if (!hasStableId(c) || typeof c?.user?.login !== "string" || !Number.isFinite(Date.parse(c?.created_at ?? ""))) {
      throw new Error(
        `snapshot issueComments[${i}] is missing a stable id, user.login, or a parseable created_at -- ` +
          "pass and pending detection would silently miscount this shape rather than reject it",
      );
    }
    // Every issue comment's body is load-bearing here: it is the only place a
    // pending trigger can be seen, and an absent body reads as "no trigger" --
    // a missing pending round, which is headroom the loop did not earn.
    if (typeof c.body !== "string") {
      throw new Error(
        `snapshot issueComments[${i}] has no string body -- pending-trigger detection reads it, and an ` +
          "omitted body is indistinguishable from a comment that carries no trigger",
      );
    }
  });
}

async function check(flags, io) {
  const pr = requirePr(flags);
  if (!flags["mcp-snapshot"]) throw new Error(`--mcp-snapshot <file> is required. ${CHECK_HOWTO(pr)}`);
  const snapshot = JSON.parse(fs.readFileSync(flags["mcp-snapshot"], "utf8"));
  assertCountingSnapshot(pr, snapshot, Date.parse(io.now()));

  const state = loadLoop(pr, io);
  if (state.problem === "no-budget") throw new Error(`no budget declared for PR #${pr} -- declare first`);
  if (state.problem) throw new Error(`cannot check: ${state.detail}`);

  // EACH CHECK NEEDS STRICTLY NEWER EVIDENCE THAN THE LAST ONE.
  //
  // Without this, the single-use contract was single-use in name only: after a
  // post consumed a receipt, re-running `check` with the SAME still-fresh
  // snapshot overwrote the consumed receipt and released the claim, and since
  // that snapshot predates the post it still reports the lower count. One
  // evidence state could authorize a request, be re-minted, and authorize the
  // next -- repeatable for the whole hour. The claim closed the concurrent
  // race and quietly opened the sequential one. (Codex, #503 round 5.)
  //
  // Monotonicity is the exact property wanted: a genuinely new observation of
  // GitHub is always later than the one before it, and re-presenting an old
  // observation is precisely what must not count as new evidence.
  const previous = readJson(io, checkPath(pr));
  if (previous.state === "ok") {
    const before = Date.parse(previous.value?.capturedAt ?? "");
    if (Number.isFinite(before) && Date.parse(snapshot.capturedAt) <= before) {
      throw new Error(
        `this snapshot was captured at ${snapshot.capturedAt}, which is not newer than the evidence behind ` +
          `the current receipt (${previous.value.capturedAt}). Re-capture the snapshot: re-presenting an ` +
          "observation that has already authorized a post is how one evidence state authorizes several.",
      );
    }
  }

  const { reviewerPasses } = await import("./review-counting.mjs");
  const counted = countRounds({
    reviewerPasses: reviewerPasses(snapshot.reviews, snapshot.issueComments),
    issueComments: snapshot.issueComments,
  });

  const receipt = {
    pr,
    repo: `${REPO_OWNER}/${REPO_NAME}`,
    // The snapshot's own capture time, NOT `io.now()`. See the freshness note
    // in assertCountingSnapshot: stamping the command time lets a stale
    // snapshot mint an indefinitely-renewable receipt.
    capturedAt: snapshot.capturedAt,
    mintedAt: io.now(),
    // This receipt's generation. The guard's claim path is derived from it, so
    // a fresh receipt gets a fresh claim WITHOUT deleting the previous one --
    // see the claimPath header. Never reused: `check` mints a new one every
    // time, so a replayed receipt cannot inherit a live claim.
    nonce: io.nonce(),
    ...counted,
  };
  io.write(checkPath(pr), `${JSON.stringify(receipt, null, 2)}\n`);

  const cap = allowance(state.tier, state.extensions, counted.spent);
  const verdict =
    counted.pending === 0 && counted.delivered >= cap
      ? "the NEXT request will be refused (tripwire)"
      : counted.pending
        ? "a round is in flight; a retry of it is allowed and costs nothing new"
        : "the next request is inside budget";
  const tie = counted.ambiguous
    ? "\nNOTE: a request shares its second with the latest pass, so the two cannot be ordered from the " +
      "evidence. Counted as answered -- the reading that cannot exceed the cap. If that request is actually " +
      "still in flight, this count is one low and a refusal here is blocking a retry."
    : "";
  return (
    `PR #${pr}: ${counted.delivered} completed reviewer pass(es)` +
    `${counted.pending ? " + 1 pending request" : ""} = ${counted.spent} of ` +
    `${cap === Infinity ? "uncapped" : cap} -- ${verdict}. Receipt written to ${checkPath(pr)} ` +
    `(ephemeral, one post).${tie}`
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

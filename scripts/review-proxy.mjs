#!/usr/bin/env node
// SYNCED FROM AI-Handbook — do not edit in a consumer repo. Local edits are overwritten by the next sync and their reasoning is lost; change the handbook instead.
/**
 * The review proxy: independent technical advice on a code-review round (#96).
 *
 * WHAT THIS IS, AFTER THE 2026-09-17 REDESIGN. Codex returns findings. Astra
 * and a Fable assessor each read the same findings, the same agreed intent and
 * the same revision, separately, and each says what is actually wrong and
 * whether acting on it is worthwhile. I compare the two, check disputed facts
 * in the repository, ask Astra a focused follow-up when a real question of
 * reasoning remains, and implement what is agreed. A purely technical
 * disagreement that survives that is settled by the Fable assessor, with its
 * reasoning recorded. Intended behaviour and accepted user-facing shortfalls
 * are David's.
 *
 * WHAT IT REPLACED, AND WHY THE SHAPE CHANGED. The first version had Astra
 * emit JSON whose per-finding disposition BOUND me, under a rubric that told
 * it to decline most findings. David replaced that design after working
 * through it with Astra: binding dispositions made every finding a
 * jurisdiction question, and a decline quota is the mirror image of the fix
 * quota it was built to fix. Both quotas are gone. There is no target rate in
 * either direction, and the measure is whether David can see what mattered and
 * why the response was proportionate.
 *
 * SO THERE IS NO SCHEMA HERE, DELIBERATELY. The substantive output is Markdown
 * because a person reads it. This module supplies the same package to both
 * assessors, stamps the metadata the harness already owns, and gets out of the
 * way. **Nothing parses an assessment to decide what happens next.** What
 * happens next is the action I state explicitly, in the block `actionBlock`
 * renders -- so no phrase in an assessment can authorise work, and agent
 * agreement never substitutes for David's approval.
 *
 * ASTRA IS THE CODEX CLI, PINNED, IN A READ-ONLY SANDBOX WITH NO OVERRIDE. The
 * plan runner permits workspace-write under `--unpinned`; this reviews the live
 * checkout and must not copy that escape hatch.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { modelTier, signInStatus, spawnSyncDefault, SIGN_IN_INSTRUCTIONS, runCodex, findRepoRoot, agentFrontmatter, claudeAlias } from "./machinery.mjs";
import { REVIEWS_DIR, ensureReviewsIgnored } from "./round-translation.mjs";

export const ROLE = "review-proxy";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * The command to run this script, COMPUTED rather than written down.
 *
 * The sync routes `core/X -> X`, so this file is `core/scripts/review-proxy.mjs`
 * in the handbook and `scripts/review-proxy.mjs` in every consumer. A literal
 * path in the usage text is therefore wrong in one of the two layouts, and it
 * is printed on every argument error -- telling an operator who has just
 * mistyped a flag to run a file that is not there. `plan-review.mjs` has
 * computed its own invocation since Codex #69 round 7, for this same defect.
 * (Codex #120 round 5; both assessors concurred, and Fable pointed at the
 * existing helper rather than a new one.)
 */
export const INVOCATION = (() => {
  const root = findRepoRoot(SCRIPT_DIR) ?? path.resolve(SCRIPT_DIR, "..", "..");
  return path.relative(root, fileURLToPath(import.meta.url)).split(path.sep).join("/");
})();
export const briefPath = () => path.resolve(SCRIPT_DIR, "..", ".agents", "roles", `${ROLE}.md`);
/**
 * The Worth rule lives in ONE file and is quoted verbatim into both assessors'
 * prompts and pointed at by the contracts. A judgement rule restated in three
 * places is three rules a year from now.
 */
export const judgmentPath = () => path.resolve(SCRIPT_DIR, "..", "docs", "ai-context", "review-judgment.md");

/** Read-only, with no flag that relaxes it. See the header. */
export const SANDBOX = "read-only";

/** One xhigh plan round measured 522 seconds; this reads more and is given room. */
export const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;

/**
 * My "where we are" note is capped and flattened, as the plan runner does for
 * disposition notes: a bound on how much of the prompt the assessed party's
 * own framing may occupy. Not a defence against anything -- I write the note
 * and I would be the one removing the cap.
 */
export const MAX_NOTE_CHARS = 300;

export const LABELS = ["David", "oracle", "reviewer", "builder", "astra", "fable"];
export const TIERS = ["product", "sensitive", "internal"];

/**
 * What each tier tells an assessor, now that no tier sets a threshold.
 *
 * UNDER THE OLD DESIGN THIS WAS A RUBRIC THAT DECIDED: `internal` reserved a
 * write for "a very high chance of a CRITICAL flaw" and everything softer was
 * a decline. That is exactly the quota David removed. What survives is the
 * only thing a tier ever genuinely knew -- **what is downstream of the change**
 * -- which the Worth rule needs in order to weigh a consequence at all, and
 * which nobody but the caller can supply.
 *
 * The lesson from `plan-review.mjs` on #102 round 1 still binds: a tier that
 * is validated, pinned and logged while never reaching the assessor selects
 * nothing. So it reaches the assessor, in the script-owned prefix.
 */
export const TIER_LENSES = {
  product: [
    "**What is downstream: product code.** Users run this and David cannot read it. Weigh consequences by",
    "what someone using the product would experience, and for how long, before anyone noticed.",
  ],
  sensitive: [
    "**What is downstream: auth, payments or a migration.** Recoverability is the thing to weigh hardest",
    "here, because a wrong authorization decision and a wrong migration cannot be taken back by a",
    "follow-up fix. This does not make every finding in these areas worthwhile; it changes which factor",
    "dominates.",
  ],
  internal: [
    "**What is downstream: the software factory.** This is tooling, process, or instructions agents read.",
    "Nobody's money or data is downstream, so weigh it by its effect on David's ability to direct agents,",
    "build features, fix bugs and understand results -- including recurring reversible disruption, which",
    "costs him real time even though each incident is individually recoverable.",
  ],
};

/**
 * What I can state as the next action. The list is short on purpose: it exists
 * so the step after an assessment is something I SAY, never something inferred
 * from an assessment's prose.
 */
export const ACTIONS = ["proceed", "investigate", "follow-up", "ask-david", "conclude"];

export const SOURCES = ["astra", "fable"];

/**
 * The subagent type the Fable assessment is dispatched as.
 *
 * NAMED HERE BECAUSE IT WAS NAMED NOWHERE. Until #126 the skill said "as a
 * subagent" and no file in the payload said which one, so every dispatch of
 * the second assessment was improvised. It is also where its `effort:` is
 * read from, which is the only place that value exists.
 */
export const ASSESSOR_AGENT = "fable-review-assessor";

/** The assessment file, derived identically by the writer and the reader. */
export const assessmentPath = (root, pr, round, { source, followUp = 0 } = {}) => {
  assertCoordinates(pr, round);
  if (!SOURCES.includes(source)) {
    throw new Error(`review-proxy: source must be one of ${SOURCES.join(", ")}, got ${JSON.stringify(source)}`);
  }
  if (!Number.isInteger(followUp) || followUp < 0) {
    throw new Error(`review-proxy: followUp must be a non-negative integer, got ${JSON.stringify(followUp)}`);
  }
  const suffix = followUp > 0 ? `.followup-${followUp}` : "";
  return path.join(root, REVIEWS_DIR, `pr-${pr}`, `round-${round}.${source}${suffix}.md`);
};

/**
 * A cheap well-formedness check on inputs that are a choice. The pull request
 * and round are mine to supply and no rule derives them, but both land in the
 * assessment path, where `pr: "12x"` writes where the read for #12 never looks
 * and reports a failed dispatch of an assessment that actually ran.
 */
function assertCoordinates(pr, round) {
  for (const [name, value] of [["pr", pr], ["round", round]]) {
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`review-proxy: ${name} must be a positive integer, got ${JSON.stringify(value)}`);
    }
  }
}

const defaultGit = (args, cwd) => spawnSync("git", args, { cwd, encoding: "utf8" });

/**
 * The floor under the prefix comparison in `assertCheckout`.
 *
 * SEVEN IS GIT'S OWN ABBREVIATION MINIMUM, so nothing a caller could
 * legitimately paste is refused by it -- not the marker's 10, not `rev-parse`'s
 * 40. What it refuses is the input too short to identify anything: with the
 * shorter side deciding and no floor, `--commit f` matched any HEAD beginning
 * with `f`, and the guard approved a checkout it had not checked. (Codex, #120
 * round 8, deferred to #122 under that round's pre-registered exit.)
 */
const MIN_REVIEWED_COMMIT_CHARS = 7;

/**
 * REFUSE UNLESS THE CHECKOUT IS THE REVISION BEING ASSESSED.
 *
 * Both assessors read the live working tree. The prompt tells them which commit
 * they are judging, and until this existed nothing made that true: on a delayed
 * webhook, or after I had already pushed, they would read newer or uncommitted
 * source, name the requested revision back, and give advice about code that was
 * never reviewed. `claude-core.md` already required this of any dispatched
 * judgement -- "check my working tree matches it when the question is about a
 * tree" -- and the dispatch did not do it. (Codex, #120 round 2.)
 *
 * Refusing is right rather than harsh: the remedy is one checkout or one fresh
 * dispatch for the new head, and both are cheaper than advice about the wrong
 * code.
 */
/**
 * The commit a documentation pass is measured from: where the reviewed commit
 * left `main`.
 *
 * DERIVED, NEVER TYPED (Codex `4101276882`, #161 round 1; both assessors). The
 * repository and the reviewed commit already determine it, since every PR's
 * base is `main`, and a typed value had two credible wrong forms that produce
 * no error: `HEAD~1` on a multi-commit PR, and `origin/main` after `main` has
 * moved, which a two-dot diff turns into the reverse of everything merged
 * since. Either narrows the only review the class gets while the header
 * records it as complete. It is computed from the COMMIT, not from HEAD, so
 * the render path names the same range after the checkout has moved on.
 *
 * A base that cannot be computed is refused, never guessed: a control that
 * cannot evaluate must refuse.
 */
export const DOCUMENTATION_BASE_REF = "origin/main";

export function documentationBaseFor(root, reviewedCommit, { git = defaultGit } = {}) {
  const r = git(["merge-base", DOCUMENTATION_BASE_REF, reviewedCommit.trim()], root);
  const base = String(r?.stdout ?? "").trim();
  if (r?.status !== 0 || !/^[0-9a-f]{7,40}$/.test(base)) {
    throw new Error(
      `review-proxy: cannot compute where ${reviewedCommit.trim()} left ${DOCUMENTATION_BASE_REF} ` +
        `(git merge-base: ${String(r?.stderr ?? "").trim() || `exit ${r?.status}`}). Fetch main ` +
        "(`git fetch origin main`) and try again; a documentation pass is never run on a guessed range.",
    );
  }
  return base;
}

export function assertCheckout(root, reviewedCommit, { git = defaultGit } = {}) {
  const head = git(["rev-parse", "HEAD"], root);
  if (head.status !== 0) {
    throw new Error(`review-proxy: cannot read HEAD in ${root}: ${String(head.stderr ?? "").trim()}`);
  }
  const at = String(head.stdout ?? "").trim();
  const want = reviewedCommit.trim();
  if (want.length < MIN_REVIEWED_COMMIT_CHARS) {
    throw new Error(
      `review-proxy: ${JSON.stringify(want)} is too short to identify a commit. The comparison below is a prefix ` +
        `match, so a shorter reference would approve any checkout that happens to start with it. Pass at least ` +
        `${MIN_REVIEWED_COMMIT_CHARS} characters -- the marker's 10, or the full sha.`,
    );
  }
  // The shorter of the two decides: a marker carries a 10-character prefix, a
  // caller may pass 7, and `rev-parse` returns all 40. The floor above is
  // one-sided on purpose -- an input LONGER than 40 is already safe, because
  // `n` is then 40 and the whole of HEAD has to match.
  const n = Math.min(at.length, want.length);
  if (at.slice(0, n) !== want.slice(0, n)) {
    throw new Error(
      `review-proxy: the checkout is at ${at.slice(0, 10)} but this assessment is of ${want}. Both assessors read ` +
        `the live tree, so assessing from here would give advice about code the reviewer never saw. Check out the ` +
        `reviewed commit, or dispatch for the current head instead.`,
    );
  }
  const dirty = git(["status", "--porcelain"], root);
  if (dirty.status !== 0) {
    throw new Error(`review-proxy: cannot read the worktree state in ${root}: ${String(dirty.stderr ?? "").trim()}`);
  }
  const changed = String(dirty.stdout ?? "").trim();
  if (changed !== "") {
    throw new Error(
      `review-proxy: the worktree has uncommitted changes, so it is not the revision being assessed:\n${changed}\n` +
        `Commit or stash them, then dispatch.`,
    );
  }
  return at;
}

export function prepareAssessmentPath(root, pr, round, opts) {
  const file = assessmentPath(root, pr, round, opts);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  ensureReviewsIgnored(root);
  // A stale assessment must never be read as this dispatch's. A re-dispatch
  // after a crash would otherwise read its predecessor and report it as fresh.
  fs.rmSync(file, { force: true });
  return file;
}

const flatten = (s) => String(s).replace(/\s+/g, " ").trim();

const cap = (s, n) => {
  const flat = flatten(s);
  return flat.length <= n ? flat : `${flat.slice(0, n - 1)}…`;
};

/**
 * Who each assessor is, who the other one is, and who holds the tie-break.
 *
 * ONE BRIEF, TWO READERS, SO THE ROLE-SPECIFIC FACTS ARE THE SCRIPT'S. The
 * brief is deliberately generic -- "the other assessor" throughout -- because
 * both assessors must receive the same words for a difference between their
 * answers to mean a difference of judgement rather than of briefing. But a
 * generic brief cannot tell Fable that the tie-break is *its own*, and the
 * first version of this file shipped Astra's brief to Fable unchanged: it read
 * that it discussed with Fable and that Fable settled ties, which is a role
 * talking to itself about a third party that is also itself. (David,
 * 2026-09-17, on reading what the subagent was actually sent.)
 *
 * So the three facts that genuinely differ are emitted here, per source, and
 * never left for either model to infer.
 */
export const identityBlock = (source) => {
  if (!SOURCES.includes(source)) {
    throw new Error(`review-proxy: source must be one of ${SOURCES.join(", ")}, got ${JSON.stringify(source)}`);
  }
  const astra = source === "astra";
  return [
    "## Who you are in this round",
    "",
    astra
      ? "- **You are Astra**, reached through the Codex CLI in a read-only sandbox."
      : "- **You are the Fable assessor**, a Claude subagent with the checkout to read.",
    astra
      ? "- **The other assessor is the Fable assessor**, a Claude subagent reading this same package separately."
      : "- **The other assessor is Astra**, reached through the Codex CLI, reading this same package separately.",
    "- **Neither of you sees the other's assessment before writing your own.** That is the point: two",
    "  independent readings, not a second opinion formed by reading the first.",
    astra
      ? "- **The tie-break is the Fable assessor's**, not yours: once Claude has investigated the facts and you have had a focused follow-up where one was warranted, a purely technical disagreement that still remains is settled there. You are not obliged to agree with how it is settled."
      : "- **The tie-break is yours**, once Claude has investigated the facts and Astra has had a focused follow-up where one was warranted. Choose, and record why in a short paragraph. Astra is not obliged to agree.",
    "- **Neither of you can settle anything reserved for David**: what the software should do, and whether a",
    "  shortfall he or a user would feel is acceptable. If a disagreement turns out to rest on one of those,",
    "  say so and stop.",
    "",
  ].join("\n");
};

/**
 * How the assessment actually reaches this script, said per assessor (#125).
 *
 * THE TWO ASSESSORS HAVE DIFFERENT TRANSPORTS AND ONE SENTENCE USED TO CLAIM
 * BOTH. Astra runs in a `read-only` sandbox, which denies every write: its
 * answer reaches the file through `--output-last-message` in the wrapper, not
 * through anything Astra does. Telling it to "write your assessment to <path>"
 * asks for the one thing the process cannot do and names the wrong channel.
 * The Fable assessor is a subagent holding `Write`, and really does write the
 * file, so the same sentence is correct for it.
 *
 * WHY IT IS WORTH A HELPER RATHER THAN TOLERATING THE DETOUR. Measured across
 * fifteen #124 rounds, Astra tried the write, was refused, worked out the real
 * transport and delivered anyway -- fifteen for fifteen. What the instruction
 * risks is the reader that follows it literally and stops: its final message is
 * then "I could not write the file", `readAssessment` accepts any non-empty
 * file as substantive, and an apology gets posted under a header naming the
 * pull request, the revision and the findings. That is this repository's
 * recorded worst shape -- a control reporting success having evaluated nothing
 * -- so the cheap correction rides along with the next change to this file,
 * which is what its own re-grade asked for.
 */
export const deliveryLine = (source, file, noun = "assessment") =>
  source === "astra"
    ? `- **Return the complete ${noun} as your final message**, in Markdown. The CLI saves that final ` +
      `message to \`${file}\`; you are in a read-only sandbox and cannot write it yourself, and you do not ` +
      `need to. Do not replace it with a completion acknowledgement or a note about the sandbox -- the ` +
      `saved message IS the deliverable.`
    : `- **Write your ${noun} to:** \`${file}\``;

const readBrief = () => `${fs.readFileSync(briefPath(), "utf8").trim()}

---

# The Worth rule

${fs.readFileSync(judgmentPath(), "utf8").replace(/^<!--[\s\S]*?-->\s*/, "").trim()}`;

/**
 * Compose the package both assessors receive.
 *
 * THE BRIEF AND THE WORTH RULE ARE READ VERBATIM FROM THEIR FILES, never
 * assembled here, so the instructions David reviewed are the instructions that
 * run. Everything this function adds is the round's evidence, labelled with who
 * said it.
 *
 * BOTH ASSESSORS GET THE SAME PACKAGE. That is what makes the two readings
 * independent rather than merely separate: a difference between them is a
 * difference of judgement, not of what they were told.
 */
export function assessmentBrief({
  source = "astra",
  pr,
  round,
  tier,
  reviewedCommit,
  oracle,
  findings = [],
  history = [],
  builderNote = "",
  assessmentFile,
  documentationBase = null,
}) {
  assertCoordinates(pr, round);
  if (!TIER_LENSES[tier]) {
    throw new Error(`review-proxy: tier must be one of ${TIERS.join(", ")}, got ${JSON.stringify(tier)}`);
  }
  if (typeof reviewedCommit !== "string" || reviewedCommit.trim() === "") {
    throw new Error("review-proxy: reviewedCommit must be the commit this round reviewed");
  }
  // THE ORACLE IS REQUIRED (David, 2026-09-17): "we should officially agree on
  // an oracle before any round starts". Refusing here is what makes the
  // agreement happen before the loop rather than being noticed after it. It is
  // taken from where it was agreed, never from the PR body, whose verbatim copy
  // for Codex is still the builder's prose.
  if (typeof oracle !== "string" || oracle.trim() === "") {
    throw new Error(
      "review-proxy: an oracle is required and must be agreed with David before the first round. It is the outcome " +
        "he agreed the work should achieve -- an approved plan, an issue discussion, or an explicit request -- " +
        "recorded where it can be quoted. Pass it from there, not from the PR body: the body's copy is the builder's prose.",
    );
  }
  // A DOCUMENTATION PASS HAS NO REVIEWER FINDINGS, BY DESIGN (David,
  // 2026-09-25). Codex reviews prose adversarially, marks a word choice P1, and
  // the loop then builds fixes and guards for it; Astra and Fable read prose
  // better. So in this class the assessors read the change itself against its
  // intent, and Codex's output is not part of the package at all -- refused
  // here rather than silently dropped, so a caller who passes it learns the
  // class does not use it.
  const documentation = documentationBase !== null;
  if (documentation) {
    if (typeof documentationBase !== "string" || documentationBase.trim() === "") {
      throw new Error("review-proxy: a documentation pass needs the commit the change is measured from (documentationBaseFor derives it)");
    }
    if (Array.isArray(findings) && findings.length) {
      throw new Error(
        "review-proxy: a documentation pass reads the change itself, not reviewer findings -- Codex's output is not " +
          "part of this class (David, 2026-09-25); drop --findings-file",
      );
    }
  } else if (!Array.isArray(findings) || findings.length === 0) {
    throw new Error("review-proxy: the assessors are dispatched on a round that RETURNED findings; there are none here");
  }
  const seen = new Set();
  for (const f of documentation ? [] : findings) {
    // GitHub's review-comment ids are integers and JSON keeps them integers, so
    // the id is coerced rather than demanded as a string. (Codex, #120 round 1.)
    const id = f == null || f.id == null ? "" : String(f.id).trim();
    if (id === "") throw new Error(`review-proxy: every finding needs a stable id, got ${JSON.stringify(f?.id)}`);
    if (seen.has(id)) throw new Error(`review-proxy: finding id ${id} appears twice; ids key the assessment`);
    // AND IT NEEDS TEXT, the same requirement the follow-up path enforces. An
    // id with a blank body dispatches both assessors without the reviewer's
    // argument, which neither can recover from the checkout -- so the round can
    // post advice that appears to cover the finding while never having read it.
    // The asymmetry was mine: round 5 put this check on the follow-up side
    // only. (Codex, #120 round 7.)
    if (String(f.body ?? "").trim() === "") {
      throw new Error(`review-proxy: finding ${id} has no body; both assessors would be dispatched without the reviewer's argument`);
    }
    seen.add(id);
  }

  const lines = [
    readBrief(),
    "",
    "---",
    "",
    identityBlock(source),
    "# This round",
    "",
    ...TIER_LENSES[tier],
    "",
    `- **Reviewed commit:** \`${reviewedCommit}\` — the revision you are assessing. The checkout you are reading ` +
      "is at this commit and is clean; the dispatch refuses otherwise.",
    `- **Repository root:** the working directory you were started in.`,
    assessmentFile ? deliveryLine(source, assessmentFile, "assessment") : null,
    "",
    "## [oracle] The outcome this work is meant to achieve",
    "",
    "Agreed with David before this loop started. Authority over intended behaviour, scope and acceptance.",
    "",
    oracle.trim(),
    "",
  ].filter((l) => l !== null);

  // The same shape check `findings` gets two blocks up. A JSON object here has
  // `length === undefined`, so an ordinary preparation mistake composed a
  // package with no history section and no complaint -- and neither assessor can
  // notice a section it never saw. (Codex, #120 round 6.)
  if (!Array.isArray(history)) {
    throw new Error(`review-proxy: history must be an array of { label, text }, got ${typeof history === "object" ? "an object" : typeof history}`);
  }
  if (history.length) {
    lines.push("## What has happened so far, labelled by who said it", "");
    for (const entry of history) {
      if (!entry || !LABELS.includes(entry.label)) {
        throw new Error(`review-proxy: every history entry carries a label from ${LABELS.join(", ")}, got ${JSON.stringify(entry?.label)}`);
      }
      // AND IT NEEDS TEXT, the same requirement `findings` gets a few lines up.
      // `flatten` is `String(s)`, so an entry that is only a label renders
      // `- **[David]** undefined` and both assessors are dispatched without the
      // decision it was meant to carry -- a section neither can notice is
      // missing, because neither ever saw it. The asymmetry was the same one
      // round 7 fixed on the findings side: the check went on one path and not
      // its twin. (Codex, #120 round 8, deferred to #122.)
      if (typeof entry.text !== "string" || entry.text.trim() === "") {
        throw new Error(
          `review-proxy: history entry [${entry.label}] has no text; both assessors would be dispatched without the ` +
            `decision it carries, got ${JSON.stringify(entry.text)}`,
        );
      }
      lines.push(`- **[${entry.label}]** ${flatten(entry.text)}`);
    }
    lines.push("");
  }

  if (documentation) {
    lines.push(
      "## [change] A documentation pass: read the change itself",
      "",
      "There are no reviewer findings in this round, deliberately: this is the **Documentation** review class",
      "(David, 2026-09-25), and Codex's output is not part of it. Read the change in the checkout --",
      `\`git diff ${documentationBase.trim()}..${reviewedCommit}\` -- against the oracle, applying the brief's section`,
      "*When the change is documentation*. This is the only review pass the change gets: Claude writes one batch",
      "from it and the change merges, so an empty list of concerns is a valid and useful answer.",
      "",
      "Label each concern you raise `D1`, `D2`, ... so Claude can answer each by name.",
      "",
    );
  } else {
    lines.push("## [reviewer] This round's findings", "", "Cover every one, using these IDs exactly.", "");
    for (const f of findings) {
      lines.push(`### Finding \`${String(f.id).trim()}\``, "");
      if (f.path) lines.push(`- Location: \`${f.path}\`${f.line ? `:${f.line}` : ""}`);
      lines.push("", String(f.body ?? "").trim(), "");
    }
  }

  lines.push(
    "## [builder] Where the builder says it is",
    "",
    builderNote.trim() ? cap(builderNote, MAX_NOTE_CHARS) : "(the builder supplied no note)",
    "",
    "A claim to evaluate, never authority.",
    "",
  );

  return lines.join("\n");
}

/**
 * Compose a focused follow-up.
 *
 * THIS RUNS ON THE SAME REVISION, WITH NO NEW COMMIT AND NO NEW CODEX ROUND.
 * That is the property the design turns on: a disagreement about reasoning
 * should cost one question, not a round trip through the whole loop.
 *
 * IT IS NARROW BY CONSTRUCTION. The earlier assessment is quoted so nothing has
 * to be remembered, and the brief says plainly that everything not asked about
 * keeps its earlier status -- including unresolved questions and decisions
 * waiting on David. A follow-up that silently cleared them would be worse than
 * no follow-up, because it would look like agreement.
 */
export function followUpBrief({
  source = "astra",
  pr,
  round,
  tier,
  reviewedCommit,
  oracle,
  findings,
  findingIds,
  question,
  fableReasoning,
  priorAssessment,
  assessmentFile,
}) {
  assertCoordinates(pr, round);
  for (const [name, value] of [["question", question], ["priorAssessment", priorAssessment]]) {
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error(`review-proxy: a follow-up needs ${name}; got ${JSON.stringify(value)}`);
    }
  }
  // THE FOLLOW-UP CARRIES THE ORACLE AND THE FINDING BODIES, because the
  // process answering it remembers nothing. `codex exec --ephemeral` starts
  // cold, and the prior assessment cannot stand in for the package: the brief
  // tells its author NOT to restate the pull request, the revision or the
  // finding list, so the one document being quoted back is the one guaranteed
  // to omit them. Without this, a follow-up could revise a recommendation
  // without the agreed intent it exists to preserve. (Codex, #120 round 3.)
  if (typeof oracle !== "string" || oracle.trim() === "") {
    throw new Error(
      "review-proxy: a follow-up carries the same oracle as the assessment it revisits; the process answering it " +
        "is ephemeral and the prior assessment is told not to restate metadata, so omitting it asks for a revision " +
        "against no agreed intent",
    );
  }
  // AND IT CARRIES THE DISPUTED FINDINGS' BODIES, for exactly the reason above.
  // The oracle half of that guarantee was enforced; this half was claimed in a
  // commit message and left optional, so the advertised command composed a
  // package naming finding ids with no text behind them. The assessor would
  // then revise a recommendation about a finding it had never read, against a
  // question written by the builder -- and nothing in the posted answer would
  // show it. (Codex #120 round 5; both assessors concurred.)
  const bodies = new Map(
    (Array.isArray(findings) ? findings : [])
      .filter((f) => f != null && f.id != null && String(f.body ?? "").trim() !== "")
      .map((f) => [String(f.id).trim(), f]),
  );
  const missing = findingIds.map((id) => String(id).trim()).filter((id) => !bodies.has(id));
  if (missing.length) {
    throw new Error(
      `review-proxy: a follow-up carries the body of every finding in dispute; ${missing.join(", ")} ` +
        "had no entry with text in the findings file. The assessor is told not to restate the finding list, so the " +
        "prior assessment cannot supply it.",
    );
  }
  if (!TIER_LENSES[tier]) {
    throw new Error(`review-proxy: tier must be one of ${TIERS.join(", ")}, got ${JSON.stringify(tier)}`);
  }
  if (!Array.isArray(findingIds) || findingIds.length === 0) {
    throw new Error("review-proxy: a follow-up names the finding IDs in dispute; there are none here");
  }
  const lines = [
    readBrief(),
    "",
    "---",
    "",
    identityBlock(source),
    "# A focused follow-up",
    "",
    "This is not a new assessment. Answer the question below directly: what the new evidence establishes, whether",
    "your recommendation changes, and what remains unresolved. **Everything you are not asked about keeps the status",
    "it already has**, including unresolved questions and decisions waiting on David. Do not repeat the assessment.",
    "",
    `- **Reviewed commit:** \`${reviewedCommit}\` — unchanged since your assessment; no new code has been written.`,
    `- **Findings in dispute:** ${findingIds.map((id) => `\`${String(id).trim()}\``).join(", ")}`,
    assessmentFile ? deliveryLine(source, assessmentFile, "answer") : null,
    "",
    ...TIER_LENSES[tier],
    "",
    "## [oracle] The outcome this work is meant to achieve",
    "",
    "The same oracle as your assessment, carried here because this process starts cold.",
    "",
    oracle.trim(),
    "",
    "## The question",
    "",
    question.trim(),
    "",
  ].filter((l) => l !== null);

  lines.push("## [reviewer] The findings in dispute, in full", "");
  for (const id of findingIds.map((i) => String(i).trim())) {
    const f = bodies.get(id);
    lines.push(`### Finding \`${id}\``, "");
    if (f.path) lines.push(`- Location: \`${f.path}\`${f.line == null ? "" : `:${f.line}`}`, "");
    lines.push(String(f.body).trim(), "");
  }

  if (fableReasoning && fableReasoning.trim()) {
    lines.push(`## [${source === "astra" ? "fable" : "astra"}] The other assessor's reasoning`, "", fableReasoning.trim(), "");
  }
  lines.push(`## [${source}] Your earlier assessment of this round, quoted`, "", priorAssessment.trim(), "");
  return lines.join("\n");
}

// THERE IS NO SEPARATE EVIDENCE INPUT, and its absence is the measured answer
// rather than an omission. `newEvidence` existed here from the redesign's first
// commit with no flag ever able to reach it, and three consecutive rounds each
// found a different instance of the same gap: the composer promising what the
// documented command could not deliver.
//
// It was removed rather than wired up, on both assessors' recommendation, after
// the first live follow-up settled the question they disagreed on. Two facts
// decided it. The section rendered every entry through `flatten()`, collapsing a
// quoted multi-line output or diff hunk to one run-on line under a `source`
// label nothing validated -- so it carried evidence WORSE than the question
// does, which inserts `question.trim()` with its structure intact. And the
// builder composes the question anyway: what it quotes is protected by the
// load-bearing-claim rule, not by a flag.
//
// The inputs that remain are the ones where a FILE is what keeps another party's
// whole document out of the builder's hands: the oracle, the finding bodies, the
// prior assessment, the other assessor's reasoning.

/**
 * Read an assessment.
 *
 * ALL THAT IS CHECKED IS THAT SOMETHING SUBSTANTIVE ARRIVED. There is no schema
 * any more, so there is nothing to validate against; prose is judged by reading
 * it. What still matters is that a missing or empty file is reported as a
 * FAILED dispatch in plain words, never as a quiet round -- the lesson from
 * #109, where a failed read rendered as "nothing to report".
 */
export function readAssessment(root, pr, round, opts = {}) {
  const file = assessmentPath(root, pr, round, opts);
  // THE ATTEMPT'S IDENTITY SURVIVES ITS FAILURE. Without `followUp` here, a
  // failed follow-up 2 renders as "no independent assessment exists for this
  // round" -- false, since the round's assessment exists and only the follow-up
  // failed. That is a failure report misnaming what failed, which is the shape
  // this repository's archive treats as the worst available. (Codex, #120
  // round 6; both assessors concurred.)
  const failed = (reason) => ({ pr, round, source: opts.source, followUp: opts.followUp ?? 0, failed: true, reason });
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    return failed(`${opts.source} wrote no assessment file (${err.code === "ENOENT" ? "not found" : err.code})`);
  }
  if (raw.trim() === "") return failed(`${opts.source} wrote an empty assessment file`);
  return { pr, round, source: opts.source, followUp: opts.followUp ?? 0, markdown: raw.trim() };
}

const SOURCE_NAMES = { astra: "Astra", fable: "Fable" };

/**
 * The comment posted on the pull request.
 *
 * THE ASSESSMENT IS PASSED THROUGH VERBATIM. I do not summarise it, reorder it,
 * or drop the part I disagree with; my own view goes in my own comment, beside
 * it. The only thing this adds is the header, and the header is deliberately
 * the metadata the harness already owns -- pull request, revision, which
 * assessment, which findings -- because asking a model to restate facts nobody
 * was missing spends the reader's attention for nothing.
 */
export function prComment(result, { reviewedCommit = null, findingIds = [], requested = null, documentationBase = null } = {}) {
  const who = SOURCE_NAMES[result.source] ?? result.source;
  const what = result.followUp ? `round ${result.round}, follow-up ${result.followUp}` : `round ${result.round}`;
  if (result.failed) {
    return [
      `## ${who} — ${what}: **dispatch failed**`,
      "",
      // SCOPED TO THE ATTEMPT, not to the round. Restoring `followUp` on the
      // result fixes the heading and leaves this sentence lying: a failed
      // follow-up does not mean the round has no assessment -- it has one, and
      // a supplementary question about it failed. (Astra named this as the
      // incomplete-fix trap on the same finding, #120 round 6.)
      result.followUp
        ? `Follow-up ${result.followUp} to ${who} on round ${result.round} produced no answer: ${result.reason}. ` +
          `${who}'s assessment of the round itself is unaffected and still stands.`
        : `No independent assessment from ${who} exists for this round: ${result.reason}.`,
      "",
      "This is a failure of the dispatch, not a report that the round was quiet, and it is not permission to",
      "proceed on one assessment alone.",
    ].join("\n");
  }
  const header = [`## ${who} — ${what}`, ""];
  const facts = [];
  if (reviewedCommit) facts.push(`Assessed at \`${reviewedCommit}\``);
  if (findingIds.length) facts.push(`findings ${findingIds.map((id) => `\`${String(id).trim()}\``).join(", ")}`);
  if (documentationBase) facts.push(`documentation pass over \`${documentationBase}..${reviewedCommit ?? "?"}\``);
  // EVERY FACT LABELLED BY WHAT IT IS, AND "REQUESTED" ONLY WHERE THIS SCRIPT
  // PASSED THE VALUE (David, 2026-09-18: *"any model call must report loudly if
  // the requested model doesn't match the used model"*). The header states what
  // was asked for; the assessor states what it is running as on its own
  // `_Running as:_` line, which sits under the ship gate rather than above it;
  // nothing here claims they match, because this reads a file and cannot
  // interrogate what wrote it, and a control reporting success having evaluated
  // nothing is the worst shape this repository's archive records.
  //
  // THE TWO ASSESSORS ARE REACHED DIFFERENTLY AND ONE WORD USED TO COVER BOTH.
  // Astra is handed a full id and an effort per call (`--model`,
  // `model_reasoning_effort`), so "requested X at Y" is literally true there.
  // A Claude subagent is handed the family ALIAS and no effort at all: the
  // Agent tool's `model` parameter is an enum of four aliases, and there is no
  // effort parameter. So the Fable header carries three separate facts:
  //
  //   - `expected` -- the pin, which is what the self-report is compared
  //     against. Comparing against the family instead would conceal version
  //     drift (Astra).
  //   - `instructed alias` -- the alias the RECIPE SENDS, derived from the pin
  //     the same way `dispatchModel()` derives it. Without it a disagreement
  //     reads as "the platform substituted a model" when a same-family drift
  //     between the pin and the alias is an edit David owns. It is labelled as
  //     an instruction and not as an act because this script never dispatches
  //     the subagent and receives no record of the call: it cannot know
  //     whether the argument was actually passed. It said "the alias the call
  //     actually carried" until #131 round 4 -- the fourth and last label in
  //     this header to name an act it had not performed.
  //   - `definition …` -- what the role's file DECLARES, as read at render
  //     time. Never "applies": definitions are cached, so the file on disk may
  //     not be the one that ran, and the self-report is the only observation.
  //     (Astra raised that in round 1 and it went unanswered in the thread;
  //     the round translation to David flagged the same gap.)
  //
  // Round 1 fixed this class in the effort field and left the model field's
  // label alone, which is why the finding came back one field over. This is
  // the class, not the instance: a fact appears here only when this process
  // established it, and never under a verb describing a mechanism it did not
  // perform. (Codex `4051974429`; both assessors, #131 round 2.)
  if (requested) {
    // NO BARE-STRING SHORTHAND. The two shapes mean different things now --
    // one says this script passed the value, the other says it did not -- and a
    // caller handing over a bare id would silently get whichever this function
    // guessed. Say which.
    const r = requested;
    if (r.id) {
      if (r.effort) {
        facts.push(`requested \`${r.id}\` at \`${r.effort}\``);
      } else {
        const parts = [`expected \`${r.id}\``];
        if (r.alias) parts.push(`instructed alias \`${r.alias}\``);
        // The declared model is shown only when it disagrees with the pin: in
        // the handbook the check holds them equal, and a line repeating itself
        // trains a reader to skip the place the real notice appears.
        if (r.definitionModel && r.definitionModel !== r.id) parts.push(`definition model \`${r.definitionModel}\``);
        // Effort is always shown when it can be read, because the definition is
        // its ONLY source -- there is nothing else to compare it against. An
        // unreadable definition omits it rather than falling back to the pin,
        // which would print a value nobody established.
        if (r.definitionEffort) parts.push(`definition effort \`${r.definitionEffort}\``);
        facts.push(parts.join(" · "));
      }
    }
  }
  if (facts.length) header.push(`*${facts.join(" · ")}*`, "");
  return [...header, result.markdown].join("\n");
}

/**
 * The next action, stated by me.
 *
 * NOTHING PARSES AN ASSESSMENT TO GET HERE. The oracle is explicit that the
 * harness acts on my explicit selection and never on a phrase inferred from an
 * assessment, and that agent agreement does not substitute for David's
 * approval. This renders that selection as a fenced block a reader can find.
 */
export function actionBlock({ action, findingIds = [], note = "" }) {
  if (!ACTIONS.includes(action)) {
    throw new Error(`review-proxy: action must be one of ${ACTIONS.join(", ")}, got ${JSON.stringify(action)}`);
  }
  const lines = ["```review-action", `action: ${action}`];
  if (findingIds.length) lines.push(`findings: ${findingIds.map((id) => String(id).trim()).join(", ")}`);
  if (note.trim()) lines.push(`note: ${flatten(note)}`);
  lines.push("```");
  return lines.join("\n");
}

/**
 * Run Astra. The assessment is read from the file, never from this return
 * value and never from the transcript.
 */
export function dispatch({
  root,
  pr,
  round,
  prompt,
  reviewedCommit,
  followUp = 0,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  run = spawnSyncDefault,
  git = defaultGit,
  io = undefined,
}) {
  assertCheckout(root, reviewedCommit, { git });
  const status = signInStatus({ run });
  if (!status.signedIn) {
    return { ok: false, signIn: true, reason: status.missingBinary ? "no codex binary" : status.detail, instructions: SIGN_IN_INSTRUCTIONS };
  }
  const reviewer = modelTier("strongestCodex", io);
  const outFile = prepareAssessmentPath(root, pr, round, { source: "astra", followUp });
  const outcome = runCodex({
    prompt,
    outFile,
    model: reviewer.id,
    effort: reviewer.effort,
    sandbox: SANDBOX,
    cwd: root,
    timeoutMs,
    run,
  });
  return { ok: outcome.status === 0, reviewer, outFile, ...outcome };
}

export const USAGE = [
  "review-proxy — independent technical advice on one code-review round.",
  "",
  "  Assessment:",
  `    node ${INVOCATION} --pr <n> --round <n> --commit <sha> --tier <t> \\`,
  "        --oracle-file <path> --findings-file <path.json> [--history-file <path.json>] [--note <text>]",
  "",
  "  Documentation pass (the Documentation review class: no reviewer findings, one pass):",
  `    node ${INVOCATION} --pr <n> --round 1 --commit <sha> --tier internal --documentation \\`,
  "        --oracle-file <path> [--history-file <path.json>] [--note <text>]",
  `                  Both assessors read the diff from where --commit left ${DOCUMENTATION_BASE_REF} (derived,`,
  "                  never typed) against the oracle. There is no follow-up in this class and no",
  "                  --findings-file: Codex's output is not part of it.",
  "",
  "  Focused follow-up (same revision, no new commit, no new Codex round):",
  `    node ${INVOCATION} --pr <n> --round <n> --commit <sha> --tier <t> --follow-up <n> \\`,
  "        --question <text> --findings <id,id> --prior-file <path> --oracle-file <path> \\",
  "        --findings-file <path.json> [--fable-file <path>]",
  "                  A follow-up carries the oracle, the tier and the disputed findings' bodies:",
  "                  the process answering it is ephemeral and remembers nothing, so all three are",
  "                  required and every --findings id must have text in --findings-file.",
  "                  --question carries the evidence too, quoted with its origin per the",
  "                  load-bearing-claim rule. There is no evidence flag, deliberately.",
  "",
  `  --tier          one of ${TIERS.join(", ")} — what is downstream, not a threshold`,
  "  --oracle-file   the outcome David agreed BEFORE this loop started. Required; there is no default.",
  "  --findings-file JSON array of { id, body, path?, line? } — this round's findings.",
  "  --history-file  JSON array of { label, text } — labels: " + LABELS.join(", "),
  "  --note          the builder's 'where we are', capped at " + MAX_NOTE_CHARS + " characters.",
  `  --source        ${SOURCES.join(" | ")} (default astra). Selects the identity block and the output path.`,
  "  --prompt-only   print the package and run nothing — how the Fable subagent is given the same words.",
  "  --render        print the PR comment for an assessment already on disk, with no dispatch. This is",
  "                  how the Fable assessment gets posted: the header is derived here rather than typed",
  "                  by whoever is posting. --commit is required (it is the evidence boundary); a",
  "                  follow-up names the findings in --findings, an ordinary round those in",
  "                  --findings-file. Astra's effort is the pin's, because it is passed per call; the",
  "                  Fable assessor's is read from its agent definition, the only route it has, and is",
  "                  omitted rather than guessed if that cannot be read.",
  "",
  `  Astra is pinned to the strongestCodex tier in the ${SANDBOX} sandbox, with no override, and the`,
  "  dispatch refuses unless the checkout is at --commit and clean. The Fable assessment is a subagent",
  "  dispatched by the builder, not by this script; both read the package this script composes, which",
  "  differs only in the identity block — so `--source fable` is only meaningful with `--prompt-only`.",
].join("\n");

const FLAGS = {
  pr: "pr",
  round: "round",
  commit: "commit",
  tier: "tier",
  "oracle-file": "oracleFile",
  "findings-file": "findingsFile",
  "history-file": "historyFile",
  note: "note",
  "follow-up": "followUp",
  question: "question",
  findings: "findings",
  "prior-file": "priorFile",
  "fable-file": "fableFile",
  "prompt-only": "promptOnly",
  render: "render",
  source: "source",
  documentation: "documentation",
};

const NUMERIC = new Set(["pr", "round", "followUp"]);
const BOOLEAN = new Set(["promptOnly", "render", "documentation"]);

/**
 * The finding ids the header names — derived the same way for both paths.
 *
 * THE TWO PATHS DISAGREED, AND THE RENDER PATH WAS THE WRONG ONE. A follow-up
 * addresses the subset named by `--findings`; the dispatch path has always used
 * that, and the render path took every id in `--findings-file` regardless. Given
 * the documented posting command -- which passes the round's findings file --
 * a follow-up's comment claimed to cover findings its assessor never received.
 * The header is exactly the metadata the reader is told to trust, so it is the
 * one place a scope must not be approximated. (Codex `4051922487`, #131 round
 * 1; both assessors concurred and both said to share the derivation rather than
 * patch the render branch.)
 */
export function headerFindingIds({ followUp = 0, findings = "", findingsFile = null, parsed = null }) {
  if (followUp) return String(findings ?? "").split(",").map((t) => t.trim()).filter(Boolean);
  const list = parsed ?? (findingsFile ? JSON.parse(fs.readFileSync(findingsFile, "utf8")) : []);
  // The same shape check the package composition makes. A JSON object here has
  // no `.map`, and "x.map is not a function" is not a sentence that tells an
  // operator their findings file is the wrong shape.
  if (!Array.isArray(list)) {
    throw new Error(`--findings-file must hold a JSON array of { id, ... }, got ${typeof list === "object" ? "an object" : typeof list}`);
  }
  return list.map((f) => f?.id).filter((id) => id != null);
}

export function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) throw new Error(`review-proxy: unexpected argument ${JSON.stringify(arg)}`);
    const key = FLAGS[arg.slice(2)];
    if (!key) throw new Error(`review-proxy: unknown flag ${arg}`);
    if (BOOLEAN.has(key)) {
      flags[key] = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`review-proxy: ${arg} needs a value`);
    flags[key] = NUMERIC.has(key) ? Number(value) : value;
    i += 1;
  }
  return flags;
}

export function main(
  argv = process.argv.slice(2),
  { root = process.cwd(), run = spawnSyncDefault, git = defaultGit, log = console.error, io = undefined } = {},
) {
  let flags;
  try {
    flags = parseArgs(argv);
  } catch (err) {
    log(`${err.message}\n\n${USAGE}`);
    return 2;
  }
  const followUp = flags.followUp ?? 0;
  // A NON-EMPTY REVIEWED COMMIT, ONCE, BEFORE ANY PATH PRODUCES ANYTHING.
  //
  // Three things made this one check rather than two. The render path accepted
  // its absence and emitted a plausible comment with no `Assessed at` line --
  // losing the evidence boundary that says which revision the advice is about,
  // on the durable record of a squash-merged pull request. The dispatch path
  // "refused" a missing commit only by way of `reviewedCommit.trim()` throwing
  // a TypeError inside `assertCheckout`, surfaced to an operator as a raw
  // runtime message. And `--commit ""` parses as an empty string -- `parseArgs`
  // only rejects a value that looks like another flag -- so presence was never
  // the right test. (Codex `4051922490`; the empty-string and TypeError halves
  // were named by both assessors reading past the finding, #131 round 1.)
  //
  // RENDER STILL DOES NOT CALL `assertCheckout`. An assessment may legitimately
  // be rendered after the tree has moved on; what the header must carry is the
  // revision the assessor READ, which is this flag, not HEAD.
  if (typeof flags.commit !== "string" || flags.commit.trim() === "") {
    log(`review-proxy: --commit <reviewed sha> is required — it is the revision the assessment is of, and the header carries it as the evidence boundary\n\n${USAGE}`);
    return 2;
  }
  // THE SOURCE PICKS BOTH THE IDENTITY BLOCK AND THE OUTPUT PATH, and it has to
  // pick both or neither: a Fable package naming Astra's file would have the
  // subagent overwrite the answer this script is about to read. Only `--source
  // fable --prompt-only` is meaningful, because this script runs the Codex CLI
  // and nothing else -- the subagent is dispatched by the harness.
  const source = flags.source ?? "astra";
  // THE DOCUMENTATION CLASS, CHECKED ONCE FOR EVERY PATH. It has no
  // follow-up: the class is one pass and one batch (David, 2026-09-25), so a
  // follow-up flag here is a caller running the code-review loop by mistake.
  // Its base is derived here, once, for compose and render alike.
  const documentation = Boolean(flags.documentation);
  if (documentation && followUp) {
    log(`review-proxy: the Documentation class is one pass and one batch; it has no follow-up\n\n${USAGE}`);
    return 2;
  }
  let documentationBase = null;
  if (documentation) {
    try {
      documentationBase = documentationBaseFor(root, flags.commit, { git });
    } catch (err) {
      log(err.message);
      return 2;
    }
  }
  // RENDERING IS NOT DISPATCHING, so it is answered before every guard that
  // belongs to composing a package: it needs no oracle, no findings and no
  // tier, because the assessment it renders already exists.
  //
  // IT EXISTS SO THE HEADER IS NOT TYPED BY HAND. The Fable assessment is
  // written by a subagent this script does not run, so posting it used to mean
  // an improvised node call -- and the facts worth the most there, which model
  // was asked for and at what effort it actually ran, were the ones most easily
  // left off. That is the same failure class as the dispatch argument this whole
  // change is about: a step that has to be remembered is a step that gets
  // skipped, measured seven rounds running on #124. Deriving them here makes
  // them arrive with the comment instead of with somebody's memory.
  if (flags.render) {
    if (flags.promptOnly) {
      log(`review-proxy: --render prints a comment for an assessment on disk and --prompt-only prints a package to dispatch; they are different jobs\n\n${USAGE}`);
      return 2;
    }
    let rendered;
    let failed = false;
    try {
      const read = readAssessment(root, flags.pr, flags.round, { source, followUp });
      failed = Boolean(read.failed);
      // EACH ASSESSOR AGAINST ITS OWN TIER. Astra is `strongestCodex` and the
      // Fable assessor is `strongestClaude`; rendering one against the other's
      // pin would put a confident wrong model in the header.
      const pin = modelTier(source === "astra" ? "strongestCodex" : "strongestClaude", io);
      // AND EACH AGAINST ITS OWN ROUTE FOR EFFORT. Astra is handed its effort
      // per call, so the pin IS the request. A Claude subagent is handed none,
      // so the value that applies is the role definition's -- read from
      // `.claude/agents/<role>.md`, one path that resolves in both layouts
      // because the handbook links that directory per file into `core/`. Null
      // when it cannot be read, and never the pin instead: see `prComment`.
      const requested =
        source === "astra"
          ? { id: pin.id, effort: pin.effort }
          : {
              id: pin.id,
              alias: claudeAlias(pin.id),
              definitionModel: agentFrontmatter(root, ASSESSOR_AGENT, "model"),
              definitionEffort: agentFrontmatter(root, ASSESSOR_AGENT, "effort"),
            };
      const ids = documentation ? [] : headerFindingIds({ followUp, findings: flags.findings, findingsFile: flags.findingsFile });
      // AN EMPTY SCOPE IS REFUSED, NOT PRINTED. Round 1 gave both paths one
      // derivation and stopped there; the input that derivation needs never
      // reached the operator-facing recipe, so a follow-up posted exactly as
      // documented produced a header naming no findings at all -- the same
      // asymmetry as `--commit`, where the render path accepted less than the
      // dispatch path requires. Every round dispatched here has at least one
      // finding (`assessmentBrief` refuses otherwise), so an empty list is
      // always a missing flag and never a quiet round. Uniform on the
      // failed-dispatch shape too: the operator composed the package from the
      // same file minutes earlier. (Codex `4051974432`; both assessors said to
      // put the refusal in the script rather than only in the recipe.)
      if (ids.length === 0 && !documentation) {
        const flag = followUp ? "--findings <id,id>" : "--findings-file <path.json>";
        log(`review-proxy: ${flag} is required to render ${followUp ? "a follow-up" : "a round"} — the header names the findings the assessment covers, and a comment claiming no scope is worse than one that was not posted\n\n${USAGE}`);
        return 2;
      }
      rendered = prComment(read, { reviewedCommit: flags.commit, findingIds: ids, requested, documentationBase });
    } catch (err) {
      log(`review-proxy: ${err.message}`);
      return 2;
    }
    process.stdout.write(`${rendered}\n`);
    // A MISSING OR EMPTY ASSESSMENT EXITS NON-ZERO, the same as a failed
    // dispatch does. The comment already says so in words, but a render whose
    // process succeeds is the shape a script or a habit reads as "posted fine".
    return failed ? 1 : 0;
  }
  if (source !== "astra" && !flags.promptOnly) {
    log(`review-proxy: --source ${source} composes a package for an assessor this script does not run; use --prompt-only to compose it or --render to post its answer\n\n${USAGE}`);
    return 2;
  }
  let prompt;
  // THE IDS ARE KEPT, NOT RE-DERIVED. They are parsed here to compose the
  // package and used again to stamp the rendered comment's header, so a reader
  // can see which findings the prose covers -- which matters most exactly when
  // there are several assessments and follow-ups on one pull request. They used
  // to be parsed and dropped one block later. (Codex, #120 round 3.)
  let findingIds = [];
  try {
    const file = assessmentPath(root, flags.pr, flags.round, { source, followUp });
    if (followUp) {
      findingIds = headerFindingIds({ followUp, findings: flags.findings });
      prompt = followUpBrief({
        source,
        pr: flags.pr,
        round: flags.round,
        tier: flags.tier,
        reviewedCommit: flags.commit,
        oracle: fs.readFileSync(flags.oracleFile, "utf8"),
        findings: flags.findingsFile ? JSON.parse(fs.readFileSync(flags.findingsFile, "utf8")) : [],
        findingIds,
        question: flags.question,
        fableReasoning: flags.fableFile ? fs.readFileSync(flags.fableFile, "utf8") : "",
        priorAssessment: fs.readFileSync(flags.priorFile, "utf8"),
        assessmentFile: file,
      });
    } else if (documentation) {
      if (flags.findingsFile) {
        throw new Error("review-proxy: a documentation pass reads the change itself; Codex's output is not part of this class -- drop --findings-file");
      }
      prompt = assessmentBrief({
        source,
        pr: flags.pr,
        round: flags.round,
        tier: flags.tier,
        reviewedCommit: flags.commit,
        oracle: fs.readFileSync(flags.oracleFile, "utf8"),
        history: flags.historyFile ? JSON.parse(fs.readFileSync(flags.historyFile, "utf8")) : [],
        builderNote: flags.note ?? "",
        assessmentFile: file,
        documentationBase,
      });
    } else {
      const findings = JSON.parse(fs.readFileSync(flags.findingsFile, "utf8"));
      findingIds = headerFindingIds({ followUp, parsed: findings });
      prompt = assessmentBrief({
        source,
        pr: flags.pr,
        round: flags.round,
        tier: flags.tier,
        reviewedCommit: flags.commit,
        oracle: fs.readFileSync(flags.oracleFile, "utf8"),
        findings,
        history: flags.historyFile ? JSON.parse(fs.readFileSync(flags.historyFile, "utf8")) : [],
        builderNote: flags.note ?? "",
        assessmentFile: file,
      });
    }
  } catch (err) {
    log(`${err.message}\n\n${USAGE}`);
    return 2;
  }
  // `--prompt-only` writes the package the Fable assessor gets, so both
  // assessors demonstrably receive the same words rather than two compositions
  // that happen to look alike.
  //
  // IT DOES THE SAME TWO THINGS `dispatch` DOES BEFORE STARTING A REVIEWER, and
  // for the same reasons. The branch used to do neither, because it "only
  // prints", which reads as harmless and is not:
  //
  //   - It CLEARS the destination. Otherwise a retried Fable dispatch whose
  //     subagent dies before writing leaves the previous attempt's file in
  //     place, and `readAssessment` accepts any non-empty file there. The worst
  //     instance is not a retry of the same package but a re-dispatch with a
  //     CORRECTED one -- a missed finding, a wrong oracle -- after which the
  //     stale file is posted under a header naming the right round and commit,
  //     with nothing to give it away. (Codex #120 round 4; both assessors
  //     concurred, and the Astra path has carried this since round 2.)
  //   - It VERIFIES THE CHECKOUT. The package it prints tells its reader the
  //     tree "is at this commit and is clean; the dispatch refuses otherwise".
  //     Emitting that sentence without checking is the one shape this
  //     repository's archive names as the worst available failure: a control
  //     reporting success having evaluated nothing. In the ordinary flow
  //     Astra's own refusal covers both, but a Fable-only re-dispatch never
  //     reaches it. (Codex #120 round 3.)
  if (flags.promptOnly) {
    // Reported in plain words and exit 2, the way every other refusal in this
    // CLI is. A raw stack trace here would be the operator's first sight of a
    // guard that is working correctly.
    try {
      assertCheckout(root, flags.commit, { git });
      prepareAssessmentPath(root, flags.pr, flags.round, { source, followUp });
    } catch (err) {
      log(`review-proxy: ${err.message}`);
      return 2;
    }
    process.stdout.write(`${prompt}\n`);
    return 0;
  }
  let result;
  try {
    result = dispatch({ root, pr: flags.pr, round: flags.round, prompt, reviewedCommit: flags.commit, followUp, run, git, io });
  } catch (err) {
    log(`review-proxy: ${err.message}`);
    return 2;
  }
  if (result.signIn) {
    log(`review-proxy: ${result.instructions}`);
    return 2;
  }
  log(`review-proxy: ${followUp ? `follow-up ${followUp} on ` : ""}round ${flags.round} on ${result.reviewer.id} (${result.reviewer.effort}, ${SANDBOX}) — ${result.seconds}s`);
  // A FAILED PROCESS IS NEVER AN ACCEPTED ASSESSMENT, even when a file is
  // sitting there: `codex exec` can write its last message and then exit
  // non-zero. (Codex, #120 round 1.)
  const read = result.ok
    ? readAssessment(root, flags.pr, flags.round, { source: "astra", followUp })
    : {
        pr: flags.pr,
        round: flags.round,
        source: "astra",
        // THE SECOND OF THE TWO FAILURE PATHS. `readAssessment`'s own failure
        // result carries `followUp` for the reason stated there; this literal
        // is the other one the finding named, and it was left behind while the
        // first was fixed and the fix was announced as covering both. The test
        // written for it drove the helpers directly and never `main()` with a
        // failing process, so it was shaped to the fix rather than to the
        // finding. (Codex #120 round 7; the round-6 assessment had named this
        // line, and the round-6 finding body had said "both failure paths".)
        followUp,
        failed: true,
        reason: `the reviewer process exited ${result.status ?? "(no status)"}${result.signal ? ` on signal ${result.signal}` : ""}`,
      };
  process.stdout.write(
    `${prComment(read, { reviewedCommit: flags.commit, findingIds, requested: result.reviewer, documentationBase })}\n`,
  );
  return read.failed ? 1 : 0;
}

// `pathToFileURL`, never a hand-built `file://` string: the two differ whenever
// the checkout path needs escaping, and a script that never runs exits 0.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}

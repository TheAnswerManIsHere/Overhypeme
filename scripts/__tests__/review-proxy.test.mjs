// SYNCED FROM AI-Handbook — do not edit in a consumer repo.
/**
 * The review proxy's tests, rewritten for the advisory model (#96, 2026-09-17).
 *
 * WHAT THE OLD SUITE TESTED AND WHY IT IS GONE. It asserted that a JSON answer
 * could not be internally incoherent -- a decline carrying a fix, a "finish"
 * leaving a question unanswered, an outcome contradicting its dispositions.
 * Those tests were correct about the design they guarded, and the design is
 * replaced: nothing is binding, nothing is parsed, and the assessment is prose.
 * Three consecutive rounds each found a new way for that JSON to contradict
 * itself, which is what a validator built by enumerating forbidden combinations
 * does. Removing the field removed the class.
 *
 * WHAT THIS SUITE TESTS INSTEAD. The properties the oracle actually names: both
 * assessors get the same package; the instructions David reviewed are the ones
 * that run; the assessment reaches him unedited; the dispatch refuses to assess
 * a revision the checkout is not at; a follow-up costs no commit and no review
 * round; and nothing an assessor writes can authorise work.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ROLE,
  SANDBOX,
  TIERS,
  ACTIONS,
  SOURCES,
  MAX_NOTE_CHARS,
  briefPath,
  judgmentPath,
  assessmentPath,
  prepareAssessmentPath,
  assertCheckout,
  identityBlock,
  INVOCATION,
  assessmentBrief,
  followUpBrief,
  readAssessment,
  prComment,
  actionBlock,
  dispatch,
  parseArgs,
  main,
  USAGE,
} from "../review-proxy.mjs";

const PR = 120;
const COMMIT = "f1c89d2";
const FULL = "f1c89d2ba3e1487457c8c30f9a8b6c66814845f2";
const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), "proxy-"));

const finding = (over = {}) => ({ id: "c1", body: "The flag could be mistyped.", path: "a.mjs", line: 3, ...over });

const brief = (over = {}) =>
  assessmentBrief({
    pr: PR,
    round: 1,
    tier: "internal",
    reviewedCommit: COMMIT,
    oracle: "ORACLE-TEXT: judgement, by more than one mind, that David can follow.",
    findings: [finding()],
    ...over,
  });

const followUp = (over = {}) =>
  followUpBrief({
    pr: PR,
    round: 1,
    tier: "internal",
    reviewedCommit: COMMIT,
    oracle: "ORACLE-TEXT: judgement, by more than one mind, that David can follow.",
    findings: [finding()],
    findingIds: ["c1"],
    question: "Does the scope of the correction change given the new evidence?",
    priorAssessment: "PRIOR-ASSESSMENT-TEXT",
    ...over,
  });

/** A git that reports a clean checkout at the commit under assessment. */
const cleanGit = (head = FULL) => (args) => {
  if (args[0] === "rev-parse") return { status: 0, stdout: `${head}\n`, stderr: "" };
  if (args[0] === "status") return { status: 0, stdout: "", stderr: "" };
  throw new Error(`unexpected git ${args.join(" ")}`);
};

// ---------------------------------------------------------------------------
// The package both assessors receive
// ---------------------------------------------------------------------------

test("the brief and the Worth rule reach the model verbatim from their files", () => {
  // David's first named requirement is the prompt itself: he reads it, not a
  // description of it. A brief assembled in the script would make the file he
  // reviewed a document ABOUT the real instruction rather than it.
  const text = brief();
  assert.ok(text.startsWith(fs.readFileSync(briefPath(), "utf8").trim()));
  const judgment = fs.readFileSync(judgmentPath(), "utf8").replace(/^<!--[\s\S]*?-->\s*/, "").trim();
  assert.ok(text.includes(judgment), "the Worth rule is not quoted verbatim");
  // And it is quoted from the ONE file, so the rule cannot drift between the
  // two assessors and the contracts that point at it.
  assert.ok(judgmentPath().endsWith(path.join("docs", "ai-context", "review-judgment.md")));
});

test("the package carries no quota in either direction", () => {
  // The whole redesign: the old rubric told the assessor to decline most
  // findings, which is the mirror image of the builder fixing everything.
  const text = brief();
  assert.doesNotMatch(text, /expect most of this round to be declines/i);
  assert.doesNotMatch(text, /very high chance of a CRITICAL flaw/i);
  // The phrase wraps across lines in both source files, so the assertion has
  // to tolerate a newline where a reader sees a space.
  assert.match(text, /no\s+target\s+acceptance\s+rate\s+or\s+decline\s+rate/i);
  assert.match(text, /no\s+target\s+rate\s+of\s+accepting\s+or\s+declining/i);
});

test("an oracle is required, because it is agreed before the loop starts and never taken from the PR", () => {
  for (const bad of [undefined, "", "   "]) {
    assert.throws(() => brief({ oracle: bad }), /oracle is required and must be agreed with David/);
  }
  assert.match(brief(), /ORACLE-TEXT/);
  assert.match(brief(), /\[oracle\] The outcome this work is meant to achieve/);
});

test("the tier tells the assessor what is downstream, and never sets a threshold", () => {
  // `plan-review.mjs` paid for the first half on #102 round 1: a tier that is
  // validated, pinned and logged while never reaching the assessor selects
  // nothing. The second half is this redesign: it is a lens, not a rubric.
  const seen = new Set();
  for (const tier of TIERS) {
    const text = brief({ tier });
    assert.match(text, /\*\*What is downstream/);
    seen.add(text);
  }
  assert.equal(seen.size, TIERS.length, "two tiers produced identical packages");
  assert.throws(() => brief({ tier: "trivial" }), /tier must be one of/);
  assert.match(brief({ tier: "sensitive" }), /This does not make every finding in these areas worthwhile/);
});

test("a GitHub comment id is a number, and the composer takes it as one", () => {
  // `get_review_comments` returns integer ids and JSON keeps them integers.
  // (Codex, #120 round 1.)
  assert.match(brief({ findings: [finding({ id: 4033623440 })] }), /### Finding `4033623440`/);
  assert.throws(() => brief({ findings: [finding({ id: 7 }), finding({ id: "7" })] }), /appears twice/);
  for (const bad of [null, undefined, "", "  "]) {
    assert.throws(() => brief({ findings: [finding({ id: bad })] }), /stable id/);
  }
});

test("the assessors are dispatched on a round that returned findings", () => {
  assert.throws(() => brief({ findings: [] }), /RETURNED findings/);
});

test("history is labelled by who said it, including both assessors", () => {
  const text = brief({
    history: [
      { label: "David", text: "Astra advises; Fable can settle a technical tie." },
      { label: "astra", text: "Recommended a narrower correction in round 1." },
    ],
  });
  assert.match(text, /\*\*\[David\]\*\* Astra advises/);
  assert.match(text, /\*\*\[astra\]\*\* Recommended a narrower correction/);
  assert.throws(() => brief({ history: [{ label: "codex", text: "x" }] }), /carries a label from/);
});

test("the builder's note is capped, so the assessed party's framing cannot fill the package", () => {
  const long = "x".repeat(MAX_NOTE_CHARS * 2);
  assert.ok(!brief({ builderNote: long }).includes(long));
  assert.match(brief({ builderNote: long }), /x{10}…/);
  assert.match(brief(), /\(the builder supplied no note\)/);
});

test("both assessors get the same brief, Worth rule and round, differing only in who they are", () => {
  // Independence is only meaningful over a common factual basis. A difference
  // between the two answers has to be a difference of judgement, so everything
  // except the identity block is byte-identical -- and that block exists
  // because the brief cannot both stay generic and tell each reader which of
  // them holds the tie-break.
  const args = { tier: "product", history: [{ label: "oracle", text: "Ship the thing." }], builderNote: "Round 1." };
  const astra = brief({ ...args, source: "astra" });
  const fable = brief({ ...args, source: "fable" });
  assert.notEqual(astra, fable, "the two packages are identical, so neither reader is told which role it holds");
  assert.equal(
    astra.replace(identityBlock("astra"), ""),
    fable.replace(identityBlock("fable"), ""),
    "the packages differ somewhere other than the identity block",
  );
  assert.equal(brief({ ...args, source: "astra" }), astra, "the same source composed twice differs");
  // Default to Astra: the Codex CLI path is the one the script runs itself.
  assert.equal(brief(args), astra);
});

test("each assessor is told who it is, who the other is, and which of them settles a technical tie", () => {
  // The defect this replaces: Astra's brief went to the Fable subagent
  // unchanged, so it read that it discussed with Fable and that Fable settled
  // ties -- a role talking to itself about a third party that is also itself.
  const astra = identityBlock("astra");
  assert.match(astra, /\*\*You are Astra\*\*/);
  assert.match(astra, /\*\*The other assessor is the Fable assessor\*\*/);
  assert.match(astra, /\*\*The tie-break is the Fable assessor's\*\*, not yours/);

  const fable = identityBlock("fable");
  assert.match(fable, /\*\*You are the Fable assessor\*\*/);
  assert.match(fable, /\*\*The other assessor is Astra\*\*/);
  assert.match(fable, /\*\*The tie-break is yours\*\*/);

  for (const block of [astra, fable]) {
    assert.match(block, /Neither of you sees the other's assessment/);
    assert.match(block, /Neither of you can settle anything reserved for David/);
  }
  assert.throws(() => identityBlock("codex"), /source must be one of/);
});

test("the brief itself names no role, so one file serves both readers", () => {
  // The brief says "the other assessor" throughout. A role name left in it
  // would be wrong for exactly one of the two, silently.
  const text = fs.readFileSync(briefPath(), "utf8");
  assert.doesNotMatch(text, /Astra|Fable/, "the shared brief names a specific assessor");
  assert.match(brief({ source: "fable" }), /the other\nassessor|the other assessor/);
});

test("a follow-up names the other assessor correctly for whoever is reading it", () => {
  assert.match(followUp({ source: "astra", fableReasoning: "X" }), /\[fable\] The other assessor's reasoning/);
  assert.match(followUp({ source: "fable", fableReasoning: "X" }), /\[astra\] The other assessor's reasoning/);
  assert.ok(followUp({ source: "fable" }).includes(identityBlock("fable")));
});

// ---------------------------------------------------------------------------
// Assessing the revision that was actually reviewed
// ---------------------------------------------------------------------------

test("the dispatch refuses unless the checkout is at the reviewed commit and clean", () => {
  // Both assessors read the live tree while the package names a commit. Until
  // this existed, a delayed webhook or an earlier push meant advice about code
  // the reviewer never saw, with the requested revision named back as though it
  // had been read. (Codex, #120 round 2.)
  const root = tmpRoot();
  assert.equal(assertCheckout(root, COMMIT, { git: cleanGit() }), FULL);
  assert.equal(assertCheckout(root, FULL, { git: cleanGit() }), FULL, "a full sha matches itself");

  assert.throws(
    () => assertCheckout(root, "deadbee", { git: cleanGit() }),
    /the checkout is at f1c89d2ba3 but this assessment is of deadbee/,
  );
  const dirty = (args) =>
    args[0] === "rev-parse" ? { status: 0, stdout: `${FULL}\n` } : { status: 0, stdout: " M core/scripts/review-proxy.mjs\n" };
  assert.throws(() => assertCheckout(root, COMMIT, { git: dirty }), /uncommitted changes/);
  const broken = () => ({ status: 128, stdout: "", stderr: "not a git repository" });
  assert.throws(() => assertCheckout(root, COMMIT, { git: broken }), /cannot read HEAD/);
});

test("a reference too short to identify a commit is refused, not prefix-matched", () => {
  // The shorter side decides, which is what lets a 7-character marker match a
  // 40-character HEAD. With no floor under it, `--commit f` matched every HEAD
  // beginning with `f` and the guard approved a checkout it had not checked.
  // (Codex, #120 round 8, deferred to #122.)
  const root = tmpRoot();
  for (const tooShort of ["f", "f1", "f1c89d"]) {
    assert.throws(() => assertCheckout(root, tooShort, { git: cleanGit() }), /too short to identify a commit/);
  }
  // The floor is git's own abbreviation minimum, so every length a caller
  // legitimately has still passes: 7 here, the marker's 10, and the full sha.
  assert.equal(assertCheckout(root, "f1c89d2", { git: cleanGit() }), FULL);
  assert.equal(assertCheckout(root, "f1c89d2ba3", { git: cleanGit() }), FULL);
  assert.equal(assertCheckout(root, FULL, { git: cleanGit() }), FULL);
  // Longer than a sha needs no floor and does not get one: `n` is 40, so the
  // whole of HEAD has to match, and a full sha with trailing garbage passes
  // only when the checkout genuinely IS that commit. Both assessors probed
  // this separately on #120 round 8 and agreed it is harmless.
  assert.equal(assertCheckout(root, `${FULL}garbage`, { git: cleanGit() }), FULL);
  assert.throws(() => assertCheckout(root, `${"0".repeat(40)}x`, { git: cleanGit() }), /this assessment is of/);
});

test("a refused checkout stops the dispatch before the reviewer is ever started", () => {
  const calls = [];
  const run = (bin, args) => {
    calls.push(args[0]);
    return { status: 0, stdout: "Logged in using ChatGPT" };
  };
  assert.throws(
    () => dispatch({ root: tmpRoot(), pr: PR, round: 1, prompt: "x", reviewedCommit: "deadbee", run, git: cleanGit() }),
    /this assessment is of deadbee/,
  );
  assert.deepEqual(calls, [], "the reviewer was started for a revision the checkout is not at");
});

// ---------------------------------------------------------------------------
// The focused follow-up
// ---------------------------------------------------------------------------

test("a follow-up runs on the same revision, with no new commit and no new review round", () => {
  // The property the design turns on: a disagreement about reasoning costs one
  // question, not a round trip through the whole loop.
  const text = followUp();
  assert.match(text, /no new code has been written/);
  assert.match(text, /Reviewed commit:\*\* `f1c89d2`/);
  assert.match(text, /This is not a new assessment/);
  assert.ok(text.includes("PRIOR-ASSESSMENT-TEXT"), "the earlier assessment is quoted, so nothing must be remembered");
});

test("a follow-up preserves everything it does not ask about", () => {
  // A narrow follow-up that silently cleared an unresolved question would be
  // worse than no follow-up, because it would look like agreement.
  assert.match(followUp(), /Everything you are not asked about keeps the status\nit already has/);
  assert.match(followUp(), /decisions waiting on David/);
});

test("a follow-up names the dispute, and refuses to be composed without one", () => {
  assert.match(followUp(), /Findings in dispute:\*\* `c1`/);
  assert.match(followUp({ fableReasoning: "FABLE-SAYS" }), /\[fable\] The other assessor's reasoning/);
  for (const bad of [{ question: "" }, { priorAssessment: "  " }]) {
    assert.throws(() => followUp(bad), /a follow-up needs/);
  }
  assert.throws(() => followUp({ findingIds: [] }), /names the finding IDs in dispute/);
});

test("a follow-up carries the same brief and Worth rule as the assessment it revisits", () => {
  assert.ok(followUp().startsWith(fs.readFileSync(briefPath(), "utf8").trim()));
});

test("a follow-up refuses unless every disputed finding has text behind its id", () => {
  // The round-4 commit CLAIMED this guarantee and enforced only the oracle half,
  // so the advertised command composed a package naming ids with no bodies. The
  // assessor would revise a recommendation about a finding it had never read,
  // and the posted answer would look like any other. (Codex, #120 round 5.)
  assert.throws(() => followUp({ findings: [] }), /c1 had no entry with text/);
  assert.throws(() => followUp({ findings: undefined }), /c1 had no entry with text/);
  assert.throws(
    () => followUp({ findings: [finding({ id: "other" })] }),
    /carries the body of every finding in dispute; c1/,
  );
  // Present but empty is the same defect wearing a hat.
  assert.throws(() => followUp({ findings: [finding({ body: "   " })] }), /c1 had no entry with text/);
  // Two disputed, one supplied: the error names the one that is missing.
  assert.throws(
    () => followUp({ findingIds: ["c1", "c2"], findings: [finding()] }),
    /dispute; c2 had no entry/,
  );
  // And the CLI cannot route around the composer.
  assert.doesNotMatch(USAGE, /\[--findings-file/, "the follow-up still advertises the flag as optional");
});

test("the invocation in the usage text is computed, so it is right in both layouts", () => {
  // The sync routes `core/X -> X`, so a literal path is wrong in one of the two
  // repos — and it prints on every argument error, telling an operator who just
  // mistyped a flag to run a file that is not there. (Codex, #120 round 5.)
  // The property is that the path is DERIVED, not that it has a given value:
  // in this repo the correct derived value happens to be `core/scripts/...`,
  // and in a consumer it is `scripts/...`. Asserting either literal would be
  // the defect under test.
  assert.ok(INVOCATION.endsWith("scripts/review-proxy.mjs"), INVOCATION);
  assert.ok(!path.isAbsolute(INVOCATION), "the invocation must be repo-relative");
  assert.ok(USAGE.includes(`node ${INVOCATION} --pr`), "the usage text does not use the computed invocation");
  assert.ok(USAGE.includes(`node ${INVOCATION} --pr <n> --round <n> --commit <sha> --tier <t> --follow-up`));
});

test("a follow-up carries the oracle, the tier and the disputed findings, because the process is ephemeral", () => {
  // `codex exec --ephemeral` starts cold, and the prior assessment cannot stand
  // in for the package: the brief tells its author NOT to restate the revision
  // or the finding list, so the one document quoted back is the one guaranteed
  // to omit them. Without this a follow-up revises a recommendation against no
  // agreed intent. (Codex, #120 round 3.)
  const text = followUp();
  assert.match(text, /ORACLE-TEXT/);
  assert.match(text, /\*\*What is downstream/, "the tier lens is missing");
  assert.match(text, /### Finding `c1`/);
  assert.ok(text.includes("The flag could be mistyped."), "the disputed finding's body is missing");

  for (const bad of [undefined, "", "   "]) {
    assert.throws(() => followUp({ oracle: bad }), /carries the same oracle as the assessment/);
  }
  assert.throws(() => followUp({ tier: "trivial" }), /tier must be one of/);

  // Only the findings in dispute, so a follow-up stays focused.
  const two = followUp({ findings: [finding(), finding({ id: "c2", body: "A SECOND FINDING BODY" })] });
  assert.doesNotMatch(two, /A SECOND FINDING BODY/, "a finding not in dispute was carried in");
});

test("--prompt-only clears the destination and verifies the checkout, exactly as a dispatch does", () => {
  // The branch "only prints", which reads as harmless and is not. It emits a
  // package telling its reader the tree is at the reviewed commit and clean,
  // and it names a file a subagent will write. Clearing nothing lets a retried
  // dispatch post its predecessor's assessment under the new header; checking
  // nothing makes the package's own sentence a claim of success by something
  // that evaluated nothing. (Codex, #120 rounds 3 and 4.)
  const root = tmpRoot();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-in-"));
  const write = (name, value) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
    return file;
  };
  const argv = (...extra) => [
    "--pr", String(PR), "--round", "1", "--commit", COMMIT, "--tier", "internal",
    "--source", "fable", "--prompt-only",
    "--oracle-file", write("o.md", "ORACLE-FROM-FILE"),
    "--findings-file", write("f.json", [{ id: "c1", body: "b" }]),
    ...extra,
  ];
  const stale = prepareAssessmentPath(root, PR, 1, { source: "fable" });
  fs.writeFileSync(stale, "A PREVIOUS ATTEMPT'S ASSESSMENT");
  assert.equal(readAssessment(root, PR, 1, { source: "fable" }).markdown, "A PREVIOUS ATTEMPT'S ASSESSMENT");

  const stdout = process.stdout.write;
  process.stdout.write = () => true;
  try {
    assert.equal(main(argv(), { root, run: () => ({ status: 0 }), git: cleanGit(), log: () => {} }), 0);
  } finally {
    process.stdout.write = stdout;
  }
  // The retry's subagent dies before writing: the read must report a failure,
  // never the predecessor.
  const after = readAssessment(root, PR, 1, { source: "fable" });
  assert.equal(after.failed, true, "a stale assessment survived and would be posted as fresh");
  assert.match(after.reason, /wrote no assessment file/);

  // And the checkout is verified before the package is emitted.
  let logged = "";
  assert.equal(
    main(argv(), { root, run: () => ({ status: 0 }), git: cleanGit("0000000000abcdef"), log: (m) => (logged += m) }),
    2,
  );
  assert.match(logged, /the checkout is at 0000000000 but this assessment is of f1c89d2/);
});

// ---------------------------------------------------------------------------
// Reading, presenting, and who authorises what
// ---------------------------------------------------------------------------

test("each assessment has its own path, keyed by source and follow-up", () => {
  assert.ok(assessmentPath("/r", PR, 2, { source: "astra" }).endsWith(path.join("pr-120", "round-2.astra.md")));
  assert.ok(assessmentPath("/r", PR, 2, { source: "fable" }).endsWith(path.join("pr-120", "round-2.fable.md")));
  assert.ok(assessmentPath("/r", PR, 2, { source: "astra", followUp: 1 }).endsWith("round-2.astra.followup-1.md"));
  assert.throws(() => assessmentPath("/r", PR, 2, { source: "codex" }), /source must be one of/);
  for (const bad of ["12x", 0, -1, 1.5, null]) {
    assert.throws(() => assessmentPath("/r", bad, 1, { source: "astra" }), /pr must be a positive integer/);
    assert.throws(() => assessmentPath("/r", PR, bad, { source: "astra" }), /round must be a positive integer/);
  }
});

test("a missing or empty assessment is a failed dispatch in plain words, never a quiet round", () => {
  const root = tmpRoot();
  const missing = readAssessment(root, PR, 7, { source: "astra" });
  assert.equal(missing.failed, true);
  assert.match(missing.reason, /wrote no assessment file/);

  fs.writeFileSync(prepareAssessmentPath(root, PR, 8, { source: "fable" }), "   \n");
  const empty = readAssessment(root, PR, 8, { source: "fable" });
  assert.match(empty.reason, /wrote an empty assessment file/);

  for (const r of [missing, empty]) {
    const text = prComment(r);
    assert.match(text, /dispatch failed/);
    assert.match(text, /not a report that the round was quiet/);
    assert.match(text, /not permission to\nproceed on one assessment alone/);
  }
});

test("the assessment reaches the pull request verbatim, under a header of facts the harness already owns", () => {
  const root = tmpRoot();
  const markdown = "## David's readout\n\nThe correction is worth making, narrowly.\n\n### c1\n\nRecommend correcting it.";
  fs.writeFileSync(prepareAssessmentPath(root, PR, 1, { source: "astra" }), markdown);
  const result = readAssessment(root, PR, 1, { source: "astra" });
  const text = prComment(result, {
    reviewedCommit: COMMIT,
    findingIds: [4033623440],
    requested: { id: "gpt-6-astra", effort: "xhigh" },
  });

  assert.ok(text.includes(markdown), "the assessment was not passed through verbatim");
  assert.match(text, /## Astra — round 1/);
  // REQUESTED, and both halves of it. The header says what was asked for and
  // never what answered -- this script reads a file and cannot interrogate
  // what wrote it, so a claimed match would be a control reporting success
  // having evaluated nothing. Effort is half of "strongest" and until #126 a
  // subagent silently ran at the session's. (#126, David 2026-09-18.)
  assert.match(text, /Assessed at `f1c89d2` · findings `4033623440` · requested `gpt-6-astra` at `xhigh`/);
  assert.doesNotMatch(text, /undefined/);
});

test("the header never claims the requested model is the one that answered", () => {
  const root = tmpRoot();
  fs.writeFileSync(prepareAssessmentPath(root, PR, 1, { source: "fable" }), "_Running as: claude-opus-5 at high._\n\nbody");
  const text = prComment(readAssessment(root, PR, 1, { source: "fable" }), {
    requested: { id: "claude-fable-5-1", effort: "xhigh" },
  });
  // The assessor's own line and the header's request disagree here, which is
  // exactly the case the two lines exist to make readable. Nothing in the
  // rendering resolves it, hides it, or calls it a match: the reader sees both.
  assert.match(text, /requested `claude-fable-5-1` at `xhigh`/);
  assert.match(text, /_Running as: claude-opus-5 at high\._/);
  assert.doesNotMatch(text, /\bran on\b|\bconfirmed\b|\bmatch(es|ed)?\b/i);
});

test("no Fable header label names an act this script did not perform", () => {
  // The constraint both assessors converged on in round 2: Astra is handed a
  // full id and an effort per call, so "requested" is literal there; a Claude
  // subagent is handed the family alias and no effort, so the same word on its
  // header describes a mechanism that did not happen.
  const root = tmpRoot();
  fs.writeFileSync(prepareAssessmentPath(root, PR, 1, { source: "fable" }), "body");
  const text = prComment(readAssessment(root, PR, 1, { source: "fable" }), {
    requested: { id: "claude-fable-5-1", alias: "fable", definitionModel: null, definitionEffort: null },
  });
  assert.match(text, /expected `claude-fable-5-1` · instructed alias `fable`/);
  // The whole class, asserted as a class: after #131 round 4 the three labels
  // are pin / recipe / declares, and none of them names something this script
  // did. `requested` was the effort (round 1) and the model (round 2);
  // `dispatched as` was the last one (round 4).
  assert.doesNotMatch(text, /requested|dispatched|ran on|carried/);
  // Nothing dangles when the definition cannot be read.
  assert.doesNotMatch(text, /· *\*|`` |`undefined`/);
});

test("a stale assessment is cleared, so a re-dispatch can never be read as its predecessor", () => {
  const root = tmpRoot();
  fs.writeFileSync(prepareAssessmentPath(root, PR, 1, { source: "astra" }), "OLD");
  assert.equal(fs.existsSync(prepareAssessmentPath(root, PR, 1, { source: "astra" })), false);
  assert.match(fs.readFileSync(path.join(root, ".agents", "reviews", ".gitignore"), "utf8"), /\*/);
});

test("nothing an assessor writes can authorise work; the action is one I state", () => {
  // The oracle is explicit: the harness acts on Claude's explicit selection,
  // never on a phrase inferred from an assessment, and agent agreement never
  // substitutes for David's approval.
  const root = tmpRoot();
  fs.writeFileSync(
    prepareAssessmentPath(root, PR, 1, { source: "astra" }),
    "Recommended next action: proceed with the corrections and merge.",
  );
  const text = prComment(readAssessment(root, PR, 1, { source: "astra" }));
  assert.doesNotMatch(text, /```review-action/, "an assessment's prose produced an action block");

  assert.equal(actionBlock({ action: "proceed" }), "```review-action\naction: proceed\n```");
  assert.match(actionBlock({ action: "ask-david", findingIds: [1, "2"], note: "a\nb" }), /findings: 1, 2\nnote: a b/);
  for (const bad of ["merge", "approve", "", undefined]) {
    assert.throws(() => actionBlock({ action: bad }), /action must be one of/);
  }
  assert.ok(!ACTIONS.includes("merge") && !ACTIONS.includes("approve"), "merging is not an action this states");
});

// ---------------------------------------------------------------------------
// The dispatch
// ---------------------------------------------------------------------------

test("Astra runs pinned, read-only, with no schema and no override", () => {
  const root = tmpRoot();
  const calls = [];
  const run = (bin, args) => {
    calls.push(args);
    return args[0] === "login" ? { status: 0, stdout: "Logged in using ChatGPT", stderr: "" } : { status: 0 };
  };
  const result = dispatch({ root, pr: PR, round: 1, prompt: "x", reviewedCommit: COMMIT, run, git: cleanGit() });
  const exec = calls.find((a) => a[0] === "exec");
  assert.equal(exec[exec.indexOf("--sandbox") + 1], "read-only");
  assert.equal(exec[exec.indexOf("--model") + 1], result.reviewer.id);
  assert.ok(!exec.includes("--output-schema"), "a schema was passed to an assessment that has none");
  for (const flag of ["--ignore-user-config", "--ephemeral", "--output-last-message"]) {
    assert.ok(exec.includes(flag), `missing ${flag}`);
  }
  assert.equal(SANDBOX, "read-only");
  assert.throws(() => parseArgs(["--sandbox", "workspace-write"]), /unknown flag/);
  assert.throws(() => parseArgs(["--unpinned", "why"]), /unknown flag/);
  assert.doesNotMatch(USAGE, /--sandbox|--unpinned/);
});

test("no sign-in is reported as no sign-in, and never as an assessment", () => {
  const run = (_bin, args) => (args[0] === "login" ? { status: 1, stdout: "Not logged in" } : { status: 0 });
  const result = dispatch({ root: tmpRoot(), pr: PR, round: 1, prompt: "x", reviewedCommit: COMMIT, run, git: cleanGit() });
  assert.equal(result.ok, false);
  assert.equal(result.signIn, true);
  assert.match(result.instructions, /No ChatGPT sign-in/);
});

test("a reviewer process that failed is never an accepted assessment, even with a file on disk", () => {
  // `codex exec` can write its last message and then exit non-zero. (Codex,
  // #120 round 1.)
  const root = tmpRoot();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-in-"));
  const write = (name, value) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
    return file;
  };
  const argv = [
    "--pr", String(PR), "--round", "1", "--commit", COMMIT, "--tier", "internal",
    "--oracle-file", write("o.md", "ORACLE"),
    "--findings-file", write("f.json", [{ id: "c1", body: "b" }]),
  ];
  let printed = "";
  const stdout = process.stdout.write;
  process.stdout.write = (chunk) => ((printed += chunk), true);
  try {
    const run = (_bin, args) => {
      if (args[0] === "login") return { status: 0, stdout: "Logged in using ChatGPT" };
      fs.writeFileSync(args[args.indexOf("--output-last-message") + 1], "## A readout that will not be believed");
      return { status: 3 };
    };
    assert.equal(main(argv, { root, run, git: cleanGit(), log: () => {} }), 1);
  } finally {
    process.stdout.write = stdout;
  }
  assert.match(printed, /dispatch failed/);
  assert.match(printed, /exited 3/);
  assert.doesNotMatch(printed, /readout that will not be believed/);
});

test("--prompt-only emits the package without running anything, so the Fable assessor gets the same words", () => {
  const root = tmpRoot();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-in-"));
  const write = (name, value) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
    return file;
  };
  const argv = [
    "--pr", String(PR), "--round", "1", "--commit", COMMIT, "--tier", "internal", "--prompt-only",
    "--oracle-file", write("o.md", "ORACLE-FROM-FILE"),
    "--findings-file", write("f.json", [{ id: "c1", body: "b" }]),
  ];
  let printed = "";
  const stdout = process.stdout.write;
  process.stdout.write = (chunk) => ((printed += chunk), true);
  const calls = [];
  try {
    assert.equal(main(argv, { root, run: (...a) => (calls.push(a), { status: 0 }), git: cleanGit(), log: () => {} }), 0);
  } finally {
    process.stdout.write = stdout;
  }
  assert.deepEqual(calls, [], "--prompt-only started a process");
  assert.match(printed, /ORACLE-FROM-FILE/);
  assert.ok(printed.includes(fs.readFileSync(briefPath(), "utf8").trim()));
});

test("--source picks the identity block and the output path together, or the CLI refuses", () => {
  // The two have to move together. A Fable package naming Astra's file would
  // have the subagent overwrite the answer the script is about to read, and the
  // mismatch would be invisible: both files exist and both hold Markdown.
  const root = tmpRoot();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-in-"));
  const write = (name, value) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
    return file;
  };
  const argv = (...extra) => [
    "--pr", String(PR), "--round", "1", "--commit", COMMIT, "--tier", "internal",
    "--oracle-file", write("o.md", "ORACLE-FROM-FILE"),
    "--findings-file", write("f.json", [{ id: "c1", body: "b" }]),
    ...extra,
  ];
  const capture = (args) => {
    let printed = "";
    const stdout = process.stdout.write;
    process.stdout.write = (chunk) => ((printed += chunk), true);
    let code;
    try {
      code = main(args, { root, run: () => ({ status: 0 }), git: cleanGit(), log: () => {} });
    } finally {
      process.stdout.write = stdout;
    }
    return { code, printed };
  };

  const fable = capture(argv("--source", "fable", "--prompt-only"));
  assert.equal(fable.code, 0);
  assert.ok(fable.printed.includes(identityBlock("fable")), "the fable package carries Astra's identity block");
  assert.match(fable.printed, /round-1\.fable\.md/);
  assert.doesNotMatch(fable.printed, /round-1\.astra\.md/);

  const astra = capture(argv("--prompt-only"));
  assert.match(astra.printed, /round-1\.astra\.md/);

  // The script runs the Codex CLI and nothing else, so a fable dispatch is a
  // request it cannot honour -- refused, rather than silently run as Astra.
  let logged = "";
  assert.equal(main(argv("--source", "fable"), { root, run: () => ({ status: 0 }), git: cleanGit(), log: (m) => (logged += m) }), 2);
  assert.match(logged, /this script does not run; use --prompt-only/);
  assert.match(USAGE, /--source/);
});

test("the CLI drives a whole follow-up, which is the path three rounds of findings walked through", () => {
  // THE GAP THAT PRODUCED THREE ROUNDS. `followUpBrief` was unit-tested as a
  // function while nothing exercised flags -> package -> dispatch -> read ->
  // comment, so each round a reviewer diffed the rich composer against the thin
  // CLI and found a different instance of the same shortfall. This is that path.
  const root = tmpRoot();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-in-"));
  const write = (name, value) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
    return file;
  };
  const argv = [
    "--pr", String(PR), "--round", "6", "--commit", COMMIT, "--tier", "internal",
    "--follow-up", "1", "--findings", "c1",
    "--question", "Does the new evidence change the scope?\n\n    a quoted line\n",
    "--oracle-file", write("o.md", "ORACLE-FROM-FILE"),
    "--findings-file", write("f.json", [finding({ body: "THE DISPUTED BODY" })]),
    "--prior-file", write("prior.md", "PRIOR-ASSESSMENT"),
    "--fable-file", write("fable.md", "THE OTHER ASSESSOR SAID THIS"),
  ];

  let sent = "";
  const run = (_bin, args, opts = {}) => {
    if (args[0] === "login") return { status: 0, stdout: "Logged in using ChatGPT" };
    // The package reaches `codex exec` on stdin, not as a path in argv.
    sent = opts.input ?? "";
    fs.writeFileSync(args[args.indexOf("--output-last-message") + 1], "My recommendation changes, and here is why.");
    return { status: 0 };
  };
  let printed = "";
  let logged = "";
  const stdout = process.stdout.write;
  process.stdout.write = (chunk) => ((printed += chunk), true);
  try {
    assert.equal(main(argv, { root, run, git: cleanGit(), log: (m) => (logged += m) }), 0, logged);
  } finally {
    process.stdout.write = stdout;
  }

  // The answer is read from the follow-up's own path and rendered as one.
  assert.match(printed, /## Astra — round 6, follow-up 1/);
  assert.match(printed, /My recommendation changes, and here is why\./);
  assert.equal(readAssessment(root, PR, 6, { source: "astra", followUp: 1 }).failed, undefined);

  // And the package the process actually received carried every party's words.
  for (const needed of ["ORACLE-FROM-FILE", "THE DISPUTED BODY", "PRIOR-ASSESSMENT", "THE OTHER ASSESSOR SAID THIS"]) {
    assert.ok(sent.includes(needed), `the follow-up package omitted ${needed}`);
  }
  // The question's own structure survives, which is what lets it carry quoted
  // evidence now that there is no separate evidence input.
  assert.ok(sent.includes("    a quoted line"), "the question was flattened");
});

test("a failed follow-up is reported as a failed follow-up, never as a round with no assessment", () => {
  // Restoring the number on the result fixes the heading and leaves the body
  // lying, which is the trap the assessment named. Both are checked here.
  const root = tmpRoot();
  const missing = readAssessment(root, PR, 6, { source: "astra", followUp: 2 });
  assert.equal(missing.failed, true);
  assert.equal(missing.followUp, 2, "the attempt's identity did not survive its failure");

  const text = prComment(missing);
  assert.match(text, /## Astra — round 6, follow-up 2: \*\*dispatch failed\*\*/);
  assert.match(text, /Follow-up 2 to Astra on round 6 produced no answer/);
  assert.match(text, /assessment of the round itself is unaffected and still stands/);
  assert.doesNotMatch(text, /No independent assessment from Astra exists for this round/);

  // A base-round failure still says the round has none, which is true there.
  const base = readAssessment(root, PR, 6, { source: "astra" });
  assert.equal(base.followUp, 0);
  assert.match(prComment(base), /No independent assessment from Astra exists for this round/);
});

test("a follow-up whose PROCESS fails is reported as a failed follow-up, through main()", () => {
  // THE TEST THAT WAS MISSING, and its absence is why round 7 happened. The
  // finding named two failure paths; the fix took one; and the test written for
  // that fix drove `readAssessment` and `prComment` directly, so it was shaped
  // to the fix rather than to the finding and passed while the other path was
  // still wrong. This one goes through `main()` with a process that fails.
  const root = tmpRoot();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-in-"));
  const write = (name, value) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
    return file;
  };
  const argv = [
    "--pr", String(PR), "--round", "6", "--commit", COMMIT, "--tier", "internal",
    "--follow-up", "1", "--findings", "c1",
    "--question", "Does the new evidence change the scope?",
    "--oracle-file", write("o.md", "ORACLE"),
    "--findings-file", write("f.json", [finding({ body: "THE DISPUTED BODY" })]),
    "--prior-file", write("prior.md", "PRIOR"),
  ];
  const run = (_bin, args) =>
    args[0] === "login" ? { status: 0, stdout: "Logged in using ChatGPT" } : { status: 3 };

  let printed = "";
  const stdout = process.stdout.write;
  process.stdout.write = (chunk) => ((printed += chunk), true);
  try {
    assert.equal(main(argv, { root, run, git: cleanGit(), log: () => {} }), 1);
  } finally {
    process.stdout.write = stdout;
  }
  assert.match(printed, /## Astra — round 6, follow-up 1: \*\*dispatch failed\*\*/);
  assert.match(printed, /Follow-up 1 to Astra on round 6 produced no answer/);
  assert.match(printed, /exited 3/);
  assert.doesNotMatch(
    printed,
    /No independent assessment from Astra exists for this round/,
    "a failed follow-up is still being reported as a round with no assessment",
  );
});

test("a finding with no body is refused before either assessor is dispatched", () => {
  // The follow-up path got this check in round 5 and the base path did not, so
  // an id with a blank body dispatched both assessors without the reviewer's
  // argument — which neither can recover from the checkout. (Codex, #120 round 7.)
  for (const bad of ["", "   ", null, undefined]) {
    assert.throws(() => brief({ findings: [finding({ body: bad })] }), /has no body/);
  }
  assert.throws(
    () => brief({ findings: [finding(), finding({ id: "c2", body: "" })] }),
    /finding c2 has no body/,
  );
  assert.doesNotThrow(() => brief({ findings: [finding()] }));
});

test("history is refused in the wrong container, the way findings already are", () => {
  // `history.length` on an object is undefined, so a preparation mistake
  // composed a package with no history and no complaint. Neither assessor can
  // notice a section it never saw. (Codex, #120 round 6.)
  assert.throws(() => brief({ history: { label: "David", text: "one entry, not in an array" } }), /history must be an array/);
  assert.throws(() => brief({ history: "David said so" }), /history must be an array/);
  assert.doesNotThrow(() => brief({ history: [] }));
  assert.match(brief({ history: [{ label: "David", text: "SAID THIS" }] }), /\*\*\[David\]\*\* SAID THIS/);
});

test("a history entry with a label and no text is refused, not rendered as undefined", () => {
  // The label was checked and the text was not, so `- **[David]** undefined`
  // composed cleanly and both assessors were dispatched without the decision
  // the entry carried. The same check `findings` already gets, on the twin
  // path that never had one. (Codex, #120 round 8, deferred to #122.)
  for (const bad of [undefined, null, "", "   ", 7, ["a line"], { text: "x" }]) {
    assert.throws(
      () => brief({ history: [{ label: "David", text: bad }] }),
      /has no text/,
      `history text ${JSON.stringify(bad)} should be refused`,
    );
  }
  assert.doesNotThrow(() => brief({ history: [{ label: "David", text: "0" }] }), "a short real string is text");
  // And the label check still fires first, on an entry carrying neither.
  assert.throws(() => brief({ history: [{}] }), /carries a label from/);
});

test("the CLI refuses an unknown flag or a flag with no value rather than guessing", () => {
  assert.throws(() => parseArgs(["--pr"]), /needs a value/);
  assert.throws(() => parseArgs(["--pr", "--round"]), /needs a value/);
  assert.throws(() => parseArgs(["--nope", "1"]), /unknown flag/);
  assert.throws(() => parseArgs(["pr", "1"]), /unexpected argument/);
  assert.deepEqual(parseArgs(["--pr", "120", "--round", "2", "--prompt-only"]), { pr: 120, round: 2, promptOnly: true });
  assert.deepEqual(SOURCES, ["astra", "fable"]);
  assert.equal(ROLE, "review-proxy");
});

// ---------------------------------------------------------------------------
// The transport each assessor actually has (#125), and rendering (#126)
// ---------------------------------------------------------------------------

/** Plant the assessor definition a render reads its effort from. */
const plantDefinition = (root, effort) => {
  const dir = path.join(root, ".claude", "agents");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "fable-review-assessor.md"),
    ["---", "name: fable-review-assessor", "tools: Read", "model: claude-fable-5-1", `effort: ${effort}`, "---", "", "Prose."].join("\n"),
  );
};

/** A findings file for a render, which now requires its scope input. */
const findingsFile = (root, ids = ["c1"]) => {
  const file = path.join(root, `findings-${ids.join("-")}.json`);
  fs.writeFileSync(file, JSON.stringify(ids.map((id) => ({ id, body: "x" }))));
  return file;
};

const pinIo = (root) => ({
  root,
  read: () =>
    JSON.stringify({
      repo: "Owner/Name",
      models: {
        strongestClaude: { id: "claude-fable-5-1", effort: "xhigh" },
        strongestCodex: { id: "gpt-6-astra", effort: "xhigh" },
      },
    }),
});

test("each package names the delivery channel that assessor actually has", () => {
  // Astra runs in a read-only sandbox and cannot write anything; its answer
  // reaches the file through the wrapper's --output-last-message. Telling it
  // to write the file asks for the one thing the process cannot do, and the
  // reader that obeys literally returns "I could not write the file" as its
  // final message -- which readAssessment accepts as a substantive assessment
  // and posts under a header naming the pull request and the findings. (#125.)
  const astra = brief({ source: "astra", assessmentFile: "/tmp/a.md" });
  assert.match(astra, /Return the complete assessment as your final message/);
  assert.match(astra, /read-only sandbox and cannot write it yourself/);
  assert.doesNotMatch(astra, /\*\*Write your assessment to:\*\*/);

  // The Fable assessor is a subagent holding Write and really does write it,
  // so the original sentence is correct there and stays.
  const fable = brief({ source: "fable", assessmentFile: "/tmp/f.md" });
  assert.match(fable, /\*\*Write your assessment to:\*\* `\/tmp\/f\.md`/);
  assert.doesNotMatch(fable, /as your final message/);
});

test("the follow-up package carries the same per-assessor transport, not the old shared sentence", () => {
  // The asymmetry was the original defect's twin: a fix applied to the
  // assessment path only leaves the follow-up telling a read-only process to
  // write a file, on exactly the round where the disagreement is sharpest.
  const common = {
    pr: PR,
    round: 2,
    tier: "internal",
    reviewedCommit: COMMIT,
    oracle: "The agreed outcome.",
    findings: [finding()],
    findingIds: ["c1"],
    question: "Does the class include the other caller?",
    priorAssessment: "The earlier assessment.",
    assessmentFile: "/tmp/f2.md",
  };
  assert.match(followUpBrief({ ...common, source: "astra" }), /Return the complete answer as your final message/);
  assert.match(followUpBrief({ ...common, source: "fable" }), /\*\*Write your answer to:\*\* `\/tmp\/f2\.md`/);
});

test("--render prints the comment for an assessment already on disk, with the pin in its header", () => {
  // WHY THIS IS A MODE AND NOT A NODE ONE-LINER. The Fable assessment is
  // written by a subagent this script does not run, so posting it used to be
  // improvised -- and the requested model and effort, the one fact worth the
  // most in that header, was the part most easily left off. A step that has to
  // be remembered is a step that gets skipped: measured seven rounds running
  // on #124, which is the whole subject of #126.
  const root = tmpRoot();
  plantDefinition(root, "xhigh");
  fs.writeFileSync(
    prepareAssessmentPath(root, PR, 3, { source: "fable" }),
    "_Running as: claude-fable-5-1 at xhigh._\n\nThe finding is real.",
  );
  let out = "";
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => ((out += chunk), true);
  let code;
  try {
    code = main(["--render", "--source", "fable", "--pr", String(PR), "--round", "3", "--commit", COMMIT, "--findings-file", findingsFile(root)], {
      root,
      io: pinIo(root),
      run: () => assert.fail("--render must dispatch nothing"),
      git: () => assert.fail("--render must not inspect the checkout"),
      log: () => {},
    });
  } finally {
    process.stdout.write = write;
  }
  assert.equal(code, 0, out);
  assert.match(out, /## Fable — round 3/);
  // The definition planted in this fixture is what supplies the effort: it is
  // the only route a Claude subagent has, so it is what the header names.
  assert.match(out, /expected `claude-fable-5-1` · instructed alias `fable` · definition effort `xhigh`/);
  // The declared model repeats the pin here, so it is not printed: a line that
  // says the same thing twice trains a reader to skip it.
  assert.doesNotMatch(out, /definition model/);
  assert.match(out, /_Running as: claude-fable-5-1 at xhigh\._/);
  assert.ok(out.includes("The finding is real."), "the assessment was not passed through verbatim");
});

test("--render resolves each assessor against its own tier", () => {
  // Rendering Astra's assessment against strongestClaude, or the subagent's
  // against strongestCodex, would put a confident wrong model in the header --
  // worse than no model, because it reads as an observation.
  const root = tmpRoot();
  fs.writeFileSync(prepareAssessmentPath(root, PR, 4, { source: "astra" }), "body");
  let out = "";
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => ((out += chunk), true);
  try {
    main(["--render", "--pr", String(PR), "--round", "4", "--commit", COMMIT, "--findings-file", findingsFile(root)], { root, io: pinIo(root), log: () => {} });
  } finally {
    process.stdout.write = write;
  }
  // "at", not "· effort": Astra is handed its effort per call as
  // `model_reasoning_effort`, so the pin genuinely IS the request there.
  assert.match(out, /requested `gpt-6-astra` at `xhigh`/);
  assert.doesNotMatch(out, /claude-fable/);
});

test("--render and --prompt-only are different jobs, and asking for both is refused", () => {
  const root = tmpRoot();
  let logged = "";
  assert.equal(
    main(["--render", "--prompt-only", "--pr", String(PR), "--round", "1", "--commit", COMMIT], {
      root,
      io: pinIo(root),
      log: (m) => (logged += m),
    }),
    2,
  );
  assert.match(logged, /different jobs/);
});

test("--render reports a missing assessment as a failed dispatch, never as a quiet round", () => {
  const root = tmpRoot();
  let out = "";
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => ((out += chunk), true);
  let code;
  try {
    code = main(["--render", "--source", "fable", "--pr", String(PR), "--round", "9", "--commit", COMMIT, "--findings-file", findingsFile(root)], { root, io: pinIo(root), log: () => {} });
  } finally {
    process.stdout.write = write;
  }
  assert.equal(code, 1, "a render with nothing to render exited 0");
  assert.match(out, /dispatch failed/);
  assert.match(out, /not a report that the round was quiet/);
});

// ---------------------------------------------------------------------------
// What the header establishes rather than approximates (#131 round 1)
// ---------------------------------------------------------------------------

const renderOut = (argv, opts) => {
  let out = "";
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => ((out += chunk), true);
  let code;
  try {
    code = main(argv, { log: () => {}, ...opts });
  } finally {
    process.stdout.write = write;
  }
  return { out, code };
};

test("a consumer whose pin disagrees with the definition sees BOTH, each labelled for what it is", () => {
  // The case Codex found and the two assessors split on. Astra: showing the
  // pin's effort exposes a real divergence. Fable: calling it "requested" is a
  // false claim, because a Claude subagent is handed no effort at all. Both
  // are right about a different half, so the header carries the value that
  // APPLIES and names the pin only where it differs.
  const root = tmpRoot();
  plantDefinition(root, "xhigh");
  fs.writeFileSync(prepareAssessmentPath(root, PR, 1, { source: "fable" }), "body");
  const io = {
    root,
    read: () =>
      JSON.stringify({
        repo: "Owner/Name",
        models: { strongestClaude: { id: "claude-fable-5-1", effort: "low" }, strongestCodex: { id: "gpt-6-astra", effort: "xhigh" } },
      }),
  };
  const { out } = renderOut(["--render", "--source", "fable", "--pr", String(PR), "--round", "1", "--commit", COMMIT, "--findings-file", findingsFile(root)], { root, io });

  assert.match(out, /expected `claude-fable-5-1` · instructed alias `fable` · definition effort `xhigh`/);
  // And never the shape that started this: the pin's effort under the word
  // "requested", which would state a request nobody made and fire the
  // mismatch warning on every round in a repository where nothing is wrong.
  assert.doesNotMatch(out, /requested/);
  assert.doesNotMatch(out, /`low`/, "the pin's effort was printed as though something had asked for it");
});

test("an unreadable definition omits the effort; it never falls back to the pin", () => {
  // The Fable assessor's tie-break condition, stated as a test: an effort this
  // process cannot establish is one it does not print. Printing a plausible
  // value instead is the failure the whole header exists to avoid.
  const root = tmpRoot(); // no .claude/agents here
  fs.writeFileSync(prepareAssessmentPath(root, PR, 1, { source: "fable" }), "body");
  const { out } = renderOut(["--render", "--source", "fable", "--pr", String(PR), "--round", "1", "--commit", COMMIT, "--findings-file", findingsFile(root)], {
    root,
    io: pinIo(root),
  });

  assert.match(out, /expected `claude-fable-5-1` · instructed alias `fable`/);
  assert.doesNotMatch(out, /definition effort/);
  assert.doesNotMatch(out, /xhigh/);
});

test("a rendered follow-up names the findings it addressed, not every finding in the round", () => {
  const root = tmpRoot();
  plantDefinition(root, "xhigh");
  fs.writeFileSync(prepareAssessmentPath(root, PR, 1, { source: "fable", followUp: 2 }), "body");
  const file = path.join(root, "round-findings.json");
  fs.writeFileSync(file, JSON.stringify([{ id: "a", body: "x" }, { id: "b", body: "y" }, { id: "c", body: "z" }]));

  const { out } = renderOut(
    ["--render", "--source", "fable", "--pr", String(PR), "--round", "1", "--follow-up", "2", "--findings", "a,c", "--commit", COMMIT, "--findings-file", file],
    { root, io: pinIo(root) },
  );

  assert.match(out, /findings `a`, `c`/);
  assert.doesNotMatch(out, /`b`/, "the follow-up claimed a finding its assessor never received");
  assert.match(out, /follow-up 2/);
});

test("an ordinary round still names every finding in the file", () => {
  const root = tmpRoot();
  fs.writeFileSync(prepareAssessmentPath(root, PR, 1, { source: "fable" }), "body");
  const file = path.join(root, "round-findings.json");
  fs.writeFileSync(file, JSON.stringify([{ id: "a", body: "x" }, { id: "b", body: "y" }]));
  const { out } = renderOut(
    ["--render", "--source", "fable", "--pr", String(PR), "--round", "1", "--commit", COMMIT, "--findings-file", file],
    { root, io: pinIo(root) },
  );
  assert.match(out, /findings `a`, `b`/);
});

test("a missing or blank reviewed commit is refused on every path, in a sentence", () => {
  // It used to be refused on the dispatch path only, and only as a TypeError
  // from `reviewedCommit.trim()` surfacing as a raw runtime message; the render
  // path accepted it and emitted a comment with no revision at all. An empty
  // string is the case presence-checking misses: `parseArgs` rejects only a
  // value that looks like another flag.
  const root = tmpRoot();
  for (const argv of [
    ["--render", "--source", "fable", "--pr", String(PR), "--round", "1", "--findings-file", findingsFile(root)],
    ["--render", "--source", "fable", "--pr", String(PR), "--round", "1", "--commit", "   ", "--findings-file", findingsFile(root)],
    ["--pr", String(PR), "--round", "1", "--tier", "internal", "--oracle-file", "/nope", "--findings-file", "/nope"],
  ]) {
    let logged = "";
    const code = main(argv, { root, io: pinIo(root), run: () => ({ status: 0 }), git: cleanGit(), log: (m) => (logged += m) });
    assert.equal(code, 2, `accepted ${JSON.stringify(argv)}`);
    assert.match(logged, /--commit <reviewed sha> is required/);
    assert.doesNotMatch(logged, /TypeError|is not a function|Cannot read/);
  }
});

test("a render with no scope input is refused, naming the flag that applies", () => {
  // Round 1 gave both paths one derivation and stopped. The input that
  // derivation needs never reached the operator-facing recipe, so a follow-up
  // posted exactly as documented produced a header naming no findings — the
  // same asymmetry as --commit, where the render path accepted less than the
  // dispatch path requires. Every dispatched round has at least one finding, so
  // an empty list is always a missing flag and never a quiet round.
  const root = tmpRoot();
  fs.writeFileSync(prepareAssessmentPath(root, PR, 1, { source: "fable" }), "body");
  fs.writeFileSync(prepareAssessmentPath(root, PR, 1, { source: "fable", followUp: 2 }), "body");

  for (const [argv, expected] of [
    [["--render", "--source", "fable", "--pr", String(PR), "--round", "1", "--commit", COMMIT], /--findings-file/],
    [["--render", "--source", "fable", "--pr", String(PR), "--round", "1", "--follow-up", "2", "--commit", COMMIT], /--findings <id,id>/],
  ]) {
    let logged = "";
    assert.equal(main(argv, { root, io: pinIo(root), log: (m) => (logged += m) }), 2, `accepted ${argv.join(" ")}`);
    assert.match(logged, expected);
  }
});

test("a pin behind the alias is legible as that, not as a substitution", () => {
  // The diagnosis this header exists to steer. When the pin and what answered
  // disagree, the reader must be able to tell "your pin trails the alias" —
  // David's one-line edit — from "the platform served something else", which is
  // the only other cause and the one he cannot fix. Naming the alias the call
  // the recipe instructs is what separates them.
  const root = tmpRoot();
  plantDefinition(root, "xhigh");
  fs.writeFileSync(prepareAssessmentPath(root, PR, 1, { source: "fable" }), "_Running as: claude-fable-5-1 at xhigh._\n\nbody");
  const io = {
    root,
    read: () =>
      JSON.stringify({
        repo: "Owner/Name",
        models: { strongestClaude: { id: "claude-fable-5-0", effort: "xhigh" }, strongestCodex: { id: "gpt-6-astra", effort: "xhigh" } },
      }),
  };
  const { out } = renderOut(
    ["--render", "--source", "fable", "--pr", String(PR), "--round", "1", "--commit", COMMIT, "--findings-file", findingsFile(root)],
    { root, io },
  );

  assert.match(out, /expected `claude-fable-5-0`/);
  assert.match(out, /instructed alias `fable`/);
  assert.match(out, /definition model `claude-fable-5-1`/);
  assert.doesNotMatch(out, /requested/);
});

test("Astra's header is unchanged, because Astra really is handed both values", () => {
  const root = tmpRoot();
  fs.writeFileSync(prepareAssessmentPath(root, PR, 1, { source: "astra" }), "body");
  const { out } = renderOut(
    ["--render", "--pr", String(PR), "--round", "1", "--commit", COMMIT, "--findings-file", findingsFile(root)],
    { root, io: pinIo(root) },
  );
  assert.match(out, /requested `gpt-6-astra` at `xhigh`/);
  assert.doesNotMatch(out, /expected |instructed alias|definition /);
});

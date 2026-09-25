// SYNCED FROM AI-Handbook — do not edit in a consumer repo.
/**
 * The round translation's tests. The deliverable is a chat message, so these assert on text.
 *
 * Two rules under test throughout: **"agrees" is never printed over an
 * unassessed item, or over a round the builder has not answered** -- and the
 * report never says anything the translator did not. And one rule about the
 * tests themselves: **the boundary between the module's own functions is
 * exercised with real results, never with fixtures built by hand.** Every
 * fixture here used to build the report shape by hand, so a `readAnswer`
 * result that `chatReport` could not consume shipped past 23 green tests.
 * (Codex, #109 round 4, P1.)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  REVIEWS_DIR,
  answerPath,
  schemaPath,
  ROLE,
  ensureReviewsIgnored,
  prepareAnswerPath,
  dispatchModel,
  roundBrief,
  validateAnswer,
  readAnswer,
  facts,
  chatLine,
  chatReport,
  findingLine,
} from "../round-translation.mjs";

const PR = 81;

const fixed = { raised: "Two rounds could have been filed under one number.", done: "The dispatch moment now bounds the window.", outcome: "fixed", holds: true, overbuilt: false };
const declined = { raised: "A mistyped flag would not be caught.", done: "Declined: you type it yourself.", outcome: "declined", holds: true, overbuilt: false };

const answer = (over = {}) => ({
  recommendation: "Nothing to do.",
  about: "Two points on how a round is located.",
  disagreements: [],
  findings: [fixed, declined],
  took_on_trust: "I took the builder's word that the test suite passes; I did not run it.",
  could_not_assess: null,
  model: "claude-fable-5-1",
  builder_answered: true,
  ...over,
});

const finalSections = {
  known_gaps: [{ what: "A mistyped flag is not caught.", reasonable: true, why: "You type it yourself." }],
  what_landed: { landed: "It reads the round from GitHub.", does_not_do: "It does not judge anything.", now_trusting: "That the translator read the whole diff." },
};

const disagreement = { what: "The builder called this fixed; the diff changes a different function.", why_it_matters: "The reported problem may still be there." };

const round = (n, a, over = {}) => ({ pr: PR, round: n, answer: a, ...over });

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), "d0-"));

/**
 * Write an answer where the translator would, then read it back the way the
 * skill does. The round's classification is stated here rather than defaulted,
 * because a default is the defect under test: omitted on both sides it makes
 * the dispatch and the read agree on "ordinary" and a stopping round reads as
 * translated with no cumulative assessment.
 */
function writeAndRead(root, pr, n, a, opts = { finalRound: false }) {
  const file = prepareAnswerPath(root, pr, n);
  fs.writeFileSync(file, JSON.stringify(a));
  return readAnswer(root, pr, n, opts, { finalRound: false });
}

// ---------------------------------------------------------------------------
// Coordinates
// ---------------------------------------------------------------------------

test("the answer path is derived, and derived the same way by writer and reader", () => {
  assert.equal(answerPath("/r", 12, 3), path.join("/r", REVIEWS_DIR, "pr-12", "round-3.answer.json"));
  // The brief must name EXACTLY the path readAnswer will open. When the brief
  // accepted a path from a caller, a mistyped one meant a valid answer written
  // where nothing looked -- reported as a failed round. (Codex, #109 round 2.)
  const b = roundBrief({ finalRound: false, root: "/r", pr: 12, round: 3, head: "abc1234" });
  assert.ok(b.includes(answerPath("/r", 12, 3)));
});

test("the schema resolves relative to the module, not to a caller's root", () => {
  // Resolving it under the ANSWER FILE's root works in this repo and breaks in
  // a consumer, where this file sits at `scripts/` rather than `core/scripts/`.
  assert.ok(fs.existsSync(schemaPath()));
  assert.ok(schemaPath().endsWith(path.join(".agents", "roles", "schemas", `${ROLE}.schema.json`)));
});

// A DISTINCT ROOT PER FIXTURE, because machineryConfig memoizes per root: two
// fixtures sharing one root would silently serve the first one's configuration
// to the second, and a test for a refusal would pass against the wrong file.
let fakeRoots = 0;
const fakeIo = (over = {}) => ({
  root: `/repo-fixture-${(fakeRoots += 1)}`,
  read: () =>
    JSON.stringify({
      repo: "Owner/Name",
      models: { strongestClaude: { id: "claude-fable-5-1", effort: "xhigh" } },
      ...over,
    }),
});

test("the repository is derived, never passed in", () => {
  assert.match(roundBrief({ finalRound: false, root: "/r", pr: 1, round: 1, head: "h", io: fakeIo() }), /Owner\/Name/);
});



test("the brief names Codex as the reviewer, and does not make identity a lookup", () => {
  // Round 5 found a real circularity -- the role was told to filter on "the
  // reviewer's login" and never given one, so the only available test was what
  // a comment looked like. I answered it with a config key, a refusal, a
  // coordinate and then a spelling-normalisation rule. David, 2026-09-17:
  // "The reviewer is ALWAYS CODEX". Naming the constant closes the same hole
  // with none of that machinery.
  const b = roundBrief({ root: "/r", pr: 1, round: 2, head: "h", finalRound: false, io: fakeIo() });
  assert.match(b, /\*\*The code reviewer is Codex\*\*/);
  assert.match(b, /Never infer this from a comment's content/);
  // No configured login, and nothing to normalise.
  assert.doesNotMatch(b, /\[bot\]|stripped|reviewer's login/);
});

test("malformed coordinates are refused before a dispatch, not interpolated", () => {
  // Measured before the fix: `round: "two"` asked for "the twoth review" and
  // `pr: "12x"` addressed `pr-12x/`, where the read for #12 finds nothing and
  // reports a FAILED translation of a round that actually ran -- a typo
  // becoming an account of the wrong round. (Codex, #109 round 5.)
  for (const bad of [{ pr: "12x", round: 1 }, { pr: 0, round: 1 }, { pr: 1, round: "two" }, { pr: 1, round: 1.5 }, { pr: 1, round: 0 }]) {
    assert.throws(() => roundBrief({ finalRound: false, root: "/r", head: "h", io: fakeIo(), ...bad }), /must be a positive integer/, JSON.stringify(bad));
  }
  // The check lives on the shared derivation, so every entry point inherits it.
  assert.throws(() => answerPath("/r", 1, "two"), /must be a positive integer/);
  assert.throws(() => readAnswer("/r", "12x", 1, { finalRound: false }), /must be a positive integer/);
  // A REAL ROOT, because this one WRITES: the refusal must happen before any
  // directory is created, and asserting that against an unwritable path would
  // pass on the permission error instead of on the validation. CI found this
  // the hard way -- the container runs as root, where `mkdir /r` silently
  // succeeded and left a stray directory behind, while the runner got EACCES.
  const writable = tmpRoot();
  assert.throws(() => prepareAnswerPath(writable, 1, -1), /must be a positive integer/);
  assert.equal(fs.existsSync(path.join(writable, REVIEWS_DIR)), false, "a refused call must leave nothing behind");
  // The head is the evidence boundary; an empty one asks for an unbounded range.
  for (const head of ["", "   ", null, undefined]) {
    assert.throws(() => roundBrief({ finalRound: false, root: "/r", pr: 1, round: 1, head, io: fakeIo() }), /head must be a non-empty commit identifier/);
  }
});

test("dispatchModel returns both the agent name and the full id, from one call", () => {
  const d = dispatchModel(fakeIo());
  // The Agent call takes `agentModel`; `chatReport` compares against `id`.
  // Naming them from two separate calls is how the skill lost the binding.
  // (Codex, #109 round 4.)
  assert.equal(d.agentModel, "fable");
  assert.equal(d.id, "claude-fable-5-1");
  assert.equal(d.effort, "xhigh");
  // WHERE the effort is applied, not WHETHER it reaches anything. It reaches
  // the subagent through the role definition's frontmatter, which
  // `scripts/check-agent-models.mjs` holds equal to this pin (#126). This
  // asserted `effortApplied: false` while the pin genuinely turned nothing.
  assert.equal(d.effortRoute, "definition");
  assert.equal(d.effortApplied, undefined);
});

test("a non-Claude dispatch model is refused, because the Agent tool cannot take it", () => {
  const io = fakeIo({ models: { strongestClaude: { id: "gpt-5", effort: "xhigh" } } });
  assert.throws(() => dispatchModel(io), /not a Claude model/);
});

test("the round's boundaries are located on the pull request, never remembered", () => {
  // The receipt store was silently carrying `since` and the previous head;
  // with it gone a resumed session read "from the start" and re-attributed
  // every earlier round to the current one. The remedy is not a smaller
  // store: the reviewer marks every round it returns, in two shapes, and the
  // Nth marker IS round N. (Codex, #109 round 4; measured on #115.)
  const b = roundBrief({ finalRound: false, root: "/r", pr: 1, round: 4, head: "deadbee", now: () => new Date("2026-09-16T11:00:00Z") });
  assert.match(b, /\*\*Round:\*\* 4 — the 4th review the reviewer has returned/);
  assert.match(b, /formal review submission/);
  assert.match(b, /\*\*Reviewed commit:\*\*/);
  assert.match(b, /Locate this round's marker and, when 4 > 1, the previous round's/);
  assert.match(b, /do not guess a window/);
  // No coordinate is remembered by the caller: neither a lower timestamp
  // bound nor a previous head is accepted, so neither can be stale.
  assert.doesNotMatch(b, /Review activity, from|Previous head/);
  assert.match(b, /\*\*Review activity, until:\*\* `2026-09-16T11:00:00\.000Z` — the moment this dispatch was made/);
  assert.match(b, /IGNORE every comment, review and reply after this timestamp/);
});

test("the activity window's upper bound is derived, so there is no way to dispatch without one", () => {
  // Accepted as an input it was: `null` printed "none supplied" and left the
  // window open at the top, and "yesterday", 42 and "2026-13-45T99:99:99Z"
  // were interpolated verbatim as though they were timestamps. Either way a
  // detached round could absorb the next round's findings and file them under
  // this one. (Codex, #109 round 6.) The bound IS the moment of the dispatch,
  // and this function is that moment, so a caller could only get it wrong.
  const before = new Date();
  const b = roundBrief({ finalRound: false, root: "/r", pr: 1, round: 2, head: "h" });
  const m = /\*\*Review activity, until:\*\* `([^`]+)`/.exec(b);
  assert.ok(m, "every brief carries an upper bound");
  const stamped = new Date(m[1]);
  assert.equal(Number.isNaN(stamped.getTime()), false, "and it is a real timestamp");
  assert.ok(stamped >= before && stamped <= new Date(), "taken at the moment of the dispatch");
  // The open-topped branch is gone, not merely unreachable.
  assert.doesNotMatch(b, /none supplied/);
  // A caller cannot supply one: the key is not read.
  assert.doesNotMatch(roundBrief({ finalRound: false, root: "/r", pr: 1, round: 2, head: "h", until: "yesterday" }), /yesterday/);
});

test("a prior account from another pull request is refused, never quoted as this one's", () => {
  // One session can hold several PRs. Quoted here, a foreign result would be
  // presented to the translator as its OWN earlier work on THIS pull request
  // -- a foreign history steering the round David reads most carefully.
  // Refused rather than dropped: a silent drop would name the round as having
  // no account and bury the real reason. (Codex, #109 round 6.)
  const root = tmpRoot();
  const mine = writeAndRead(root, 12, 1, answer({ about: "MINE" }));
  const theirs = writeAndRead(root, 99, 1, answer({ about: "FOREIGN" }));
  assert.equal(theirs.pr, 99, "every read result carries the pull request it came from");
  assert.throws(
    () => roundBrief({ root, pr: 12, round: 2, head: "h", finalRound: true, priorAccounts: [theirs] }),
    /carries a result from pull request #99 .*this brief is for #12/s,
  );
  // This PR's own accounts are quoted as before.
  assert.match(roundBrief({ root, pr: 12, round: 2, head: "h", finalRound: true, priorAccounts: [mine] }), /MINE/);
});

test("a round must be classified explicitly, because an omitted flag is silently wrong", () => {
  // Omitted on BOTH sides of the stopping round, the old default made the
  // dispatch and the read agree on "ordinary": the round-4 mismatch check
  // never fired, the answer was schema-valid without known_gaps or
  // what_landed, and the stopping round read as translated with the one
  // section that tells David what is shipping unfixed simply absent.
  // (Codex, #109 round 8.)
  const root = tmpRoot();
  for (const call of [
    () => roundBrief({ root, pr: 1, round: 2, head: "h" }),
    () => validateAnswer(answer()),
    () => readAnswer(root, 1, 2),
  ]) {
    assert.throws(call, /needs finalRound stated explicitly as true or false, got undefined/);
  }
  // Both explicit values are accepted at every entry point.
  assert.ok(roundBrief({ root, pr: 1, round: 2, head: "h", finalRound: false }));
  assert.ok(roundBrief({ root, pr: 1, round: 2, head: "h", finalRound: true }));
  assert.deepEqual(validateAnswer(answer(), { finalRound: false }), []);
  // And the reproduction that motivated it: a stopping round whose answer
  // carries no final sections is now a FAILED read rather than a quiet one.
  fs.writeFileSync(prepareAnswerPath(root, 12, 9), JSON.stringify(answer()));
  assert.match(readAnswer(root, 12, 9, { finalRound: true }).reason, /written for an ordinary round but read as the final one/);
});

test("prior accounts carry what an earlier round did NOT verify", () => {
  // `took_on_trust` is the one field naming claims an earlier account accepted
  // without checking -- exactly the list the final round should recheck. It was
  // dropped while three other navigation fields were kept, because I enumerated
  // by what read like navigation rather than by what the final round needs.
  // (Codex, #109 round 8; same class as round 4's finding, one field over.)
  const root = tmpRoot();
  const prior = writeAndRead(root, 12, 1, answer({ took_on_trust: "TRUSTED-THE-TEST-COUNTS" }));
  const fin = roundBrief({ root, pr: 12, round: 2, head: "h", finalRound: true, priorAccounts: [prior] });
  assert.match(fin, /Took on trust, unverified by that round:\*\* TRUSTED-THE-TEST-COUNTS/);
  // Every navigation field the final round is told to use travels together.
  for (const needed of [/Builder had replied/, /Could not assess/, /Disagreements reported|Disagreed with the builder/, /Took on trust/]) {
    assert.match(fin, needed);
  }
});

test("the head is where the evidence stops, not the commit the reviewer reviewed", () => {
  // Pinned to the reviewed commit, the translator could never check a reply's
  // "fixed in <later sha>". (Astra, 2026-09-16.)
  const b = roundBrief({ finalRound: false, root: "/r", pr: 1, round: 2, head: "deadbee" });
  const headLine = b.split("\n").find((l) => l.includes("**Head:**"));
  assert.match(headLine, /`deadbee` — where the evidence stops/);
  assert.match(headLine, /NOT necessarily the commit the reviewer reviewed/);
  // And no clock appears on it.
  assert.doesNotMatch(headLine, /\d{4}-\d{2}-\d{2}T/);
});

test("the brief carries the schema, nested field names included", () => {
  // The role holds no tool that can open the schema file, and neither the
  // role nor the coordinates named `why_it_matters`, `does_not_do` or
  // `now_trusting`. A validator the writer cannot see rejects honest answers.
  // (Astra, 2026-09-16.)
  const b = roundBrief({ finalRound: false, root: "/r", pr: 1, round: 1, head: "h" });
  assert.match(b, /## The shape of your answer/);
  for (const key of ["why_it_matters", "does_not_do", "now_trusting", "builder_answered", "could_not_assess", "overbuilt", "took_on_trust"]) {
    assert.ok(b.includes(`"${key}"`), `schema key ${key} missing from the brief`);
  }
  // The quoted schema is the shipped one, so the two cannot drift.
  assert.ok(b.includes(JSON.stringify(JSON.parse(fs.readFileSync(schemaPath(), "utf8")), null, 2)));
});

test("prior accounts are readAnswer results, quoted whole, on the final round only", () => {
  const root = tmpRoot();
  const one = writeAndRead(root, PR, 1, answer({ about: "ABOUT-ONE", findings: [{ ...fixed, raised: "RAISED-ONE", overbuilt: true }], builder_answered: false, could_not_assess: "CNA-ONE", disagreements: [{ what: "D-ONE", why_it_matters: "WHY-ONE" }] }));
  const fin = roundBrief({ root, pr: PR, round: 3, head: "h", finalRound: true, priorAccounts: [one] });
  assert.match(fin, /navigation only/);
  // The round number comes from the readAnswer result, not from a bare answer
  // -- which carries none and rendered "### Round undefined". (Astra.)
  assert.match(fin, /### Round 1\n/);
  assert.doesNotMatch(fin, /undefined/);
  assert.match(fin, /ABOUT-ONE/);
  // Each finding is quoted as the SAME line the report prints, flags included,
  // so the final round sees what an earlier one marked as not holding or as
  // overbuilt in the shape David saw it.
  assert.ok(fin.includes(`- ${findingLine({ ...fixed, raised: "RAISED-ONE", overbuilt: true })}`));
  assert.match(fin, /OVERBUILT\*\* — RAISED-ONE/);
  // The navigation fields the final round is REQUIRED to use, all quoted:
  // whether the builder had replied, the limitation, and each disagreement.
  // (Codex, #109 round 4.)
  assert.match(fin, /Builder had replied when this was written:\*\* no — treat its conclusions as provisional/);
  assert.match(fin, /Could not assess:\*\* CNA-ONE/);
  assert.match(fin, /Disagreed with the builder on 1:/);
  assert.match(fin, /D-ONE — WHY-ONE/);
  // NAMED AS FILES IS AN INSTRUCTION TO DO THE IMPOSSIBLE: the role holds no
  // Read tool, and a path specifier in `tools:` is not honoured, so there is
  // no narrow read grant to give it. Scoped to the section because the brief
  // legitimately names one .json path -- the answer file.
  const section = fin.slice(fin.indexOf("## Earlier accounts"), fin.indexOf("## The shape of your answer"));
  assert.doesNotMatch(section, /\.json/);

  const ordinary = roundBrief({ finalRound: false, root, pr: PR, round: 2, head: "h", priorAccounts: [one] });
  assert.doesNotMatch(ordinary, /navigation only|ABOUT-ONE/);
});

test("an untranslated round is the cadence, a failed translation is a limitation", () => {
  // Both are still NAMED -- the old brief emitted no section at all, so the
  // final round read as though there had been no earlier rounds (Fable,
  // 2026-09-16). What changed on 2026-09-19 is what the translator is told to
  // DO with each. Under the every-round cadence an absent account meant
  // something had gone wrong, so it was a limitation. The cadence now owes a
  // translation only on a decline round, a smell, or the last round before a
  // merge, so an untranslated round is the ORDINARY case -- and calling it a
  // limitation put "partial: something could not be assessed" on the headline
  // of every final report, which is the noise the cadence change removes.
  // A FAILED translation was owed and did not arrive, so it stays a
  // limitation. (Codex #134 R1-F3; both assessments agreed on this shape.)
  const root = tmpRoot();
  const two = readAnswer(root, PR, 2, { finalRound: false }); // nothing written: a FAILED result
  assert.equal(two.failed, true);
  const fin = roundBrief({ root, pr: PR, round: 4, head: "h", finalRound: true, priorAccounts: [two] });
  assert.match(fin, /### Round 1\n\nThis round was not translated\./);
  assert.match(fin, /NOT a limitation — do not put it in `could_not_assess`/);
  // And the two cases must not be collapsed. Scope to round 2's OWN section:
  // splitting on the round-2 heading alone also captures round 3, which is
  // untranslated and legitimately carries the cadence sentence.
  const roundTwo = fin.split("### Round 2")[1].split("### Round 3")[0];
  assert.match(roundTwo, /state this as a limitation/);
  assert.doesNotMatch(roundTwo, /NOT a limitation/);
  assert.match(fin, /### Round 2\n\nThe translation of this round FAILED — the translator wrote no answer file/);
  assert.match(fin, /### Round 3\n\nThis round was not translated\./);
  // Nothing is ever said about the current round or a later one.
  assert.doesNotMatch(fin, /### Round 4/);
  // And with no prior accounts passed at all, the section still names every round.
  const none = roundBrief({ root, pr: PR, round: 3, head: "h", finalRound: true });
  assert.match(none, /### Round 1\n/);
  assert.match(none, /### Round 2\n/);
});

test("prepareAnswerPath clears a stale answer, so a re-dispatch cannot be read as its predecessor", () => {
  // `answerPath` is the same for every attempt of a round; waiting for
  // completion fixes an EARLY read but not a STALE one. (Astra, 2026-09-16.)
  const root = tmpRoot();
  const first = writeAndRead(root, PR, 5, answer({ recommendation: "FIRST ATTEMPT" }));
  assert.equal(first.answer.recommendation, "FIRST ATTEMPT");
  const file = prepareAnswerPath(root, PR, 5);
  assert.equal(file, answerPath(root, PR, 5));
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.existsSync(path.dirname(file)), true);
  assert.equal(fs.readFileSync(path.join(root, REVIEWS_DIR, ".gitignore"), "utf8"), "*\n");
  // A second attempt that writes nothing is a FAILED round, not the first attempt's answer.
  const second = readAnswer(root, PR, 5, { finalRound: false });
  assert.equal(second.failed, true);
  assert.match(second.reason, /wrote no answer file/);
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test("validateAnswer runs against the REAL shipped schema, so brief and schema cannot drift", () => {
  assert.deepEqual(validateAnswer(answer(), { finalRound: false }), []);
});

test("the final-round sections are required on the final round and refused otherwise", () => {
  assert.deepEqual(validateAnswer(answer(finalSections), { finalRound: true }), []);
  // Both directions, because an optional field nothing enforces is the defect
  // this machinery keeps paying for.
  assert.notDeepEqual(validateAnswer(answer(), { finalRound: true }), []);
  assert.notDeepEqual(validateAnswer(answer(finalSections), { finalRound: false }), []);
});

test("an empty or blank could_not_assess is refused, not read as 'nothing to report'", () => {
  // The validator accepted "" and the reader read "" as not-unassessed: two
  // checks disagreeing about what empty means, with the favourable state as
  // the result. (Codex, #109 round 2.) Then "   " passed the schema's
  // `minLength` and was trimmed into the favourable state one character away
  // (Astra, 2026-09-16) -- the schema now says `minTrimmedLength`, so the
  // general rule refuses it too, and this check survives for its message.
  assert.notDeepEqual(validateAnswer(answer({ could_not_assess: "" }), { finalRound: false }), []);
  assert.match(validateAnswer(answer({ could_not_assess: "   " }), { finalRound: false }).join("; "), /is blank/);
  assert.deepEqual(validateAnswer(answer({ could_not_assess: null }), { finalRound: false }), []);
  assert.deepEqual(validateAnswer(answer({ could_not_assess: "The diff was cut." }), { finalRound: false }), []);
  // And the reader side does not trim either: only null is fully assessed.
  assert.equal(facts(round(1, answer({ could_not_assess: "   " }))).unassessed, true);
});

test("a required prose field cannot be whitespace and still validate", () => {
  // Measured on this schema for #116: every required prose field set to three
  // spaces returned `problems: []`, and the answer rendered under the
  // favourable headline -- an empty account presented as agreement. The
  // schema's keyword measured the RAW string, so "   " satisfied it.
  const blank = {
    recommendation: "   ",
    about: "  ",
    took_on_trust: "\n\t ",
  };
  const problems = validateAnswer(answer(blank), { finalRound: false });
  for (const field of Object.keys(blank)) {
    assert.ok(
      problems.some((p) => p.includes(field)),
      `"${field}" was whitespace and nothing complained: ${JSON.stringify(problems)}`,
    );
  }
  // Nested prose too, which is where most of the fields are.
  assert.notDeepEqual(
    validateAnswer(answer({ disagreements: [{ what: "   ", why_it_matters: "   " }] }), { finalRound: false }),
    [],
  );
  assert.notDeepEqual(
    validateAnswer(answer({ ...finalSections, known_gaps: [{ what: " ", reasonable: true, why: " " }] }), { finalRound: true }),
    [],
  );
  assert.deepEqual(validateAnswer(answer(finalSections), { finalRound: true }), [], "the filled final round still validates");
});

test("an undeterminable model is null, never prose", () => {
  // The brief permitted prose, and every reader treats a non-empty string as a
  // model id -- so the honest answer printed as the model's name.
  assert.deepEqual(validateAnswer(answer({ model: null }), { finalRound: false }), []);
  assert.notDeepEqual(validateAnswer(answer({ model: "" }), { finalRound: false }), []);
});

test("the answer directory is kept ignored, because an answer must never be committed", () => {
  const root = tmpRoot();
  const ignore = ensureReviewsIgnored(root);
  assert.equal(fs.readFileSync(ignore, "utf8"), "*\n");
});

// ---------------------------------------------------------------------------
// The boundary: step 3's output IS step 4's input
// ---------------------------------------------------------------------------

test("a real readAnswer result feeds chatReport unchanged, on an ordinary and a final round", () => {
  // THE TEST WHOSE ABSENCE LET THE P1 THROUGH. `readAnswer` returned
  // `{ ok, answer }`, `chatReport` read `{ round, answer }`, and every fixture
  // built the second shape by hand. (Codex, #109 round 4.)
  const root = tmpRoot();
  const ordinary = writeAndRead(root, PR, 2, answer());
  const text = chatReport(ordinary, { askedModel: "claude-fable-5-1" });
  assert.ok(text.startsWith("**Translation — round 2: agrees with the builder's account**"));
  assert.doesNotMatch(text, /undefined/);

  const fin = writeAndRead(root, PR, 3, answer(finalSections), { finalRound: true });
  const finText = chatReport(fin);
  assert.ok(finText.startsWith("**Translation — round 3: agrees with the builder's account**"));
  assert.match(finText, /\*\*Shipping unfixed\*\*/);
  assert.match(finText, /\*\*What actually landed\*\*/);
  assert.doesNotMatch(finText, /undefined/);
});

test("every delivery failure reaches chatReport as a FAILED round, never as a benign state", () => {
  // A failed read used to render as "no builder account yet -- the round was
  // unanswered when this was read": a failure wearing a benign state's
  // clothes, the third instance on this PR. (Codex, #109 round 4.)
  const root = tmpRoot();
  const missing = readAnswer(root, PR, 4, { finalRound: false });
  assert.deepEqual(Object.keys(missing).sort(), ["failed", "pr", "reason", "round"]);
  assert.match(missing.reason, /wrote no answer file/);
  let text = chatReport(missing);
  assert.ok(text.startsWith("**Translation — round 4: translation failed — the translator wrote no answer file"));
  assert.doesNotMatch(text, /undefined|no builder account|agrees/);

  fs.writeFileSync(prepareAnswerPath(root, PR, 4), "not json at all");
  text = chatReport(readAnswer(root, PR, 4, { finalRound: false }));
  assert.match(text, /^\*\*Translation — round 4: translation failed — the answer file is not valid JSON/);

  fs.writeFileSync(prepareAnswerPath(root, PR, 4), JSON.stringify({ about: "x" }));
  text = chatReport(readAnswer(root, PR, 4, { finalRound: false }));
  assert.match(text, /^\*\*Translation — round 4: translation failed — the answer did not match the expected shape/);
  assert.match(text, /No independent account of this round exists/);
});

test("a finalRound flag that differs between dispatch and read is named, not reported as a bad answer", () => {
  // The flag is supplied by hand twice; a mismatch renders a VALID answer as a
  // failed round, and "did not match the expected shape" points at the
  // translator. (Fable, 2026-09-16.)
  const root = tmpRoot();
  const readAsOrdinary = writeAndRead(root, PR, 6, answer(finalSections));
  assert.equal(readAsOrdinary.failed, true);
  assert.match(readAsOrdinary.reason, /written for the final round but read as an ordinary one/);
  assert.match(readAsOrdinary.reason, /finalRound flag differs/);
  const readAsFinal = writeAndRead(root, PR, 7, answer(), { finalRound: true });
  assert.match(readAsFinal.reason, /written for an ordinary round but read as the final one/);
  // A genuinely bad answer is still reported as one, even on a final round.
  const bad = writeAndRead(root, PR, 8, answer({ ...finalSections, model: "" }), { finalRound: true });
  assert.match(bad.reason, /did not match the expected shape/);
});

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

test("agrees is printed only when nothing was left unassessed", () => {
  assert.equal(chatLine(round(1, answer())), "round 1: agrees with the builder's account");
  assert.equal(
    chatLine(round(1, answer({ could_not_assess: "The diff was cut before the second file." }))),
    "round 1: partial — something could not be assessed",
  );
});

test("on an answered round any disagreement wins over both, and is counted", () => {
  assert.equal(chatLine(round(2, answer({ disagreements: [disagreement] }))), "round 2: differs on 1 point");
  assert.equal(
    chatLine(round(2, answer({ disagreements: [disagreement, { what: "c", why_it_matters: "d" }], could_not_assess: "also this" }))),
    "round 2: differs on 2 points",
  );
});

test("the favourable line needs the translator to have SEEN a builder reply", () => {
  // `answered` used to be read off a receipt field whose only writer was the
  // record builder the #89 cut deleted, so every round read as answered.
  assert.equal(
    chatLine(round(1, answer({ builder_answered: false }))),
    "round 1: no builder account yet — the round was unanswered when this was read",
  );
  const { builder_answered, ...withoutField } = answer();
  assert.equal(facts(round(1, withoutField)).answered, false);
});

test("an unanswered round never has a position attributed to the builder", () => {
  // The role may raise "a risk nobody named" on a round nobody has replied to,
  // and the old order printed "differs on 1 point" plus "Where it disagrees
  // with the builder" over `builder_answered: false`. (Codex, #109 round 4.)
  const a = answer({ builder_answered: false, disagreements: [disagreement] });
  assert.equal(chatLine(round(3, a)), "round 3: no builder account yet — the translator raises 1 concern of its own");
  const text = chatReport(round(3, a));
  assert.match(text, /\*\*Concerns the translator raises on its own — the builder has not replied\*\* \(1\)/);
  assert.doesNotMatch(text, /disagrees with the builder|differs on/);
  // The concern itself still renders in full: mislabelling it would be bad,
  // suppressing it worse.
  assert.ok(text.includes(disagreement.what));
  assert.ok(text.includes(disagreement.why_it_matters));
  assert.equal(
    chatLine(round(3, answer({ builder_answered: false, disagreements: [disagreement], could_not_assess: "x" }))),
    "round 3: no builder account yet — the translator raises 1 concern of its own, and something could not be assessed",
  );
  assert.equal(
    chatLine(round(3, answer({ builder_answered: false, could_not_assess: "x" }))),
    "round 3: no builder account yet — partial, something could not be assessed",
  );
});

test("the verdict line and the section wording name the same fact in every state", () => {
  // Four times this component has paid for two claim sites reading different
  // facts (#81 round 8; #109 rounds 2, 3, 4). Enumerate every cell rather
  // than the reported one.
  const evaluative = /\b(good|fine|clean|reasonable|correct|safe|agrees?)\b/i;
  for (const answered of [true, false]) {
    for (const unassessed of [false, true]) {
      for (const n of [0, 1, 2]) {
        const a = answer({
          builder_answered: answered,
          could_not_assess: unassessed ? "One thread could not be fetched." : null,
          disagreements: Array.from({ length: n }, (_, i) => ({ what: `W${i}`, why_it_matters: `M${i}` })),
        });
        const line = chatLine(round(1, a));
        const text = chatReport(round(1, a));
        const label = `answered=${answered} unassessed=${unassessed} n=${n}`;
        if (!answered) {
          assert.match(line, /no builder account yet/, label);
          assert.doesNotMatch(text, /disagrees with the builder|differs on|agrees with/, label);
          if (n) assert.match(text, /Concerns the translator raises on its own — the builder has not replied\*\* \(\d\)/, label);
          else assert.match(text, /No concerns of its own reported; there is no builder account yet to disagree with/, label);
        } else if (n) {
          assert.match(line, new RegExp(`differs on ${n} point`), label);
          assert.match(text, new RegExp(`Where it disagrees with the builder\\*\\* \\(${n}\\)`), label);
        } else {
          assert.match(line, unassessed ? /partial/ : /agrees with the builder's account/, label);
          assert.match(text, unassessed ? /No disagreements reported on what could be assessed/ : /No disagreements reported with the builder's account/, label);
        }
        // "agrees" appears in the headline only in the one cell that earns it.
        assert.equal(/agrees/.test(line), answered && !unassessed && n === 0, label);
        // The empty-case label states a value and evaluates nothing.
        if (n === 0) {
          const emptyLine = text.split("\n").find((l) => /reported/.test(l));
          assert.doesNotMatch(emptyLine, evaluative, label);
        }
        // Partial is never silent.
        assert.equal(/Could not assess:/.test(text), unassessed, label);
      }
    }
  }
});

test("a failed round is its own state and is never reported as a quiet one", () => {
  const f = { pr: PR, round: 3, failed: true, reason: "the answer file never arrived" };
  assert.equal(facts(f).failed, true);
  assert.equal(facts(f).skipped, false);
  assert.match(chatLine(f), /^round 3: translation failed — the answer file never arrived$/);
  const skipped = { pr: PR, round: 4, skipped: true, reason: "the dispatch was refused: Agent type not found" };
  assert.match(chatLine(skipped), /^round 4: skipped — the dispatch was refused/);
  // Failure to launch and failure to answer are told apart in the report.
  assert.match(chatReport(skipped), /was not dispatched for this round — the dispatch was refused/);
  assert.match(chatReport(f), /was dispatched and produced nothing usable/);
});

// ---------------------------------------------------------------------------
// The deliverable
// ---------------------------------------------------------------------------

test("the chat report is the translator's words, not the builder's summary of them", () => {
  const a = answer({ disagreements: [disagreement] });
  const text = chatReport(round(2, a), { askedModel: "claude-fable-5-1" });

  // Every prose field appears VERBATIM. This is the one property worth having
  // machinery for: a builder-written summary of an independent account is just
  // the builder's account again.
  assert.ok(text.includes(a.recommendation));
  assert.ok(text.includes(a.about));
  for (const x of a.findings) {
    assert.ok(text.includes(x.raised));
    assert.ok(text.includes(x.done));
  }
  assert.ok(text.includes(a.disagreements[0].what));
  assert.ok(text.includes(a.disagreements[0].why_it_matters));
  // And the verdict leads, so the headline cannot disagree with the body.
  assert.ok(text.startsWith("**Translation — round 2: differs on 1 point**"));
  // The builder's thread shorthand never reaches David.
  assert.doesNotMatch(text, /Class:|Worth:|Oracle:/);
});

test("a failed report says nobody explained the round, not that it was quiet", () => {
  const text = chatReport({ pr: PR, round: 3, failed: true, reason: "the answer file never arrived" });
  assert.match(text, /No independent account of this round exists/);
  assert.match(text, /not a report that the round was quiet/);
  // It must not borrow the quiet-round wording, which would be a false clean
  // bill of health.
  assert.doesNotMatch(text, /agrees/);
});

test("the final round's sections render, and a disputed gap is marked as disputed", () => {
  const a = answer({
    known_gaps: [
      { what: "A mistyped flag is not caught.", reasonable: true, why: "You type it yourself." },
      { what: "The retry can loop twice.", reasonable: false, why: "I think this one should have been fixed." },
    ],
    what_landed: finalSections.what_landed,
  });
  const text = chatReport(round(9, a));
  assert.match(text, /\*\*Shipping unfixed\*\*/);
  assert.match(text, /\*\*Not reasonable\*\*: The retry can loop twice/);
  assert.match(text, /Reasonable: A mistyped flag/);
  assert.match(text, /\*\*What actually landed\*\*/);
  assert.ok(text.includes("It does not judge anything."));
  assert.ok(text.includes("That the translator read the whole diff."));
});

test("an empty gaps list on the final round renders an explicit result", () => {
  // The schema calls `known_gaps: []` "a real answer", and a length check
  // rendered nothing for it -- so David could not tell "nothing is shipping
  // unfixed" from "gaps were never assessed", with no side channel left
  // because builder prose around the report is forbidden. (Codex, #109
  // round 4.) The label is qualified when the assessment was partial.
  const text = chatReport(round(9, answer({ ...finalSections, known_gaps: [] })));
  assert.match(text, /\*\*Shipping unfixed\*\*\n\n\*No known gaps reported\.\*/);
  const partial = chatReport(round(9, answer({ ...finalSections, known_gaps: [], could_not_assess: "one thread" })));
  assert.match(partial, /\*No known gaps reported on what could be assessed\.\*/);
});

test("an ordinary round's report carries none of the final-round sections", () => {
  const text = chatReport(round(2, answer()));
  assert.doesNotMatch(text, /Shipping unfixed|What actually landed|known gaps/);
});

test("the model is mentioned only when it is worth a reader's attention", () => {
  // Silent on a match: a line on every round saying the model was right trains
  // a reader to skip the place the real notice would appear.
  assert.doesNotMatch(chatReport(round(1, answer()), { askedModel: "claude-fable-5-1" }), /Written by|did not report which model/);
  // THE PIN IS NOT WHAT WAS ASKED FOR, and this line used to say it was. The
  // Agent tool takes the family alias, never a version, so a disagreement
  // between the pin and what answered is most often the pin trailing the alias
  // -- David's one-line edit -- rather than a substitution he cannot fix.
  // Naming the likelier cause first is the whole value of the notice.
  // (Astra, #131 round 2.)
  // BOTH FAMILIES, because round 2 wrote one explanation for two opposite
  // situations and got the more important one backwards. The alias `fable`
  // cannot resolve to an Opus or Sonnet model, so when the families differ the
  // pin CANNOT be the cause -- and the round-2 wording ruled out the only
  // remaining explanation by name, on David's own content-refusal case.
  const crossFamily = chatReport(round(1, answer({ model: "claude-sonnet-5" })), { askedModel: "claude-fable-5-1" });
  assert.match(crossFamily, /Written by claude-sonnet-5; this repository pins claude-fable-5-1/);
  assert.match(crossFamily, /cannot resolve to claude-sonnet-5, so the pin does not explain this/);
  assert.match(crossFamily, /content refusal/);
  assert.doesNotMatch(crossFamily, /pin trailing|drifted apart/, "the pin was blamed for a cross-family answer");

  const sameFamily = chatReport(round(1, answer({ model: "claude-fable-5-0" })), { askedModel: "claude-fable-5-1" });
  assert.match(sameFamily, /sends the family alias `fable`, not a version/);
  assert.match(sameFamily, /one likely explanation/, "a possible cause was stated as the established one");
  assert.match(sameFamily, /drifted apart/);
  // Direction-neutral: the pin can sit ahead of the alias as easily as behind,
  // and this same sentence covers both, so "trailing" was wrong for half of them.
  assert.doesNotMatch(sameFamily, /trailing|behind/);
  assert.doesNotMatch(sameFamily, /asked for/);

  // A pin that is not a Claude id has no alias to name, and the line says the
  // rest rather than printing an empty one.
  const noAlias = chatReport(round(1, answer({ model: "x-1" })), { askedModel: "gpt-6-astra" });
  assert.match(noAlias, /Written by x-1; this repository pins gpt-6-astra/);
  assert.doesNotMatch(noAlias, /family alias/);

  assert.match(chatReport(round(1, answer({ model: null })), { askedModel: "claude-fable-5-1" }), /did not report which model wrote it/);
});

// ---------------------------------------------------------------------------
// The report's order and the findings list (David, 2026-09-17)
// ---------------------------------------------------------------------------

test("the report is ordered by what David does with it: about, the ask, disagreements, findings", () => {
  // Revised 2026-09-19 on his reading of a live report. `about` leads, so he
  // knows which round he is looking at before he is told what to do; the ask
  // follows. Two sections are gone and their ABSENCE is asserted, because a
  // renderer that quietly keeps printing what was cut is the failure here:
  // the paragraph justifying the recommendation ("I don't care that you
  // checked everything. I assume you did") and the trust footer ("I trust
  // you"). The order is asserted, not just the presence of each part.
  const a = answer({ disagreements: [disagreement] });
  const text = chatReport(round(2, a));
  const at = (needle) => {
    const i = text.indexOf(needle);
    assert.ok(i >= 0, `missing: ${needle}`);
    return i;
  };
  const headline = at("**Translation — round 2");
  const about = at(a.about);
  const needs = at(`**Needs you:** ${a.recommendation}`);
  const differs = at("**Where it disagrees with the builder** (1)");
  const findings = at("**Findings** (2 raised: 1 fixed, 1 declined)");
  assert.ok(headline < about && about < needs && needs < differs && differs < findings);
  assert.doesNotMatch(text, /Taken on trust/, "the trust footer was cut and is still printing");
  assert.doesNotMatch(text, /\*About:\*/, "About moved to the top; the old footer label survived");
  assert.doesNotMatch(text, /\bD0\b/, "the role is called Translation now");
  // The recommendation appears once, at the top, and never as a closing line.
  assert.equal(text.split(a.recommendation).length - 1, 1);
});

test("what the report stops showing David is still collected for the next round", () => {
  // `took_on_trust` has two consumers and only one of them is David. He asked
  // for the section to go; the FIELD stays, because roundBrief renders it into
  // a later round's prior-accounts block as the list worth rechecking (Codex
  // #109 round 8). Dropping the field would have taken that with it.
  const a = answer();
  assert.doesNotMatch(chatReport(round(2, a)), /Taken on trust/);
  assert.deepEqual(validateAnswer({ ...a, took_on_trust: undefined }, { finalRound: false }).length > 0, true);
});

test("every finding is one line carrying its outcome, whether it held, and whether it was overbuilt", () => {
  // One line per finding is what David asked for, so he can see what was
  // written for each -- and OVERBUILT is the flag he reads to stop the builder
  // writing more than a finding is worth. The tag states the outcome and
  // whether it held, and a false `holds` is printed as such, never softened.
  const notBorneOut = { raised: "R-NOT", done: "D-NOT", outcome: "fixed", holds: false, overbuilt: false };
  const badDecline = { raised: "R-BAD", done: "D-BAD", outcome: "declined", holds: false, overbuilt: false };
  const over = { raised: "R-OVER", done: "D-OVER: 134 lines for a constant", outcome: "fixed", holds: true, overbuilt: true };
  const open = { raised: "R-OPEN", done: "Nothing yet.", outcome: "unanswered", holds: null, overbuilt: false };
  assert.equal(findingLine(fixed), `fixed ✓ — ${fixed.raised} ${fixed.done}`);
  assert.equal(findingLine(declined), `declined ✓ holds — ${declined.raised} ${declined.done}`);
  assert.equal(findingLine(notBorneOut), "fixed ✗ not borne out by the code — R-NOT D-NOT");
  assert.equal(findingLine(badDecline), "declined ✗ does not hold — R-BAD D-BAD");
  assert.equal(findingLine(over), "fixed ✓ · **OVERBUILT** — R-OVER D-OVER: 134 lines for a constant");
  assert.equal(findingLine(open), "unanswered — R-OPEN Nothing yet.");

  const text = chatReport(round(3, answer({ findings: [fixed, notBorneOut, badDecline, over, open] })));
  assert.match(text, /\*\*Findings\*\* \(5 raised: 3 fixed, 1 declined, 1 unanswered\)/);
  for (const x of [fixed, notBorneOut, badDecline, over, open]) assert.ok(text.includes(`- ${findingLine(x)}`));
});

test("overbuilt is counted on the headline, in every state, because agreement does not clear it", () => {
  // A fix can do exactly what the reply claims and still be code nobody
  // needed; the headline is what David scans, so the count is there whether
  // the round agrees, differs, is partial or is unanswered.
  const over = { raised: "R", done: "D", outcome: "fixed", holds: true, overbuilt: true };
  const two = [over, { ...over, raised: "R2" }];
  assert.equal(chatLine(round(1, answer({ findings: two }))), "round 1: agrees with the builder's account; 2 overbuilt");
  assert.equal(chatLine(round(1, answer({ findings: two, disagreements: [disagreement] }))), "round 1: differs on 1 point; 2 overbuilt");
  assert.equal(chatLine(round(1, answer({ findings: two, could_not_assess: "one thread" }))), "round 1: partial — something could not be assessed; 2 overbuilt");
  assert.equal(
    chatLine(round(1, answer({ findings: [over], builder_answered: false }))),
    "round 1: no builder account yet — the round was unanswered when this was read; 1 overbuilt",
  );
  // And absent, nothing is appended: a line on every round saying nothing was
  // overbuilt would train him to skip the place the real count appears.
  assert.equal(chatLine(round(1, answer())), "round 1: agrees with the builder's account");
  assert.equal(facts(round(1, answer({ findings: two }))).overbuilt, 2);
});

test("a round that raised no findings renders that as its own explicit result", () => {
  // The same rule as an empty disagreements list: David must be able to tell
  // "nothing was raised" from "the list was never written".
  const text = chatReport(round(4, answer({ findings: [] })));
  assert.match(text, /\*\*Findings\*\* \(none raised\)/);
  assert.doesNotMatch(text, /raised: /);
});

test("a finding's shape is enforced by the schema: the outcome is an enum and every flag is required", () => {
  // The renderer reads `outcome`, `holds` and `overbuilt` to build the line,
  // and an omitted flag would render as the favourable "fixed ✓". So each is
  // required, and an outcome outside the three words is refused.
  const bad = (x) => validateAnswer(answer({ findings: [x] }), { finalRound: false });
  assert.equal(bad(fixed).length, 0);
  assert.ok(bad({ ...fixed, outcome: "resolved" }).some((p) => /not one of/.test(p)));
  for (const k of ["holds", "overbuilt", "outcome", "raised", "done"]) {
    const { [k]: _dropped, ...without } = fixed;
    assert.ok(bad(without).length > 0, `a finding without ${k} was accepted`);
  }
  // And a field the schema no longer knows is refused rather than ignored:
  // `reasoning` was cut on 2026-09-19 and a role still emitting it should be
  // told, not silently rendered away.
  assert.ok(validateAnswer({ ...answer(), reasoning: "x" }, { finalRound: false }).length > 0);
});

test("a finding that did not hold is a point of difference even when the list omits it", () => {
  // The role is told a `holds: false` finding also gets a disagreements
  // entry, but both are model-filled fields and compliance is not a
  // guarantee. Without the entry the round fell through to "agrees with the
  // builder's account" over a fix the translator said was not borne out --
  // the false favourable this module must never print. The written-up list
  // is authoritative when present; the flags are the fallback, never summed
  // with it. (Codex, #119 round 1, P1.)
  const notBorneOut = { raised: "R-NOT", done: "D-NOT", outcome: "fixed", holds: false, overbuilt: false };
  const a = answer({ findings: [fixed, notBorneOut] });
  assert.equal(chatLine(round(2, a)), "round 2: differs on 1 point");
  const text = chatReport(round(2, a));
  assert.doesNotMatch(text, /agrees with the builder|No disagreements reported/);
  // The list is empty, so no heading: the qualified label stands in its place.
  assert.match(text, /\*No disagreement written up, but 1 finding below did not hold\.\*/);
  // Listed AND flagged is the instructed shape and counts once, not twice.
  assert.equal(chatLine(round(2, answer({ findings: [notBorneOut], disagreements: [disagreement] }))), "round 2: differs on 1 point");
  // Unanswered rounds get the same derivation under their own heading.
  assert.match(chatLine(round(2, answer({ findings: [notBorneOut], builder_answered: false }))), /raises 1 concern of its own/);
});

test("agrees is never printed over a finding still unanswered, or over a null holds on a fix or decline", () => {
  // Two more ways the headline could contradict the body (Astra, #119 round
  // 1, written for on David's ruling): `builder_answered: true` with one
  // finding still `unanswered`, and `holds: null` on a fixed or declined
  // finding, which the schema admits and `findingLine` prints as not holding.
  const open = { raised: "R-OPEN", done: "Nothing yet.", outcome: "unanswered", holds: null, overbuilt: false };
  assert.equal(chatLine(round(3, answer({ findings: [fixed, open] }))), "round 3: partial — 1 finding still unanswered");
  const text = chatReport(round(3, answer({ findings: [fixed, open] })));
  assert.doesNotMatch(text, /agrees with the builder/);
  // A written-up disagreement still outranks it, as it outranks "unassessed".
  assert.equal(chatLine(round(3, answer({ findings: [fixed, open], disagreements: [disagreement] }))), "round 3: differs on 1 point");

  for (const outcome of ["fixed", "declined"]) {
    const nullHolds = { ...fixed, outcome, holds: null };
    assert.equal(chatLine(round(3, answer({ findings: [nullHolds] }))), "round 3: differs on 1 point", `${outcome} with null holds`);
    assert.match(findingLine(nullHolds), /✗/);
  }
});

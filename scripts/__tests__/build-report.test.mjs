// SYNCED FROM KITT — do not edit in a consumer repo.
/**
 * The build report's tests. The deliverable is a chat message, so these assert
 * on text. The rule under test throughout: **"agrees" is never printed over an
 * unassessed item**, and the report never says anything the role did not --
 * except the labels. The
 * boundary between the module's functions is exercised with real results
 * (`readAnswer` feeding `chatReport`), never with a report shape built by hand.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  REVIEWS_DIR,
  ROLE,
  answerPath,
  schemaPath,
  prepareAnswerPath,
  dispatchModel,
  buildBrief,
  validateAnswer,
  readAnswer,
  chatReport,
  readUnit,
  unitPath,
  readPrivateSource,
  main,
} from "../build-report.mjs";

const answer = (over = {}) => ({
  what_was_built: "A worker that downloads a session video, probes it and writes a proxy.",
  decisions: [{ choice: "The CI runner is pinned to ubuntu-24.04.", undo: "Revert the pin and bump Playwright.", concern: null }],
  shipping_unfixed: [],
  overbuilt: [],
  disagreements: [],
  next: "Step 2, the logging viewer.",
  took_on_trust: "That CI ran the worker tests; I did not read the logs.",
  could_not_assess: null,
  model: "claude-fable-5-1",
  ...over,
});

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "build-report-"));
const io = { root: "/fake", read: (rel) => (rel === ".agents/machinery.json" ? JSON.stringify({ repo: "Owner/Repo", models: { strongestClaude: { id: "claude-fable-5-1", effort: "xhigh" }, strongestCodex: { id: "gpt-6-astra", effort: "xhigh" } } }) : null) };

const write = (root, unit, a) => {
  const file = prepareAnswerPath(root, unit);
  fs.writeFileSync(file, JSON.stringify(a));
  return file;
};

test("the role and its schema are named consistently", () => {
  assert.equal(ROLE, "fable-build-report");
  assert.ok(fs.existsSync(schemaPath()), schemaPath());
});

test("the answer path is derived from the unit, and a malformed unit is refused before any side effect", () => {
  const root = tmp();
  assert.equal(answerPath(root, "pr-12"), path.join(root, REVIEWS_DIR, "build-pr-12.answer.json"));
  for (const bad of ["", "PR 12", "../x", 12, null]) assert.throws(() => prepareAnswerPath(root, bad), /unit must be/);
  assert.equal(fs.existsSync(path.join(root, REVIEWS_DIR)), false);
});

test("preparing clears a stale answer and keeps the directory ignored", () => {
  const root = tmp();
  write(root, "pr-1", answer());
  prepareAnswerPath(root, "pr-1");
  assert.equal(fs.existsSync(answerPath(root, "pr-1")), false);
  assert.equal(fs.readFileSync(path.join(root, REVIEWS_DIR, ".gitignore"), "utf8"), "*\n");
});

test("the brief carries the coordinates, the answer path and the whole schema inline", () => {
  const root = tmp();
  const brief = buildBrief({ root, unit: "pr-7", issue: 3, issueTitle: "Ingest v2", prs: [7, 8], prTitles: ["Ingest: the parser", "Ingest: the worker"], io, now: () => new Date("2026-10-21T00:00:00Z") });
  assert.match(brief, /`Owner\/Repo`/);
  assert.match(brief, /Workstream issue:\*\* Issue #3 — Ingest v2 — the plan/);
  assert.match(brief, /PR #7 — Ingest: the parser · PR #8 — Ingest: the worker — read each one whole/);
  assert.match(brief, /2026-10-21T00:00:00.000Z/);
  assert.ok(brief.includes(answerPath(root, "pr-7")));
  assert.ok(brief.includes('"what_was_built"'), "the schema travels with the brief");
  assert.match(brief, /no tool that can open a file/);
  assert.doesNotMatch(brief, /paid-ai-ledger|Spend so far/, "the build report carries no spend (David, 2026-11-04)");
});

test("a branch-regime prototype version is a unit with no pull request", () => {
  const brief = buildBrief({ root: tmp(), unit: "proto-v2", issue: 4, issueTitle: "Ingest prototype", branch: { name: "prototype/ingest", since: "0ld0001", head: "abc1234" }, io });
  assert.match(brief, /prototype\/ingest/);
  assert.match(brief, /from after `0ld0001` through `abc1234`/);
  assert.match(brief, /merged into the branch/, "merged-in main commits are named as not this version's work");
  assert.doesNotMatch(brief, /previous build report|branch began/, "the role is never sent looking for an unrecorded boundary");
  assert.doesNotMatch(brief, /Pull requests:/);
});

test("a unit with no evidence, no issue, or a half-stated branch is refused", () => {
  const root = tmp();
  const t = { issueTitle: "T", prTitles: ["t"] };
  assert.throws(() => buildBrief({ root, unit: "x", issue: 1, issueTitle: "T", io }), /needs its evidence/);
  assert.throws(() => buildBrief({ root, unit: "x", prs: [1], ...t, io }), /no workstream issue and no private source .* --private-source/);
  assert.throws(() => buildBrief({ root, unit: "x", prs: [1], ...t, privateSource: "  ", io }), /private source is empty/);
  assert.throws(() => buildBrief({ root, unit: "x", issue: 0, prs: [1], ...t, io }), /issue must be/);
  assert.throws(() => buildBrief({ root, unit: "x", issue: 1, issueTitle: "T", branch: { name: "p" }, io }), /branch must be/);
  assert.throws(() => buildBrief({ root, unit: "x", issue: 1, issueTitle: "T", branch: { name: "p", head: "h" }, io }), /since/, "a branch unit without its lower bound is refused");
  assert.throws(() => buildBrief({ root, unit: "x", issue: 1, issueTitle: "T", prs: ["7"], prTitles: ["t"], io }), /pull request number/);
});

test("a number without its title is refused: the report names the unit to David (interaction rule 14)", () => {
  const root = tmp();
  assert.throws(() => buildBrief({ root, unit: "x", issue: 1, prs: [7], prTitles: ["t"], io }), /--issue-title/);
  assert.throws(() => buildBrief({ root, unit: "x", issue: 1, issueTitle: " ", prs: [7], prTitles: ["t"], io }), /--issue-title/, "whitespace is not a title");
  assert.throws(() => buildBrief({ root, unit: "x", issue: 1, issueTitle: "T", prs: [7, 8], prTitles: ["t"], io }), /every --pr needs its --pr-title/, "one title short");
  assert.throws(() => buildBrief({ root, unit: "x", issue: 1, issueTitle: "T", prs: [7], prTitles: ["t", "u"], io }), /every --pr needs its --pr-title/, "one title over");
  assert.throws(() => buildBrief({ root, unit: "x", issue: 1, issueTitle: "T", prs: [7], prTitles: [""], io }), /every --pr needs its --pr-title/);
  assert.equal(fs.existsSync(unitPath(root, "x")), false, "a refused brief records no coordinates");
});

test("a valid answer validates, and a missing section does not", () => {
  assert.deepEqual(validateAnswer(answer()), []);
  const { next, ...noNext } = answer();
  assert.ok(validateAnswer(noNext).length > 0);
  assert.ok(validateAnswer(answer({ needs_you: "x" })).length > 0, "the retired Needs you line is refused");
  assert.ok(validateAnswer({ ...answer(), spend: { build_total: "$1", paid_runs_this_week: null } }).length > 0, "a retired spend section is refused");
  assert.ok(validateAnswer(answer({ could_not_assess: "   " })).some((p) => /blank/.test(p)));
});

test("no file, bad JSON and a schema-invalid answer are each a visible failure", () => {
  const root = tmp();
  prepareAnswerPath(root, "u");
  const none = readAnswer(root, "u");
  assert.equal(none.failed, true);
  assert.match(chatReport(none), /report failed/);
  assert.match(chatReport(none), /not a sign that the work was quiet/);
  fs.writeFileSync(answerPath(root, "u"), "{");
  assert.match(readAnswer(root, "u").reason, /not valid JSON/);
  fs.writeFileSync(answerPath(root, "u"), JSON.stringify({ what_was_built: "x" }));
  assert.match(readAnswer(root, "u").reason, /expected shape/);
});

test("agrees only when nothing differs, and never plainly over something it could not check", () => {
  const root = tmp();
  write(root, "a", answer());
  assert.match(chatReport(readAnswer(root, "a")), /\*\*Agrees\*\* with the builder's account\./);
  write(root, "b", answer({ could_not_assess: "The branch's last commit could not be fetched." }));
  const partial = chatReport(readAnswer(root, "b"));
  assert.match(partial, /Agrees, as far as it could check/);
  assert.match(partial, /\*Caveat:\* It could not check everything: The branch's last commit/);
  write(root, "c", answer({ disagreements: [{ what: "Said fixed; is not.", why_it_matters: "It still breaks." }] }));
  const differs = chatReport(readAnswer(root, "c"));
  assert.match(differs, /\*\*Where it disagrees with the builder\*\*\n\n- \*\*Said fixed; is not\.\*\* — It still breaks\./);
  assert.doesNotMatch(differs, /Agrees/);
});

test("the report is short: what was built, the verdict and the next step, with nothing else when nothing else holds", () => {
  const root = tmp();
  write(root, "q", answer());
  const text = chatReport(readAnswer(root, "q"), { askedModel: "claude-fable-5-1" });
  assert.equal(text, [
    "**Build report — q**",
    "",
    "A worker that downloads a session video, probes it and writes a proxy.",
    "",
    "**Agrees** with the builder's account.",
    "",
    "**Next:** Step 2, the logging viewer.",
  ].join("\n"));
  assert.doesNotMatch(text, /Needs you|Session|Evidence|Where we are|Revert the pin|did not read the logs/, "retired sections, unquestioned decisions and took_on_trust are not shown");
});

test("only questioned decisions, unreasonable unfixed items and overbuilt work appear, in order", () => {
  const root = tmp();
  write(root, "e1", answer({
    decisions: [
      { choice: "Quiet choice.", undo: "u0", concern: null },
      { choice: "The URL shape is fixed.", undo: "Revert it.", concern: "It locks in the URL shape." },
    ],
    shipping_unfixed: [
      { what: "A slow page.", reasonable: true, why: "Rare." },
      { what: "A crash on empty video.", reasonable: false, why: "Users hit it." },
    ],
    overbuilt: ["A config key for a constant."],
    could_not_assess: "One commit could not be fetched.",
  }));
  const loud = chatReport(readAnswer(root, "e1"));
  const order = ["**Decisions it questions**", "**Should not have shipped unfixed**", "**Overbuilt**", "*Caveat:*", "**Next:**"];
  let at = -1;
  for (const h of order) {
    const i = loud.indexOf(h);
    assert.ok(i > at, `${h} out of order`);
    at = i;
  }
  assert.match(loud, /- \*\*The URL shape is fixed\.\*\* — It locks in the URL shape\. · undo: Revert it\./);
  assert.match(loud, /- \*\*A crash on empty video\.\*\* — Users hit it\./);
  assert.doesNotMatch(loud, /Quiet choice|A slow page/);
  assert.match(loud, /No dispute with the builder's account\*\*, but see its concerns below/);
  assert.doesNotMatch(loud, /\*\*Agrees/, "never a bold Agrees above a concern");
  for (const over of [
    { decisions: [{ choice: "c", undo: "u", concern: "It locks in the URL shape." }] },
    { shipping_unfixed: [{ what: "A crash.", reasonable: false, why: "Users hit it." }] },
    { overbuilt: ["A config key for a constant."] },
  ]) {
    write(root, "e2", answer(over));
    assert.doesNotMatch(chatReport(readAnswer(root, "e2")), /\*\*Agrees/);
  }
});

test("a model mismatch or absence is a caveat, and a match prints nothing", () => {
  const root = tmp();
  write(root, "e", answer({ model: "claude-opus-5-5" }));
  assert.match(chatReport(readAnswer(root, "e"), { askedModel: "claude-fable-5-1" }), /\*Caveat:\* It was written by claude-opus-5-5, not the claude-fable-5-1 this repository asks for\./);
  write(root, "e", answer({ model: null }));
  assert.match(chatReport(readAnswer(root, "e"), { askedModel: "claude-fable-5-1" }), /did not say which model/);
  write(root, "e", answer());
  assert.doesNotMatch(chatReport(readAnswer(root, "e"), { askedModel: "claude-fable-5-1" }), /Caveat/);
});

test("the dispatch model resolves to an Agent alias", () => {
  assert.deepEqual(dispatchModel(io), { id: "claude-fable-5-1", agentModel: "fable", effort: "xhigh", effortRoute: "definition" });
});

test("the command line prints a brief after preparing, and a report from what was written", () => {
  const root = tmp();
  let out = "";
  const stdout = { write: (s) => (out += s) };
  write(root, "f", answer());
  assert.throws(() => main({ argv: ["brief", "--unit", "f", "--issue", "2", "--pr", "9"], root, io, stdout }), /--issue-title/, "the command line refuses a bare number too");
  main({ argv: ["brief", "--unit", "f", "--issue", "2", "--issue-title", "The workstream", "--pr", "9", "--pr-title", "The change"], root, io, stdout });
  assert.equal(fs.existsSync(answerPath(root, "f")), false, "brief prepares the path, clearing a stale answer");
  assert.match(out, /PR #9 — The change/);
  // Written where the brief prepared it, not through `write`, whose prepare step would clear the coordinates.
  fs.writeFileSync(answerPath(root, "f"), JSON.stringify(answer()));
  out = "";
  main({ argv: ["report", "--unit", "f"], root, io, stdout });
  assert.match(out, /^\*\*Build report — PR #9 — The change\*\*/, "the header names the unit by number and title, from the brief's coordinates");
  assert.match(out, /\*\*Agrees\*\*/);
  assert.throws(() => main({ argv: ["nope"], root, io, stdout }), /unknown command/);
});

test("a branch unit is named by both ends of its range", () => {
  const root = tmp();
  let out = "";
  const stdout = { write: (s) => (out += s) };
  main({ argv: ["brief", "--unit", "v3", "--issue", "4", "--issue-title", "Ingest prototype", "--branch", "prototype/ingest", "--since", "0ld0001", "--head", "abc1234"], root, io, stdout });
  assert.deepEqual(readUnit(root, "v3").branch, { name: "prototype/ingest", since: "0ld0001", head: "abc1234" });
  fs.writeFileSync(answerPath(root, "v3"), JSON.stringify(answer()));
  out = "";
  main({ argv: ["report", "--unit", "v3"], root, io, stdout });
  assert.match(out, /^\*\*Build report — branch `prototype\/ingest` from after `0ld0001` through `abc1234`\*\*/, "both ends: the head is the next version's --since");
  assert.doesNotMatch(out, /private item/);
});

test("the private flag without the relayed source is refused, since the sanitized issue holds no plan", () => {
  const root = tmp();
  assert.throws(
    () => buildBrief({ root, unit: "p0", issue: 5, prs: [12], privatePath: true, io }),
    /--private yes was given without a private source/,
  );
});

test("a private-path unit tells David to keep it in the private item, and preparing clears stale coordinates", () => {
  const root = tmp();
  const stdout = { write: () => {} };
  const src = path.join(os.tmpdir(), `relay-p1-${process.pid}.md`);
  fs.writeFileSync(src, "Plan: x. Decisions: none. Spend so far: $1.\n");
  main({ argv: ["brief", "--unit", "p1", "--issue", "5", "--issue-title", "Payments", "--pr", "12", "--pr-title", "Rotate the keys", "--private", "yes", "--private-source", src], root, io, stdout });
  assert.equal(readUnit(root, "p1").private, true);
  fs.writeFileSync(answerPath(root, "p1"), JSON.stringify(answer()));
  const text = chatReport(readAnswer(root, "p1"), { coords: readUnit(root, "p1") });
  assert.ok(text.indexOf("paste this into its private item") > -1 && text.indexOf("paste this into its private item") < text.indexOf("A worker"), "the keeping note leads");
  prepareAnswerPath(root, "p1");
  assert.equal(fs.existsSync(unitPath(root, "p1")), false);
  assert.match(chatReport(readAnswer(root, "p1"), { coords: null }), /report failed/);
});

test("a workstream private from the start is reported from the relayed source", () => {
  const root = tmp();
  const src = "Plan: rotate the payment keys. Decisions: none yet. Spend so far: $1.20";
  const brief = buildBrief({ root, unit: "priv", prs: [31], prTitles: ["Rotate the keys"], privateSource: src, privateRef: "SEC-7", io });
  assert.doesNotMatch(brief, /Workstream issue/, "no issue is named when there is none");
  assert.match(brief, /Private workstream \(SEC-7\)/);
  assert.match(brief, /fetch no issue for them/);
  assert.ok(brief.includes(`<private-source>\n${src}\n</private-source>`), "the relay is quoted verbatim");
  assert.ok(brief.indexOf("<private-source>") > brief.indexOf("```json"), "the source follows the schema, labelled");
  const coords = readUnit(root, "priv");
  assert.deepEqual(coords, { issue: null, issueTitle: null, prs: [31], prTitles: ["Rotate the keys"], branch: null, private: true, privateSource: true, privateRef: "SEC-7" });
  assert.doesNotMatch(fs.readFileSync(unitPath(root, "priv"), "utf8"), /rotate/, "the relayed text is never written to disk by the script");
  fs.writeFileSync(answerPath(root, "priv"), JSON.stringify(answer()));
  const text = chatReport(readAnswer(root, "priv"), { coords });
  assert.match(text, /David, paste this into its private item to keep it/);
  assert.match(text, /^\*\*Build report — PR #31 — Rotate the keys\*\*/);
});

test("a workstream that turned sensitive keeps its sanitized issue and reads the plan from the relay", () => {
  const root = tmp();
  const brief = buildBrief({ root, unit: "turned", issue: 9, issueTitle: "Payments", prs: [40], prTitles: ["Rotate the keys"], privateSource: "the plan", io });
  assert.match(brief, /Workstream issue:\*\* Issue #9 — Payments — public, and sanitized/);
  assert.equal(readUnit(root, "turned").private, true, "a private source makes the unit private");
});

test("relayed private text is refused when it sits inside the checkout", () => {
  const root = tmp();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "relay-"));
  fs.writeFileSync(path.join(root, "plan.txt"), "secret");
  fs.writeFileSync(path.join(outside, "plan.txt"), "relayed");
  assert.throws(() => readPrivateSource(root, "plan.txt"), /inside the checkout/);
  assert.throws(() => readPrivateSource(root, path.join(root, "plan.txt")), /inside the checkout/);
  assert.equal(readPrivateSource(root, path.join(outside, "plan.txt")), "relayed");
  let out = "";
  main({ argv: ["brief", "--unit", "cli", "--pr", "3", "--pr-title", "The change", "--private-source", path.join(outside, "plan.txt"), "--private-ref", "P-1"], root, io, stdout: { write: (s) => (out += s) } });
  assert.match(out, /<private-source>\nrelayed\n<\/private-source>/);
});

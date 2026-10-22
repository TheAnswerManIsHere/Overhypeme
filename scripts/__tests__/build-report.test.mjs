// SYNCED FROM AI-Handbook — do not edit in a consumer repo.
/**
 * The build report's tests. The deliverable is a chat message, so these assert
 * on text. The rule under test throughout: **"agrees" is never printed over an
 * unassessed item**, and the report never says anything the role did not --
 * except the labels and the builder's own, labelled, session line. The
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
  chatLine,
  chatReport,
  readUnit,
  unitPath,
  main,
} from "../build-report.mjs";

const answer = (over = {}) => ({
  about: "The first version of the session ingest.",
  needs_you: "Nothing needed from you.",
  what_was_built: "A worker that downloads a session video, probes it and writes a proxy.",
  decisions: [{ choice: "The CI runner is pinned to ubuntu-24.04.", undo: "Revert the pin and bump Playwright.", concern: null }],
  ramifications: "Step 2 can now read real proxies.",
  shipping_unfixed: [],
  overbuilt: [],
  disagreements: [],
  spend: { build_total: "$4.10 over 6 turns", paid_runs_this_week: null },
  where_we_are: { planned: "Five steps to a usable ingest.", done: "Step 1 is finished.", next: "Step 2, the logging viewer." },
  what_landed: { does_not_do: "It does not transcribe.", now_trusting: "That the proxy is faithful to the source." },
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
  const brief = buildBrief({ root, unit: "pr-7", issue: 3, prs: [7, 8], io, now: () => new Date("2026-10-21T00:00:00Z") });
  assert.match(brief, /`Owner\/Repo`/);
  assert.match(brief, /Workstream issue:\*\* #3/);
  assert.match(brief, /#7, #8/);
  assert.match(brief, /2026-10-21T00:00:00.000Z/);
  assert.ok(brief.includes(answerPath(root, "pr-7")));
  assert.ok(brief.includes('"what_was_built"'), "the schema travels with the brief");
  assert.match(brief, /no tool that can open a file/);
});

test("a branch-regime prototype version is a unit with no pull request", () => {
  const brief = buildBrief({ root: tmp(), unit: "proto-v2", issue: 4, branch: { name: "prototype/ingest", since: "0ld0001", head: "abc1234" }, io });
  assert.match(brief, /prototype\/ingest/);
  assert.match(brief, /from after `0ld0001` through `abc1234`/);
  assert.match(brief, /merged into the branch/, "merged-in main commits are named as not this version's work");
  assert.doesNotMatch(brief, /previous build report|branch began/, "the role is never sent looking for an unrecorded boundary");
  assert.doesNotMatch(brief, /Pull requests:/);
});

test("a unit with no evidence, no issue, or a half-stated branch is refused", () => {
  const root = tmp();
  assert.throws(() => buildBrief({ root, unit: "x", issue: 1, io }), /needs its evidence/);
  assert.throws(() => buildBrief({ root, unit: "x", prs: [1], io }), /no public issue .* has no build report yet: write the unit up yourself/);
  assert.throws(() => buildBrief({ root, unit: "x", issue: 0, prs: [1], io }), /issue must be/);
  assert.throws(() => buildBrief({ root, unit: "x", issue: 1, branch: { name: "p" }, io }), /branch must be/);
  assert.throws(() => buildBrief({ root, unit: "x", issue: 1, branch: { name: "p", head: "h" }, io }), /since/, "a branch unit without its lower bound is refused");
  assert.throws(() => buildBrief({ root, unit: "x", issue: 1, prs: ["7"], io }), /pull request number/);
});

test("a valid answer validates, and a missing section does not", () => {
  assert.deepEqual(validateAnswer(answer()), []);
  const { spend, ...noSpend } = answer();
  assert.ok(validateAnswer(noSpend).length > 0);
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
  fs.writeFileSync(answerPath(root, "u"), JSON.stringify({ about: "x" }));
  assert.match(readAnswer(root, "u").reason, /expected shape/);
});

test("agrees only when nothing differs, nothing is unreasonable, no decision is questioned and all was assessed", () => {
  const root = tmp();
  write(root, "a", answer());
  assert.equal(chatLine(readAnswer(root, "a")), "a: agrees with the builder's account");
  const cases = [
    [{ could_not_assess: "The branch's last commit could not be fetched." }, /partial/],
    [{ disagreements: [{ what: "Said fixed; is not.", why_it_matters: "It still breaks." }] }, /differs on 1 point/],
    [{ shipping_unfixed: [{ what: "A crash on empty video.", reasonable: false, why: "Users hit it." }] }, /1 not reasonable to ship/],
    [{ decisions: [{ choice: "c", undo: "u", concern: "It locks in the URL shape." }] }, /1 decision questioned/],
    [{ overbuilt: ["A config key for a constant."] }, /1 overbuilt/],
  ];
  for (const [over, re] of cases) {
    write(root, "b", answer(over));
    const line = chatLine(readAnswer(root, "b"));
    assert.match(line, re);
    assert.doesNotMatch(line, /agrees/);
  }
});

test("the report prints the fixed sections in order, in the role's words", () => {
  const root = tmp();
  write(root, "c", answer());
  const text = chatReport(readAnswer(root, "c"), { askedModel: "claude-fable-5-1" });
  const order = ["**Needs you:**", "**What was built**", "**Decisions taken on my recommendation**", "**Ramifications**", "**Shipping unfixed**", "**Where it disagrees with the builder**", "**Spend**", "**Where we are**", "*Does not do:*", "**Session**"];
  let at = -1;
  for (const h of order) {
    const i = text.indexOf(h);
    assert.ok(i > at, `${h} out of order`);
    at = i;
  }
  assert.ok(text.includes("Revert the pin and bump Playwright."));
  assert.ok(text.includes("$4.10 over 6 turns"));
  assert.match(text, /no paid-run ledger in this repository/);
  assert.doesNotMatch(text, /took_on_trust|did not read the logs/, "took_on_trust is collected, not shown");
  assert.doesNotMatch(text, /Written by/, "a matching model prints nothing");
});

test("the session line is the builder's and is labelled so, or says it was not stated", () => {
  const root = tmp();
  write(root, "d", answer());
  const r = readAnswer(root, "d");
  assert.match(chatReport(r, { session: { verdict: "hand off", why: "the next unit is a different area" } }), /\*\*Session\*\* \(the builder's call\): hand off — the next unit is a different area/);
  assert.match(chatReport(r), /\(the builder's call\): \*not stated\.\*/);
  assert.match(chatReport(r, { session: { verdict: "sure" } }), /not stated/);
});

test("a model mismatch is named, with the family-aware explanation", () => {
  const root = tmp();
  write(root, "e", answer({ model: "claude-opus-5-5" }));
  assert.match(chatReport(readAnswer(root, "e"), { askedModel: "claude-fable-5-1" }), /a different model answered/);
  write(root, "e", answer({ model: null }));
  assert.match(chatReport(readAnswer(root, "e"), { askedModel: "claude-fable-5-1" }), /did not say which model/);
});

test("the dispatch model resolves to an Agent alias", () => {
  assert.deepEqual(dispatchModel(io), { id: "claude-fable-5-1", agentModel: "fable", effort: "xhigh", effortRoute: "definition" });
});

test("the command line prints a brief after preparing, and a report from what was written", () => {
  const root = tmp();
  let out = "";
  const stdout = { write: (s) => (out += s) };
  write(root, "f", answer());
  main({ argv: ["brief", "--unit", "f", "--issue", "2", "--pr", "9"], root, io, stdout });
  assert.equal(fs.existsSync(answerPath(root, "f")), false, "brief prepares the path, clearing a stale answer");
  assert.match(out, /#9/);
  write(root, "f", answer());
  out = "";
  main({ argv: ["report", "--unit", "f", "--session", "continue"], root, io, stdout });
  assert.match(out, /^\*\*Build report — f: agrees/);
  assert.match(out, /\(the builder's call\): continue/);
  assert.throws(() => main({ argv: ["nope"], root, io, stdout }), /unknown command/);
});

test("the report names the evidence the brief carried, both ends of a branch range included", () => {
  const root = tmp();
  let out = "";
  const stdout = { write: (s) => (out += s) };
  main({ argv: ["brief", "--unit", "v3", "--issue", "4", "--branch", "prototype/ingest", "--since", "0ld0001", "--head", "abc1234"], root, io, stdout });
  assert.deepEqual(readUnit(root, "v3").branch, { name: "prototype/ingest", since: "0ld0001", head: "abc1234" });
  fs.writeFileSync(answerPath(root, "v3"), JSON.stringify(answer()));
  out = "";
  main({ argv: ["report", "--unit", "v3"], root, io, stdout });
  assert.match(out, /\*Evidence:\* workstream #4 · branch `prototype\/ingest` from after `0ld0001` through `abc1234`/);
  assert.doesNotMatch(out, /chat only/);
});

test("a private-path unit is marked for chat-only delivery, and preparing clears stale coordinates", () => {
  const root = tmp();
  const stdout = { write: () => {} };
  main({ argv: ["brief", "--unit", "p1", "--issue", "5", "--pr", "12", "--private", "yes"], root, io, stdout });
  assert.equal(readUnit(root, "p1").private, true);
  fs.writeFileSync(answerPath(root, "p1"), JSON.stringify(answer()));
  const text = chatReport(readAnswer(root, "p1"), { coords: readUnit(root, "p1") });
  assert.ok(text.indexOf("chat only, never as an issue comment") < text.indexOf("**Needs you:**"), "the delivery warning leads");
  prepareAnswerPath(root, "p1");
  assert.equal(fs.existsSync(unitPath(root, "p1")), false);
  assert.match(chatReport(readAnswer(root, "p1"), { coords: null }), /report failed/);
});

test("a report read without its brief's coordinates says so", () => {
  const root = tmp();
  write(root, "q", answer());
  assert.match(chatReport(readAnswer(root, "q"), { coords: null }), /Evidence:\* \*not recorded/);
});

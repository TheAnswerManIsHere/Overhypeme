// SYNCED FROM KITT — do not edit in a consumer repo. Local edits are overwritten by the next sync and their reasoning is lost; change KITT instead.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  decide, evaluate, client, prNumber, sameCommit, exemptClass, parseAssessment, findingsRounds, WAIVER_LABEL, CONTEXT,
} from "../review-gate.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const CODEX = { login: "chatgpt-codex-connector[bot]" };
const OWNER = { login: "TheAnswerManIsHere" };

const findingsReview = (id, sha, at) => ({
  id, user: CODEX, submitted_at: at, state: "COMMENTED",
  body: `<!-- codex-review-receipt:v1 -->\n\n### 💡 Codex Review\n\nHere are some automated review suggestions for this pull request.\n\n**Reviewed commit:** \`${sha}\`\n`,
});
const assessment = (who, round, sha, ids, at, { followUp, failed } = {}) => ({
  id: Math.floor(Math.random() * 1e9), created_at: at, user: OWNER,
  body: failed
    ? `## ${who} — round ${round}: **dispatch failed**\n\nNo independent assessment from ${who} exists for this round: timeout.`
    : `## ${who} — round ${round}${followUp ? `, follow-up ${followUp}` : ""}\n\n*Assessed at \`${sha}\` · findings ${ids.map((i) => `\`${i}\``).join(", ")} · requested \`x\` at \`xhigh\`*\n\nOracle met at this head: no\n\nBody mentioning findings \`999\` elsewhere.`,
});
const pushes = (from, ...events) => ({ from, events: events.map(([at, after, type = "push"]) => ({ type, at, before: "0", after })) });

// Overhype.me PR #915 — Image tracing, increment 2: the regression record
// (findings review 01:56:30, push 02:00:12, clean receipt 02:03 as an issue
// comment, assessments 03:16). Ids and times as read from GitHub.
const pr915 = () => ({
  body: "## Summary\n...\nWorkstream: #912\n",
  labels: [],
  reviews: [
    findingsReview(5852633202, "139cadbd65", "2026-11-11T01:56:30Z"),
    { id: 5852668693, user: OWNER, submitted_at: "2026-11-11T02:00:20Z", body: "" },
  ],
  reviewComments: [
    { id: 4533006674, pull_request_review_id: 5852633202 },
    { id: 4533006667, pull_request_review_id: 5852633202 },
    { id: 4533100000, pull_request_review_id: 5852668693 },
  ],
  comments: [
    { id: 1, created_at: "2026-11-11T02:03:00Z", user: CODEX, body: "<!-- codex-review-receipt:v1 -->\n\nCodex Review: Didn't find any major issues.\n\n**Reviewed commit:** `8cbfd3837e`\n" },
    assessment("Astra", 1, "139cadbd65e521b8a8feb166715c75724cea4be6", ["4533006674", "4533006667"], "2026-11-11T03:16:22Z"),
    assessment("Fable", 1, "139cadbd65e521b8a8feb166715c75724cea4be6", ["4533006674", "4533006667"], "2026-11-11T03:16:49Z"),
  ],
  pushes: pushes("2026-11-10T22:37:47Z",
    ["2026-11-10T22:37:47Z", "b1182a0", "branch_creation"],
    ["2026-11-11T01:48:46Z", "139cadb"],
    ["2026-11-11T01:57:57Z", "9e438b1"],
    ["2026-11-11T02:00:12Z", "8cbfd38"]),
});

test("#915's real sequence fails, naming the pushes that preceded both assessments", () => {
  const r = decide(pr915());
  assert.equal(r.state, "failure");
  assert.match(r.description, /round at 139cadb: push `9e438b1` at 2026-11-11T01:57:57Z preceded the Astra and Fable assessments/);
  assert.ok(r.lines.some((l) => /8cbfd38/.test(l)), "the 02:00 push is listed too");
  assert.ok(r.lines.some((l) => /cannot repair a push already made/.test(l)), "the recovery is the waiver, not a late assessment");
});

test("#915 before the assessments existed fails as missing", () => {
  const f = pr915();
  f.comments = f.comments.slice(0, 1);
  f.pushes.events = f.pushes.events.slice(0, 2);
  const r = decide(f);
  assert.equal(r.state, "failure");
  assert.match(r.description, /Astra and Fable missing/);
});

test("a compliant two-round sequence passes", () => {
  const f = {
    body: "", labels: [],
    reviews: [findingsReview(1, "aaaaaaaaaa", "2026-01-01T01:00:00Z"), findingsReview(2, "bbbbbbbbbb", "2026-01-01T03:00:00Z")],
    reviewComments: [{ id: 11, pull_request_review_id: 1 }, { id: 21, pull_request_review_id: 2 }, { id: 22, pull_request_review_id: 2 }],
    comments: [
      assessment("Astra", 1, "aaaaaaaaaaaaaaaa", ["11"], "2026-01-01T01:10:00Z"),
      assessment("Fable", 1, "aaaaaaa", ["11"], "2026-01-01T01:12:00Z"),
      assessment("Fable", 2, "bbbbbbbbbb", ["21", "22"], "2026-01-01T03:05:00Z"),
      assessment("Astra", 2, "bbbbbbbbbbbb", ["21", "22"], "2026-01-01T03:06:00Z"),
    ],
    pushes: pushes("2026-01-01T00:00:00Z",
      ["2026-01-01T00:00:00Z", "aaaaaaa", "branch_creation"],
      ["2026-01-01T02:00:00Z", "bbbbbbb"],
      ["2026-01-01T04:00:00Z", "ccccccc"]),
  };
  const r = decide(f);
  assert.equal(r.state, "success", r.lines.join("\n"));
  assert.equal(r.description, "2 findings rounds assessed in order");
});

const oneRound = (comments, extra = {}) => ({
  body: "", labels: [],
  reviews: [findingsReview(1, "aaaaaaaaaa", "2026-01-01T01:00:00Z")],
  reviewComments: [{ id: 11, pull_request_review_id: 1 }, { id: 12, pull_request_review_id: 1 }],
  comments,
  pushes: pushes("2026-01-01T00:00:00Z", ["2026-01-01T00:00:00Z", "aaaaaaa", "branch_creation"]),
  ...extra,
});

test("a failed dispatch does not count", () => {
  const r = decide(oneRound([
    assessment("Astra", 1, "aaaaaaaaaa", ["11", "12"], "2026-01-01T01:10:00Z"),
    assessment("Fable", 1, null, [], "2026-01-01T01:11:00Z", { failed: true }),
  ]));
  assert.equal(r.state, "failure");
  assert.match(r.description, /Fable missing/);
});

test("an assessment of the wrong commit does not count", () => {
  const r = decide(oneRound([
    assessment("Astra", 1, "aaaaaaaaaa", ["11", "12"], "2026-01-01T01:10:00Z"),
    assessment("Fable", 1, "abbbbbbbbb", ["11", "12"], "2026-01-01T01:11:00Z"),
  ]));
  assert.equal(r.state, "failure");
  assert.match(r.description, /Fable missing/);
});

test("an assessment posted before the review does not count", () => {
  const r = decide(oneRound([
    assessment("Astra", 1, "aaaaaaaaaa", ["11", "12"], "2026-01-01T00:59:00Z"),
    assessment("Fable", 1, "aaaaaaaaaa", ["11", "12"], "2026-01-01T01:11:00Z"),
  ]));
  assert.equal(r.state, "failure");
  assert.match(r.description, /Astra missing/);
});

test("a partial assessment fails; a follow-up covering the rest passes", () => {
  const partial = [
    assessment("Astra", 1, "aaaaaaaaaa", ["11", "12"], "2026-01-01T01:10:00Z"),
    assessment("Fable", 1, "aaaaaaaaaa", ["11"], "2026-01-01T01:11:00Z"),
  ];
  assert.equal(decide(oneRound(partial)).state, "failure");
  const r = decide(oneRound([...partial, assessment("Fable", 1, "aaaaaaaaaa", ["12"], "2026-01-01T01:20:00Z", { followUp: 1 })]));
  assert.equal(r.state, "success", r.lines.join("\n"));
});

test("findings ids are read from the facts line only, not the body", () => {
  const a = parseAssessment(assessment("Astra", 1, "aaaaaaaaaa", ["11"], "2026-01-01T01:10:00Z"));
  assert.deepEqual(a.findings, ["11"]);
});

test("a Documentation pass counts the same way", () => {
  const doc = (who, at) => ({
    id: 5, created_at: at,
    body: `## ${who} — round 1\n\n*Assessed at \`aaaaaaaaaa\` · findings \`11\`, \`12\` · documentation pass over \`0000000..aaaaaaaaaa\` · requested \`x\` at \`xhigh\`*\n\nOracle met at this head: yes`,
  });
  assert.equal(decide(oneRound([doc("Astra", "2026-01-01T01:10:00Z"), doc("Fable", "2026-01-01T01:12:00Z")])).state, "success");
});

test("each exemption line passes, and nothing else exempts", () => {
  for (const c of ["trivial", "sync", "registry", "prototype"]) {
    const r = decide(oneRound([], { body: `Summary\n\nReview class: ${c}\n`, pushes: undefined }));
    assert.equal(r.state, "success");
    assert.equal(r.description, `exempt: ${c}`);
  }
  assert.equal(exemptClass("Review class: documentation"), null);
  assert.equal(exemptClass("This is a trivial change. Review class trivial"), null);
  assert.equal(exemptClass("quoted: `Review class: trivial` inline"), null);
});

test("the waiver label without a reason fails; with a reason it passes", () => {
  const labelled = oneRound([], { labels: [WAIVER_LABEL] });
  const r1 = decide(labelled);
  assert.equal(r1.state, "failure");
  assert.ok(r1.lines[0].includes("does not apply"));
  const r2 = decide({ ...labelled, pushes: undefined, comments: [{ id: 1, created_at: "2026-01-01T02:00:00Z", body: "Review gate waived: Astra sign-in down all day" }] });
  assert.equal(r2.state, "success");
  assert.equal(r2.description, "waived — Astra sign-in down all day");
  const r3 = decide({ ...labelled, comments: [{ id: 1, created_at: "2026-01-01T02:00:00Z", body: "Review gate waived:   " }] });
  assert.equal(r3.state, "failure");
});

test("a waiver label without its reason never sets an exemption aside (KITT #294 round 2)", () => {
  for (const c of ["trivial", "sync", "registry", "prototype"]) {
    for (const comments of [[], [{ id: 1, created_at: "2026-01-01T02:00:00Z", body: "Review gate waived:   " }]]) {
      const r = decide(oneRound(comments, { body: `Review class: ${c}`, labels: [WAIVER_LABEL], pushes: undefined }));
      assert.equal(r.state, "success", `${c}: ${JSON.stringify(r)}`);
      assert.equal(r.description, `exempt: ${c}`);
    }
  }
});

test("the waiver releases #915's out-of-order PR (approval item 2)", () => {
  const f = pr915();
  f.labels = [WAIVER_LABEL];
  f.comments.push({ id: 9, created_at: "2026-11-11T03:20:00Z", body: "Review gate waived: round 1 fixes pushed before the assessments; both posted retroactively and concur." });
  assert.equal(decide({ ...f, pushes: undefined }).state, "success");
});

test("a later clean review does not discharge an earlier round", () => {
  const f = oneRound([]);
  f.reviews.push({ id: 2, user: CODEX, submitted_at: "2026-01-01T02:00:00Z", body: "Codex Review: Didn't find any major issues.\n\n**Reviewed commit:** `bbbbbbbbbb`" });
  assert.equal(decide(f).state, "failure");
});

test("no findings rounds passes without reading push history", () => {
  const f = oneRound([], { reviewComments: [], pushes: undefined });
  assert.deepEqual(decide(f).state, "success");
});

test("a findings round asks for push history before deciding", () => {
  const r = decide(oneRound([], { pushes: undefined }));
  assert.deepEqual(r, { need: "pushes", since: "2026-01-01T01:00:00Z" });
});

test("push history unavailable or incomplete is an error, never success", () => {
  const done = [assessment("Astra", 1, "aaaaaaaaaa", ["11", "12"], "2026-01-01T01:10:00Z"), assessment("Fable", 1, "aaaaaaaaaa", ["11", "12"], "2026-01-01T01:11:00Z")];
  assert.equal(decide(oneRound(done, { pushes: null })).state, "error");
  const late = decide(oneRound(done, { pushes: pushes("2026-01-01T02:00:00Z", ["2026-01-01T02:00:00Z", "ccccccc"]) }));
  assert.equal(late.state, "error");
  assert.match(late.description, /incomplete/);
});

test("a branch deletion is not a push", () => {
  const done = [assessment("Astra", 1, "aaaaaaaaaa", ["11", "12"], "2026-01-01T01:10:00Z"), assessment("Fable", 1, "aaaaaaaaaa", ["11", "12"], "2026-01-01T01:11:00Z")];
  const f = oneRound(done);
  f.pushes.events.push({ type: "branch_deletion", at: "2026-01-01T01:05:00Z", after: "0000000" });
  assert.equal(decide(f).state, "success");
  f.pushes.events.push({ type: "branch_creation", at: "2026-01-01T01:06:00Z", after: "ddddddd" });
  assert.equal(decide(f).state, "failure");
});

test("a pull request merged into the head branch counts as a push (Overhype.me PR #918)", () => {
  const done = [assessment("Astra", 1, "aaaaaaaaaa", ["11", "12"], "2026-01-01T01:10:00Z"), assessment("Fable", 1, "aaaaaaaaaa", ["11", "12"], "2026-01-01T01:11:00Z")];
  for (const type of ["pr_merge", "merge_queue_merge"]) {
    const f = oneRound(done);
    f.pushes.events.push({ type, at: "2026-01-01T01:05:00Z", after: "eeeeeee" });
    const r = decide(f);
    assert.equal(r.state, "failure", type);
    assert.match(r.description, /push `eeeeeee` .* preceded the Astra and Fable assessments/);
  }
});

test("an unrecognised connector findings review fails loudly", () => {
  const f = oneRound([], { pushes: undefined });
  f.reviews = [{ id: 1, user: CODEX, submitted_at: "2026-01-01T01:00:00Z", body: "### Codex Review\n\nReviewed at abcdef1 (new format)" }];
  const r = decide(f);
  assert.equal(r.state, "failure");
  assert.match(r.description, /unrecognised findings review/);
});

test("a human review with comments is not a round", () => {
  const f = oneRound([], { pushes: undefined });
  f.reviews[0].user = OWNER;
  assert.equal(decide(f).state, "success");
});

test("helpers", () => {
  assert.ok(sameCommit("139cadbd65", "139cadbd65e521b8a8feb166715c75724cea4be6"));
  assert.ok(!sameCommit("139cad", "139cadbd65"));
  assert.ok(!sameCommit("139cadbd66", "139cadbd65e5"));
  assert.equal(findingsRounds(pr915().reviews, pr915().reviewComments).rounds.length, 1);
  assert.equal(prNumber("issue_comment", { issue: { number: 5 } }), null);
  assert.equal(prNumber("issue_comment", { issue: { number: 5, pull_request: {} } }), 5);
  assert.equal(prNumber("pull_request_review", { pull_request: { number: 7 } }), 7);
  assert.equal(prNumber("workflow_dispatch", { inputs: { pr: "12" } }), 12);
  assert.equal(prNumber("workflow_dispatch", { inputs: { pr: "x" } }), null);
  assert.ok(decide({ ...pr915(), pushes: undefined }).need);
  const long = decide({ ...oneRound([], { labels: [WAIVER_LABEL] }), pushes: undefined, comments: [{ id: 1, created_at: "2026-01-02T00:00:00Z", body: `Review gate waived: ${"x".repeat(200)}` }] });
  assert.ok(long.description.length <= 140);
});

// ── I/O ─────────────────────────────────────────────────────────────────────

/**
 * A stub GitHub: routes by path, records every status posted, and can fail
 * a named route. `heads` is consumed in order by successive PR reads, so a
 * head that moves mid-evaluation can be simulated.
 */
function stubGitHub({ facts, heads = ["h1", "h1"], fail = null, pageSize = 0 }) {
  const posted = [];
  let pulls = 0;
  const json = (body, link) => ({ ok: true, status: 200, json: async () => body, headers: { get: (h) => (h === "link" ? link ?? null : null) } });
  const paged = (arr, url) => {
    if (!pageSize) return json(arr);
    const u = new URL(url);
    const page = Number(u.searchParams.get("page") ?? "1");
    const slice = arr.slice((page - 1) * pageSize, page * pageSize);
    u.searchParams.set("page", String(page + 1));
    return json(slice, page * pageSize < arr.length ? `<${u}>; rel="next"` : null);
  };
  const fetchImpl = async (url, { method, body }) => {
    const path = url.replace("https://api.github.com/", "");
    if (fail && fail.test(`${method} ${path}`)) return { ok: false, status: 502, json: async () => ({}), headers: { get: () => null } };
    if (method === "POST") {
      posted.push(JSON.parse(body));
      return json({});
    }
    if (/^repos\/o\/r\/pulls\/1$/.test(path)) {
      const sha = heads[Math.min(pulls++, heads.length - 1)];
      return json({ body: facts.body, labels: facts.labels.map((name) => ({ name })), head: { sha, ref: "feature", repo: { full_name: "o/r" } } });
    }
    if (path.startsWith("repos/o/r/issues/1/comments")) return paged(facts.comments, url);
    if (path.startsWith("repos/o/r/pulls/1/reviews")) return paged(facts.reviews, url);
    if (path.startsWith("repos/o/r/pulls/1/comments")) return paged(facts.reviewComments, url);
    if (path.startsWith("repos/o/r/activity")) {
      if (facts.pushes === null) return json([]);
      return paged(facts.pushes.events.map((e) => ({ activity_type: e.type, timestamp: e.at, before: e.before, after: e.after })), url);
    }
    throw new Error(`unrouted ${method} ${path}`);
  };
  return { gh: client({ token: "t", fetchImpl }), posted };
}

const satisfied = () => oneRound([
  assessment("Astra", 1, "aaaaaaaaaa", ["11", "12"], "2026-01-01T01:10:00Z"),
  assessment("Fable", 1, "aaaaaaaaaa", ["11", "12"], "2026-01-01T01:11:00Z"),
]);

test("I/O: pending first, then the result, on the head", async () => {
  const { gh, posted } = stubGitHub({ facts: satisfied() });
  const r = await evaluate({ gh, repo: "o/r", pr: 1 });
  assert.deepEqual(posted.map((p) => p.state), ["pending", "success"]);
  assert.ok(posted.every((p) => p.context === CONTEXT));
  assert.equal(r.head, "h1");
});

test("I/O: pagination is followed to the end", async () => {
  const f = satisfied();
  // Push the satisfying assessments past the first page.
  f.comments = [...Array.from({ length: 5 }, (_, i) => ({ id: 100 + i, created_at: "2026-01-01T00:30:00Z", body: "chatter" })), ...f.comments];
  const { gh, posted } = stubGitHub({ facts: f, pageSize: 2 });
  await evaluate({ gh, repo: "o/r", pr: 1 });
  assert.equal(posted.at(-1).state, "success");
});

test("I/O: head moved during evaluation posts nothing after pending", async () => {
  const { gh, posted } = stubGitHub({ facts: satisfied(), heads: ["h1", "h2"] });
  const r = await evaluate({ gh, repo: "o/r", pr: 1 });
  assert.equal(r.posted, null);
  assert.deepEqual(posted.map((p) => p.state), ["pending"]);
});

test("I/O: a read failing after pending posts error, withdrawing an earlier success", async () => {
  const { gh, posted } = stubGitHub({ facts: satisfied(), fail: /^GET repos\/o\/r\/pulls\/1\/reviews/ });
  await evaluate({ gh, repo: "o/r", pr: 1 });
  assert.deepEqual(posted.map((p) => p.state), ["pending", "error"]);
});

test("I/O: a failure before pending posts nothing and throws (the previous status stands)", async () => {
  const { gh, posted } = stubGitHub({ facts: satisfied(), fail: /^POST / });
  await assert.rejects(evaluate({ gh, repo: "o/r", pr: 1 }));
  assert.deepEqual(posted, []);
});

test("I/O: transitions from success on an unchanged head", async () => {
  // An assessment deleted.
  const del = satisfied();
  del.comments = del.comments.slice(0, 1);
  let s = stubGitHub({ facts: del });
  await evaluate({ gh: s.gh, repo: "o/r", pr: 1 });
  assert.equal(s.posted.at(-1).state, "failure");
  // The exemption line removed: the rounds are evaluated again.
  const exempt = oneRound([], { body: "Review class: trivial" });
  s = stubGitHub({ facts: exempt });
  await evaluate({ gh: s.gh, repo: "o/r", pr: 1 });
  assert.equal(s.posted.at(-1).state, "success");
  s = stubGitHub({ facts: { ...exempt, body: "" } });
  await evaluate({ gh: s.gh, repo: "o/r", pr: 1 });
  assert.equal(s.posted.at(-1).state, "failure");
  // The waiver label removed.
  const waived = oneRound([{ id: 1, created_at: "2026-01-01T02:00:00Z", body: "Review gate waived: outage" }], { labels: [WAIVER_LABEL] });
  s = stubGitHub({ facts: waived });
  await evaluate({ gh: s.gh, repo: "o/r", pr: 1 });
  assert.equal(s.posted.at(-1).state, "success");
  s = stubGitHub({ facts: { ...waived, labels: [] } });
  await evaluate({ gh: s.gh, repo: "o/r", pr: 1 });
  assert.equal(s.posted.at(-1).state, "failure");
});

test("I/O: push history unavailable is error; a waived or exempt PR still passes without it", async () => {
  let s = stubGitHub({ facts: satisfied(), fail: /^GET repos\/o\/r\/activity/ });
  await evaluate({ gh: s.gh, repo: "o/r", pr: 1 });
  assert.equal(s.posted.at(-1).state, "error");
  s = stubGitHub({ facts: { ...satisfied(), pushes: null } });
  await evaluate({ gh: s.gh, repo: "o/r", pr: 1 });
  assert.equal(s.posted.at(-1).state, "error");
  s = stubGitHub({ facts: { ...satisfied(), body: "Review class: sync" }, fail: /^GET repos\/o\/r\/activity/ });
  await evaluate({ gh: s.gh, repo: "o/r", pr: 1 });
  assert.equal(s.posted.at(-1).state, "success");
});

// ── wiring ──────────────────────────────────────────────────────────────────

test("KITT's root workflow and the payload's are identical", (t) => {
  const payload = join(here, "../../.github/workflows/review-gate.yml");
  const root = join(here, "../../../.github/workflows/review-gate.yml");
  // In a consumer this file sits under scripts/, not core/scripts/, and the
  // synced copy IS the root copy: there is nothing to compare.
  if (basename(join(here, "../..")) !== "core" || !existsSync(payload)) return t.skip("not in KITT");
  assert.equal(readFileSync(root, "utf8"), readFileSync(payload, "utf8"));
});

test("no workflow job carries the status's name", () => {
  // A job check named like the commit status would be required too, and only
  // some events refresh it (KITT #294 round 1). Read whichever copy exists.
  const candidates = [join(here, "../../.github/workflows/review-gate.yml"), join(here, "../../../.github/workflows/review-gate.yml")];
  const file = candidates.find((p) => existsSync(p) && /review-gate\.mjs/.test(readFileSync(p, "utf8")));
  assert.ok(file, "the review-gate workflow is present");
  const names = [...readFileSync(file, "utf8").matchAll(/^\s{4}name:\s*(.+)$/gm)].map((m) => m[1].trim());
  assert.ok(names.length > 0, "found the job names");
  assert.ok(!names.includes(CONTEXT), `a job is named ${CONTEXT}`);
});

#!/usr/bin/env node
// SYNCED FROM KITT — do not edit in a consumer repo. Local edits are overwritten by the next sync and their reasoning is lost; change KITT instead.
/**
 * The review gate ("Devon", KITT #293): a required commit status that fails a
 * pull request while a Codex findings round lacks its two independent
 * assessments, or while a push landed between such a review and them.
 *
 * WHAT IT PROVES, AND WHAT IT DOES NOT (David, 2026-11-11, approval item 1).
 * GitHub records when a commit reached the branch; it cannot see when a file
 * was edited. So the gate proves that no commit was PUSHED after a findings
 * review and before both of its assessments. "No fix is written before them"
 * stays a working rule (`claude-core.md`, *The write-gate rule*).
 *
 * THREAT MODEL: the builder's own mistakes, never deliberate bypass
 * (`agents-core.md`, *Important product principles*). Anyone who can comment
 * can post text shaped like an assessment; author filtering is not attempted,
 * because the builder's comments carry the owner's login. The waiver label is
 * David's, by agreement, not by mechanism.
 *
 * ASYNCHRONOUS, NOT A VETO (approval item 3). Until a run publishes `pending`
 * on the current head, an earlier success may stand. After it, an incomplete
 * evaluation leaves `pending` or `error`, never `success`. The pre-merge
 * live-state read in close-out remains necessary.
 *
 * Inputs it reads, and the plan decisions they come from
 * (`docs/plans/PLAN_REVIEW_GATE.md` in KITT):
 *   - the PR body's `Review class:` line (decision 1);
 *   - the waiver label plus a `Review gate waived:` comment (decision 2);
 *   - Codex connector reviews and the review comments they own (decision 3);
 *   - `review-proxy.mjs`'s assessment comments (decision 4);
 *   - the head branch's push history from the activity API (decision 5).
 * It writes one thing: a commit status, context `Review gate` (decision 6).
 */
import { readFileSync, appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const CONTEXT = "Review gate";
export const WAIVER_LABEL = "review-gate: waived by David";
export const EXEMPT_CLASSES = ["trivial", "sync", "registry", "prototype"];
const CONNECTOR = /^chatgpt-codex-connector(\[bot\])?$/;
// Measured on Overhype.me PR #915: "**Reviewed commit:** `139cadbd65`".
const REVIEWED_COMMIT = /\*\*Reviewed commit:\*\*\s*`([0-9a-f]{7,40})`/i;
const ASSESSORS = ["Astra", "Fable"];
// Written by review-proxy.mjs `prComment`: "## Astra — round 1",
// "## Fable — round 2, follow-up 1", and a failed dispatch's
// "## Astra — round 1: **dispatch failed**".
const HEADER = /^##\s+(Astra|Fable)\s+—\s+round\s+(\d+)(?:,\s*follow-up\s+(\d+))?(:\s*\*\*dispatch failed\*\*)?\s*$/;
// Events in the activity API that move the branch. A branch's first push is
// recorded as `branch_creation`, not `push` (probe, KITT #293 step 1).
const MOVES = new Set(["push", "branch_creation", "force_push"]);

const t = (iso) => Date.parse(iso);
const short = (sha) => String(sha).slice(0, 7);

/** Two abbreviations name the same commit when one prefixes the other, over ≥ 7 characters. */
export function sameCommit(a, b) {
  if (!a || !b) return false;
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  const n = Math.min(x.length, y.length);
  return n >= 7 && x.slice(0, n) === y.slice(0, n);
}

/** The exempt class the PR body declares, or null. A line of its own; nothing else is inferred. */
export function exemptClass(body) {
  const m = String(body ?? "").replace(/\r/g, "").match(/^[ \t]*Review class:[ \t]*([a-z]+)[ \t]*$/im);
  if (!m) return null;
  const c = m[1].toLowerCase();
  return EXEMPT_CLASSES.includes(c) ? c : null;
}

/** The waiver's reason, or null: the label AND a comment starting `Review gate waived:` with text after it. */
export function waiverReason(labels, comments) {
  if (!labels.includes(WAIVER_LABEL)) return null;
  for (const c of [...comments].sort((a, b) => t(b.created_at) - t(a.created_at))) {
    const m = String(c.body ?? "").replace(/\r/g, "").match(/^\s*Review gate waived:[ \t]*(\S[^\n]*)/);
    if (m) return m[1].trim();
  }
  return null;
}

/** An assessment comment's facts, or null when the comment is not one. */
export function parseAssessment(comment) {
  const lines = String(comment.body ?? "").replace(/\r/g, "").split("\n");
  const first = lines.findIndex((l) => l.trim() !== "");
  if (first < 0) return null;
  const h = lines[first].trim().match(HEADER);
  if (!h) return null;
  const facts = lines.slice(first + 1).find((l) => l.trim() !== "") ?? "";
  const assessed = facts.match(/Assessed at `([0-9a-f]{7,40})`/i);
  const findings = facts.match(/findings ((?:`[^`]+`(?:,\s*)?)+)/);
  return {
    assessor: h[1],
    round: Number(h[2]),
    followUp: h[3] ? Number(h[3]) : null,
    failed: Boolean(h[4]),
    commit: assessed ? assessed[1] : null,
    findings: findings ? [...findings[1].matchAll(/`([^`]+)`/g)].map((m) => m[1].trim()) : [],
    createdAt: comment.created_at,
    id: comment.id,
  };
}

/**
 * The findings rounds: Codex connector reviews that own at least one review
 * comment. One that owns comments but carries no recognisable reviewed-commit
 * line is returned as unrecognised, so a change of shape fails loudly instead
 * of opening a hole (plan, Risks).
 */
export function findingsRounds(reviews, reviewComments) {
  const owned = new Map();
  for (const c of reviewComments) {
    if (c.pull_request_review_id == null) continue;
    if (!owned.has(c.pull_request_review_id)) owned.set(c.pull_request_review_id, []);
    owned.get(c.pull_request_review_id).push(String(c.id));
  }
  const rounds = [];
  const unrecognised = [];
  for (const r of reviews) {
    if (!CONNECTOR.test(r.user?.login ?? "")) continue;
    const ids = owned.get(r.id);
    if (!ids || !ids.length) continue;
    const m = String(r.body ?? "").match(REVIEWED_COMMIT);
    if (!m) {
      unrecognised.push({ reviewId: r.id, submittedAt: r.submitted_at });
      continue;
    }
    rounds.push({ reviewId: r.id, commit: m[1], submittedAt: r.submitted_at, findings: ids.sort() });
  }
  rounds.sort((a, b) => t(a.submittedAt) - t(b.submittedAt));
  return { rounds, unrecognised };
}

/**
 * When an assessor's assessments of a round became complete: the creation
 * time of the comment that completed the cover of every finding id, or null.
 * Follow-ups add to the cover; they never replace it.
 */
export function satisfiedAt(round, assessor, assessments) {
  const need = new Set(round.findings);
  const usable = assessments
    .filter((a) => a.assessor === assessor && !a.failed && sameCommit(a.commit, round.commit) && t(a.createdAt) > t(round.submittedAt))
    .sort((a, b) => t(a.createdAt) - t(b.createdAt));
  for (const a of usable) {
    for (const id of a.findings) need.delete(id);
    if (!need.size) return a.createdAt;
  }
  return null;
}

/**
 * The decision. Pure: `facts` is what the I/O layer read.
 *
 *   facts = { body, labels: [name], comments: [{id, body, created_at}],
 *             reviews: [{id, user:{login}, body, submitted_at}],
 *             reviewComments: [{id, pull_request_review_id}],
 *             pushes }   // undefined: not read yet; null: unavailable;
 *                        // { events: [{type, at, before, after}], from: iso }
 *
 * Returns { state, description, lines } or { need: "pushes", since: iso }.
 * Order (decision 2's note): waiver, then exemption, then rounds; so a waived
 * or exempt PR never needs the push history.
 */
export function decide(facts) {
  const waived = waiverReason(facts.labels, facts.comments);
  if (waived) return result("success", `waived — ${waived}`, [`Waived by the \`${WAIVER_LABEL}\` label: ${waived}`]);
  const cls = exemptClass(facts.body);
  if (cls) return result("success", `exempt: ${cls}`, [`Exempt: the PR body declares \`Review class: ${cls}\`.`]);
  const r = decideRounds(facts);
  // The label alone is not a waiver and changes no verdict (KITT #294 round 2):
  // it only adds a line to a failure saying why it did not apply.
  if (r.state === "failure" && facts.labels.includes(WAIVER_LABEL)) {
    r.lines.unshift(`The \`${WAIVER_LABEL}\` label is present but no comment starting \`Review gate waived:\` gives a reason, so it does not apply.`);
  }
  return r;
}

function decideRounds(facts) {
  const { rounds, unrecognised } = findingsRounds(facts.reviews, facts.reviewComments);
  const lines = [];
  const problems = [];
  for (const u of unrecognised) {
    problems.push(`unrecognised findings review ${u.reviewId}`);
    lines.push(`- **Unrecognised findings review** ${u.reviewId} (${u.submittedAt}): a Codex review owning review comments, with no \`**Reviewed commit:**\` line the gate can read. The connector's shape has changed; the gate must be updated before this PR can pass.`);
  }
  if (!rounds.length) {
    if (problems.length) return result("failure", problems[0], lines);
    return result("success", "no findings rounds", ["No Codex review on this PR returned findings."]);
  }
  if (facts.pushes === undefined) return { need: "pushes", since: rounds[0].submittedAt };
  if (facts.pushes === null) {
    return result("error", "push history unavailable", ["The head branch's push history could not be read, so push order cannot be checked. Re-run the gate."]);
  }
  if (t(facts.pushes.from) > t(rounds[0].submittedAt)) {
    return result("error", "push history incomplete", [`The head branch's push history reaches back only to ${facts.pushes.from}, after the first findings review (${rounds[0].submittedAt}); push order cannot be checked.`]);
  }
  const assessments = facts.comments.map(parseAssessment).filter(Boolean);
  const moves = facts.pushes.events.filter((e) => MOVES.has(e.type)).sort((a, b) => t(a.at) - t(b.at));
  for (const r of rounds) {
    const label = `round at \`${short(r.commit)}\` (review ${r.reviewId}, ${r.submittedAt}, findings ${r.findings.map((f) => `\`${f}\``).join(", ")})`;
    const done = Object.fromEntries(ASSESSORS.map((a) => [a, satisfiedAt(r, a, assessments)]));
    const missing = ASSESSORS.filter((a) => !done[a]);
    const after = moves.filter((m) => t(m.at) > t(r.submittedAt));
    const states = ASSESSORS.map((a) => `${a} ${done[a] ? `at ${done[a]}` : "missing"}`).join(", ");
    const roundProblems = [];
    if (missing.length) {
      roundProblems.push(`${missing.join(" and ")} missing`);
    }
    for (const m of after) {
      const late = ASSESSORS.filter((a) => !done[a] || t(done[a]) > t(m.at));
      if (late.length) {
        roundProblems.push(`push \`${short(m.after)}\` at ${m.at} preceded the ${late.join(" and ")} assessment${late.length > 1 ? "s" : ""}`);
      }
    }
    if (!roundProblems.length) {
      lines.push(`- **Satisfied:** ${label}: ${states}.`);
      continue;
    }
    problems.push(`round at ${short(r.commit)}: ${roundProblems[0]}`);
    lines.push(`- **Not satisfied:** ${label}: ${states}.`);
    for (const p of roundProblems) lines.push(`  - ${p}.`);
    const pushProblem = roundProblems.some((p) => p.startsWith("push "));
    lines.push(
      pushProblem
        ? "  - **Recovery:** a late assessment cannot repair a push already made. Post both assessments, then David's waiver: the label `" + WAIVER_LABEL + "` and a comment starting `Review gate waived:` explaining what happened."
        : "  - **Recovery:** post the missing assessment (`review-proxy.mjs`); if the assessors genuinely cannot run, David's waiver."
    );
  }
  if (!problems.length) return result("success", `${rounds.length} findings round${rounds.length > 1 ? "s" : ""} assessed in order`, lines);
  const more = problems.length > 1 ? ` (+${problems.length - 1} more)` : "";
  return result("failure", `${problems[0]}${more}`, lines);
}

function result(state, description, lines) {
  // A commit status description is capped at 140 characters.
  const d = description.length > 140 ? `${description.slice(0, 139)}…` : description;
  return { state, description: d, lines };
}

// ── I/O ─────────────────────────────────────────────────────────────────────

/**
 * A GitHub REST client over `fetch`, following `Link: rel="next"` to the end.
 * Any non-2xx throws, so a failed read can never be mistaken for an empty one.
 */
export function client({ token, fetchImpl = fetch, api = "https://api.github.com" }) {
  const headers = {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "kitt-review-gate",
  };
  async function request(method, path, body) {
    const res = await fetchImpl(path.startsWith("http") ? path : `${api}/${path}`, {
      method,
      headers: body ? { ...headers, "content-type": "application/json" } : headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status}`);
    return res;
  }
  return {
    async get(path) {
      return (await request("GET", path)).json();
    },
    async all(path) {
      const out = [];
      let url = path;
      while (url) {
        const res = await request("GET", url);
        const page = await res.json();
        if (!Array.isArray(page)) throw new Error(`GET ${url}: expected an array`);
        out.push(...page);
        const link = res.headers.get("link") ?? "";
        const next = link.split(",").map((s) => s.match(/<([^>]+)>;\s*rel="next"/)).find(Boolean);
        url = next ? next[1] : null;
      }
      return out;
    },
    async post(path, body) {
      return (await request("POST", path, body)).json();
    },
  };
}

/** The head branch's moves, oldest event reached, from the activity API. */
export async function readPushes(gh, headRepo, headRef) {
  const ref = encodeURIComponent(`refs/heads/${headRef}`);
  const events = await gh.all(`repos/${headRepo}/activity?ref=${ref}&per_page=100`);
  if (!events.length) return null;
  const times = events.map((e) => e.timestamp).sort((a, b) => t(a) - t(b));
  return {
    from: times[0],
    events: events.map((e) => ({ type: e.activity_type, at: e.timestamp, before: e.before, after: e.after })),
  };
}

/**
 * One evaluation of one PR. `pending` is posted on the head first, so a run
 * that fails after it withdraws an earlier success; the result is posted only
 * if the head has not moved meanwhile (the newer push's own run posts).
 * Returns what was posted, for the job summary and the tests.
 */
export async function evaluate({ gh, repo, pr, targetUrl = undefined, log = () => {} }) {
  const first = await gh.get(`repos/${repo}/pulls/${pr}`);
  const head = first.head.sha;
  const status = (state, description) =>
    gh.post(`repos/${repo}/statuses/${head}`, { state, context: CONTEXT, description, target_url: targetUrl });
  await status("pending", "evaluating");
  let out;
  try {
    const [comments, reviews, reviewComments] = await Promise.all([
      gh.all(`repos/${repo}/issues/${pr}/comments?per_page=100`),
      gh.all(`repos/${repo}/pulls/${pr}/reviews?per_page=100`),
      gh.all(`repos/${repo}/pulls/${pr}/comments?per_page=100`),
    ]);
    const facts = { body: first.body ?? "", labels: (first.labels ?? []).map((l) => l.name), comments, reviews, reviewComments };
    out = decide(facts);
    if (out.need === "pushes") {
      let pushes;
      try {
        pushes = await readPushes(gh, first.head.repo?.full_name ?? repo, first.head.ref);
      } catch (e) {
        log(`push history: ${e.message}`);
        pushes = null;
      }
      out = decide({ ...facts, pushes });
    }
  } catch (e) {
    out = result("error", "evaluation failed; re-run the gate", [`Evaluation failed: ${e.message}`]);
  }
  const now = await gh.get(`repos/${repo}/pulls/${pr}`);
  if (now.head.sha !== head) {
    log(`head moved ${short(head)} -> ${short(now.head.sha)}; not posting`);
    return { posted: null, head, out };
  }
  await status(out.state, out.description);
  return { posted: out.state, head, out };
}

/** The PR number this event concerns, or null when it concerns none. */
export function prNumber(eventName, event) {
  if (event.pull_request?.number) return event.pull_request.number;
  if (eventName === "issue_comment") return event.issue?.pull_request ? event.issue.number : null;
  if (eventName === "workflow_dispatch") {
    const n = Number(event.inputs?.pr);
    return Number.isInteger(n) && n > 0 ? n : null;
  }
  return null;
}

async function main() {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  const pr = prNumber(process.env.GITHUB_EVENT_NAME, event);
  if (!pr) {
    console.log("Not a pull request event; nothing to evaluate.");
    return;
  }
  const repo = process.env.GITHUB_REPOSITORY;
  const gh = client({ token: process.env.GITHUB_TOKEN });
  const targetUrl = `${process.env.GITHUB_SERVER_URL}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}`;
  const r = await evaluate({ gh, repo, pr, targetUrl, log: console.log });
  const summary = [
    `## Review gate — PR #${pr} at \`${short(r.head)}\``,
    "",
    r.posted ? `**${r.posted}** — ${r.out.description}` : `Not posted: the head moved during evaluation.`,
    "",
    ...r.out.lines,
  ].join("\n");
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  if (r.posted === "error") process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    // Before `pending` was posted: the previous status stands (approval item 3);
    // the run fails loudly so the failure is visible on the Actions tab.
    console.error(`review-gate: ${e.message}`);
    process.exitCode = 1;
  });
}

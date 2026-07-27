#!/usr/bin/env node
/**
 * loop-metrics — derive the mechanical half of a loop-ledger row from a PR.
 *
 * Why this exists: every efficacy claim about our review workflow was
 * unfalsifiable, because nothing recorded a single round. See
 * `.agents/metrics/loop-ledger.md` for the ledger itself and the obligation to
 * append to it.
 *
 * The design rule is that **numbers a machine can count are never recalled by
 * hand.** Prior attempts to characterise our own review history by inference
 * were wrong three times out of three; every figure produced by counting a
 * source held. So this script owns the countable columns and nothing else —
 * the judgment columns stay explicitly, visibly human.
 *
 * Usage:
 *   node scripts/loop-metrics.mjs --pr 268
 *   node scripts/loop-metrics.mjs --fixture path/to/fixture.json
 *   node scripts/loop-metrics.mjs --pr 268 --save-fixture out.json
 *   node scripts/loop-metrics.mjs --mcp-snapshot path/to/snapshot.json
 *
 * `--mcp-snapshot` is for agents whose only working GitHub credential is a
 * tool-calling MCP integration rather than a direct token against
 * api.github.com (this repo's own dev container is one such agent — its
 * GITHUB_TOKEN is scoped to a local git proxy and 401s against the real API).
 * See `fromMcp()` below for the exact shape and how it differs from the REST
 * shape `gh()` expects.
 *
 * Auth: GITHUB_TOKEN or GH_TOKEN, needing only public repo read.
 */

const REPO_OWNER = "TheAnswerManIsHere";
const REPO_NAME = "Overhypeme";

/** Logins whose reviews count as a review round. */
const REVIEWER_LOGINS = new Set(["chatgpt-codex-connector[bot]", "chatgpt-codex-connector"]);

// ---------------------------------------------------------------------------
// Pure derivation — no I/O. This is the part that is tested.
// ---------------------------------------------------------------------------

/**
 * A *round* is a completed review event by the reviewer, NOT an "@codex review"
 * comment.
 *
 * The connector auto-reviews every non-draft PR on open and only needs an
 * explicit trigger for later fix rounds, so counting trigger comments
 * undercounts every implementation PR by exactly one — and does so
 * non-uniformly, since draft plan-review PRs get no auto-review and would
 * count correctly. Comparing those two cohorts is the entire point of the
 * ledger, so a bias present in one and absent in the other is disqualifying.
 */
export function countRounds(reviews) {
  return reviews.filter((r) => REVIEWER_LOGINS.has(r.user?.login)).length;
}

/**
 * A *finding* is one reviewer-authored ROOT comment — one per thread.
 *
 * Two corrections are baked in here, both of which inflated the count in the
 * direction that would have flattered the workflow:
 *
 *  1. Our own workflow requires an author reply on every thread, so raw
 *     comment counts run roughly double. PR #269 carried 31 comments for ~23
 *     findings.
 *  2. A re-raised prior finding is not newly surfaced ground.
 *
 * Correction 2 is deliberately NOT applied here. "Reconciliation" is a prose
 * convention with no machine-readable marker: it is named in
 * `docs/ai-context/plan-review-contract.md` without a serialized field, and
 * `docs/engineering/code-review.md` does not define the category at all. A
 * regex over prose would be a guess wearing the costume of a measurement, so
 * re-raised findings are counted here and separated in the *judgment* column
 * instead, where their uncertainty is visible. See the ledger's `re-raised`
 * cause.
 */
export function countFindings(comments) {
  const rootThreadIds = new Set();
  for (const c of comments) {
    if (!REVIEWER_LOGINS.has(c.user?.login)) continue;
    if (c.in_reply_to_id) continue; // a reply, not a finding
    rootThreadIds.add(c.id);
  }
  return rootThreadIds.size;
}

/** Findings grouped by round, keyed by the review event they belong to. */
export function findingsByRound(reviews, comments) {
  const reviewerReviews = reviews
    .filter((r) => REVIEWER_LOGINS.has(r.user?.login))
    .sort((a, b) => new Date(a.submitted_at) - new Date(b.submitted_at));

  return reviewerReviews.map((review, i) => ({
    round: i + 1,
    submitted_at: review.submitted_at,
    findings: comments.filter(
      (c) =>
        REVIEWER_LOGINS.has(c.user?.login) &&
        !c.in_reply_to_id &&
        c.pull_request_review_id === review.id,
    ).length,
  }));
}

/**
 * Review-interval wall-clock: PR open → final reviewer event.
 *
 * ONE interval, never a sum. An earlier design added preflight duration to
 * this, which double-counts every preflight that happens after the PR opens —
 * those already sit inside this window. Preflight time that precedes the PR is
 * recorded separately in the ledger's judgment column and is *not* added here;
 * whoever wants total cost adds the pre-open portion only, and the ledger says
 * so per row rather than presenting a conflated number as derived.
 */
export function reviewInterval(pr, reviews) {
  const reviewerReviews = reviews.filter((r) => REVIEWER_LOGINS.has(r.user?.login));
  if (reviewerReviews.length === 0) return null;
  const last = reviewerReviews
    .map((r) => new Date(r.submitted_at))
    .reduce((a, b) => (a > b ? a : b));
  const opened = new Date(pr.created_at);
  return {
    opened_at: pr.created_at,
    last_review_at: last.toISOString(),
    hours: Math.round(((last - opened) / 36e5) * 10) / 10,
  };
}

/**
 * Cohort, evaluated top-down, first match wins. A mixed code/prose PR lands in
 * `prose/contract` because that is where the stricter obligations and the
 * measured risk are.
 */
export function classifyCohort(pr, files) {
  if (/^\[PLAN REVIEW\]/.test(pr.title ?? "")) return "plan-review";
  const paths = files.map((f) => f.filename);
  const isProse = (p) => /\.(md|mdx)$/.test(p) || p.startsWith(".claude/skills/");
  if (paths.some(isProse)) return "prose/contract";
  // The primary signal is the bugfix workflow's own required PR-body field —
  // "**Fix tier:**", per .github/pull_request_template.md, present on every
  // Tier A/B/C bugfix PR by contract. working-modes.md never requires a
  // conventional "fix:" title or a label, and this repo's real history has
  // natural-language bugfix titles with neither ("Fix test isolation
  // issues...", "Prevent the crash..."), which title/label matching alone
  // silently misclassified as feature/code. Title and label are kept as a
  // fallback for a bugfix PR predating the template field.
  if (
    /\*\*Fix tier:\*\*/i.test(pr.body ?? "") ||
    /^(fix|bugfix)(\([^)]*\))?[:/]/i.test(pr.title ?? "") ||
    (pr.labels ?? []).some((l) => l.name === "bugfix")
  )
    return "bugfix";
  return "feature/code";
}

/** Artifact size. Both dimensions are kept — neither alone is size. */
export function artifactSize(files) {
  return {
    files: files.length,
    added: files.reduce((n, f) => n + (f.additions ?? 0), 0),
    removed: files.reduce((n, f) => n + (f.deletions ?? 0), 0),
  };
}

/**
 * Adjudication sample size for the causal classification.
 *
 * `max(1, ceil(0.3 * findings))` with an explicit zero case, because "random
 * 30%" is undefined exactly where most loops live: at 1–3 findings, rounding
 * down audits nothing and rounding up changes the rate substantially.
 */
export function adjudicationSample(findings) {
  if (findings === 0) return { size: 0, note: "no findings — nothing to adjudicate" };
  return { size: Math.max(1, Math.ceil(0.3 * findings)), note: null };
}

/** Assemble the mechanical columns. Judgment columns are left null by design. */
export function derive({ pr, reviews, comments, files }) {
  const rounds = countRounds(reviews);
  const findings = countFindings(comments);
  return {
    pr: pr.number,
    title: pr.title,
    cohort: classifyCohort(pr, files),
    size: artifactSize(files),
    rounds,
    findings,
    per_round: findingsByRound(reviews, comments),
    review_interval: reviewInterval(pr, reviews),
    adjudication_sample: adjudicationSample(findings),
    state: pr.merged_at ? "merged" : pr.closed_at ? "closed" : "open",
    // Judgment columns — appended by hand at loop close, never guessed here.
    judgment: {
      new_ground: null,
      propagation: null,
      wrong_fix: null,
      re_raised: null,
      preflight_passes: null,
      preflight_minutes_pre_open: null,
      breakers_fired: null,
    },
  };
}

// ---------------------------------------------------------------------------
// MCP adapter — for agents without a direct api.github.com credential.
//
// `derive()` expects the flat REST comment shape: {id, user:{login},
// in_reply_to_id, pull_request_review_id}. The GitHub MCP server's
// `get_review_comments` does NOT return that shape — verified against this
// repo's own PR #270 rather than assumed. It returns comments grouped by
// thread, with `author` as a bare string (not `user.login`), no numeric `id`
// field (only recoverable from the `#discussion_r<digits>` suffix on
// `html_url`), no `in_reply_to_id`, and no `pull_request_review_id` at all.
//
// A regex over the wrong shape would produce a number that looks derived and
// isn't — the exact failure this file exists to prevent — so this adapter is
// tested against the real shape, not an assumed one.
// ---------------------------------------------------------------------------

/**
 * Flatten MCP `get_review_comments` thread groups into the flat shape
 * `countFindings`/`findingsByRound` expect.
 *
 * Two things are inferred rather than read directly, because the MCP shape
 * does not carry them:
 *
 *  - `in_reply_to_id`: the first comment in a thread is the root finding;
 *    every later comment in the same thread is a reply to it. This matches
 *    our own workflow (one reviewer opens a thread, one author replies) and
 *    is not a general GitHub guarantee for arbitrarily-authored threads.
 *  - `pull_request_review_id`: not present in this MCP shape at all. It is
 *    approximated as the id of the latest `reviews` entry, **by the same
 *    author**, submitted at or before the comment's `created_at` — the same
 *    correlation a human would do by reading timestamps, made explicit and
 *    testable instead of implicit.
 */
/**
 * Same bot, two spellings: `get_reviews` returns
 * `chatgpt-codex-connector[bot]` as the review author's login, but
 * `get_review_comments` returns the bare `chatgpt-codex-connector` (no
 * `[bot]` suffix) as the comment's `author` string — confirmed by comparing
 * the two calls against the same PR. An exact-match lookup between them
 * silently finds nothing for every one of the bot's own comments, which is
 * exactly the kind of confidently-wrong result this file exists to prevent.
 */
const normalizeLogin = (login) => (login ?? "").replace(/\[bot\]$/, "");

export function flattenMcpThreads(reviewThreads, reviews) {
  const byAuthor = new Map();
  for (const r of reviews) {
    const login = normalizeLogin(r.user?.login);
    if (!login) continue;
    if (!byAuthor.has(login)) byAuthor.set(login, []);
    byAuthor.get(login).push(r);
  }
  for (const list of byAuthor.values()) list.sort((a, b) => new Date(a.submitted_at) - new Date(b.submitted_at));

  const out = [];
  for (const thread of reviewThreads ?? []) {
    let rootId = null;
    (thread.comments ?? []).forEach((c, i) => {
      const match = /discussion_r(\d+)/.exec(c.html_url ?? "");
      const id = match ? Number(match[1]) : `${thread.id}#${i}`;
      if (i === 0) rootId = id;

      const login = c.author ?? c.user?.login;
      const createdAt = new Date(c.created_at);
      const candidates = byAuthor.get(normalizeLogin(login)) ?? [];
      const review = candidates.filter((r) => new Date(r.submitted_at) <= createdAt).pop();

      out.push({
        id,
        user: { login },
        in_reply_to_id: i === 0 ? undefined : rootId,
        pull_request_review_id: review?.id,
        body: c.body,
      });
    });
  }
  return out;
}

/**
 * Refuse an MCP snapshot that hasn't been paginated to completion.
 *
 * `loop-metrics.mjs` runs as a plain Node process — it cannot itself call
 * `pull_request_read`, so it can't page through the MCP tool the way `gh()`
 * pages through the raw REST API. The agent assembling `--mcp-snapshot` must
 * do that instead, and must say so explicitly: this throws unless
 * `snapshot.complete` marks all three paginated collections `true`.
 *
 * This is not a formality. A loop with 18 review rounds and 40 findings —
 * our worst case to date, and exactly the shape this adapter exists to
 * measure — will paginate on at least one of `get_reviews`,
 * `get_review_comments`, or `get_files`. Deriving a row from an unmarked
 * partial snapshot produces a number that looks measured and undercounts
 * rounds, findings, or artifact size on precisely the loops that matter most.
 */
export function assertMcpSnapshotComplete(snapshot) {
  const complete = snapshot.complete ?? {};
  for (const key of ["reviews", "files", "reviewThreads"]) {
    if (complete[key] !== true) {
      throw new Error(
        `MCP snapshot incomplete: complete.${key} must be explicitly true. ` +
          `Page through pull_request_read (method:"${
            key === "reviewThreads" ? "get_review_comments" : key === "reviews" ? "get_reviews" : "get_files"
          }") until it reports no further pages, concatenate every page, then set complete.${key} = true.`,
      );
    }
  }
}

/**
 * Refuse a snapshot that *claims* completeness but doesn't actually have the
 * data to back it up.
 *
 * `assertMcpSnapshotComplete` only checks the attestation was made — it can't
 * tell whether the collection it attests to is even present. A snapshot with
 * `complete.reviewThreads: true` and no `reviewThreads` field would otherwise
 * fall through `flattenMcpThreads`'s `?? []` defaults and silently report
 * zero findings, and a thread with no `comments` array would be silently
 * dropped the same way — both indistinguishable from a genuinely clean,
 * finding-free loop unless checked explicitly.
 */
export function assertMcpSnapshotShape(snapshot) {
  for (const key of ["reviews", "files", "reviewThreads"]) {
    if (!Array.isArray(snapshot[key])) {
      throw new Error(
        `MCP snapshot malformed: "${key}" must be an array (got ${typeof snapshot[key]}). ` +
          `An attestation of completeness does not substitute for the data being present.`,
      );
    }
  }
  snapshot.reviewThreads.forEach((thread, i) => {
    if (!Array.isArray(thread.comments)) {
      throw new Error(
        `MCP snapshot malformed: reviewThreads[${i}] (id ${thread.id ?? "unknown"}) has no comments array.`,
      );
    }
  });
}

/**
 * Assemble a `derive()`-ready object from raw MCP tool outputs.
 *
 * `snapshot` is the four raw results an agent gets from `pull_request_read`,
 * **after fully paginating each of `reviews`, `files`, and `reviewThreads`**
 * (see `assertMcpSnapshotComplete`), plus an explicit attestation:
 *   { pr: <method:"get">,
 *     reviews: <all pages of method:"get_reviews", concatenated>,
 *     files: <all pages of method:"get_files", concatenated>,
 *     reviewThreads: <all pages of method:"get_review_comments">.review_threads, concatenated>,
 *     complete: { reviews: true, files: true, reviewThreads: true } }
 *
 * `pr`, `reviews`, and `files` pass through unchanged — verified against
 * PR #270's live output to carry the same field names `derive()` expects
 * (`user.login`, `submitted_at`, `filename`/`additions`/`deletions`). Only
 * `reviewThreads` needs the flattening above.
 */
export function fromMcp(snapshot) {
  assertMcpSnapshotShape(snapshot);
  assertMcpSnapshotComplete(snapshot);
  const { pr, reviews, files, reviewThreads } = snapshot;
  return { pr, reviews, files, comments: flattenMcpThreads(reviewThreads, reviews) };
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/**
 * Paginated GitHub GET.
 *
 * Pagination is not incidental here: a loop with 18 review rounds — our worst
 * case to date, and the one the ledger most needs to characterise — exceeds a
 * default page. A wrapper that silently returns page one would undercount
 * rounds precisely on the large loops, which is the failure this whole file
 * exists to prevent.
 *
 * `fetchImpl` is injectable so the pagination and error behaviour can be
 * tested without network access.
 */
export async function gh(path, { token, fetchImpl = fetch } = {}) {
  const auth = token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!auth) throw new Error("GITHUB_TOKEN or GH_TOKEN required");
  const out = [];
  let url = `https://api.github.com${path}${path.includes("?") ? "&" : "?"}per_page=100`;
  const seen = new Set();
  while (url) {
    if (seen.has(url)) throw new Error(`pagination loop detected at ${url}`);
    seen.add(url);
    const res = await fetchImpl(url, {
      headers: {
        Authorization: `Bearer ${auth}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "loop-metrics",
      },
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
    const page = await res.json();
    out.push(...(Array.isArray(page) ? page : [page]));
    const next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get("link") ?? "");
    url = next?.[1] ?? null;
  }
  return out;
}

async function fetchPR(number) {
  const base = `/repos/${REPO_OWNER}/${REPO_NAME}/pulls/${number}`;
  const [prArr, reviews, comments, files] = await Promise.all([
    gh(base),
    gh(`${base}/reviews`),
    gh(`${base}/comments`),
    gh(`${base}/files`),
  ]);
  return { pr: prArr[0], reviews, comments, files };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? null : process.argv[i + 1];
}

async function main() {
  const fixture = arg("fixture");
  const mcpSnapshot = arg("mcp-snapshot");
  const prNumber = arg("pr");
  if (!fixture && !mcpSnapshot && !prNumber) {
    console.error(
      "usage: loop-metrics.mjs --pr <number> | --fixture <file> | --mcp-snapshot <file>",
    );
    process.exit(2);
  }

  const { readFile, writeFile } = await import("node:fs/promises");
  const raw = fixture
    ? JSON.parse(await readFile(fixture, "utf8"))
    : mcpSnapshot
      ? fromMcp(JSON.parse(await readFile(mcpSnapshot, "utf8")))
      : await fetchPR(prNumber);

  const saveTo = arg("save-fixture");
  if (saveTo) await writeFile(saveTo, JSON.stringify(raw, null, 2));

  console.log(JSON.stringify(derive(raw), null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}

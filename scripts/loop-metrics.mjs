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
  // Deduplicated by review id: a duplicated review record (a bad fixture, or
  // two concatenated MCP/REST pages that overlap) is one review event, not
  // two — counting the raw array would overcount rounds and, via
  // findingsByRound below, produce two round-entries that each claim the
  // same findings, disagreeing with countFindings' own deduplicated total.
  const ids = new Set();
  for (const r of reviews) {
    if (REVIEWER_LOGINS.has(r.user?.login)) ids.add(r.id);
  }
  return ids.size;
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

/**
 * Findings grouped by round, keyed by the review event they belong to.
 *
 * Both inputs are deduplicated by id first — matching countRounds' and
 * countFindings' own semantics — because a duplicated review record (or a
 * duplicated root comment, from a bad fixture or an overlapping concatenated
 * page) would otherwise produce a round whose findings count disagrees with
 * the deduplicated totals those two functions report, tripping derive()'s
 * reconciliation check for what is actually a duplicate-input problem, not a
 * genuine correlation failure.
 */
export function findingsByRound(reviews, comments) {
  const seenReviewIds = new Set();
  const reviewerReviews = reviews
    .filter((r) => REVIEWER_LOGINS.has(r.user?.login))
    .filter((r) => (seenReviewIds.has(r.id) ? false : seenReviewIds.add(r.id)))
    .sort((a, b) => new Date(a.submitted_at) - new Date(b.submitted_at));

  const seenRootIds = new Set();
  const uniqueRoots = comments
    .filter((c) => REVIEWER_LOGINS.has(c.user?.login) && !c.in_reply_to_id)
    .filter((c) => (seenRootIds.has(c.id) ? false : seenRootIds.add(c.id)));

  return reviewerReviews.map((review, i) => ({
    round: i + 1,
    submitted_at: review.submitted_at,
    findings: uniqueRoots.filter((c) => c.pull_request_review_id === review.id).length,
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
 * Strip HTML comments so unedited template placeholder text isn't read as
 * content.
 *
 * A single non-looped pass is incomplete: removing an inner comment can
 * splice its surrounding text into a NEW, previously-nonexistent comment
 * span. E.g. `"X<!" + "<!-- hidden -->" + "-- real content -->Y"` — one pass
 * removes only the inner `<!-- hidden -->` (the first `<!--` it finds,
 * closed by the first `-->` after it), leaving `"X<!-- real content -->Y"`:
 * the leftover `<!` and `--` have spliced into a fresh, fully-formed,
 * unstripped comment that didn't exist as a literal match in the original
 * string (flagged by CodeQL as incomplete multi-character sanitization).
 * Looping to a fixed point removes any such reconstituted marker too.
 */
export function stripHtmlComments(text) {
  let previous;
  let current = text;
  do {
    previous = current;
    current = current.replace(/<!--[\s\S]*?-->/g, "");
  } while (current !== previous);
  return current;
}

/**
 * The complete, fixed set of oracle field labels
 * `.github/pull_request_template.md` prints — the ONLY lines that count as a
 * field boundary. Treating any bold-colon text as a boundary is too eager: a
 * value that itself uses a bold sub-label (e.g. "**Product intent:**" with
 * content written as "**Goal:** ...") would have that sub-label misread as
 * the START of a new field, truncating the real value to empty.
 */
const ORACLE_FIELD_LABELS = [
  "Approved-plan source",
  "Product intent",
  "Must not change",
  "Settled decisions",
  "Fix tier",
  "Reported symptom",
  "Intended correct behavior",
  "Root cause",
  "Blast radius",
  "Why this is trivial",
  "David's go-ahead",
  "Migration ceremony checklist",
];
const ORACLE_FIELD_BOUNDARY = ORACLE_FIELD_LABELS.map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");

/**
 * Strip content an oracle field scan should never read as real field text:
 * fenced code blocks and blockquoted lines. Without this, a body that
 * quotes an example PR (illustrating the template, or citing a prior PR)
 * containing literal "**Product intent:**"/"**Fix tier:**" text would have
 * that quoted example read as this PR's own oracle.
 */
function stripExampleText(text) {
  return text
    .replace(/```[\s\S]*?```/g, "")
    .split("\n")
    .filter((line) => !/^\s*>/.test(line))
    .join("\n");
}

/**
 * Extract a markdown oracle field's value — everything after `**Label:**` up
 * to the next recognized oracle field label or the end of the body, trimmed.
 * The boundary is restricted to `ORACLE_FIELD_LABELS`, not any bold-colon
 * text, so a bold sub-label inside the value itself isn't misread as a new
 * field.
 *
 * A field's value is not always on the same line as its label — the PR
 * template's own natural layout is to write multi-line content (a
 * paragraph, a numbered list) starting on the line AFTER the label. A
 * same-line-only regex reads that as empty, which is wrong in the dangerous
 * direction: an empty-looking "**Product intent:**" with real content one
 * line down would make `featureOracleIsPopulated()` report the feature
 * oracle as unpopulated, and a leftover unedited Tier C block would then
 * make `hasGenuineFixTier` misclassify the PR as `bugfix`. Capturing through
 * the next field label (or end of string) instead of just `[^\n]*` reads
 * both same-line and multi-line values correctly.
 */
function fieldValue(stripped, label) {
  const re = new RegExp(`\\*\\*${label}:\\*\\*([\\s\\S]*?)(?=\\n\\*\\*(?:${ORACLE_FIELD_BOUNDARY}):\\*\\*|$)`, "gi");
  return [...stripped.matchAll(re)].map((m) => m[1].trim());
}

/**
 * Whether the PR body's `**Fix tier:**` field carries a real value anywhere
 * it appears — not just the unedited template placeholder.
 * `.github/pull_request_template.md` prints this field in TWO blocks
 * unconditionally (Tier A/B and Tier C), so a body can contain it more than
 * once; first-non-empty means an untouched A/B placeholder (comment-only, so
 * empty once comments are stripped) doesn't hide a genuinely filled Tier C
 * value that follows it.
 */
function fixTierValue(body) {
  const values = fieldValue(stripExampleText(stripHtmlComments(body)), "Fix tier");
  return values.find((v) => v.length > 0) ?? "";
}

/**
 * Whether the PR body's FEATURE oracle fields carry real content. Checked
 * against `**Product intent:**` and `**Settled decisions:**` specifically
 * because both are feature-block-only in the template (unlike
 * `**Must not change:**`, which the bugfix A/B block also uses) — so either
 * one being populated is an unambiguous feature-mode signal.
 */
function featureOracleIsPopulated(body) {
  const stripped = stripExampleText(stripHtmlComments(body));
  return ["Product intent", "Settled decisions"].some((label) =>
    fieldValue(stripped, label).some((v) => v.length > 0),
  );
}

/**
 * Cohort, evaluated top-down, first match wins. A mixed code/prose PR lands in
 * `prose/contract` because that is where the stricter obligations and the
 * measured risk are.
 */
// Excluded from prose-cohort detection: per working-modes.md's "a row is
// never its own dedicated PR," a closed loop's row is folded into whichever
// PR is opened next, on ANY subject — meaning nearly every future feature or
// bugfix PR will carry an incidental edit to this file. Counting it as
// prose-cohort evidence would misclassify almost every PR going forward as
// prose/contract regardless of its actual substance.
const LEDGER_PATH = ".agents/metrics/loop-ledger.md";

export function classifyCohort(pr, files) {
  if (/^\[PLAN REVIEW\]/.test(pr.title ?? "")) return "plan-review";
  const paths = files.map((f) => f.filename);
  const isProse = (p) => p !== LEDGER_PATH && (/\.(md|mdx)$/.test(p) || p.startsWith(".claude/skills/"));
  if (paths.some(isProse)) return "prose/contract";
  // The primary signal is the bugfix workflow's own required PR-body field —
  // "**Fix tier:**", per .github/pull_request_template.md, present on every
  // Tier A/B/C bugfix PR by contract. working-modes.md never requires a
  // conventional "fix:" title or a label, and this repo's real history has
  // natural-language bugfix titles with neither ("Fix test isolation
  // issues...", "Prevent the crash..."), which title/label matching alone
  // silently misclassified as feature/code. Title and label are kept as a
  // fallback for a bugfix PR predating the template field.
  //
  // A bare existence check on "**Fix tier:**" is not enough: the template
  // prints that field in TWO blocks (Tier A/B, Tier C) whether or not either
  // is used, and the Tier C block's default text ("C — trivial
  // schema/migration fix, no plan") is not comment-wrapped, so a code-only
  // feature PR that forgot to delete the unused bugfix blocks (the template
  // instructs deleting them, but doesn't enforce it) would still match. So a
  // genuine signal requires BOTH a populated Fix tier value AND the feature
  // oracle fields being empty — a body carrying both is contradictory, not
  // trustworthy evidence either way, and falls through to the fallback below.
  const body = pr.body ?? "";
  const featureOracle = featureOracleIsPopulated(body);
  const hasGenuineFixTier = Boolean(fixTierValue(body)) && !featureOracle;
  // The title fallback matches on a word boundary, not just conventional
  // "fix:"/"fix(scope):" forms — this repo's real pre-template bugfix titles
  // are natural language ("Fix test isolation issues..."), which is exactly
  // the legacy case this fallback exists for. \b keeps "Fixture..." and
  // similar non-fix words out while still covering "Fix ...", "Fixes ...",
  // "Fixed ...", "fix: ...", and "fix(scope): ...".
  //
  // The title heuristic is gated on the feature oracle being empty, same as
  // the Fix-tier signal: it exists only for pre-template PRs, which have no
  // oracle at all. Without the gate, a genuine feature PR whose title
  // happens to start with "Fix" (an approved behavior change like "Fix
  // checkout semantics") would have its populated feature oracle overridden
  // by a word in its title. The explicit bugfix label stays ungated — a
  // label is a deliberate marker, not a legacy heuristic.
  if (
    hasGenuineFixTier ||
    (!featureOracle && /^(fix(es|ed)?|bugfix)\b/i.test(pr.title ?? "")) ||
    (pr.labels ?? []).some((l) => l.name === "bugfix")
  )
    return "bugfix";
  return "feature/code";
}

/**
 * Artifact size. Both dimensions are kept — neither alone is size.
 *
 * Deduplicated by filename first: a repeated file record (a bad fixture, or
 * two concatenated pages that overlap) would otherwise double-count that
 * file's additions and deletions, silently inflating every dimension of a
 * number this ledger persists as mechanically authoritative.
 */
export function artifactSize(files) {
  const seen = new Set();
  const unique = files.filter((f) => (seen.has(f.filename) ? false : seen.add(f.filename)));
  return {
    files: unique.length,
    added: unique.reduce((n, f) => n + (f.additions ?? 0), 0),
    removed: unique.reduce((n, f) => n + (f.deletions ?? 0), 0),
  };
}

/**
 * Adjudication population for the causal classification: EVERY finding,
 * deliberately (David, 2026-07-27).
 *
 * The blind adjudicator is an agent, so full coverage costs tokens once per
 * loop close rather than anyone's time — and the earlier 30%-sample design
 * produced two confirmed selection-bias defects in two consecutive review
 * rounds before being removed (an id-sort that oversampled round 1, then a
 * round-robin whose coverage guarantee failed when nonempty rounds exceeded
 * the sample size). Full population makes the >20% disagreement gate exact
 * and leaves no selection rule to get wrong. See working-modes.md's "Why the
 * full population, not a sample". The zero case stays explicit: a clean loop
 * has nothing to adjudicate, and its causal share is recorded as "n/a —
 * clean loop", never 0%.
 */
export function adjudicationSample(findings) {
  if (findings === 0) return { size: 0, note: "no findings — nothing to adjudicate" };
  return { size: findings, note: "full population — no sampling; see working-modes.md" };
}

/** Assemble the mechanical columns. Judgment columns are left null by design. */
export function derive({ pr, reviews, comments, files }) {
  const rounds = countRounds(reviews);
  const findings = countFindings(comments);
  const per_round = findingsByRound(reviews, comments);

  // Every reviewer-authored root comment must land in exactly one round.
  // `flattenMcpThreads` can produce a root whose `pull_request_review_id` is
  // `undefined` when a comment's `created_at` precedes every same-author
  // review's `submitted_at` (no review to correlate it to) — `countFindings`
  // still counts that root, but `findingsByRound`'s exact-match filter puts it
  // in no round, so the per-round sum would silently disagree with the total.
  // A row whose own numbers don't reconcile is worse than no row at all.
  const perRoundTotal = per_round.reduce((n, r) => n + r.findings, 0);
  if (perRoundTotal !== findings) {
    throw new Error(
      `findings (${findings}) does not equal the sum of per-round findings (${perRoundTotal}) for PR #${pr.number}. ` +
        `At least one reviewer-authored root comment could not be attributed to a review round. ` +
        `Fix the round correlation rather than deriving a row whose own totals disagree.`,
    );
  }

  return {
    pr: pr.number,
    title: pr.title,
    cohort: classifyCohort(pr, files),
    size: artifactSize(files),
    rounds,
    findings,
    per_round,
    review_interval: reviewInterval(pr, reviews),
    adjudication_sample: adjudicationSample(findings),
    state: pr.merged_at ? "merged" : pr.closed_at ? "closed" : "open",
    // Judgment columns — appended by hand at loop close, never guessed here.
    judgment: {
      new_ground: null,
      propagation: null,
      wrong_fix: null,
      re_raised: null,
      invalid: null,
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
 * This is not a formality. A loop with 32 review rounds and 166 findings —
 * PR #279's, our worst case to date, and exactly the shape this adapter
 * exists to measure — will paginate on at least one of `get_reviews`,
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
 *
 * Checking that each collection is an ARRAY is not enough either: an entry
 * missing a required field is just as silently wrong. `files: [{filename:
 * "x.ts"}]` (no additions/deletions) would make `artifactSize()` substitute
 * zero for both via `?? 0`, and a review missing `user.login` is silently
 * excluded from `countRounds`'s round count rather than counted or rejected —
 * both produce a credible-looking undercount instead of throwing.
 *
 * `snapshot.pr` itself is validated too: `derive()` consumes `pr.created_at`
 * for `reviewInterval()`, and a missing/unparseable one produces `NaN` hours
 * that JSON-serializes as a legitimate-looking `hours: null` (with
 * `opened_at` silently omitted) instead of failing loudly.
 */
export function assertMcpSnapshotShape(snapshot) {
  const pr = snapshot.pr ?? {};
  if (typeof pr.number !== "number" || typeof pr.title !== "string" || Number.isNaN(new Date(pr.created_at ?? "").getTime())) {
    throw new Error(
      `MCP snapshot malformed: "pr" must have a numeric number, a string title, and a parseable created_at ` +
        `(got number=${JSON.stringify(pr.number)}, title=${JSON.stringify(pr.title)}, created_at=${JSON.stringify(pr.created_at)}).`,
    );
  }
  for (const key of ["reviews", "files", "reviewThreads"]) {
    if (!Array.isArray(snapshot[key])) {
      throw new Error(
        `MCP snapshot malformed: "${key}" must be an array (got ${typeof snapshot[key]}). ` +
          `An attestation of completeness does not substitute for the data being present.`,
      );
    }
  }
  snapshot.files.forEach((f, i) => {
    if (typeof f.filename !== "string" || typeof f.additions !== "number" || typeof f.deletions !== "number") {
      throw new Error(
        `MCP snapshot malformed: files[${i}] must have a string filename and numeric additions/deletions ` +
          `(got filename=${JSON.stringify(f.filename)}, additions=${JSON.stringify(f.additions)}, ` +
          `deletions=${JSON.stringify(f.deletions)}). A missing field silently substitutes zero rather than ` +
          `reflecting real artifact size.`,
      );
    }
  });
  snapshot.reviews.forEach((r, i) => {
    const hasStableId = typeof r.id === "number" || typeof r.id === "string";
    if (!hasStableId || typeof r.user?.login !== "string" || !r.submitted_at) {
      throw new Error(
        `MCP snapshot malformed: reviews[${i}] must have a stable id (number or string), a string user.login, ` +
          `and a submitted_at (got id=${JSON.stringify(r.id)}, user.login=${JSON.stringify(r.user?.login)}, ` +
          `submitted_at=${JSON.stringify(r.submitted_at)}). countRounds/findingsByRound now dedupe by id — ` +
          `multiple id-less reviews would silently collapse into a single round instead of being rejected.`,
      );
    }
  });
  snapshot.reviewThreads.forEach((thread, i) => {
    if (!Array.isArray(thread.comments)) {
      throw new Error(
        `MCP snapshot malformed: reviewThreads[${i}] (id ${thread.id ?? "unknown"}) has no comments array.`,
      );
    }
    // flattenMcpThreads recovers a comment's id from a discussion_r<digits>
    // match in html_url, falling back to `${thread.id}#${i}` only when that
    // fails. If BOTH are missing — no parseable html_url AND no stable
    // thread.id — every such comment across every such thread collapses to
    // the identical literal id "undefined#0"; countFindings' Set-based dedup
    // then silently merges distinct findings into one, and the per-round
    // count (built from the same collapsed set) stays self-consistent while
    // being wrong.
    const threadHasStableId = typeof thread.id === "string" && thread.id.length > 0;
    thread.comments.forEach((c, j) => {
      const login = c.author ?? c.user?.login;
      if (typeof c.body !== "string" || typeof login !== "string" || !c.created_at) {
        throw new Error(
          `MCP snapshot malformed: reviewThreads[${i}].comments[${j}] must have a body, an author or ` +
            `user.login, and a created_at (got body=${JSON.stringify(c.body)}, author=${JSON.stringify(login)}, ` +
            `created_at=${JSON.stringify(c.created_at)}).`,
        );
      }
      if (!/discussion_r\d+/.test(c.html_url ?? "") && !threadHasStableId) {
        throw new Error(
          `MCP snapshot malformed: reviewThreads[${i}].comments[${j}] has no parseable discussion_r id in ` +
            `html_url (got ${JSON.stringify(c.html_url)}) and reviewThreads[${i}] has no stable thread id ` +
            `(got ${JSON.stringify(thread.id)}) to fall back to.`,
        );
      }
    });
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
 * Pagination is not incidental here: PR #279's loop ran 32 review rounds —
 * our worst case to date, and the one the ledger most needs to characterise —
 * which exceeds a default page. A wrapper that silently returns page one
 * would undercount rounds precisely on the large loops, which is the failure
 * this whole file exists to prevent.
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

/**
 * Parse and validate CLI arguments. Exported so the validation itself is
 * directly testable without mocking process.argv/exit.
 *
 * Failure modes this used to let through silently:
 *  - More than one of --fixture/--mcp-snapshot/--pr supplied together: the
 *    old code just picked by precedence, so e.g. `--fixture stale.json --pr
 *    270` would derive from the stale fixture while appearing to target PR
 *    270 — persisting a row for the wrong loop with no error at all.
 *  - `--save-fixture` given with no following path (e.g. as the last arg):
 *    the old code treated a `null`/`undefined` value the same as "not
 *    requested" and skipped saving silently — a capture that looks
 *    successful but loses the fixture needed to reproduce the calculation.
 *  - A valueless option immediately followed by another option: `--save-
 *    fixture --pr 270` used to read `"--pr"` itself as save-fixture's value
 *    and write a file literally named `--pr`, instead of reporting the
 *    missing path. A value that itself looks like an option (starts with
 *    `--`) is now treated as no value at all.
 *  - The same flag given twice: the old lookup silently used the first
 *    occurrence and ignored the second, which could mean the wrong one of
 *    two conflicting values gets used with no indication anything was
 *    dropped.
 */
export function parseArgs(argv) {
  // A flag present with no valid value (missing entirely, or the next token
  // itself looks like another option) throws immediately, uniformly across
  // all four flags — never silently falls back to "as if it wasn't given."
  const arg = (name) => {
    const flag = `--${name}`;
    const i = argv.indexOf(flag);
    if (i === -1) return null;
    if (argv.lastIndexOf(flag) !== i) {
      throw new Error(`--${name} was given more than once`);
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`--${name} requires a value`);
    }
    return value;
  };

  const fixture = arg("fixture");
  const mcpSnapshot = arg("mcp-snapshot");
  const prNumber = arg("pr");
  const sources = [fixture, mcpSnapshot, prNumber].filter((v) => v != null);
  if (sources.length === 0) {
    throw new Error("usage: loop-metrics.mjs --pr <number> | --fixture <file> | --mcp-snapshot <file>");
  }
  if (sources.length > 1) {
    throw new Error(
      "loop-metrics.mjs accepts exactly one of --pr, --fixture, --mcp-snapshot, not more than one at once.",
    );
  }

  const saveTo = arg("save-fixture");

  return { fixture, mcpSnapshot, prNumber, saveTo };
}

async function main() {
  const { fixture, mcpSnapshot, prNumber, saveTo } = parseArgs(process.argv);

  const { readFile, writeFile } = await import("node:fs/promises");
  const raw = fixture
    ? JSON.parse(await readFile(fixture, "utf8"))
    : mcpSnapshot
      ? fromMcp(JSON.parse(await readFile(mcpSnapshot, "utf8")))
      : await fetchPR(prNumber);

  if (saveTo) await writeFile(saveTo, JSON.stringify(raw, null, 2));

  console.log(JSON.stringify(derive(raw), null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}

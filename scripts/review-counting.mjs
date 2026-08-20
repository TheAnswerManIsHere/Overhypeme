/**
 * review-counting — count review rounds and findings from a PR snapshot.
 *
 * A library, not a CLI. `review-budget.mjs` (the round budget) and
 * `review-loop-record.mjs` (the adjudicator's mechanical record) both import
 * from here, so both count the same way by construction rather than by two
 * implementations agreeing.
 *
 * The design rule is that **numbers a machine can count are never recalled by
 * hand.** Attempts to characterise our own review history by recollection
 * were wrong three times out of three; every figure produced by counting a
 * source held.
 *
 * Input is an MCP snapshot (`fromMcp`), because this container has no usable
 * direct GitHub credential: `GITHUB_TOKEN` is scoped to a local git proxy and
 * 401s against the real API, and `curl` is refused by the guard. The MCP
 * integration is the only working channel — see
 * `.agents/memory/github-rest-api-blocked-from-bash.md`.
 *
 * This file was `loop-metrics.mjs` until the loop ledger was deleted
 * (2026-08-20). The ledger's derivation, cohort classification, and record
 * store went with it; the counting functions the live machinery depends on
 * stayed and are all that remain here.
 */


/** Logins whose reviews count as a review round. */
export const REVIEWER_LOGINS = new Set(["chatgpt-codex-connector[bot]", "chatgpt-codex-connector"]);

/**
 * The connector's own machine-ish declaration that a review pass completed,
 * and against which commit: a literal "**Reviewed commit:** `<sha>`" line.
 *
 * This is the only marker that appears on EVERY completed pass regardless of
 * how the pass was delivered — verified against this repo's PRs #286, #288 and
 * #290 rather than assumed. It carries an abbreviated sha (10 hex chars in
 * practice), while a review object's own `commit_id` is the full 40, so
 * comparisons between the two are prefix-based (`sameCommit` below).
 *
 * Deliberately NOT keyed on the pass's prose ("Didn't find any major issues.
 * Delightful!" / "…Swish!" / "…:+1:" — three different suffixes across three
 * PRs). Sentiment wording drifts; the structured marker is what the connector
 * emits consistently.
 */
const REVIEWED_COMMIT_MARKER = /\*\*Reviewed commit:\*\*\s*`([0-9a-f]{7,40})`/i;

/** Whether two commit references name the same commit, one possibly abbreviated. */
function sameCommit(a, b) {
  if (!a || !b) return false;
  const x = String(a).toLowerCase();
  const y = String(b).toLowerCase();
  return x.startsWith(y) || y.startsWith(x);
}

// ---------------------------------------------------------------------------
// Pure derivation — no I/O. This is the part that is tested.
// ---------------------------------------------------------------------------

/**
 * A *round* is one completed reviewer PASS — not an "@codex review" comment,
 * and not a raw `pull_request_review` record either.
 *
 * The connector auto-reviews every non-draft PR on open and only needs an
 * explicit trigger for later fix rounds, so counting trigger comments
 * undercounts every implementation PR by exactly one — and does so
 * non-uniformly, since draft plan-review PRs get no auto-review and would
 * count correctly. Comparing those two cohorts is the entire point of the
 * ledger, so a bias present in one and absent in the other is disqualifying.
 * That is why this never counted triggers.
 *
 * Counting raw review records instead — what this function did until
 * 2026-08-01 — turned out to be wrong in BOTH directions at once, which is
 * why the ledger's own rows disagreed with their PRs' hand-written round
 * narrations:
 *
 *  - **Undercount.** A pass that finds nothing does not always submit a
 *    `pull_request_review` at all. On #286 and #288 the clean pass posted as a
 *    plain *issue* comment ("Codex Review: Didn't find any major issues…")
 *    carrying a `**Reviewed commit:**` line — invisible to a function that
 *    only reads the `reviews` collection. #288 lost two rounds this way.
 *  - **Overcount.** A single pass can emit TWO review records — one *bodiless*
 *    record carrying the inline findings, one summary record carrying the
 *    "💡 Codex Review" announcement. #290's round 3 did exactly that (records
 *    4815015613 and 4815024115, both on `c81d316fe6`), inflating its round
 *    count by one.
 *
 * Both are corrected by counting *announcements*, which is the one thing the
 * connector emits exactly once per completed pass: a `**Reviewed commit:**`
 * line, in a review body when the pass found something and in an issue comment
 * when it didn't. A bodiless review record is an inline-comment carrier, not a
 * pass, and is attached to the announcement it belongs to.
 *
 * Grouping by the reviewed *commit* instead would be wrong, and #292 is the
 * counter-example: its records 4823525411 and 4823605230 are both full
 * announcements against `66c2780bd0` twelve minutes apart, separated by author
 * replies and no push — two genuine re-review passes over one commit, which
 * commit-grouping would have silently merged into one.
 *
 * Checked against every PR whose rounds a human independently narrated in its
 * own body: #286 (2), #288 (7), #290 (7). This agrees with all three; counting
 * raw records agreed with none of them. #292 is cited above for its structural
 * counter-example only — its two same-commit announcements — not for a round
 * total, which was not independently narrated there.
 */
export function reviewerPasses(reviews, issueComments = []) {
  // Deduplicated by review id first: a duplicated review record (a bad
  // fixture, or two concatenated MCP/REST pages that overlap) is one record,
  // not two.
  const seenIds = new Set();
  const formal = reviews
    .filter((r) => REVIEWER_LOGINS.has(r.user?.login))
    .filter((r) => (seenIds.has(r.id) ? false : seenIds.add(r.id)))
    .sort((a, b) => new Date(a.submitted_at) - new Date(b.submitted_at));

  const isAnnouncement = (r) => REVIEWED_COMMIT_MARKER.test(r.body ?? "");
  // Fixtures captured before review bodies were retained carry no body at all.
  // With no announcement to key on there is nothing to improve, so those fall
  // back to one-pass-per-record — the pre-2026-08-01 behaviour — rather than
  // collapsing every record into nothing.
  const announced = formal.filter(isAnnouncement);
  const base = announced.length ? announced : formal;
  const carriers = announced.length ? formal.filter((r) => !isAnnouncement(r)) : [];

  const passes = base.map((r) => ({
    commit: r.commit_id ?? null,
    at: r.submitted_at,
    reviewIds: [r.id],
    records: 1,
    source: "review",
  }));

  for (const carrier of carriers) {
    // A carrier's inline findings belong to the announcement that closes the
    // same pass, which is submitted at or after it. Same-commit wins when more
    // than one announcement qualifies (#292 shows a commit can be announced
    // twice); otherwise the earliest following announcement. A carrier with
    // nothing after it stands alone rather than having its findings orphaned —
    // an unattributable root comment would trip derive()'s reconciliation.
    const following = passes.filter((p) => new Date(p.at) >= new Date(carrier.submitted_at));
    const target = following.find((p) => sameCommit(p.commit, carrier.commit_id)) ?? following[0];
    if (target) {
      target.reviewIds.push(carrier.id);
      target.records += 1;
    } else {
      passes.push({
        commit: carrier.commit_id ?? null,
        at: carrier.submitted_at,
        reviewIds: [carrier.id],
        records: 1,
        source: "review",
      });
    }
  }

  // Deduplicated by id first, same reasoning as `formal` above: a bad fixture
  // or two overlapping concatenated `get_comments` pages can repeat a comment
  // record. Root comments and formal reviews already guard against this input
  // shape; a repeated clean-pass announcement would otherwise silently
  // fabricate a second round with zero findings — invisible to derive()'s
  // reconciliation check, since a zero-finding round can't disagree with
  // anything.
  const seenCommentIds = new Set();
  for (const comment of issueComments) {
    if (!REVIEWER_LOGINS.has(comment.user?.login)) continue;
    if (seenCommentIds.has(comment.id)) continue;
    seenCommentIds.add(comment.id);
    const marker = REVIEWED_COMMIT_MARKER.exec(comment.body ?? "");
    if (!marker) continue;
    // Not deduplicated against the formal announcements: the two shapes are
    // mutually exclusive on this transport (a pass posts a review body when it
    // found something, an issue comment when it didn't — checked across #286,
    // #288, #290 and #292), and #292 proves a repeated commit can be a second
    // real pass rather than a restatement of the first.
    passes.push({
      commit: marker[1].toLowerCase(),
      at: comment.created_at,
      reviewIds: [],
      records: 0,
      source: "comment",
    });
  }

  return passes.sort((a, b) => new Date(a.at) - new Date(b.at));
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
 * Findings grouped by round, one entry per reviewer PASS (see
 * `reviewerPasses`) rather than per raw review record — so a pass split across
 * two records reports its findings once, under one round, instead of as two
 * rounds that between them claim the same findings.
 *
 * Root comments are deduplicated by id first, matching `countFindings`' own
 * semantics: a duplicated root comment (a bad fixture, or an overlapping
 * concatenated page) would otherwise make a round's count disagree with the
 * deduplicated total, tripping derive()'s reconciliation check for what is
 * actually a duplicate-input problem rather than a genuine correlation
 * failure.
 *
 * A clean pass contributes an entry with `findings: 0`. That is the point of
 * recording it: the ledger's "rounds that surfaced findings" analysis needs to
 * tell a loop that ran a fourth round and found nothing from a loop that
 * simply stopped at three.
 */
export function findingsByRound(reviews, comments, issueComments = []) {
  const passes = reviewerPasses(reviews, issueComments);

  const seenRootIds = new Set();
  const uniqueRoots = comments
    .filter((c) => REVIEWER_LOGINS.has(c.user?.login) && !c.in_reply_to_id)
    .filter((c) => (seenRootIds.has(c.id) ? false : seenRootIds.add(c.id)));

  return passes.map((pass, i) => ({
    round: i + 1,
    submitted_at: pass.at,
    source: pass.source,
    findings: uniqueRoots.filter((c) => pass.reviewIds.includes(c.pull_request_review_id)).length,
  }));
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
export const normalizeLogin = (login) => (login ?? "").replace(/\[bot\]$/, "");

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
 * This library runs inside a plain Node process — it cannot itself call
 * `pull_request_read`, so it cannot page through the MCP tool. The agent
 * assembling the snapshot must
 * do that instead, and must say so explicitly: this throws unless
 * `snapshot.complete` marks all three paginated collections `true`.
 *
 * This is not a formality. A loop with 32 review rounds (PR #279, our worst
 * case by round count) or 180 findings (PR #280, our worst case by finding
 * count, on 18 rounds) — exactly the shape this adapter exists to measure —
 * will paginate on at least one of `get_reviews`,
 * `get_review_comments`, or `get_files`. Deriving a row from an unmarked
 * partial snapshot produces a number that looks measured and undercounts
 * rounds, findings, or artifact size on precisely the loops that matter most.
 */
const MCP_METHOD_FOR = {
  reviews: "get_reviews",
  files: "get_files",
  reviewThreads: "get_review_comments",
  issueComments: "get_comments",
};

export function assertMcpSnapshotComplete(snapshot) {
  const complete = snapshot.complete ?? {};
  // `issueComments` is checked only when supplied. Requiring it outright would
  // invalidate every snapshot captured before it was needed, and `derive()`
  // already warns loudly when it is absent — but a snapshot that DOES carry it
  // must attest to it like any other paginated collection, or a truncated
  // first page would silently drop the clean passes it was added to find.
  const required = ["reviews", "files", "reviewThreads"];
  if (snapshot.issueComments !== undefined) required.push("issueComments");
  for (const key of required) {
    if (complete[key] !== true) {
      throw new Error(
        `MCP snapshot incomplete: complete.${key} must be explicitly true. ` +
          `Page through pull_request_read (method:"${MCP_METHOD_FOR[key]}") until it reports no further ` +
          `pages, concatenate every page, then set complete.${key} = true.`,
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
  // `closed_at` is required whenever the PR is closed, because the digest
  // windows on it and a record without one cannot be placed in time. It is
  // deliberately NOT required to be non-null: an open PR has no closure
  // timestamp, and `--write` (which is the only consumer that needs one)
  // rejects that case on its own with a clearer message than a shape error.
  // What is rejected here is a snapshot that omits the KEY entirely — the
  // pre-2026-08-07 shape — since silently defaulting it to null would put an
  // unplaceable record in the store and call it complete.
  if (!("closed_at" in pr)) {
    throw new Error(
      `MCP snapshot malformed: "pr" is missing "closed_at". Capture it alongside number/title/created_at ` +
        `(pull_request_read method:"get" returns it); use null for a PR that is still open. ` +
        `The digest windows on the closure timestamp and cannot place a record without it.`,
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
  if (snapshot.issueComments !== undefined && !Array.isArray(snapshot.issueComments)) {
    throw new Error(
      `MCP snapshot malformed: "issueComments" must be an array when present (got ` +
        `${typeof snapshot.issueComments}). Omit the key entirely to derive without clean-pass detection — ` +
        `derive() then warns that rounds may be understated, rather than reporting a confident wrong number.`,
    );
  }
  (snapshot.issueComments ?? []).forEach((c, i) => {
    // body/user.login/created_at are what reviewerPasses/reviewInterval read —
    // missing either silently hides a real clean pass or sorts it to the
    // epoch. id is required for the same reason reviews require a stable id
    // (see hasStableId below): reviewerPasses dedupes issue comments by id,
    // and an id-less comment would either collide with every other id-less
    // comment (silently dropping distinct passes) or, if left unvalidated,
    // could be repeated across concatenated pages and fabricate a phantom
    // zero-finding round that findings reconciliation cannot catch.
    const hasStableCommentId = typeof c.id === "number" || typeof c.id === "string";
    if (!hasStableCommentId || typeof c.body !== "string" || typeof c.user?.login !== "string" || !c.created_at) {
      throw new Error(
        `MCP snapshot malformed: issueComments[${i}] must have a stable id (number or string), a string body, ` +
          `a string user.login, and a created_at (got id=${JSON.stringify(c.id)}, body=${typeof c.body}, ` +
          `user.login=${JSON.stringify(c.user?.login)}, created_at=${JSON.stringify(c.created_at)}).`,
      );
    }
  });
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
 *     issueComments: <all pages of method:"get_comments", concatenated>,
 *     complete: { reviews: true, files: true, reviewThreads: true, issueComments: true } }
 *
 * `issueComments` may be omitted for backward compatibility with snapshots
 * captured before clean-pass detection existed, but a row derived without it
 * carries a `warnings` entry saying its `rounds` may be short. Supply it.
 *
 * `pr`, `reviews`, and `files` pass through unchanged — verified against
 * PR #270's live output to carry the same field names `derive()` expects
 * (`user.login`, `submitted_at`, `filename`/`additions`/`deletions`). Only
 * `reviewThreads` needs the flattening above.
 */
export function fromMcp(snapshot) {
  assertMcpSnapshotShape(snapshot);
  assertMcpSnapshotComplete(snapshot);
  const { pr, reviews, files, reviewThreads, issueComments } = snapshot;
  return {
    pr,
    reviews,
    files,
    comments: flattenMcpThreads(reviewThreads, reviews),
    // Passed through undefined-preserving: `derive()` distinguishes "supplied
    // and empty" (a loop with no clean pass) from "not supplied at all" (a
    // snapshot that cannot answer the question), and warns only on the latter.
    issueComments,
  };
}

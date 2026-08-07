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

export function countRounds(reviews, issueComments = []) {
  return reviewerPasses(reviews, issueComments).length;
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
 * Review-interval wall-clock: PR open → final reviewer event.
 *
 * ONE interval, never a sum. An earlier design added preflight duration to
 * this, which double-counts every preflight that happens after the PR opens —
 * those already sit inside this window. Preflight time that precedes the PR is
 * recorded separately in the ledger's judgment column and is *not* added here;
 * whoever wants total cost adds the pre-open portion only, and the ledger says
 * so per row rather than presenting a conflated number as derived.
 *
 * "Final reviewer event" spans BOTH delivery shapes, for the same reason
 * `reviewerPasses` counts both: on #286 the loop's last reviewer engagement
 * was a clean issue-comment pass ~2.8h after open, and reading only the
 * `reviews` collection reported 0.1h — understating the review window by a
 * factor of twenty-eight.
 */
export function reviewInterval(pr, reviews, issueComments = []) {
  const stamps = [
    ...reviews.filter((r) => REVIEWER_LOGINS.has(r.user?.login)).map((r) => new Date(r.submitted_at)),
    ...issueComments
      .filter((c) => REVIEWER_LOGINS.has(c.user?.login) && REVIEWED_COMMIT_MARKER.test(c.body ?? ""))
      .map((c) => new Date(c.created_at)),
  ];
  if (stamps.length === 0) return null;
  const last = stamps.reduce((a, b) => (a > b ? a : b));
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
// Excluded from prose-cohort detection. Historically (until 2026-08-02) a
// closed loop's row was folded into whichever PR opened next, on ANY subject,
// so most feature/bugfix PRs carried an incidental edit to this file —
// counting it as prose-cohort evidence would have misclassified nearly every
// PR as prose/contract. Rows now ship via dedicated [LEDGER] PRs
// (working-modes.md → "A row ships in a dedicated [LEDGER] PR"), which never
// get rows and are never run through this classifier — but the exclusion
// stays, both for re-deriving the historical rows that DO carry incidental
// ledger edits and as a guard against the file appearing in any future mixed
// diff.
const LEDGER_PATH = ".agents/metrics/loop-ledger.md";

/**
 * The per-loop metrics store. Excluded from cohort weighting for the same
 * reason `LEDGER_PATH` is: a record rides an ordinary PR, so counting its own
 * bookkeeping as evidence about that PR's shape is circular.
 */
const METRICS_STORE_PREFIX = ".agents/metrics/loops/";

/**
 * One record per filename. A repeated file record (a bad fixture, or two
 * concatenated pages that overlap) would otherwise double-count that file in
 * every dimension derived from it.
 */
function dedupeByFilename(files) {
  const seen = new Set();
  return files.filter((f) => (seen.has(f.filename) ? false : seen.add(f.filename)));
}

export function classifyCohort(pr, files) {
  if (/^\[PLAN REVIEW\]/.test(pr.title ?? "")) return "plan-review";
  // Cohort order is plan-review → bugfix → code-majority → prose/contract.
  //
  // Until 2026-08-07 a bare "any prose path present" check ran FIRST and
  // returned `prose/contract` immediately, which is why five structurally
  // different PR shapes all carry that label in the frozen ledger — a 21-file
  // backend/frontend/migration PR (#288), a pure docs backfill (#289), a
  // skills migration (#301), a devops guard (#304), and a 22-file feature
  // (#308). The label was never evidence of a shared shape, so every
  // cross-cohort comparison built on it was reading noise. Checking the
  // bugfix tier before shape, and weighing code against docs instead of
  // treating one `.md` as decisive, is what makes the column mean something.
  //
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

  const { code, docs, codeFiles, docsFiles } = cohortWeights(files);
  // Presence decides when only one side is represented; weight decides only
  // when the PR is genuinely mixed. Going straight to the weights would make
  // a pure-code PR whose file records carry no line counts (weight 0 on both
  // sides) fall to `prose/contract` on the tie rule — classifying "no data"
  // as "prose", which is exactly the kind of quiet miscount this column is
  // being fixed to stop.
  if (codeFiles === 0) return "prose/contract";
  if (docsFiles === 0) return "feature/code";
  return code > docs ? "feature/code" : "prose/contract";
}

/**
 * Changed-line weight on each side of the code-majority rule.
 *
 * A file's weight is `additions + deletions` — neither alone is size, and a
 * deletion-heavy refactor is still code work. Ties and all-docs both fall to
 * `prose/contract` (the caller's `code > docs`), matching the bias the old
 * prose-first rule had: when a PR is genuinely balanced, the stricter
 * obligations are the safer label.
 *
 * Everything under `.agents/metrics/` contributes to NEITHER side. That is
 * the same reasoning the `LEDGER_PATH` exclusion has always had, extended to
 * the new per-loop store: a record now rides an ordinary PR, so without this
 * a docs-only PR that happens to carry a large metrics record would be
 * reclassified `feature/code` by its own bookkeeping — recreating the exact
 * leak this rule exists to close.
 *
 * A rename arrives as a single file record at its destination path with its
 * own additions/deletions, so it is counted once, on whichever side that
 * destination falls.
 */
export function cohortWeights(files) {
  let code = 0;
  let docs = 0;
  let codeFiles = 0;
  let docsFiles = 0;
  for (const f of dedupeByFilename(files)) {
    const p = f.filename;
    if (p === LEDGER_PATH || p.startsWith(METRICS_STORE_PREFIX)) continue;
    const weight = (f.additions ?? 0) + (f.deletions ?? 0);
    if (/\.(md|mdx)$/.test(p) || p.startsWith("docs/") || p.startsWith(".claude/skills/")) {
      docs += weight;
      docsFiles++;
    } else {
      code += weight;
      codeFiles++;
    }
  }
  return { code, docs, codeFiles, docsFiles };
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

/**
 * Assemble the mechanical columns. Judgment columns are left null by design.
 *
 * `issueComments` is optional only so that fixtures captured before
 * 2026-08-01 still derive. It is not optional in meaning: without it, a clean
 * reviewer pass that posted as an issue comment is invisible and `rounds` /
 * `review hrs` are understated (see `reviewerPasses`). An input that omits it
 * therefore gets a `warnings` entry in the output rather than a clean-looking
 * row — the ledger's own standard that a number which cannot be trusted must
 * not be presented as though it can.
 */
export function derive({ pr, reviews, comments, files, issueComments }) {
  const warnings = [];
  if (issueComments === undefined) {
    warnings.push(
      "issueComments was not supplied, so clean reviewer passes delivered as issue comments could not be " +
        "detected: `rounds` and `review_interval` may both be understated. Re-derive with the issue-comment " +
        "collection (REST /issues/<n>/comments, or MCP pull_request_read method:\"get_comments\") before " +
        "recording this row.",
    );
  }
  const issues = issueComments ?? [];

  const rounds = countRounds(reviews, issues);
  const findings = countFindings(comments);
  const per_round = findingsByRound(reviews, comments, issues);

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

  const merged = reviewerPasses(reviews, issues).filter((p) => p.records > 1);
  if (merged.length) {
    // Never silent: an attribution decision nobody can see reads as a raw count.
    warnings.push(
      `${merged.length} reviewer pass(es) absorbed a bodiless inline-comment review record alongside their ` +
        `announcement (${merged.map((p) => `${p.commit?.slice(0, 10)}×${p.records}`).join(", ")}). Counted as ` +
        `one round each, per reviewerPasses' announcement rule.`,
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
    review_interval: reviewInterval(pr, reviews, issues),
    adjudication_sample: adjudicationSample(findings),
    warnings,
    state: pr.merged_at ? "merged" : pr.closed_at ? "closed" : "open",
    // Closure timestamps, not just the coarse `state`. The digest windows on
    // `closedAt`, and neither `state` nor `review_interval` can supply it:
    // `review_interval` is null for a loop with no reviews at all, and it
    // ends at the LAST REVIEW, which for a post-merge review (frozen-ledger
    // rows #323 and #324) is after the merge rather than at it.
    closedAt: pr.closed_at ?? null,
    mergedAt: pr.merged_at ?? null,
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
  // Issue comments live on the ISSUE resource, not the pull resource — a PR's
  // `/pulls/<n>/comments` is review comments only. The clean-pass
  // announcements `reviewerPasses` needs are issue comments, so they need
  // their own call; omitting it is what made `rounds` undercount.
  const issues = `/repos/${REPO_OWNER}/${REPO_NAME}/issues/${number}`;
  const [prArr, reviews, comments, files, issueComments] = await Promise.all([
    gh(base),
    gh(`${base}/reviews`),
    gh(`${base}/comments`),
    gh(`${base}/files`),
    gh(`${issues}/comments`),
  ]);
  return { pr: prArr[0], reviews, comments, files, issueComments };
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

  const write = argv.includes("--write");
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

  return { fixture, mcpSnapshot, prNumber, saveTo, write };
}

// ---------------------------------------------------------------------------
// The per-loop metrics store — `--write`
// ---------------------------------------------------------------------------

/**
 * The ONLY keys a stored `mechanical` block may carry. An allowlist, not a
 * blocklist, and not a spread of `derive()`'s output.
 *
 * `derive()` returns more than this: its own `pr`, a `judgment` block of
 * nulls, `adjudication_sample`, and a coarse `state`. Persisting any of them
 * would put a second representation of something authoritative into the
 * record — identity beside the top-level `pr`, an empty judgment beside the
 * real one, a sampling verdict beside the real `adjudication`, a state beside
 * `closedAt` — and a later refresh would leave that copy stale while every
 * other check still passed. The guard rejects unknown keys for the same
 * reason, so the shape cannot drift back.
 */
export const MECHANICAL_KEYS = [
  "title",
  "cohort",
  "size",
  "rounds",
  "findings",
  "perRound",
  "reviewInterval",
  "warnings",
];

/** `derive()` output → the stored `mechanical` block, built key by key. */
export function mechanicalProjection(derived) {
  return {
    title: derived.title,
    cohort: derived.cohort,
    size: derived.size,
    rounds: derived.rounds,
    findings: derived.findings,
    perRound: derived.per_round,
    reviewInterval: derived.review_interval,
    warnings: derived.warnings,
  };
}

/** The scaffold `--write` lays down. `judgment` is deliberately null: the
 * closing session fills it, and the guard fails any record that lands
 * without it, so an interrupted session cannot leave a valid-looking hole. */
export function scaffoldRecord(derived) {
  return {
    schemaVersion: 1,
    pr: derived.pr,
    closedAt: derived.closedAt,
    mechanical: mechanicalProjection(derived),
    judgment: null,
    adjudication: null,
    notes: "",
  };
}

export const recordPath = (pr) => `${METRICS_STORE_PREFIX}${pr}.json`;

async function main() {
  const { fixture, mcpSnapshot, prNumber, saveTo, write } = parseArgs(process.argv);

  const { readFile, writeFile, mkdir } = await import("node:fs/promises");
  const raw = fixture
    ? JSON.parse(await readFile(fixture, "utf8"))
    : mcpSnapshot
      ? fromMcp(JSON.parse(await readFile(mcpSnapshot, "utf8")))
      : await fetchPR(prNumber);

  if (saveTo) await writeFile(saveTo, JSON.stringify(raw, null, 2));

  const derived = derive(raw);
  if (!write) {
    console.log(JSON.stringify(derived, null, 2));
    return;
  }

  // ── --write: land a record in the store ────────────────────────────────
  //
  // Plain derivation stays lenient about a missing issue-comment collection
  // (older read-only snapshots predate it, and `derive()` warns). Writing is
  // different: a reviewer pass delivered as a plain issue comment is
  // invisible without that collection, so `rounds` and `review_interval`
  // come out understated — and the digest would then aggregate them as
  // measured. "Counted, never recalled" has to mean counted *completely*, so
  // this is the one place the leniency stops.
  if (raw.issueComments === undefined) {
    throw new Error(
      `Refusing to write a record for PR #${derived.pr}: the input has no issue-comment collection, so ` +
        `rounds and review time are understated (a clean reviewer pass often posts as a plain issue ` +
        `comment).\n  Re-derive with that collection — REST /issues/<n>/comments, or MCP ` +
        `pull_request_read method:"get_comments", paged to completion — then --write again.\n` +
        `  Plain derivation (without --write) still works on an incomplete input; it just warns.`,
    );
  }
  if (!derived.closedAt) {
    throw new Error(
      `Refusing to write a record for PR #${derived.pr}: it has no closure timestamp, so the loop is not ` +
        `over and the digest could not place it in a window. Record at the loop's terminal point.`,
    );
  }

  const path = recordPath(derived.pr);
  const existing = await existingRecord(path);
  if (existing) {
    console.log(`already recorded: ${path} (${existing})`);
    return;
  }

  await mkdir(METRICS_STORE_PREFIX, { recursive: true });
  await writeFile(path, `${JSON.stringify(scaffoldRecord(derived), null, 2)}\n`);
  console.log(
    `wrote ${path}\n` +
      `  Next: fill "judgment" (causes, preOpenPreflightMin, breakersFired), then set "adjudication".\n` +
      `  Sampling predicate: pr % 5 === 0 (${derived.pr % 5 === 0 ? "yes" : "no"}) or findings >= 30 ` +
      `(${derived.findings} findings) → ${derived.pr % 5 === 0 || derived.findings >= 30 ? "ADJUDICATE" : "never-run"}.\n` +
      `  Commit it on any open PR EXCEPT #${derived.pr} itself.`,
  );
}

/**
 * Where a record for this loop already exists, or null.
 *
 * Checks the working tree AND `origin/main`, because a record that landed on
 * `main` is invisible to a branch cut before it — without the remote check,
 * "recording the same loop twice in sequence is a no-op" would hold only for
 * a fresh checkout.
 *
 * It deliberately does NOT look at other open branches. A record sitting on
 * someone's unmerged PR is not discoverable without an authoritative
 * open-branch lookup, and per the design that whole class — every overlap
 * before a record lands — is the accepted git-conflict case rather than a
 * promise this function pretends to keep.
 */
async function existingRecord(path) {
  const { access } = await import("node:fs/promises");
  try {
    await access(path);
    return "working tree";
  } catch {
    /* not present locally — fall through to the remote check */
  }
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  try {
    await run("git", ["fetch", "--quiet", "origin", "main"]);
    await run("git", ["cat-file", "-e", `origin/main:${path}`]);
    return "origin/main";
  } catch {
    return null;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}

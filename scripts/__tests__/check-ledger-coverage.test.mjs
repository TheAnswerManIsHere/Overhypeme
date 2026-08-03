import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseLedger,
  tableUnderHeading,
  countCell,
  checkArithmetic,
  isArithmeticCheckable,
  owedRows,
  auditLedgerDebt,
  isLedgerPr,
  isConfirmedLedgerPr,
  ledgerPrStrayFiles,
  confirmedLedgerPrNumbers,
} from "../check-ledger-coverage.mjs";

const PULL = (n) => `[#${n}](https://github.com/TheAnswerManIsHere/Overhypeme/pull/${n})`;

/** A minimal ledger with the real column layout, parameterised per row. */
function ledgerDoc(rowLines, exemptLines = []) {
  return `# Loop ledger

## Rows

| # | pr | cohort | files | +lines | -lines | rounds | findings | new | prop | wrong | re-raised | invalid | self-infl. | review hrs | pre-open preflight | breakers fired | adjudicated | notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
${rowLines.join("\n")}

## Deliberately not measured

| pr | cohort | reason |
|---|---|---|
${exemptLines.join("\n")}

## Something else
`;
}

const row = (n, { findings, causes, cohort = "bugfix" }) =>
  `| 1 | ${PULL(n)} | ${cohort} | 3 | 10 | 2 | 1 | ${findings} | ${causes.join(" | ")} | **0%** | 0.1 | — | none | ✓ | note |`;

test("a row's causal counts must sum to its findings total", () => {
  const ok = parseLedger(ledgerDoc([row(283, { findings: 4, causes: [2, 1, 1, 0, 0] })]));
  assert.deepEqual(checkArithmetic(ok), []);

  const short = parseLedger(ledgerDoc([row(283, { findings: 4, causes: [1, 1, 1, 0, 0] })]));
  const problems = checkArithmetic(short);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /sum to 3 but findings is 4/);
});

test("an unmeasured causal column is tolerated, but the present ones must still reconcile", () => {
  // Rows 1-2 of the real ledger predate the `invalid` category and record it
  // as "—". Their four present counts still sum to findings, and treating "—"
  // as zero would be wrong in the other direction: blank means not measured.
  const retro = parseLedger(ledgerDoc([row(268, { findings: 40, causes: [16, 19, 5, 0, "—"] })]));
  assert.deepEqual(checkArithmetic(retro), []);

  const broken = parseLedger(ledgerDoc([row(268, { findings: 40, causes: [16, 19, 4, 0, "—"] })]));
  assert.equal(checkArithmetic(broken).length, 1);
});

test("a wholly unclassified row (all causal cells blank) is not arithmetic-checkable", () => {
  // Confirmed on PR #292 (Codex round 5): checkArithmetic silently skips a
  // row whose causes are all "—" (a size-based deferral, e.g. row 6/#279),
  // but main()'s old success message reported ledger.rows.length regardless
  // — overclaiming that every row in the table had been reconciled.
  // isArithmeticCheckable is what main() uses to report the checked/total
  // split honestly instead.
  const deferred = parseLedger(
    ledgerDoc([row(279, { findings: 166, causes: ["—", "—", "—", "—", "—"] })]),
  );
  assert.equal(isArithmeticCheckable(deferred.rows[0]), false);
  assert.deepEqual(checkArithmetic(deferred), []);

  const classified = parseLedger(ledgerDoc([row(283, { findings: 4, causes: [2, 1, 1, 0, 0] })]));
  assert.equal(isArithmeticCheckable(classified.rows[0]), true);
});

test("countCell distinguishes an unmeasured cell from zero", () => {
  assert.equal(countCell("0"), 0);
  assert.equal(countCell("**3**"), 3);
  assert.equal(countCell("—"), null);
  assert.equal(countCell(""), null);
  assert.equal(countCell("n/a"), null);
});

test("countCell rejects malformed text instead of silently treating it as unmeasured", () => {
  // A typo like "4x" is neither a number nor a recognized "not measured"
  // sentinel. Folding it into null would let a corrupted `findings` cell skip
  // its row out of checkArithmetic entirely, and a corrupted causal cell
  // could pass arithmetic outright whenever the other columns already summed
  // correctly — the guard reporting the ledger reconciles while it doesn't.
  assert.throws(() => countCell("4x", "PR #1's finding"), /neither a number nor a recognized/);
  assert.throws(() => countCell("abc"), /neither a number nor a recognized/);
});

test("a row with a malformed count cell fails parsing loudly, not silently as unmeasured", () => {
  const doc = ledgerDoc([row(283, { findings: "4x", causes: [1, 0, 0, 0, 0] })]);
  assert.throws(() => parseLedger(doc), /neither a number nor a recognized/);
});

test("two rows for the same PR are rejected rather than both silently accepted", () => {
  const doc = ledgerDoc([
    row(283, { findings: 1, causes: [1, 0, 0, 0, 0] }),
    row(283, { findings: 1, causes: [1, 0, 0, 0, 0] }),
  ]);
  assert.throws(() => parseLedger(doc), /appears more than once in the "## Rows" table/);
});

test("a table is read only up to the next heading", () => {
  const parsed = tableUnderHeading(ledgerDoc([row(283, { findings: 1, causes: [1, 0, 0, 0, 0] })]), "Rows");
  assert.equal(parsed.rows.length, 1);
});

// ── Coverage rule ────────────────────────────────────────────────────────────

const CURRENT = { number: 300, created_at: "2026-08-01T00:00:00Z", closed_at: null, user: { login: "me" } };
const emptyLedger = { rows: [], exempt: new Map() };

test("a loop that closed before this PR opened, with no row, is owed", () => {
  const allPrs = [CURRENT, { number: 283, closed_at: "2026-07-29T00:00:00Z", title: "x", user: { login: "me" } }];
  const { owed } = owedRows({ allPrs, currentPr: CURRENT, ledger: emptyLedger });
  assert.deepEqual(owed.map((p) => p.number), [283]);
});

test("a loop that closed AFTER this PR opened is not owed on this PR", () => {
  // Its row belongs to the next PR, not retroactively to one already in
  // flight — otherwise a long-lived PR would fail for loops that closed
  // while it sat open, which no amount of editing it could have anticipated.
  const allPrs = [CURRENT, { number: 299, closed_at: "2026-08-02T00:00:00Z", title: "x", user: { login: "me" } }];
  const { owed } = owedRows({ allPrs, currentPr: CURRENT, ledger: emptyLedger });
  assert.deepEqual(owed, []);
});

test("an open loop is not owed, and the current PR never owes itself", () => {
  const allPrs = [CURRENT, { number: 285, closed_at: null, title: "still open", user: { login: "me" } }];
  const { owed } = owedRows({ allPrs, currentPr: CURRENT, ledger: emptyLedger });
  assert.deepEqual(owed, []);
});

test("loops before the ledger's first enforced PR are not owed", () => {
  const allPrs = [CURRENT, { number: 269, closed_at: "2026-07-27T00:00:00Z", title: "x", user: { login: "me" } }];
  const { owed } = owedRows({ allPrs, currentPr: CURRENT, ledger: emptyLedger });
  assert.deepEqual(owed, []);
});

test("a row or a recorded exemption both satisfy the rule", () => {
  const allPrs = [
    CURRENT,
    { number: 283, closed_at: "2026-07-29T00:00:00Z", title: "has a row", user: { login: "me" } },
    { number: 277, closed_at: "2026-07-28T00:00:00Z", title: "exempted", user: { login: "me" } },
  ];
  const ledger = { rows: [{ pr: 283 }], exempt: new Map([[277, "prose loop, deliberately not backfilled"]]) };
  const { owed } = owedRows({ allPrs, currentPr: CURRENT, ledger });
  assert.deepEqual(owed, []);
});

test("Dependabot PRs are excluded, and the exclusion is counted rather than silent", () => {
  const allPrs = [
    CURRENT,
    { number: 271, closed_at: "2026-07-27T12:00:00Z", title: "bump", user: { login: "dependabot[bot]" } },
  ];
  const { owed, skippedNonLoop } = owedRows({ allPrs, currentPr: CURRENT, ledger: emptyLedger });
  assert.deepEqual(owed, []);
  assert.equal(skippedNonLoop, 1);
});

// ── Post-merge debt audit ────────────────────────────────────────────────────

const closedLoop = (number, closed_at, title = "x") => ({
  number,
  created_at: "2026-07-01T00:00:00Z",
  closed_at,
  merged_at: closed_at,
  title,
  user: { login: "me" },
});

test("a loop with no PR opened since it closed is pending, not overdue", () => {
  // Nothing is wrong yet: the row's carrier does not exist. This is the state
  // the PR-context check can never see, and reporting it is the whole point —
  // the debt should be visible while it is still cheap to pay.
  const { overdue, pending } = auditLedgerDebt({
    allPrs: [closedLoop(290, "2026-07-30T21:09:48Z")],
    ledger: emptyLedger,
  });
  assert.deepEqual(overdue, []);
  assert.deepEqual(pending.map((p) => p.number), [290]);
});

test("a merged [LEDGER] PR that opened after a loop closed and skipped its row makes it overdue", () => {
  // The designated carrier under the 2026-08-02 rule is the next [LEDGER]
  // PR, not whatever PR happened to open next. One that opened after the
  // loop closed, merged to main, and did not carry the row missed the
  // obligation it exists for — and its own hard gate should have caught it,
  // so this firing also means a guard hole worth failing loudly on.
  const { overdue, pending } = auditLedgerDebt({
    allPrs: [
      closedLoop(290, "2026-07-30T21:09:48Z"),
      { number: 294, created_at: "2026-07-30T21:14:59Z", closed_at: "2026-07-31T00:00:00Z", merged_at: "2026-07-31T00:00:00Z", title: "[LEDGER] rows", user: { login: "me" } },
    ],
    ledger: emptyLedger,
    confirmedLedgerPrs: new Set([294]),
  });
  assert.deepEqual(pending, []);
  assert.deepEqual(overdue.map((o) => [o.pr.number, o.trigger, o.carrier.number]), [[290, "carrier", 294]]);
});

test("a [LEDGER]-titled PR not in confirmedLedgerPrs is NOT treated as a carrier", () => {
  // Fixed on PR #304 (Codex round 1, P1): a PR retitled to [LEDGER] after its
  // last push gets no new CI run (this repo's Build workflow doesn't trigger
  // on a title-only edit), so trusting a live title check for OTHER PRs would
  // let an unvalidated retitle borrow the carrier/exclusion status. Passing
  // an empty confirmedLedgerPrs — as if the file fetch found stray files, or
  // was never run — must leave the debt merely pending, not silently exempt
  // or falsely carried.
  const { overdue, pending } = auditLedgerDebt({
    allPrs: [
      closedLoop(290, "2026-07-30T21:09:48Z"),
      { number: 294, created_at: "2026-07-30T21:14:59Z", closed_at: "2026-07-31T00:00:00Z", merged_at: "2026-07-31T00:00:00Z", title: "[LEDGER] rows", user: { login: "me" } },
    ],
    ledger: emptyLedger,
    // confirmedLedgerPrs omitted — defaults to empty, i.e. nothing confirmed.
  });
  assert.deepEqual(overdue, []);
  assert.deepEqual(pending.map((p) => p.number).sort(), [290, 294]);
});

test("a regular merged PR is not a carrier — one merge since close leaves the row pending", () => {
  // The core of the rule change: under the old semantics this exact shape
  // (#294 merging after #290 closed, rowless) was overdue. A regular PR no
  // longer carries anyone's row, and one merge is under the backstop
  // threshold, so the debt stays pending — reported, not failed.
  const { overdue, pending } = auditLedgerDebt({
    allPrs: [
      closedLoop(290, "2026-07-30T21:09:48Z"),
      { number: 294, created_at: "2026-07-30T21:14:59Z", closed_at: "2026-07-31T00:00:00Z", merged_at: "2026-07-31T00:00:00Z", title: "next", user: { login: "me" } },
    ],
    ledger: { rows: [{ pr: 294 }], exempt: new Map() },
  });
  assert.deepEqual(overdue, []);
  assert.deepEqual(pending.map((p) => p.number), [290]);
});

test("the backstop trips after two merges since close with no [LEDGER] PR open", () => {
  // Without this, a debt whose carrier never shows up would stay politely
  // "pending" forever — the [LEDGER] rule would have no forcing function at
  // all once regular PRs stopped failing for it.
  const later = (n, at) => ({ number: n, created_at: at, closed_at: at, merged_at: at, title: "later", user: { login: "me" } });
  const { overdue, pending } = auditLedgerDebt({
    allPrs: [
      closedLoop(290, "2026-07-30T21:09:48Z"),
      later(294, "2026-07-31T00:00:00Z"),
      later(296, "2026-07-31T02:00:00Z"),
    ],
    ledger: { rows: [{ pr: 294 }, { pr: 296 }], exempt: new Map() },
  });
  assert.deepEqual(pending, []);
  assert.deepEqual(overdue.map((o) => [o.pr.number, o.trigger, o.mergedSince]), [[290, "backstop", 2]]);
});

test("an open [LEDGER] PR defers the backstop but not the carrier trigger", () => {
  // An open ledger PR means the debt is visibly being paid — failing main
  // then would be noise. But a carrier that already merged without the row
  // is a miss that already happened; an open successor doesn't unmiss it.
  const later = (n, at) => ({ number: n, created_at: at, closed_at: at, merged_at: at, title: "later", user: { login: "me" } });
  const openLedger = { number: 301, created_at: "2026-07-31T03:00:00Z", closed_at: null, merged_at: null, title: "[LEDGER] rows for #290", user: { login: "me" } };

  const deferred = auditLedgerDebt({
    allPrs: [closedLoop(290, "2026-07-30T21:09:48Z"), later(294, "2026-07-31T00:00:00Z"), later(296, "2026-07-31T02:00:00Z"), openLedger],
    ledger: { rows: [{ pr: 294 }, { pr: 296 }], exempt: new Map() },
    confirmedLedgerPrs: new Set([301]),
  });
  assert.deepEqual(deferred.overdue, []);
  assert.deepEqual(deferred.pending.map((p) => p.number), [290]);

  const missedCarrier = { number: 293, created_at: "2026-07-30T22:00:00Z", closed_at: "2026-07-30T23:00:00Z", merged_at: "2026-07-30T23:00:00Z", title: "[LEDGER] incomplete", user: { login: "me" } };
  const notDeferred = auditLedgerDebt({
    allPrs: [closedLoop(290, "2026-07-30T21:09:48Z"), missedCarrier, openLedger],
    ledger: emptyLedger,
    confirmedLedgerPrs: new Set([293, 301]),
  });
  assert.deepEqual(notDeferred.overdue.map((o) => [o.pr.number, o.trigger]), [[290, "carrier"]]);
});

test("an open [LEDGER] PR that opened BEFORE a loop closed does not defer that loop's backstop", () => {
  // Fixed on PR #304 (Codex round 1, P2): the deferral used to be one
  // repo-wide boolean ("is any [LEDGER] PR open"), so a stale ledger PR
  // opened before a newer loop closed could mask that newer loop's backstop
  // forever, even though it structurally cannot carry a row for a loop that
  // didn't exist yet when it opened. The fix evaluates deferral per loop,
  // using the same opened-after-closed cutoff as the carrier match.
  const later = (n, at) => ({ number: n, created_at: at, closed_at: at, merged_at: at, title: "later", user: { login: "me" } });
  const staleOpenLedger = { number: 280, created_at: "2026-07-20T00:00:00Z", closed_at: null, merged_at: null, title: "[LEDGER] old rows", user: { login: "me" } };
  const { overdue, pending } = auditLedgerDebt({
    allPrs: [closedLoop(290, "2026-07-30T21:09:48Z"), later(294, "2026-07-31T00:00:00Z"), later(296, "2026-07-31T02:00:00Z"), staleOpenLedger],
    ledger: { rows: [{ pr: 294 }, { pr: 296 }], exempt: new Map() },
    confirmedLedgerPrs: new Set([280]),
  });
  assert.deepEqual(pending, []);
  assert.deepEqual(overdue.map((o) => [o.pr.number, o.trigger]), [[290, "backstop"]]);
});

test("a closed [LEDGER] PR owes no row of its own, and the skip is counted", () => {
  // The policy exclusion that terminates the ledger's self-reference — same
  // shape as the Dependabot exclusion, and reported the same way so it is
  // never silent. Checked on both halves of the guard, which must agree on
  // what the ledger even owes.
  const ledgerPr = { number: 296, created_at: "2026-07-31T00:00:00Z", closed_at: "2026-07-31T01:00:00Z", merged_at: "2026-07-31T01:00:00Z", title: "[LEDGER] rows for #290", user: { login: "me" } };

  const confirmed = new Set([296]);
  const audit = auditLedgerDebt({ allPrs: [ledgerPr], ledger: emptyLedger, confirmedLedgerPrs: confirmed });
  assert.deepEqual(audit.overdue, []);
  assert.deepEqual(audit.pending, []);
  assert.equal(audit.skippedLedger, 1);

  const coverage = owedRows({
    allPrs: [CURRENT, ledgerPr],
    currentPr: { ...CURRENT, created_at: "2026-08-02T00:00:00Z" },
    ledger: emptyLedger,
    confirmedLedgerPrs: confirmed,
  });
  assert.deepEqual(coverage.owed, []);
  assert.equal(coverage.skippedLedger, 1);
});

test("a [LEDGER] PR opened BEFORE the loop closed is not its carrier", () => {
  // Sequencing mirrors owedRows: a ledger PR carries rows for loops closed
  // before it opened. One already in flight when the loop closed could not
  // have owed this row, so its merge is not a miss.
  const { overdue, pending } = auditLedgerDebt({
    allPrs: [
      closedLoop(290, "2026-07-30T21:09:48Z"),
      { number: 289, created_at: "2026-07-30T20:00:00Z", closed_at: "2026-07-30T22:00:00Z", merged_at: "2026-07-30T22:00:00Z", title: "[LEDGER] earlier rows", user: { login: "me" } },
    ],
    ledger: emptyLedger,
    confirmedLedgerPrs: new Set([289]),
  });
  assert.deepEqual(overdue, []);
  assert.deepEqual(pending.map((p) => p.number), [290]);
});

test("ledgerPrStrayFiles flags everything except the ledger file", () => {
  // The structural gate that makes the [LEDGER] title load-bearing: without
  // it, any work could ride in under the prefix and inherit the exclusion.
  assert.deepEqual(ledgerPrStrayFiles([{ filename: ".agents/metrics/loop-ledger.md" }]), []);
  assert.deepEqual(
    ledgerPrStrayFiles([{ filename: ".agents/metrics/loop-ledger.md" }, { filename: "src/index.ts" }]),
    ["src/index.ts"],
  );
});

test("isLedgerPr matches the title prefix exactly", () => {
  assert.equal(isLedgerPr({ title: "[LEDGER] rows for #290, #292" }), true);
  assert.equal(isLedgerPr({ title: "docs: mention [LEDGER] PRs" }), false);
  assert.equal(isLedgerPr({ title: "[PLAN REVIEW] x" }), false);
  assert.equal(isLedgerPr({}), false);
});

test("isConfirmedLedgerPr checks Set membership, not title", () => {
  const confirmed = new Set([294]);
  assert.equal(isConfirmedLedgerPr({ number: 294, title: "anything" }, confirmed), true);
  assert.equal(isConfirmedLedgerPr({ number: 295, title: "[LEDGER] x" }, confirmed), false);
});

test("confirmedLedgerPrNumbers only fetches files for [LEDGER]-titled candidates, and confirms only clean diffs", async () => {
  // The fetch is the actual defense against the title-retitle gap fixed on
  // PR #304: a candidate is confirmed only if its LIVE file list (fetched
  // fresh, not cached from whatever CI last saw) touches nothing but the
  // ledger file. A PR that never matched the title prefix is never fetched
  // at all — cost scales with [LEDGER] candidates, not total PR count.
  const requested = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    requested.push(url);
    const filesByPr = {
      294: [{ filename: ".agents/metrics/loop-ledger.md" }],
      295: [{ filename: ".agents/metrics/loop-ledger.md" }, { filename: "src/index.ts" }],
    };
    const match = /\/pulls\/(\d+)\/files/.exec(url);
    const files = match ? (filesByPr[match[1]] ?? []) : [];
    return { ok: true, json: async () => files, headers: { get: () => null } };
  };
  try {
    const allPrs = [
      { number: 294, title: "[LEDGER] rows" }, // clean diff — confirmed
      { number: 295, title: "[LEDGER] rows plus extra" }, // stray file — not confirmed
      { number: 296, title: "docs: unrelated" }, // not a candidate — never fetched
    ];
    const confirmed = await confirmedLedgerPrNumbers(allPrs, "fake-token");
    assert.deepEqual([...confirmed].sort(), [294]);
    assert.equal(requested.length, 2, "only the two [LEDGER]-titled candidates should be fetched");
    assert.ok(requested.every((u) => /\/pulls\/29[45]\/files/.test(u)));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a carrier that closed unmerged does not make a row overdue", () => {
  // A [PLAN REVIEW] PR is closed unmerged by contract, so a row folded into
  // one would never reach main. Treating it as a missed carrier would report
  // a debt nobody could ever have paid.
  const { overdue, pending } = auditLedgerDebt({
    allPrs: [
      closedLoop(290, "2026-07-30T21:09:48Z"),
      { number: 293, created_at: "2026-07-30T22:00:00Z", closed_at: "2026-07-31T00:00:00Z", merged_at: null, title: "[PLAN REVIEW] x", user: { login: "me" } },
    ],
    ledger: { rows: [{ pr: 293 }], exempt: new Map() },
  });
  assert.deepEqual(overdue, []);
  assert.deepEqual(pending.map((p) => p.number), [290]);
});

test("a PR that merged BEFORE the loop closed is not its carrier", () => {
  // Ordering is the whole test: a PR that had already landed could not have
  // carried a row for a loop that had not closed yet.
  const { overdue, pending } = auditLedgerDebt({
    allPrs: [
      closedLoop(290, "2026-07-30T21:09:48Z"),
      { number: 288, created_at: "2026-07-30T01:44:33Z", closed_at: "2026-07-30T20:36:03Z", merged_at: "2026-07-30T20:36:03Z", title: "earlier", user: { login: "me" } },
    ],
    ledger: { rows: [{ pr: 288 }], exempt: new Map() },
  });
  assert.deepEqual(overdue, []);
  assert.deepEqual(pending.map((p) => p.number), [290]);
});

test("the audit honours rows, exemptions, Dependabot, and the first-enforced boundary", () => {
  // Same exclusions as owedRows — a divergence between the two would make the
  // two halves of the guard disagree about what the ledger even owes.
  const carrier = { number: 299, created_at: "2026-07-31T00:00:00Z", closed_at: "2026-07-31T01:00:00Z", merged_at: "2026-07-31T01:00:00Z", title: "carrier", user: { login: "me" } };
  const { overdue, pending, skippedNonLoop } = auditLedgerDebt({
    allPrs: [
      carrier,
      closedLoop(283, "2026-07-29T00:00:00Z", "has a row"),
      closedLoop(277, "2026-07-28T00:00:00Z", "exempted"),
      closedLoop(269, "2026-07-27T00:00:00Z", "pre-enforcement"),
      { ...closedLoop(271, "2026-07-27T12:00:00Z", "bump"), user: { login: "dependabot[bot]" } },
    ],
    ledger: { rows: [{ pr: 283 }, { pr: 299 }], exempt: new Map([[277, "prose loop, deliberately not backfilled"]]) },
  });
  assert.deepEqual(overdue, []);
  assert.deepEqual(pending, []);
  assert.equal(skippedNonLoop, 1);
});

test("a PR merged into a stacked parent branch is not a landed carrier", () => {
  // working-modes.md's "Dependent bugs" note: a stacked bugfix PR bases
  // against another open bugfix PR's head, not main. GitHub stamps merged_at
  // on that stack merge exactly like a merge into main — nothing in the field
  // alone says which branch received it. Only base.ref === "main" actually
  // reached the branch this audit runs against.
  const { overdue, pending } = auditLedgerDebt({
    allPrs: [
      closedLoop(290, "2026-07-30T21:09:48Z"),
      {
        number: 295,
        created_at: "2026-07-31T00:00:00Z",
        closed_at: "2026-07-31T01:00:00Z",
        merged_at: "2026-07-31T01:00:00Z",
        base: { ref: "claude/bug-parent-abc123" },
        title: "stacked dependent bugfix",
        user: { login: "me" },
      },
    ],
    ledger: emptyLedger,
  });
  // #295 itself is a second closed loop owing a row — pending too, not
  // overdue, since nothing has landed on main since it closed either. The
  // assertion under test is that it does NOT make #290 overdue.
  assert.deepEqual(overdue, []);
  assert.deepEqual(pending.map((p) => p.number).sort(), [290, 295]);
});

test("a merged PR does not count itself toward its own backstop", () => {
  // A merged PR is both a closed loop owing a row AND a landed merge. Without
  // the self-exclusion, every merged loop would inch its own debt toward the
  // backstop just by existing.
  const { overdue, pending } = auditLedgerDebt({
    allPrs: [closedLoop(290, "2026-07-30T21:09:48Z")],
    ledger: emptyLedger,
  });
  assert.deepEqual(overdue, []);
  assert.deepEqual(pending.map((p) => p.number), [290]);
});

test("in CI on a pull_request, missing inputs fail loudly instead of skipping", async () => {
  // A coverage guard that quietly no-ops produces a green check that verified
  // nothing — indistinguishable from one that verified everything, which is
  // the exact failure class this script exists to close. Locally, skipping is
  // correct; in CI it means broken wiring and must be red.
  const { execFileSync } = await import("node:child_process");
  const script = new URL("../check-ledger-coverage.mjs", import.meta.url).pathname;

  assert.throws(
    () =>
      execFileSync(process.execPath, [script], {
        env: { ...process.env, GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "pull_request", GITHUB_TOKEN: "", GH_TOKEN: "", PR_NUMBER: "" },
        stdio: "pipe",
      }),
    /Coverage check cannot run/,
  );

  // Same missing inputs, but not in CI: skipping is the correct behavior.
  const out = execFileSync(process.execPath, [script], {
    env: { ...process.env, GITHUB_ACTIONS: "", GITHUB_EVENT_NAME: "", GITHUB_TOKEN: "", GH_TOKEN: "", PR_NUMBER: "" },
    stdio: "pipe",
  }).toString();
  assert.match(out, /Coverage check skipped/);
});

test("the exemption table is parsed with its reason text", () => {
  const doc = ledgerDoc(
    [row(283, { findings: 1, causes: [1, 0, 0, 0, 0] })],
    [`| ${PULL(277)} | prose/contract | Not backfilled — scoped out of the 2026-07-29 pass. |`],
  );
  const { exempt } = parseLedger(doc);
  assert.equal(exempt.get(277), "Not backfilled — scoped out of the 2026-07-29 pass.");
});

test("the reason is resolved by its header, not by 'last cell' guesswork", () => {
  // A misaligned or short row could otherwise have its cohort column read as
  // the reason. Column order in the fixture below is fine, but this pins the
  // resolution mechanism itself: swapping cohort and reason positions would
  // fail this test if the lookup ever regressed to a positional guess.
  const doc = ledgerDoc(
    [row(283, { findings: 1, causes: [1, 0, 0, 0, 0] })],
    [`| ${PULL(277)} | prose/contract | Deliberately not backfilled. |`],
  );
  const { exempt } = parseLedger(doc);
  assert.equal(exempt.get(277), "Deliberately not backfilled.");
});

test("an exemption with an empty reason is rejected, not accepted as a silent pass", () => {
  const doc = ledgerDoc(
    [row(283, { findings: 1, causes: [1, 0, 0, 0, 0] })],
    [`| ${PULL(277)} | prose/contract |  |`],
  );
  // An exemption with no stated reason is indistinguishable from a row
  // someone forgot to write — the whole point of the table is the reason.
  assert.throws(() => parseLedger(doc), /empty reason/);
});

test("two exemption entries for the same PR are rejected", () => {
  const doc = ledgerDoc(
    [row(283, { findings: 1, causes: [1, 0, 0, 0, 0] })],
    [
      `| ${PULL(277)} | prose/contract | First reason. |`,
      `| ${PULL(277)} | prose/contract | Second, conflicting reason. |`,
    ],
  );
  assert.throws(() => parseLedger(doc), /appears more than once in "Deliberately not measured"/);
});

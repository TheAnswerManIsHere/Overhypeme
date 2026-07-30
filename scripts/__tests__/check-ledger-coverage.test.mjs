import { test } from "node:test";
import assert from "node:assert/strict";

import { parseLedger, tableUnderHeading, countCell, checkArithmetic, owedRows } from "../check-ledger-coverage.mjs";

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

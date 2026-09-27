// SYNCED FROM AI-Handbook — do not edit in a consumer repo. Local edits are overwritten by the next sync and their reasoning is lost; change the handbook instead.
/**
 * The planning loop's suite.
 *
 * WHAT IT NO LONGER COVERS, AND WHY. The old suite spent a third of itself on a
 * JSON schema, a reconciliation check, a convergence computation and a
 * priors-cover-last-round guard. All four are gone with the verdict-driven
 * design they served (David, 2026-09-18). What survives is every test of the
 * machinery that protects something other than a verdict, and those are the
 * majority.
 *
 * WHAT IT ADDS. Sequence-level checks over the workflow claims, because the
 * first draft of this change proposed tests that asserted a vocabulary
 * contained a word and called that proof of a behaviour -- which is this
 * repository's own recorded failure shape, "a check satisfiable without the
 * thing it exists to check", written into the verification plan for the change
 * that removes it (Astra, on the redesign plan). Where a claim is genuinely
 * judgement-dependent, it is named as the live exercise's job here rather than
 * dressed up as an assertion.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ACTIONS,
  CONCERN_STATES,
  CONTRACT_PATH,
  JUDGMENT_PATH,
  KINDS,
  MAX_FIELD_CHARS,
  ROLES,
  TIERS,
  TIER_LENSES,
  USAGE,
  actionBlock,
  assemblePackage,
  assertIgnored,
  assertSlug,
  assertTierPinned,
  defaultReviewer,
  ensurePlansIgnored,
  ensureRoundDir,
  exchangeContext,
  extractFenced,
  fenced,
  findRepoRoot,
  main,
  normalizeLedger,
  oracleFrom,
  pinOracle,
  readAssessment,
  readVerbatim,
  renderLedger,
  roleBlock,
  roundsRun,
  signInStatus,
  slugFromPlanPath,
  stablePrefix,
} from "../plan-review.mjs";

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "plan-review.mjs");

// ── fixtures ───────────────────────────────────────────────────────────────

const ORACLE = "**Direction.** #123.\n**Product intent.** Rebuild the planning loop.\n**Must not change.** The code loop.";

const PLAN = [
  "# Plan: a thing",
  "```plan-oracle",
  ORACLE,
  "```",
  "## Proposed design",
  "Do the thing.",
  "```affected-files",
  "- src/thing.ts",
  "```",
  "",
].join("\n");

const concern = (over = {}) => ({
  id: "C1",
  title: "Cache invalidation is unspecified",
  state: "open",
  source: "round-1.md",
  raised: "assess-1",
  concern: "The plan says cache the thing but never says when the cache is invalidated.",
  proposed: "State the invalidation trigger.",
  evidence: ["src/thing.ts:12"],
  response: "",
  ...over,
});

/** A throwaway repo root carrying only what the script reads. */
function fixtureRoot({ layout = "core", plan = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), "planning-test-"));
  const at = (rel) => join(root, layout === "core" ? `core/${rel}` : rel);
  for (const [rel, text] of [
    [CONTRACT_PATH, "# The planning contract\n\nRole-neutral body.\n"],
    [JUDGMENT_PATH, "# The Worth rule\n\nIs this intervention worthwhile?\n"],
  ]) {
    const abs = at(rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text);
  }
  if (plan) {
    const abs = join(root, plan.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, plan.text);
  }
  return root;
}

const drop = (root) => rmSync(root, { recursive: true, force: true });

/** A `spawnSync` stand-in: records calls, returns whatever the test scripted. */
function fakeRun(script) {
  const calls = [];
  const run = (bin, args, opts) => {
    calls.push({ bin, args, opts });
    const next = script.shift();
    if (typeof next === "function") return next({ bin, args, opts });
    return next ?? { status: 0, stdout: "", stderr: "" };
  };
  run.calls = calls;
  return run;
}

const SIGNED_IN = { status: 0, stdout: "Logged in", stderr: "" };

/** A codex-exec stand-in that writes `text` to wherever the flags say. */
const writesAssessment = (text) => ({ args }) => {
  const out = args[args.indexOf("--output-last-message") + 1];
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, text);
  return { status: 0, stdout: "", stderr: "" };
};

/** Run one exchange through main() with a scripted reviewer. */
function runMain(root, argv, { script = [SIGNED_IN, writesAssessment("# Assessment\n\nSomething substantive.\n")] } = {}) {
  const logs = [];
  const code = main(argv, { root, run: fakeRun(script), log: (m) => logs.push(m), git: () => ({ status: 128 }) });
  return { code, log: logs.join("\n") };
}

const seed = (root, slug, files) => {
  const dir = join(root, ".agents/reviews", slug);
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), typeof body === "string" ? body : JSON.stringify(body, null, 2));
  }
  return dir;
};

// ── the contract and the Worth rule reach both parties, verbatim ───────────

test("the contract and the Worth rule are inlined, not handed over as paths", () => {
  const root = fixtureRoot();
  const contract = readVerbatim(CONTRACT_PATH, root);
  const judgment = readVerbatim(JUDGMENT_PATH, root);
  const text = stablePrefix({
    role: "astra", kind: "assess", contract: contract.text, judgment: judgment.text,
    oracle: ORACLE, planPath: "docs/plans/PLAN_X.md", tier: "internal", assessmentFile: "out.md",
  });
  assert.match(text, /Role-neutral body\./, "the contract's body must be present, not just its path");
  assert.match(text, /Is this intervention worthwhile\?/, "the Worth rule must be present");
  drop(root);
});

test("both files resolve in either payload layout", () => {
  for (const layout of ["core", "consumer"]) {
    const root = fixtureRoot({ layout });
    const found = readVerbatim(CONTRACT_PATH, root);
    assert.equal(found.path, layout === "core" ? `core/${CONTRACT_PATH}` : CONTRACT_PATH);
    drop(root);
  }
});

test("a missing contract refuses and names both attempts", () => {
  const root = mkdtempSync(join(tmpdir(), "planning-test-"));
  assert.throws(() => readVerbatim(CONTRACT_PATH, root), (e) => {
    assert.match(e.message, new RegExp(CONTRACT_PATH));
    assert.match(e.message, new RegExp(`core/${CONTRACT_PATH}`));
    return true;
  });
  drop(root);
});

test("the sync banner is stripped, so the package does not open with a do-not-edit notice", () => {
  const root = fixtureRoot();
  const abs = join(root, `core/${CONTRACT_PATH}`);
  writeFileSync(abs, "<!-- SYNCED FROM AI-Handbook — do not edit -->\n\n# The planning contract\n");
  assert.equal(readVerbatim(CONTRACT_PATH, root).text.startsWith("# The planning contract"), true);
  drop(root);
});

// ── one contract, two roles ────────────────────────────────────────────────

test("both roles receive byte-identical packages outside the role block", () => {
  const root = fixtureRoot();
  const contract = readVerbatim(CONTRACT_PATH, root).text;
  const judgment = readVerbatim(JUDGMENT_PATH, root).text;
  const parts = {
    kind: "assess", round: 1, contract, judgment, oracle: ORACLE,
    planPath: "docs/plans/PLAN_X.md", tier: "internal", assessmentFile: "out.md",
    lens: null, concerns: [concern()],
  };
  const astra = assemblePackage({ ...parts, role: "astra" });
  const claude = assemblePackage({ ...parts, role: "claude" });

  // The role block is everything up to the first `---`. Past it, the two
  // packages must not differ by one character: that is what makes a difference
  // between two readings a difference of judgement rather than of briefing.
  const past = (t) => t.slice(t.indexOf("\n---\n"));
  assert.equal(past(astra), past(claude));
  assert.notEqual(astra.slice(0, astra.indexOf("\n---\n")), claude.slice(0, claude.indexOf("\n---\n")));
  drop(root);
});

test("the role block states who holds the plan and who settles a tie, per role", () => {
  const astra = roleBlock("astra");
  const claude = roleBlock("claude");
  // PROSPECTIVE since round 11: the block is emitted at the scope exchange too,
  // where the same package says there is no plan yet (`4050124296`).
  assert.match(astra, /The authoritative plan is your counterpart's to write and hold/);
  assert.doesNotMatch(astra, /holds the authoritative plan/, "no sentence asserts a plan already exists");
  assert.match(astra, /is your counterpart's to settle/);
  // KIND-NEUTRAL. It said "the complete assessment", which contradicted
  // `exchangeContext`'s "It is not a new assessment" in every discuss package
  // (#124 round 10 `4049965635`).
  assert.match(astra, /Return your complete reply as your final message/);
  assert.doesNotMatch(astra, /complete assessment/, "the standing block never names one kind of exchange");
  // THE CLI OWNS THE FILE -- which is true whatever the sandbox, and is why
  // this replaced an assertion pinning "read-only sandbox and cannot write
  // that file yourself". That sentence was false under the supported
  // `--sandbox workspace-write --unpinned` override, and this test was
  // holding it in place (#124 round 14 `4051418744`).
  assert.match(astra, /The CLI saves that message to this exchange.s file/);
  // NO CONCRETE PATH. It made the "stable" prefix change every exchange, and
  // the CLI writes the file from the final message anyway (#124 round 5; the
  // "Astra cannot write it" half retired at round 14).
  assert.doesNotMatch(astra, /round-\d+\.md/);
  assert.match(claude, /The authoritative plan is yours to write and hold/);
  assert.doesNotMatch(claude, /You hold the authoritative plan/, "prospective for the scope exchange too");
  assert.match(claude, /is yours to settle/);
  assert.match(claude, /no assessment file is written by you/);
});

test("neither role may settle what is David's, and both are told so in the same words", () => {
  const reserved = /Neither of you can settle what is reserved for David.*intended behaviour, scope/s;
  for (const role of ROLES) assert.match(roleBlock(role), reserved);
});

test("an unknown role is refused rather than defaulted", () => {
  assert.throws(() => roleBlock("reviewer"), /role must be one of astra, claude/);
});

test("the role block states no capability the supported sandbox override would falsify", () => {
  // The class: a standing instruction asserting an environmental restriction
  // that supported execution can change. `--sandbox workspace-write
  // --unpinned "<why>"` is accepted, and the danger-full-access refusal
  // RECOMMENDS it for running the suite -- so two categorical "read-only"
  // claims were false on a path the script itself proposes. The reviewer
  // reported one site; the Fable assessment found the second.
  // (Codex, #124 round 14 `4051418744`; Astra bounded the class and
  // recommended the write, the Fable assessor would have left it, and the
  // builder held himself to the flip condition he registered before the
  // round ran.)
  //
  // ASSERTED AS AN ABSENCE, deliberately: rendering the selected sandbox into
  // the block would make it configuration-dependent, which is the shape both
  // assessors declined.
  for (const role of ROLES) {
    assert.doesNotMatch(roleBlock(role), /read-only/i, role + ": the role block must not pin the sandbox");
    assert.doesNotMatch(roleBlock(role), /cannot write/i, role + ": the role block must not assert what it cannot do");
  }
  // The useful half survives: the CLI still owns the file, so nothing here
  // asks the reviewer to write one whatever the sandbox.
  assert.match(roleBlock("astra"), /The CLI saves that message to this exchange.s file/);
});

// ── Markdown out: no schema anywhere ───────────────────────────────────────

test("the reviewer is never given an output schema", () => {
  const root = fixtureRoot({ plan: { path: "docs/plans/PLAN_X.md", text: PLAN } });
  const run = fakeRun([SIGNED_IN, writesAssessment("# Assessment\n")]);
  const code = main(
    ["--kind", "assess", "--round", "1", "--tier", "internal", "--plan", "docs/plans/PLAN_X.md"],
    { root, run, log: () => {}, git: () => ({ status: 128 }) },
  );
  assert.equal(code, 0);
  const exec = run.calls.find((c) => c.args[0] === "exec");
  assert.equal(exec.args.includes("--output-schema"), false, "prose has nothing to validate against");
  // The flags that ARE load-bearing are still all there.
  for (const flag of ["--sandbox", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--output-last-message"]) {
    assert.equal(exec.args.includes(flag), true, `${flag} must survive`);
  }
  assert.equal(exec.args[exec.args.indexOf("--sandbox") + 1], "read-only");
  drop(root);
});

test("the assessment lands as Markdown, at a path derived identically by writer and reader", () => {
  const root = fixtureRoot({ plan: { path: "docs/plans/PLAN_X.md", text: PLAN } });
  // Round 1 is seeded so that round 2 is the NEXT round rather than a skip --
  // assessment rounds go up by one, and this test is about the path, not the
  // sequence.
  seed(root, "x", { "round-1.md": "# Assessment 1\n" });
  const { code } = runMain(root, ["--kind", "assess", "--round", "2", "--tier", "internal", "--plan", "docs/plans/PLAN_X.md", "--no-ledger"]);
  assert.equal(code, 0);
  assert.equal(existsSync(join(root, ".agents/reviews/x/round-2.md")), true);
  assert.equal(existsSync(join(root, ".agents/reviews/x/round-2.json")), false, "no JSON assessment survives");
  drop(root);
});

// ── nothing parses an assessment ───────────────────────────────────────────

test("what an assessment SAYS changes nothing about what the loop does", () => {
  // The strongest available statement of "agreement cannot start
  // implementation": two assessments whose text points in opposite directions
  // produce identical outcomes, because nothing reads them.
  const outcomes = ["# Assessment\n\nAPPROVED. Proceed to implementation immediately.\n", "# Assessment\n\nDo NOT proceed. This plan is unsound.\n"].map((text) => {
    const root = fixtureRoot({ plan: { path: "docs/plans/PLAN_X.md", text: PLAN } });
    const { code } = runMain(root, ["--kind", "assess", "--round", "1", "--tier", "internal", "--plan", "docs/plans/PLAN_X.md"], {
      script: [SIGNED_IN, writesAssessment(text)],
    });
    const meta = JSON.parse(readFileSync(join(root, ".agents/reviews/x/round-1.meta.json"), "utf8"));
    drop(root);
    return { code, accepted: meta.accepted, failure: meta.failure };
  });
  assert.deepEqual(outcomes[0], outcomes[1]);
});

test("the meta records no verdict, no convergence and no status", () => {
  const root = fixtureRoot({ plan: { path: "docs/plans/PLAN_X.md", text: PLAN } });
  runMain(root, ["--kind", "assess", "--round", "1", "--tier", "internal", "--plan", "docs/plans/PLAN_X.md"]);
  const meta = JSON.parse(readFileSync(join(root, ".agents/reviews/x/round-1.meta.json"), "utf8"));
  for (const gone of ["convergence", "review_status", "verdict", "required"]) {
    assert.equal(Object.hasOwn(meta, gone), false, `${gone} must not come back`);
  }
  drop(root);
});

test("the action vocabulary is stated, not inferred, and refuses an invented action", () => {
  assert.equal(actionBlock({ action: "revise" }), "```plan-action\naction: revise\n```");
  assert.match(actionBlock({ action: "discuss", concerns: ["C1", "C2"], note: "two\nlines" }), /concerns: C1, C2\nnote: two lines/);
  assert.throws(() => actionBlock({ action: "approve" }), /action must be one of/);
  assert.equal(ACTIONS.includes("approve"), false, "nothing in this loop approves");
});

// ── the concern ledger ─────────────────────────────────────────────────────

test("a well-formed ledger normalizes, and the documented states are all accepted", () => {
  const rows = CONCERN_STATES.map((state, i) => concern({ id: `C${i}`, state, concern: "reasoning" }));
  assert.equal(normalizeLedger(rows).length, CONCERN_STATES.length);
});

test("a duplicate id is refused, because every later reference is keyed by it", () => {
  assert.throws(() => normalizeLedger([concern(), concern({ title: "other" })]), /repeats id "C1"/);
});

test("an unrecognised state is refused, because it would render as nothing", () => {
  assert.throws(() => normalizeLedger([concern({ state: "pending" })]), /must be one of open, addressed/);
});

test("a concern with no source is refused — the point is that the original can be read", () => {
  assert.throws(() => normalizeLedger([concern({ source: "" })]), /has no "source"/);
});

test("an unresolved concern with no reasoning is a title pretending to be a concern", () => {
  for (const state of ["open", "for-david"]) {
    assert.throws(() => normalizeLedger([concern({ state, concern: "" })]), /carries no "concern" text/);
  }
});

test("a concern keeps its reasoning in EVERY state -- source is not a substitute", () => {
  // THIS TEST USED TO ASSERT THE OPPOSITE, under the name "a settled concern may
  // carry no reasoning, because its source holds it". That name was the premise
  // and the premise was false: `source` is validated as any non-empty string and
  // the validator's own error documents a person's name as valid, so a settled
  // concern sourced to "Astra" rendered an empty block under "The concern, as
  // written" (#124 round 7). A test whose name states an assumption is the place
  // that assumption goes unexamined.
  for (const state of CONCERN_STATES) {
    assert.throws(
      () => normalizeLedger([concern({ state, concern: "" })]),
      /carries no "concern" text/,
      `state ${state}`,
    );
  }
  // A person as the source is still valid -- it is the reasoning that must be
  // present, not a resolvable path.
  const kept = normalizeLedger([concern({ state: "addressed", source: "Astra", concern: "The transport should be chat." })]);
  assert.equal(kept[0].concern, "The transport should be chat.");
});

test("a ledger that is not an array is refused", () => {
  assert.throws(() => normalizeLedger({ C1: "open" }), /must contain a JSON array/);
});

// ── rendering the ledger ───────────────────────────────────────────────────

test("open concerns and David's questions render in full; settled ones render by reference", () => {
  const rows = normalizeLedger([
    concern({ id: "C1", state: "open", concern: "OPEN REASONING" }),
    concern({ id: "C2", state: "for-david", concern: "DAVID REASONING" }),
    concern({ id: "C3", state: "superseded", concern: "SETTLED REASONING" }),
  ]);
  const text = renderLedger(rows).join("\n");
  assert.match(text, /OPEN REASONING/);
  assert.match(text, /DAVID REASONING/);
  assert.equal(text.includes("SETTLED REASONING"), false, "a settled concern's body is not reproduced every exchange");
  assert.match(text, /- \*\*C3\*\* — .* — \*superseded\*/, "but it is still listed, with its source");
});

test("a concern SELECTED for a discussion renders in full whatever state it is in", () => {
  // The correction that matters most: a focused question is often about
  // something already settled, and giving full text only to open concerns would
  // strip exactly the reasoning the discussion is about.
  const rows = normalizeLedger([concern({ id: "C3", state: "withdrawn", concern: "WITHDRAWN REASONING" })]);
  assert.equal(renderLedger(rows).join("\n").includes("WITHDRAWN REASONING"), false);
  assert.match(renderLedger(rows, { selected: ["C3"] }).join("\n"), /WITHDRAWN REASONING/);
});

test("a settled concern is listed as reopenable, not as closed", () => {
  const rows = normalizeLedger([concern({ id: "C3", state: "addressed" })]);
  assert.match(renderLedger(rows).join("\n"), /settled is not closed/);
});

test("the ledger's every field reaches the reader when a concern is rendered in full", () => {
  const rows = normalizeLedger([
    concern({ concern: "THE CONCERN", proposed: "THE PROPOSAL", response: "THE RESPONSE", david: "THE DECISION", evidence: ["a.ts:1"] }),
  ]);
  const text = renderLedger(rows).join("\n");
  for (const part of ["THE CONCERN", "THE PROPOSAL", "THE RESPONSE", "THE DECISION", "a.ts:1", "round-1.md"]) {
    assert.match(text, new RegExp(part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("an empty ledger says so rather than rendering nothing", () => {
  assert.match(renderLedger([]).join("\n"), /No concerns are on the ledger yet/);
});

// ── free text cannot restructure the package, and is never silently cut ────

test("a heading inside a concern body cannot open a section of the package", () => {
  const rows = normalizeLedger([concern({ concern: "before\n## Not a real heading\nafter" })]);
  const text = renderLedger(rows).join("\n");
  const body = text.slice(text.indexOf("The concern, as written"));
  const opener = body.indexOf("~~~");
  const closer = body.indexOf("~~~", opener + 3);
  assert.equal(body.indexOf("## Not a real heading") > opener && body.indexOf("## Not a real heading") < closer, true);
});

test("text containing a tilde fence does not close its own wrapper", () => {
  const wrapped = fenced("a\n~~~\nb\n~~~~\nc");
  const fence = wrapped.split("\n")[0];
  assert.equal(fence.length >= 5, true, `fence ${fence.length} must outrun the longest run inside`);
  assert.equal(wrapped.endsWith(`\n${fence}`), true);
});

test("ordinary text gets an ordinary fence", () => {
  assert.equal(fenced("plain").split("\n")[0], "~~~");
});

test("a field that is cut says so and names where the full text is", () => {
  // THE LEDGER, NOT THE SOURCE. This assertion used to read `round-7.md` and
  // passed for the wrong reason: it only ever seeded a filename as the source.
  const long = "x".repeat(MAX_FIELD_CHARS + 500);
  const rows = normalizeLedger([concern({ concern: long, source: "round-7.md" })]);
  const text = renderLedger(rows, { ledgerPath: ".agents/reviews/x/concerns.json" }).join("\n");
  assert.match(text, /truncated at \d+ characters — the full text is in \.agents\/reviews\/x\/concerns\.json \(entry C1\)/);
  assert.equal(text.includes("x".repeat(MAX_FIELD_CHARS + 1)), false, "it is actually cut, not merely annotated");
});

test("a person-name source is never handed to the reader as a place to look", () => {
  // The class: a retrieval reference that supplies ATTRIBUTION where a STORAGE
  // LOCATION is needed. `source` is validated as any non-empty string and the
  // validator's own refusal says it may be a person, so every sentence that
  // told the reader to read "the source file" was false for a documented
  // input. Three sites had it; the truncation one fires on an OPEN concern,
  // which is the case the design renders in full.
  // (Codex, #124 round 13 `4050405448`.)
  const ledgerPath = ".agents/reviews/x/concerns.json";
  const long = "y".repeat(MAX_FIELD_CHARS + 500);

  const open = renderLedger(normalizeLedger([concern({ concern: long, source: "Astra" })]), { ledgerPath }).join("\n");
  assert.doesNotMatch(open, /full text is in Astra/, "a truncated open concern must not point at a person");
  assert.match(open, /full text is in \.agents\/reviews\/x\/concerns\.json \(entry C1\)/);

  const settled = renderLedger(
    normalizeLedger([concern({ id: "C2", state: "addressed", source: "Astra" })]),
    { ledgerPath },
  ).join("\n");
  assert.doesNotMatch(settled, /the source file named on each/, "the retired sentence named no real file");
  assert.match(settled, /The full reasoning of each is in `\.agents\/reviews\/x\/concerns\.json`/);
});

test("a custom ledger location reaches the package in both exchange kinds", () => {
  // The default ledger sits in the review directory the package already names,
  // so a reader could list it. A custom --ledger does not, and its path was
  // computed at the call site and never passed -- the same defect round 12
  // fixed one field over for `reviewDir`.
  const ledgerPath = "somewhere/else/carried-over.json";
  const rows = normalizeLedger([concern({ id: "C3", state: "addressed", source: "Astra" })]);
  for (const kind of ["assess", "discuss"]) {
    const text = exchangeContext({
      kind, round: 2, discussion: kind === "discuss" ? 1 : 0, lens: null,
      concerns: rows, selected: [], question: kind === "discuss" ? "q" : null,
      reviewDir: ".agents/reviews/x", ledgerPath,
    });
    assert.match(text, /somewhere\/else\/carried-over\.json/, `the ${kind} package must locate the ledger`);
  }
});

// ── the exchange kinds ─────────────────────────────────────────────────────

test("every kind and role in the documented sets is accepted by the CLI", () => {
  assert.deepEqual(KINDS, ["scope", "assess", "discuss"]);
  assert.deepEqual(ROLES, ["astra", "claude"]);
});

test("the scope exchange composes from the oracle alone and names no plan", () => {
  const root = fixtureRoot();
  mkdirSync(join(root, ".agents/reviews/s"), { recursive: true });
  writeFileSync(join(root, ".agents/reviews/s/oracle-s.md"), ORACLE);
  const { code } = runMain(root, ["--kind", "scope", "--slug", "s", "--oracle", ".agents/reviews/s/oracle-s.md", "--dry-run"]);
  assert.equal(code, 0);
  const pkg = readFileSync(join(root, ".agents/reviews/s/round-0.prompt.md"), "utf8");
  assert.match(pkg, /There is no plan yet/);
  assert.match(pkg, /should this exist at all/);
  assert.equal(pkg.includes("docs/plans/"), false, "nothing points at a plan that does not exist");
  drop(root);
});

test("the scope exchange refuses a plan, and a later exchange refuses to run without one", () => {
  const root = fixtureRoot({ plan: { path: "docs/plans/PLAN_X.md", text: PLAN } });
  assert.match(runMain(root, ["--kind", "scope", "--slug", "s", "--plan", "docs/plans/PLAN_X.md"]).log, /runs BEFORE a plan exists/);
  assert.match(runMain(root, ["--kind", "assess", "--round", "1", "--tier", "internal"]).log, /needs --plan/);
  drop(root);
});

test("a tier is required except at the scope gate, and is validated", () => {
  const root = fixtureRoot({ plan: { path: "docs/plans/PLAN_X.md", text: PLAN } });
  assert.match(runMain(root, ["--kind", "assess", "--round", "1", "--plan", "docs/plans/PLAN_X.md"]).log, /--tier is required except for the scope exchange/);
  assert.match(runMain(root, ["--kind", "assess", "--round", "1", "--tier", "critical", "--plan", "docs/plans/PLAN_X.md"]).log, /--tier must be one of/);
  drop(root);
});

test("the tier names what is downstream and reaches the reader — it sets no threshold", () => {
  for (const tier of TIERS) {
    const text = TIER_LENSES[tier].join(" ");
    assert.match(text, /What is downstream/);
    assert.equal(/critical flaw|reserved for|most of your findings/i.test(text), false, `${tier} must not carry a threshold`);
  }
  const root = fixtureRoot();
  const pkg = stablePrefix({
    role: "astra", kind: "assess", contract: "c", judgment: "j", oracle: ORACLE,
    planPath: "p.md", tier: "internal", assessmentFile: "o.md",
  });
  assert.match(pkg, /software factory/);
  assert.match(pkg, /It names who bears the consequence\. It sets no threshold\./);
  drop(root);
});

// ── the focused discussion ─────────────────────────────────────────────────

test("a discussion needs a question and named concerns, or it is a re-assessment", () => {
  const root = fixtureRoot({ plan: { path: "docs/plans/PLAN_X.md", text: PLAN } });
  const base = ["--kind", "discuss", "--round", "1", "--discussion", "1", "--tier", "internal", "--plan", "docs/plans/PLAN_X.md"];
  assert.match(runMain(root, base).log, /needs --question/);
  assert.match(runMain(root, [...base, "--question", "q"]).log, /needs --concerns/);
  drop(root);
});

test("a discussion refuses a concern id the ledger does not carry", () => {
  const root = fixtureRoot({ plan: { path: "docs/plans/PLAN_X.md", text: PLAN } });
  seed(root, "x", { "concerns.json": [concern()], "round-1.md": "# Assessment\n", "plan-round-1.md": PLAN });
  const { log } = runMain(root, ["--kind", "discuss", "--round", "1", "--discussion", "1", "--tier", "internal",
    "--plan", "docs/plans/PLAN_X.md", "--concerns", "C9", "--question", "q", "--dry-run"]);
  assert.match(log, /--concerns names C9, which the ledger does not carry/);
  drop(root);
});

test("a discussion quotes back the assessment it revisits, and refuses without it", () => {
  const root = fixtureRoot({ plan: { path: "docs/plans/PLAN_X.md", text: PLAN } });
  seed(root, "x", { "concerns.json": [concern()], "plan-round-1.md": PLAN });
  const args = ["--kind", "discuss", "--round", "1", "--discussion", "1", "--tier", "internal",
    "--plan", "docs/plans/PLAN_X.md", "--concerns", "C1", "--question", "Does it still hold?", "--dry-run"];
  assert.match(runMain(root, args).log, /a discussion quotes back the assessment it revisits/);

  seed(root, "x", { "round-1.md": "# Assessment\n\nTHE EARLIER POSITION.\n" });
  assert.equal(runMain(root, args).code, 0);
  const pkg = readFileSync(join(root, ".agents/reviews/x/round-1.discussion-1.prompt.md"), "utf8");
  assert.match(pkg, /THE EARLIER POSITION/);
  assert.match(pkg, /Does it still hold\?/);
  assert.match(pkg, /Rebuild the planning loop/, "the oracle travels too — the process answering starts cold");
  drop(root);
});

test("a discussion is not a new assessment, and says so", () => {
  const text = exchangeContext({ kind: "discuss", round: 2, discussion: 1, lens: null, concerns: [], question: "q", priorAssessment: "earlier" });
  assert.match(text, /It is not a new assessment/);
  assert.match(text, /No new plan revision has been written/);
  assert.match(text, /Everything you are not asked about keeps the state it already has/);
});

test("a chained discussion quotes the previous reply, and says that is what it is", () => {
  // `4049773985`'s sibling (`4049773970`): from discussion 2 onward the quoted
  // file is `round-N.discussion-(M-1).md`, a narrow focused answer -- and the
  // heading called it the round's assessment, in the same package that tells
  // the reader a discussion "is not a new assessment". A cold reader handed a
  // narrow reply under that heading can conclude everything absent from it was
  // dropped, which contradicts the line three paragraphs up.
  const first = exchangeContext({ kind: "discuss", round: 2, discussion: 1, lens: null, concerns: [], question: "q", priorAssessment: "the full assessment" });
  assert.match(first, /### The assessment of this round, quoted/);

  const chained = exchangeContext({ kind: "discuss", round: 2, discussion: 3, lens: null, concerns: [], question: "q", priorAssessment: "a narrow reply" });
  assert.match(chained, /### The previous focused reply of this round \(discussion 2\), quoted/);
  assert.doesNotMatch(chained, /assessment of this round, quoted/, "a focused reply is never labelled the assessment");
});

test("a discussion advances no round and rewrites no plan", () => {
  const root = fixtureRoot({ plan: { path: "docs/plans/PLAN_X.md", text: PLAN } });
  seed(root, "x", { "concerns.json": [concern()], "round-1.md": "# Assessment\n", "plan-round-1.md": PLAN });
  const before = readFileSync(join(root, "docs/plans/PLAN_X.md"), "utf8");
  const { code } = runMain(root, ["--kind", "discuss", "--round", "1", "--discussion", "1", "--tier", "internal",
    "--plan", "docs/plans/PLAN_X.md", "--concerns", "C1", "--question", "q"]);
  assert.equal(code, 0);
  assert.equal(readFileSync(join(root, "docs/plans/PLAN_X.md"), "utf8"), before, "the plan is untouched");
  assert.deepEqual(roundsRun(join(root, ".agents/reviews/x")), [1], "no new round exists");
  assert.equal(existsSync(join(root, ".agents/reviews/x/round-1.discussion-1.md")), true);
  drop(root);
});

test("two discussions of one round do not overwrite each other", () => {
  const root = fixtureRoot({ plan: { path: "docs/plans/PLAN_X.md", text: PLAN } });
  seed(root, "x", { "concerns.json": [concern()], "round-1.md": "# Assessment\n", "plan-round-1.md": PLAN });
  const args = (n) => ["--kind", "discuss", "--round", "1", "--discussion", String(n), "--tier", "internal",
    "--plan", "docs/plans/PLAN_X.md", "--concerns", "C1", "--question", `q${n}`];
  runMain(root, args(1), { script: [SIGNED_IN, writesAssessment("first")] });
  seed(root, "x", { "round-1.discussion-1.md": "first" });
  runMain(root, args(2), { script: [SIGNED_IN, writesAssessment("second")] });
  assert.equal(readFileSync(join(root, ".agents/reviews/x/round-1.discussion-1.md"), "utf8"), "first");
  assert.equal(readFileSync(join(root, ".agents/reviews/x/round-1.discussion-2.md"), "utf8"), "second");
  drop(root);
});

// ── sequence: the workflow claims, exercised rather than asserted ──────────

test("discuss → revise → present-to-david runs with no acknowledgement in the path, and David's question survives it", () => {
  const root = fixtureRoot({ plan: { path: "docs/plans/PLAN_X.md", text: PLAN } });
  const dir = join(root, ".agents/reviews/x");
  const ledger = [
    concern({ id: "C1", state: "open", concern: "the disputed technical point" }),
    concern({ id: "C2", state: "for-david", concern: "a product choice only David can make" }),
    concern({ id: "C3", state: "open", concern: "an unrelated open point" }),
  ];
  seed(root, "x", { "concerns.json": ledger, "round-1.md": "# Assessment\n\nC1, C2, C3.\n", "plan-round-1.md": PLAN });

  // 1. A focused discussion about C1 alone.
  assert.equal(runMain(root, ["--kind", "discuss", "--round", "1", "--discussion", "1", "--tier", "internal",
    "--plan", "docs/plans/PLAN_X.md", "--concerns", "C1", "--question", "Is the premise right?"]).code, 0);

  // 2. The tie is settled by the party holding the plan, recorded in the ledger.
  //    Nothing asks Astra to agree, and no further exchange is required.
  const settled = JSON.parse(JSON.stringify(ledger));
  settled[0].state = "settled-over-dissent";
  settled[0].response = "Settled on the evidence; reasoning recorded. Astra did not concur and is not required to.";
  writeFileSync(join(dir, "concerns.json"), JSON.stringify(settled, null, 2));

  // 3. A revision is assessed. The discussion did not consume a round.
  writeFileSync(join(root, "docs/plans/PLAN_X.md"), PLAN.replace("Do the thing.", "Do the thing, invalidating on write."));
  // The revision is what round 2 assesses; round 1's snapshot stays as it was.
  assert.equal(runMain(root, ["--kind", "assess", "--round", "2", "--tier", "internal", "--plan", "docs/plans/PLAN_X.md"]).code, 0);

  // 4. The question for David survived every step of it, in full.
  const pkg = readFileSync(join(dir, "round-2.prompt.md"), "utf8");
  assert.match(pkg, /a product choice only David can make/, "a focused reply closes nothing else");
  assert.match(pkg, /an unrelated open point/);
  assert.match(pkg, /Settled on the evidence/, "the recorded reasoning travels with the concern");

  // 5. Presenting to David is selectable straight from here: no rule in this
  //    module requires another assessment first.
  assert.equal(ACTIONS.includes("present-to-david"), true);
  assert.deepEqual(roundsRun(dir), [1, 2], "one discussion, two assessments");
  drop(root);
});

test("a focused reply leaves every unselected concern's state exactly as it was", () => {
  const rows = normalizeLedger([
    concern({ id: "C1", state: "open" }),
    concern({ id: "C2", state: "for-david", concern: "David's" }),
    concern({ id: "C3", state: "addressed" }),
  ]);
  const before = rows.map((c) => `${c.id}:${c.state}`);
  renderLedger(rows, { selected: ["C1"] });
  assert.deepEqual(rows.map((c) => `${c.id}:${c.state}`), before, "rendering never mutates state");
});

// ── no round-number branch: a late concern is not downgraded ───────────────

test("the composer treats exchange 7 exactly as it treats exchange 2", () => {
  const parts = { kind: "assess", lens: null, concerns: [] };
  const two = exchangeContext({ ...parts, round: 2 });
  const seven = exchangeContext({ ...parts, round: 7 });
  assert.equal(two.replace("assessment 2", "assessment N"), seven.replace("assessment 7", "assessment N"));
});

test("no retired instruction survives in the composed package", () => {
  const text = assemblePackage({
    role: "astra", kind: "assess", round: 5, contract: "c", judgment: "j", oracle: ORACLE,
    planPath: "p.md", tier: "internal", assessmentFile: "o.md", lens: null, concerns: [],
  });
  for (const retired of [
    /lens you have not applied/i,
    /recommended_improvements/,
    /required_revisions/,
    /previous_findings/,
    /review_status/,
    /belongs in `recommended/i,
    /a concern you raise for the first time now/i,
    /every section/i,
    /return only the JSON/i,
  ]) {
    assert.equal(retired.test(text), false, `the package still carries ${retired}`);
  }
  assert.match(text, /there is no obligation to reinvestigate everything, to find something new, or to attack from an angle you have not used before/);
});

test("an emphasis is optional, is framed as emphasis, and its absence is stated", () => {
  const withLens = exchangeContext({ kind: "assess", round: 1, lens: "failure modes", concerns: [] });
  assert.match(withLens, /Emphasis for this exchange: failure modes/);
  assert.match(withLens, /directs EMPHASIS, not scope/);
  assert.match(exchangeContext({ kind: "assess", round: 1, lens: null, concerns: [] }), /none — assess evenly/);
});

// ── a failed exchange is failed, never quiet ───────────────────────────────

test("a missing or empty assessment is a failed dispatch with a reason", () => {
  assert.match(readAssessment(join(tmpdir(), "nope-", String(Math.random()))).reason, /no assessment file was written/);
  const f = join(mkdtempSync(join(tmpdir(), "planning-test-")), "empty.md");
  writeFileSync(f, "   \n");
  assert.equal(readAssessment(f).failed, true);
  assert.match(readAssessment(f).reason, /empty/);
});

test("a reader that writes nothing is reported as a FAILED dispatch, not as nothing to report", () => {
  const root = fixtureRoot({ plan: { path: "docs/plans/PLAN_X.md", text: PLAN } });
  const { code, log } = runMain(root, ["--kind", "assess", "--round", "1", "--tier", "internal", "--plan", "docs/plans/PLAN_X.md"], {
    script: [SIGNED_IN, { status: 0, stdout: "", stderr: "" }],
  });
  assert.equal(code, 1);
  assert.match(log, /FAILED dispatch, not a quiet exchange/);
  assert.match(log, /do not relay it to David as "nothing to report"/);
  drop(root);
});

test("a reader that crashes is a failed exchange, and is not re-asked", () => {
  const root = fixtureRoot({ plan: { path: "docs/plans/PLAN_X.md", text: PLAN } });
  const run = fakeRun([SIGNED_IN, { status: 7, stdout: "", stderr: "boom" }]);
  const code = main(["--kind", "assess", "--round", "1", "--tier", "internal", "--plan", "docs/plans/PLAN_X.md"],
    { root, run, log: () => {}, git: () => ({ status: 128 }) });
  assert.equal(code, 1);
  assert.equal(run.calls.filter((c) => c.args[0] === "exec").length, 1, "one attempt: there is no schema to re-ask for");
  drop(root);
});

test("no sign-in exits 2 with the device-code instructions, and runs nothing", () => {
  const root = fixtureRoot({ plan: { path: "docs/plans/PLAN_X.md", text: PLAN } });
  const run = fakeRun([{ status: 1, stdout: "Not logged in", stderr: "" }]);
  const code = main(["--kind", "assess", "--round", "1", "--tier", "internal", "--plan", "docs/plans/PLAN_X.md"],
    { root, run, log: () => {}, git: () => ({ status: 128 }) });
  assert.equal(code, 2);
  assert.equal(run.calls.some((c) => c.args[0] === "exec"), false);
  drop(root);
});

test("not signed in is read from both the exit code and the text", () => {
  assert.equal(signInStatus({ run: () => ({ status: 1, stdout: "Not logged in" }) }).signedIn, false);
  assert.equal(signInStatus({ run: () => ({ status: 0, stdout: "not logged in" }) }).signedIn, false);
  assert.equal(signInStatus({ run: () => ({ status: 0, stdout: "Logged in as x" }) }).signedIn, true);
  assert.equal(signInStatus({ run: () => ({ error: { code: "ENOENT", message: "no codex" } }) }).missingBinary, true);
});

// ── the ledger is required once a loop has started ─────────────────────────

test("a missing ledger after an exchange has run is refused, with --no-ledger as the explicit escape", () => {
  const root = fixtureRoot({ plan: { path: "docs/plans/PLAN_X.md", text: PLAN } });
  seed(root, "x", { "round-1.md": "# Assessment\n" });
  const args = ["--kind", "assess", "--round", "2", "--tier", "internal", "--plan", "docs/plans/PLAN_X.md", "--dry-run"];
  assert.match(runMain(root, args).log, /no concern ledger at/);
  assert.equal(runMain(root, [...args, "--no-ledger"]).code, 0);
  drop(root);
});

test("a first exchange needs no ledger at all", () => {
  const root = fixtureRoot({ plan: { path: "docs/plans/PLAN_X.md", text: PLAN } });
  assert.equal(runMain(root, ["--kind", "assess", "--round", "1", "--tier", "internal", "--plan", "docs/plans/PLAN_X.md", "--dry-run"]).code, 0);
  drop(root);
});

test("the ledger defaults inside the protected directory, so the common case cannot be exposed", () => {
  const root = fixtureRoot({ plan: { path: "docs/plans/PLAN_X.md", text: PLAN } });
  seed(root, "x", { "concerns.json": [concern()] });
  assert.equal(runMain(root, ["--kind", "assess", "--round", "1", "--tier", "internal", "--plan", "docs/plans/PLAN_X.md", "--dry-run"]).code, 0);
  const pkg = readFileSync(join(root, ".agents/reviews/x/round-1.prompt.md"), "utf8");
  assert.match(pkg, /Cache invalidation is unspecified/);
  drop(root);
});

// ── my own copy of the package ─────────────────────────────────────────────

test("--role claude requires --prompt-only, because this script runs only the other party", () => {
  const root = fixtureRoot({ plan: { path: "docs/plans/PLAN_X.md", text: PLAN } });
  assert.match(
    runMain(root, ["--kind", "assess", "--round", "1", "--tier", "internal", "--plan", "docs/plans/PLAN_X.md", "--role", "claude"]).log,
    /it is mine to read. Use --prompt-only/,
  );
  drop(root);
});

test("--prompt-only prints the package and spawns nothing", () => {
  const root = fixtureRoot({ plan: { path: "docs/plans/PLAN_X.md", text: PLAN } });
  const run = fakeRun([]);
  const written = [];
  const stdout = process.stdout.write;
  process.stdout.write = (s) => (written.push(s), true);
  try {
    const code = main(["--kind", "assess", "--round", "1", "--tier", "internal", "--plan", "docs/plans/PLAN_X.md", "--role", "claude", "--prompt-only"],
      { root, run, log: () => {}, git: () => ({ status: 128 }) });
    assert.equal(code, 0);
  } finally {
    process.stdout.write = stdout;
  }
  assert.equal(run.calls.length, 0, "nothing is spawned, not even a sign-in check");
  assert.match(written.join(""), /You are Claude/);
  drop(root);
});

test("--prompt-only clears the ATTEMPT, never the accepted assessment", () => {
  // It used to clear the canonical file, which is the same continuity failure
  // --force had, reached through prompt generation where nobody was looking.
  // NO ACCEPTED round-1.md HERE any more: with one present, an astra preview is
  // now refused outright (see the test below), so seeding it would have made
  // this test pass on the refusal rather than on the thing it is for.
  const root = fixtureRoot({ plan: { path: "docs/plans/PLAN_X.md", text: PLAN } });
  seed(root, "x", { "round-1.attempt.md": "A STALE ATTEMPT FROM AN EARLIER, DIFFERENT PACKAGE" });
  const stdout = process.stdout.write;
  process.stdout.write = () => true;
  try {
    main(["--kind", "assess", "--round", "1", "--tier", "internal", "--plan", "docs/plans/PLAN_X.md", "--no-ledger", "--prompt-only"],
      { root, run: fakeRun([]), log: () => {}, git: () => ({ status: 128 }) });
  } finally {
    process.stdout.write = stdout;
  }
  assert.equal(existsSync(join(root, ".agents/reviews/x/round-1.attempt.md")), false);
  drop(root);
});

test("an astra preview cannot overwrite the record of a dispatch that happened", () => {
  // THE PATH WAS COVERED AND THE PROPERTY WAS NOT. The test above ran this exact
  // scenario at the default astra role and passed, because it asserted on the
  // assessment and the attempt and never looked at the prompt record -- which
  // was being replaced while the meta still described the original package
  // (Codex and both assessors, #124 round 5).
  for (const kind of [["assess", "1"], ["scope", "0"]]) {
    const [k, n] = kind;
    const root = fixtureRoot({ plan: { path: "docs/plans/PLAN_X.md", text: PLAN } });
    seed(root, "x", { [`round-${n}.md`]: "AN ACCEPTED ASSESSMENT", [`round-${n}.prompt.md`]: "THE PACKAGE ASTRA WAS ACTUALLY SENT" });
    writeFileSync(join(root, "oracle.md"), "# The oracle\n\nBuild the thing.\n");
    const args = k === "scope"
      ? ["--kind", "scope", "--slug", "x", "--oracle", "oracle.md", "--no-ledger", "--prompt-only"]
      : ["--kind", "assess", "--round", "1", "--tier", "internal", "--plan", "docs/plans/PLAN_X.md", "--no-ledger", "--prompt-only"];
    const { code, log } = runMain(root, args, { script: [] });
    assert.equal(code, 1, `${k} preview is refused`);
    assert.match(log, /an accepted assessment is never replaced/);
    assert.equal(readFileSync(join(root, `.agents/reviews/x/round-${n}.prompt.md`), "utf8"), "THE PACKAGE ASTRA WAS ACTUALLY SENT");
    drop(root);
  }
});

test("a Claude-role package does not overwrite the record of what Astra was sent", () => {
  const root = fixtureRoot({ plan: { path: "docs/plans/PLAN_X.md", text: PLAN } });
  const stdout = process.stdout.write;
  process.stdout.write = () => true;
  try {
    for (const role of ["astra", "claude"]) {
      main(["--kind", "assess", "--round", "1", "--tier", "internal", "--plan", "docs/plans/PLAN_X.md", "--no-ledger", "--role", role, "--prompt-only"],
        { root, run: fakeRun([]), log: () => {}, git: () => ({ status: 128 }) });
    }
  } finally {
    process.stdout.write = stdout;
  }
  const d = join(root, ".agents/reviews/x");
  assert.match(readFileSync(join(d, "round-1.prompt.md"), "utf8"), /You are Astra/);
  assert.match(readFileSync(join(d, "round-1.claude.prompt.md"), "utf8"), /You are Claude/);
  drop(root);
});

// ── the oracle, pinned ─────────────────────────────────────────────────────

test("the oracle comes from the plan's own block, and an explicit file wins", () => {
  assert.equal(oracleFrom({ oracleText: null, planText: PLAN }), ORACLE);
  assert.equal(oracleFrom({ oracleText: "```plan-oracle\nFROM THE FILE\n```", planText: PLAN }), "FROM THE FILE");
  assert.equal(oracleFrom({ oracleText: "unfenced whole file", planText: null }), "unfenced whole file");
});

test("no oracle is a refusal, because a plan measured against itself is not the contract", () => {
  assert.throws(() => oracleFrom({ oracleText: null, planText: "# Plan\n\nno block" }), /no oracle/);
});

test("the first exchange pins the oracle; a drifted one is refused; a declared change is recorded", () => {
  const dir = mkdtempSync(join(tmpdir(), "planning-test-"));
  const first = pinOracle(dir, ORACLE);
  assert.equal(first.firstPin, true);
  first.commit();
  assert.equal(pinOracle(dir, ORACLE).changed, false);
  assert.throws(() => pinOracle(dir, "a rewritten intent"), /the oracle differs from the one pinned/);
  const changed = pinOracle(dir, "a rewritten intent", { changedReason: "David widened the scope" });
  assert.equal(changed.changed, true);
  assert.equal(changed.changedReason, "David widened the scope");
  drop(dir);
});

test("a refused run does not re-pin, so the next one still sees the drift", () => {
  const root = fixtureRoot({ plan: { path: "docs/plans/PLAN_X.md", text: PLAN } });
  const dir = seed(root, "x", {});
  writeFileSync(join(dir, "oracle.txt"), "THE ORIGINAL INTENT\n");
  const { code, log } = runMain(root, ["--kind", "assess", "--round", "1", "--tier", "internal", "--plan", "docs/plans/PLAN_X.md", "--dry-run"]);
  assert.equal(code, 1);
  assert.match(log, /the oracle differs/);
  assert.equal(readFileSync(join(dir, "oracle.txt"), "utf8"), "THE ORIGINAL INTENT\n");
  drop(root);
});

// ── the tier, pinned ───────────────────────────────────────────────────────

test("a tier that disagrees with the exchange this loop started on is refused", () => {
  const dir = mkdtempSync(join(tmpdir(), "planning-test-"));
  writeFileSync(join(dir, "round-1.meta.json"), JSON.stringify({ tier: "internal" }));
  assert.doesNotThrow(() => assertTierPinned(dir, [1], "internal"));
  assert.throws(() => assertTierPinned(dir, [1], "product"), /ran exchange 1 as tier "internal"/);
  drop(dir);
});

test("a meta with no tier recorded is skipped, not treated as a mismatch", () => {
  const dir = mkdtempSync(join(tmpdir(), "planning-test-"));
  writeFileSync(join(dir, "round-0.meta.json"), JSON.stringify({ kind: "scope" }));
  assert.doesNotThrow(() => assertTierPinned(dir, [0], "internal"));
  drop(dir);
});

// ── publication refusals ───────────────────────────────────────────────────

test("the reviews directory ignores itself, so no plan or package reaches git history", () => {
  const root = mkdtempSync(join(tmpdir(), "planning-test-"));
  ensureRoundDir(root, "x", () => ({ status: 128 }));
  assert.match(readFileSync(join(root, ".agents/reviews/.gitignore"), "utf8"), /^\*$/m);
  drop(root);
});

test("an existing reviews ignore that does not ignore everything is extended, then verified", () => {
  const root = mkdtempSync(join(tmpdir(), "planning-test-"));
  mkdirSync(join(root, ".agents/reviews"), { recursive: true });
  writeFileSync(join(root, ".agents/reviews/.gitignore"), "# a consumer's own note\nsomething-else\n");
  ensureRoundDir(root, "x", () => ({ status: 128 }));
  const text = readFileSync(join(root, ".agents/reviews/.gitignore"), "utf8");
  assert.match(text, /a consumer's own note/, "never rewrite what a consumer put there");
  assert.match(text, /^\*$/m);
  drop(root);
});

test("docs/plans ignores itself, so `git add -A` cannot publish a plan", () => {
  const root = mkdtempSync(join(tmpdir(), "planning-test-"));
  ensurePlansIgnored(root, null, () => ({ status: 128 }));
  assert.match(readFileSync(join(root, "docs/plans/.gitignore"), "utf8"), /^PLAN_\*\.md$/m);
  drop(root);
});

test("the ignore chokepoint asks git, not the pattern file — a negation that re-exposes a plan refuses", () => {
  const root = mkdtempSync(join(tmpdir(), "planning-test-"));
  mkdirSync(join(root, "docs/plans"), { recursive: true });
  writeFileSync(join(root, "docs/plans/.gitignore"), "PLAN_*.md\n!PLAN_SECRET.md\n");
  // A .gitignore is an ordered program whose LAST match decides, so a pattern
  // scan calls this protected and git does not.
  const git = (args) => (args[0] === "check-ignore" ? { status: 1 } : { status: 0, stdout: "?? docs/plans/PLAN_SECRET.md\n" });
  assert.throws(() => assertIgnored(root, "docs/plans/PLAN_SECRET.md", git, "plan"), /is NOT ignored by git/);
  drop(root);
});

test("a tracked plan is allowed — David asking for one on main is deliberate — but a tracked oracle is not", () => {
  const root = mkdtempSync(join(tmpdir(), "planning-test-"));
  mkdirSync(join(root, "docs/plans"), { recursive: true });
  writeFileSync(join(root, "docs/plans/PLAN_X.md"), "x");
  writeFileSync(join(root, "oracle.md"), "x");
  const tracked = (args) => (args[0] === "check-ignore" ? { status: 1 } : { status: 0, stdout: " M docs/plans/PLAN_X.md\n" });
  assert.doesNotThrow(() => assertIgnored(root, "docs/plans/PLAN_X.md", tracked, "plan"));
  assert.throws(() => assertIgnored(root, "oracle.md", tracked, "oracle"), /is NOT ignored by git/);
  drop(root);
});

test("the ledger is protected by name, because it holds the plan's reasoning in a file that looks like bookkeeping", () => {
  const root = mkdtempSync(join(tmpdir(), "planning-test-"));
  writeFileSync(join(root, "concerns.json"), "[]");
  const exposed = () => ({ status: 1 });
  assert.throws(() => assertIgnored(root, "concerns.json", exposed, "ledger"), /the concern ledger concerns\.json is NOT ignored/);
  drop(root);
});

test("git declining to answer is not evidence of exposure", () => {
  const root = mkdtempSync(join(tmpdir(), "planning-test-"));
  assert.doesNotThrow(() => assertIgnored(root, "anything.md", () => ({ status: 128 }), "oracle"));
  assert.doesNotThrow(() => assertIgnored(root, "anything.md", () => ({ error: new Error("no git") }), "oracle"));
  drop(root);
});

// ── the plan must not move under the reader ────────────────────────────────

test("a plan edited while the exchange ran refuses it rather than pinning the wrong bytes", () => {
  const root = fixtureRoot({ plan: { path: "docs/plans/PLAN_X.md", text: PLAN } });
  const edits = ({ args }) => {
    writeFileSync(join(root, "docs/plans/PLAN_X.md"), `${PLAN}\n<!-- edited mid-flight -->\n`);
    return writesAssessment("# Assessment\n")({ args });
  };
  const { code, log } = runMain(root, ["--kind", "assess", "--round", "1", "--tier", "internal", "--plan", "docs/plans/PLAN_X.md"], {
    script: [SIGNED_IN, edits],
  });
  assert.equal(code, 1);
  assert.match(log, /changed while this exchange was running/);
  assert.match(log, /do not relay it to David/);
  drop(root);
});

test("an untouched plan costs nothing, and its digest is recorded in full for the PR body's oracle-source line", () => {
  const root = fixtureRoot({ plan: { path: "docs/plans/PLAN_X.md", text: PLAN } });
  assert.equal(runMain(root, ["--kind", "assess", "--round", "1", "--tier", "internal", "--plan", "docs/plans/PLAN_X.md"]).code, 0);
  const meta = JSON.parse(readFileSync(join(root, ".agents/reviews/x/round-1.meta.json"), "utf8"));
  assert.equal(meta.planDrift, null);
  assert.equal(/^[0-9a-f]{64}$/.test(meta.planSha256), true, "the full digest pins which text David approved");
  assert.equal(readFileSync(join(root, ".agents/reviews/x/plan-round-1.md"), "utf8"), PLAN, "the exact bytes read are snapshotted");
  drop(root);
});

// ── the reviewer's identity is pinned ──────────────────────────────────────

test("model, effort and sandbox are refused without a recorded reason", () => {
  const root = fixtureRoot({ plan: { path: "docs/plans/PLAN_X.md", text: PLAN } });
  for (const flag of ["--model", "--effort", "--sandbox"]) {
    const value = flag === "--sandbox" ? "workspace-write" : "cheap";
    assert.match(runMain(root, ["--kind", "assess", "--round", "1", "--tier", "internal", "--plan", "docs/plans/PLAN_X.md", flag, value]).log,
      /would depart from the settled reviewer/);
  }
  drop(root);
});

test("danger-full-access is refused even with a reason", () => {
  const root = fixtureRoot({ plan: { path: "docs/plans/PLAN_X.md", text: PLAN } });
  assert.match(
    runMain(root, ["--kind", "assess", "--round", "1", "--tier", "internal", "--plan", "docs/plans/PLAN_X.md",
      "--sandbox", "danger-full-access", "--unpinned", "I want to"]).log,
    /refused, with or without --unpinned/,
  );
  drop(root);
});

test("an unpinned exchange says so on its own record", () => {
  const root = fixtureRoot({ plan: { path: "docs/plans/PLAN_X.md", text: PLAN } });
  runMain(root, ["--kind", "assess", "--round", "1", "--tier", "internal", "--plan", "docs/plans/PLAN_X.md",
    "--effort", "low", "--unpinned", "smoke test"]);
  const meta = JSON.parse(readFileSync(join(root, ".agents/reviews/x/round-1.meta.json"), "utf8"));
  assert.equal(meta.unpinned, "smoke test");
  assert.equal(meta.effort, "low");
  drop(root);
});

test("the settled reviewer is read from configuration, never hardcoded here", () => {
  const settled = defaultReviewer();
  assert.equal(typeof settled.id, "string");
  assert.match(settled.id, /^[a-z][a-z0-9.]*(-[a-z0-9.]+)+$/, "a full id, never an alias");
});

// ── inputs, slugs and paths ────────────────────────────────────────────────

test("a slug that is not a safe path segment is refused", () => {
  for (const bad of ["../escape", "has space", "/abs", "", "Upper"]) assert.throws(() => assertSlug(bad), /--slug must match/);
  assert.equal(assertSlug("planning-loop-1"), "planning-loop-1");
});

test("a slug is derived from the plan filename so the common case needs no flag", () => {
  assert.equal(slugFromPlanPath("docs/plans/PLAN_FOO_BAR.md"), "foo-bar");
  assert.throws(() => slugFromPlanPath("docs/plans/PLAN_.md"), /cannot derive a slug/);
});

test("a fenced block is lifted out of the file that carries it", () => {
  assert.equal(extractFenced(PLAN, "affected-files"), "- src/thing.ts");
  assert.equal(extractFenced(PLAN, "nothing-here"), null);
});

test("exchanges run are counted from the assessment files, and a discussion is not one", () => {
  const dir = mkdtempSync(join(tmpdir(), "planning-test-"));
  for (const f of ["round-0.md", "round-1.md", "round-1.discussion-1.md", "round-2.md", "round-2.prompt.md"]) {
    writeFileSync(join(dir, f), "x");
  }
  assert.deepEqual(roundsRun(dir), [0, 1, 2]);
  drop(dir);
});

test("the repo root is found by walking up to .git, not by counting directories", () => {
  const root = mkdtempSync(join(tmpdir(), "planning-test-"));
  mkdirSync(join(root, ".git"), { recursive: true });
  mkdirSync(join(root, "core/scripts"), { recursive: true });
  assert.equal(findRepoRoot(join(root, "core/scripts")), root);
  assert.equal(findRepoRoot(join(root, "..", "..", "definitely-not-here")), null);
  drop(root);
});

test("USAGE names the invocation path by computing it, never by hardcoding a layout", () => {
  const source = readFileSync(SCRIPT, "utf8");
  assert.equal(source.includes('"core/scripts/plan-review.mjs"'), false);
  assert.equal(source.includes('"scripts/plan-review.mjs"'), false);
  assert.match(USAGE, /node \S*scripts\/plan-review\.mjs/);
});

test("an accepted assessment is never replaced, and no flag overrides that", () => {
  // --force was removed rather than guarded: with promotion in place its only
  // remaining job was re-running an accepted exchange, and its only remaining
  // effect was deleting the file a ledger entry cites as its source.
  const root = fixtureRoot({ plan: { path: "docs/plans/PLAN_X.md", text: PLAN } });
  seed(root, "x", { "round-1.md": "the earlier assessment" });
  const args = ["--kind", "assess", "--round", "1", "--tier", "internal", "--plan", "docs/plans/PLAN_X.md", "--no-ledger"];
  assert.match(runMain(root, args).log, /an accepted assessment is never replaced/);
  assert.match(runMain(root, [...args, "--force"]).log, /unknown flag --force/);
  assert.equal(readFileSync(join(root, ".agents/reviews/x/round-1.md"), "utf8"), "the earlier assessment");
  assert.equal(USAGE.includes("--force"), false);
  drop(root);
});

test("bad arguments are refused with the usage, never guessed at", () => {
  const root = fixtureRoot();
  for (const argv of [["--nonsense"], ["stray"], ["--kind"], ["--kind", "audit"]]) {
    const { code, log } = runMain(root, argv);
    assert.equal(code, 1);
    assert.equal(log.length > 0, true);
  }
  drop(root);
});

// ── what only a live exchange can establish ────────────────────────────────

test("the judgement-dependent claims are named here rather than asserted", () => {
  // Deliberately not a behavioural assertion, and deliberately present: these
  // are the claims the redesign makes that no string comparison can establish,
  // recorded so that a reader of this suite sees what it does NOT cover.
  //
  //   - that supplied evidence is actually evaluated rather than accepted
  //   - that an inadequate search is caught rather than treated as exhaustive
  //   - that the readout helps David judge the plan
  //
  // They are read from a real scope, assessment and discussion against a real
  // plan. A suite that claimed them would be the failure this loop exists to
  // avoid: a check satisfiable without the thing it exists to check.
  assert.equal(true, true);
});

// ── a tie settled over a dissent stays readable ────────────────────────────

test("a tie settled over a dissent keeps its reasoning in full, so it can be revisited", () => {
  // Without this the party that was overruled stops seeing the argument on the
  // next exchange, and cannot bring new evidence against a conclusion it can no
  // longer read. Found by the sequence test above, not reasoned into existence.
  const rows = normalizeLedger([
    concern({ id: "C1", state: "settled-over-dissent", concern: "THE DISPUTED POINT", response: "THE RECORDED REASONING" }),
    concern({ id: "C2", state: "addressed", concern: "AGREED AND DONE" }),
  ]);
  const text = renderLedger(rows).join("\n");
  assert.match(text, /THE DISPUTED POINT/);
  assert.match(text, /THE RECORDED REASONING/);
  assert.equal(text.includes("AGREED AND DONE"), false, "an ordinary resolved concern still renders by reference");
});

test("a tie settled over a dissent must carry the reasoning it was settled against", () => {
  assert.throws(() => normalizeLedger([concern({ state: "settled-over-dissent", concern: "" })]), /carries no "concern" text/);
});

// ── only an accepted exchange reaches the canonical path ───────────────────
//
// `round-N.md` means "an exchange that happened", and three consumers depend on
// it: roundsRun counts it, a discussion reads it as the prior assessment, and a
// ledger entry cites it as a concern's durable source. Both assessors called the
// drift finding and the --force finding one mechanism rather than two fixes, so
// these test the mechanism from both ends.

test("a plan edited mid-flight leaves nothing at the canonical path, and the exchange re-runs with no flag", () => {
  const root = fixtureRoot({ plan: { path: "docs/plans/PLAN_X.md", text: PLAN } });
  const edits = ({ args }) => {
    writeFileSync(join(root, "docs/plans/PLAN_X.md"), `${PLAN}\n<!-- edited mid-flight -->\n`);
    return writesAssessment("# Assessment\n")({ args });
  };
  const first = runMain(root, ["--kind", "assess", "--round", "1", "--tier", "internal", "--plan", "docs/plans/PLAN_X.md"], {
    script: [SIGNED_IN, edits],
  });
  assert.equal(first.code, 1);

  const dir = join(root, ".agents/reviews/x");
  assert.equal(existsSync(join(dir, "round-1.md")), false, "a rejected attempt never reaches the canonical path");
  assert.deepEqual(roundsRun(dir), [], "so nothing counts it as an exchange that happened");
  assert.equal(existsSync(join(dir, "round-1.attempt.md")), true, "but what the reader returned is still readable");
  assert.match(first.log, /deliberately NOT at the canonical path/);

  // The same round re-runs with no flag, because nothing was accepted.
  const again = runMain(root, ["--kind", "assess", "--round", "1", "--tier", "internal", "--plan", "docs/plans/PLAN_X.md"]);
  assert.equal(again.code, 0);
  assert.deepEqual(roundsRun(dir), [1]);
  drop(root);
});

test("a reader that writes nothing leaves nothing at the canonical path either", () => {
  const root = fixtureRoot({ plan: { path: "docs/plans/PLAN_X.md", text: PLAN } });
  const { code } = runMain(root, ["--kind", "assess", "--round", "1", "--tier", "internal", "--plan", "docs/plans/PLAN_X.md"], {
    script: [SIGNED_IN, { status: 0, stdout: "", stderr: "" }],
  });
  assert.equal(code, 1);
  assert.equal(existsSync(join(root, ".agents/reviews/x/round-1.md")), false);
  assert.deepEqual(roundsRun(join(root, ".agents/reviews/x")), []);
  drop(root);
});

test("a reader that exits non-zero having written something does not get promoted", () => {
  // The failure class the reviewer named for plan drift, reached by the other
  // branch: a process can write its last message and still exit non-zero.
  const root = fixtureRoot({ plan: { path: "docs/plans/PLAN_X.md", text: PLAN } });
  const writesThenFails = ({ args }) => {
    writesAssessment("# A partial answer\n")({ args });
    return { status: 7, stdout: "", stderr: "boom" };
  };
  assert.equal(runMain(root, ["--kind", "assess", "--round", "1", "--tier", "internal", "--plan", "docs/plans/PLAN_X.md"], {
    script: [SIGNED_IN, writesThenFails],
  }).code, 1);
  assert.equal(existsSync(join(root, ".agents/reviews/x/round-1.md")), false);
  drop(root);
});

// ── a discussion's premise about the plan is checked, not asserted ─────────

test("a discussion refuses when the plan has changed since the assessment", () => {
  const root = fixtureRoot({ plan: { path: "docs/plans/PLAN_X.md", text: PLAN } });
  seed(root, "x", { "concerns.json": [concern()], "round-1.md": "# Assessment\n", "plan-round-1.md": PLAN });
  writeFileSync(join(root, "docs/plans/PLAN_X.md"), PLAN.replace("Do the thing.", "Do something else entirely."));
  const { code, log } = runMain(root, ["--kind", "discuss", "--round", "1", "--discussion", "1", "--tier", "internal",
    "--plan", "docs/plans/PLAN_X.md", "--concerns", "C1", "--question", "q"]);
  assert.equal(code, 1);
  assert.match(log, /has changed since round 1 assessed it/);
  assert.match(log, /A revised plan belongs in an assessment/);
  drop(root);
});

test("a discussion leaves the assessment's snapshot untouched", () => {
  // The snapshot is the baseline the check above compares against, so an
  // exchange that rewrote it destroyed the only record of a mismatch.
  const root = fixtureRoot({ plan: { path: "docs/plans/PLAN_X.md", text: PLAN } });
  const dir = seed(root, "x", { "concerns.json": [concern()], "round-1.md": "# Assessment\n", "plan-round-1.md": PLAN });
  assert.equal(runMain(root, ["--kind", "discuss", "--round", "1", "--discussion", "1", "--tier", "internal",
    "--plan", "docs/plans/PLAN_X.md", "--concerns", "C1", "--question", "q"]).code, 0);
  assert.equal(readFileSync(join(dir, "plan-round-1.md"), "utf8"), PLAN);
  drop(root);
});

test("a discussion with no snapshot to compare against refuses rather than guessing", () => {
  const root = fixtureRoot({ plan: { path: "docs/plans/PLAN_X.md", text: PLAN } });
  seed(root, "x", { "concerns.json": [concern()], "round-1.md": "# Assessment\n" });
  assert.match(runMain(root, ["--kind", "discuss", "--round", "1", "--discussion", "1", "--tier", "internal",
    "--plan", "docs/plans/PLAN_X.md", "--concerns", "C1", "--question", "q"]).log, /no plan snapshot at/);
  drop(root);
});

// ── the tier pin covers a discussion of the only assessment ───────────────

test("a discussion cannot silently re-frame what is downstream", () => {
  // `earlier` excluded the current round, so a discussion of round 1 had no
  // metadata to pin against and an accidental --tier product was accepted.
  const root = fixtureRoot({ plan: { path: "docs/plans/PLAN_X.md", text: PLAN } });
  seed(root, "x", {
    "concerns.json": [concern()], "round-1.md": "# Assessment\n", "plan-round-1.md": PLAN,
    "round-1.meta.json": { slug: "x", kind: "assess", round: 1, tier: "internal" },
  });
  const args = (tier) => ["--kind", "discuss", "--round", "1", "--discussion", "1", "--tier", tier,
    "--plan", "docs/plans/PLAN_X.md", "--concerns", "C1", "--question", "q", "--dry-run"];
  assert.match(runMain(root, args("product")).log, /ran exchange 1 as tier "internal"/);
  assert.equal(runMain(root, args("internal")).code, 0);
  drop(root);
});

// ── a later assessment is given the version it is asked to compare against ──
//
// The round > 1 instruction used to say "the changes since you last saw it"
// while the package carried no earlier plan, no diff and no path to either --
// the third instance in this file's own history of the package asserting
// something its contents do not supply (#124 round 2).

/** The package text, without spawning anything. */
function promptOf(root, argv) {
  const written = [];
  const stdout = process.stdout.write;
  process.stdout.write = (s) => (written.push(s), true);
  try {
    // `--role claude`, because this composes MY copy -- which is what
    // `--prompt-only` is exempt for. Running it as astra made these tests
    // exercise a path no recipe uses, and made the reread test below assert
    // one role while running another (#124 round 5).
    const code = main([...argv, "--role", "claude", "--prompt-only"], { root, run: fakeRun([]), log: () => {}, git: () => ({ status: 128 }) });
    assert.equal(code, 0, "the package was composed");
  } finally {
    process.stdout.write = stdout;
  }
  return written.join("");
}

test("a later assessment names the previous exchange's plan and assessment by path", () => {
  const root = fixtureRoot({ plan: { path: "docs/plans/PLAN_X.md", text: PLAN } });
  seed(root, "x", { "concerns.json": [concern()], "round-1.md": "# Assessment 1\n", "plan-round-1.md": PLAN });
  const prompt = promptOf(root, ["--kind", "assess", "--round", "2", "--tier", "internal", "--plan", "docs/plans/PLAN_X.md"]);
  assert.match(prompt, /\.agents\/reviews\/x\/plan-round-1\.md/, "the plan as round 1 read it");
  assert.match(prompt, /\.agents\/reviews\/x\/round-1\.md/, "round 1's own assessment");
  assert.match(prompt, /readable, not remembered/);
  drop(root);
});

test("a first assessment names no predecessor and does not claim one", () => {
  // The scope exchange leaves `round-0.md` but no plan snapshot -- there was no
  // plan yet -- so there is nothing complete to point at. Naming a file that is
  // not there would be one more instance of the class this fix belongs to.
  const root = fixtureRoot({ plan: { path: "docs/plans/PLAN_X.md", text: PLAN } });
  seed(root, "x", { "concerns.json": [concern()], "round-0.md": "# Scope\n" });
  const prompt = promptOf(root, ["--kind", "assess", "--round", "1", "--tier", "internal", "--plan", "docs/plans/PLAN_X.md"]);
  // A CONCRETE snapshot, not the naming convention. Round 11 added a sentence
  // describing `plan-round-N.md` as a shape, which is true before any snapshot
  // exists and is how `round-0.md` finally becomes reachable; `/plan-round-/`
  // could not tell the two apart and failed on the convention line.
  assert.doesNotMatch(prompt, /plan-round-\d/, "no actual snapshot is named");
  assert.doesNotMatch(prompt, /readable, not remembered/);
  assert.doesNotMatch(prompt, /changes since you last saw it/, "and the instruction does not assert one either");
  drop(root);
});

test("a rejected exchange is never named as the predecessor", () => {
  // Since the promotion fix a rejected round leaves no `round-N.md`, so the
  // predecessor is the highest ACCEPTED round rather than `round - 1`.
  //
  // RE-SEEDED AT #124 ROUND 8, and the re-seeding is the point rather than
  // bookkeeping. This test used to run round **3** against a tree where only
  // round 1 was accepted, and assert that it SUCCEEDED -- which is exactly the
  // hole `4045616282` reported, staged here as a fixture and thereby asserted
  // to be correct. Round 2 failed and left `round-2.attempt.md`, so the retry
  // KEEPS ITS NUMBER (the sequencing refusal says so in its own message), and
  // round 2 is what the operator runs next. Same tree, same question -- does a
  // rejected exchange get cited -- now asked at the number the workflow
  // actually reaches. (The Fable assessor supplied this shape; without it the
  // fix would have landed against a red test I would have been tempted to
  // delete.)
  const root = fixtureRoot({ plan: { path: "docs/plans/PLAN_X.md", text: PLAN } });
  seed(root, "x", {
    "concerns.json": [concern()],
    "round-1.md": "# Assessment 1\n",
    "plan-round-1.md": PLAN,
    "round-2.attempt.md": "# An exchange that did not happen\n",
    "plan-round-2.md": PLAN,
  });
  const prompt = promptOf(root, ["--kind", "assess", "--round", "2", "--tier", "internal", "--plan", "docs/plans/PLAN_X.md"]);
  assert.match(prompt, /plan-round-1\.md/);
  assert.doesNotMatch(prompt, /round-2\.md/, "round 2 was never accepted");
  drop(root);
});

test("a Claude preview obeys the sequence, because it is briefed like any other", () => {
  // `4045616282`: `myReread` is `--prompt-only && role === "claude"` -- EVERY
  // preview -- and it used to short-circuit the sequencing gate entirely. So
  // with only round 1 accepted, the plan holder could compose a package headed
  // "This is assessment 3" while the Astra dispatch of that same number was
  // refused as out of order: briefed against an exchange that cannot exist.
  //
  // The three cases together are what say the fix is bounded: the out-of-order
  // preview refuses, the NEXT one passes, and the documented reread of an
  // ALREADY-ACCEPTED round still passes -- that last one is the path the old
  // exemption was written for, and it survives on the `ran.includes` clause
  // that was always sitting beside it.
  const root = fixtureRoot({ plan: { path: "docs/plans/PLAN_X.md", text: PLAN } });
  seed(root, "x", {
    "concerns.json": [concern()],
    "round-1.md": "# Assessment 1\n",
    "plan-round-1.md": PLAN,
  });
  const preview = (n) =>
    runMain(root, [
      "--kind", "assess", "--round", String(n), "--role", "claude", "--prompt-only",
      "--tier", "internal", "--plan", "docs/plans/PLAN_X.md",
    ]);

  const skipped = preview(3);
  assert.notEqual(skipped.code, 0, "a preview of a round that is not next is refused, as the dispatch of it would be");
  assert.match(skipped.log, /not the next assessment/, "and it says which number it wanted");
  assert.equal(existsSync(join(root, ".agents/reviews/x/round-3.prompt.md")), false, "and it writes no package");

  assert.equal(preview(2).code, 0, "the next round previews, because it is next");
  assert.equal(preview(1).code, 0, "and an accepted round still rereads -- the case the old exemption was for");
  drop(root);
});

// ── the plan ignore exists before the plan does ────────────────────────────

test("a scope exchange creates the plan ignore, before any plan is drafted", () => {
  // It used to be created only by an exchange that already had a plan, and the
  // documented sequence drafts the plan between the scope exchange and the
  // first assessment -- so the draft sat unignored for exactly that long, in
  // every consumer (#124 round 2).
  const root = fixtureRoot();
  writeFileSync(join(root, "oracle.md"), "# The oracle\n\nBuild the thing.\n");
  assert.equal(existsSync(join(root, "docs/plans/.gitignore")), false, "nothing has created it yet");
  assert.equal(runMain(root, ["--kind", "scope", "--slug", "x", "--tier", "internal", "--oracle", "oracle.md", "--no-ledger"]).code, 0);
  assert.match(readFileSync(join(root, "docs/plans/.gitignore"), "utf8"), /^PLAN_\*\.md$/m);
  drop(root);
});

// ── assessment rounds go up by one ─────────────────────────────────────────
//
// `Math.max` over round numbers stands for "the most recently run exchange",
// and that proxy holds only while the numbers are assigned monotonically. The
// numbers are typed by hand and nothing checked them, so a gap filled in later
// briefed the other party against a stale revision and said nothing about it
// (#124 round 4).

test("a skipped round cannot be filled in later", () => {
  const root = fixtureRoot({ plan: { path: "docs/plans/PLAN_X.md", text: PLAN } });
  const dir = seed(root, "x", { "round-1.md": "# One\n", "round-3.md": "# Three\n" });
  const { code, log } = runMain(root, ["--kind", "assess", "--round", "2", "--tier", "internal",
    "--plan", "docs/plans/PLAN_X.md", "--no-ledger"]);
  assert.equal(code, 1);
  assert.match(log, /--round 2 is not the next assessment/);
  assert.match(log, /the next one is 4/);
  assert.equal(existsSync(join(dir, "round-2.prompt.md")), false, "and it refuses before composing anything");
  drop(root);
});

test("the round after a gap is allowed, because the gap is what was refused", () => {
  // Fable's acceptance list asked for round 4 to be refused under this seed
  // too. It does not follow from the rule it proposed and it should not: with
  // rounds 1 and 3 run, 4 IS the next number. Refusing the fill-in above is
  // what stops the 1-3-2 ordering that corrupts round 4 from ever existing.
  const root = fixtureRoot({ plan: { path: "docs/plans/PLAN_X.md", text: PLAN } });
  seed(root, "x", { "round-1.md": "# One\n", "round-3.md": "# Three\n" });
  assert.equal(runMain(root, ["--kind", "assess", "--round", "4", "--tier", "internal",
    "--plan", "docs/plans/PLAN_X.md", "--no-ledger"]).code, 0);
  drop(root);
});

test("a retry after a failed exchange keeps its own number", () => {
  // A rejected exchange leaves no round-N.md, so `ran` does not carry it and
  // round N is still next -- which is what the script's own failure messages
  // already tell the operator to do.
  const root = fixtureRoot({ plan: { path: "docs/plans/PLAN_X.md", text: PLAN } });
  seed(root, "x", { "round-1.md": "# One\n", "round-2.attempt.md": "# An exchange that did not happen\n" });
  assert.equal(runMain(root, ["--kind", "assess", "--round", "2", "--tier", "internal",
    "--plan", "docs/plans/PLAN_X.md", "--no-ledger"]).code, 0);
  drop(root);
});

test("the first assessment is round 1, with or without a scope exchange", () => {
  // A FRESH FIXTURE PER CASE. Running round 1 first makes round 2 genuinely
  // next, so reusing the tree would have asserted the opposite of the point.
  for (const seeded of [{}, { "round-0.md": "# Scope\n" }]) {
    for (const [round, want] of [[1, 0], [2, 1]]) {
      const root = fixtureRoot({ plan: { path: "docs/plans/PLAN_X.md", text: PLAN } });
      seed(root, "x", seeded);
      assert.equal(
        runMain(root, ["--kind", "assess", "--round", String(round), "--tier", "internal",
          "--plan", "docs/plans/PLAN_X.md", "--no-ledger"]).code,
        want,
        `round ${round} with ${Object.keys(seeded).join(", ") || "nothing"} seeded`,
      );
      drop(root);
    }
  }
});

test("rereading my own copy of an accepted round is exempt, and is not handed a later round", () => {
  // The documented "returning to an existing plan" recipe rereads an
  // already-accepted round. It creates no exchange, so the sequential rule does
  // not apply to it -- and the predecessor bound is what keeps its package
  // honest, since round 3's snapshot is not what round 1 was assessed against.
  const root = fixtureRoot({ plan: { path: "docs/plans/PLAN_X.md", text: PLAN } });
  seed(root, "x", {
    "concerns.json": [concern()],
    "round-1.md": "# One\n", "plan-round-1.md": PLAN,
    "round-3.md": "# Three\n", "plan-round-3.md": PLAN,
  });
  const prompt = promptOf(root, ["--kind", "assess", "--round", "1", "--tier", "internal", "--plan", "docs/plans/PLAN_X.md"]);
  assert.doesNotMatch(prompt, /plan-round-3\.md/, "round 3 is not what round 1 was assessed against");
  assert.doesNotMatch(prompt, /readable, not remembered/, "and round 1 has no predecessor at all");
  drop(root);
});

test("a discussion targets the latest assessment, not an older one on the same plan", () => {
  // FLIPPED AT #124 ROUND 9 (`4049773985`), and the flip is the finding. This
  // test asserted that discussing round 1 SUCCEEDED while round 3 existed, and
  // its old name -- "a discussion is untouched by the sequential rule" -- says
  // what it was actually protecting: a discussion must not hit the "not the
  // next assessment" error, which is a different rule. It was never a decision
  // that discussing a superseded round is desirable, and nothing in `SKILL.md`
  // documents doing so.
  //
  // Identical plan bytes are what make this reachable AND what make it silent:
  // the snapshot check passes, because two assessments of the same plan can
  // still reach different conclusions. The cold peer is then briefed from the
  // older reasoning and the ledger updated from its reply.
  const root = fixtureRoot({ plan: { path: "docs/plans/PLAN_X.md", text: PLAN } });
  seed(root, "x", { "concerns.json": [concern()], "round-1.md": "# One\n", "plan-round-1.md": PLAN,
    "round-3.md": "# Three\n", "plan-round-3.md": PLAN });
  const discuss = (n) => runMain(root, ["--kind", "discuss", "--round", String(n), "--discussion", "1",
    "--tier", "internal", "--plan", "docs/plans/PLAN_X.md", "--concerns", "C1", "--question", "q"]);

  const stale = discuss(1);
  assert.equal(stale.code, 1, "round 1 is superseded by round 3");
  assert.match(stale.log, /--round 1 is not the latest assessment: 3 has since run/);
  assert.match(stale.log, /name its concern id in --concerns/, "and it names the way to reopen the older concern");

  assert.equal(discuss(3).code, 0, "the latest assessment is what a discussion revisits");
  drop(root);
});

test("the scope exchange is not an assessment, so it never counts as the latest", () => {
  // `roundsRun` counts `round-0.md`. Comparing against it unfiltered would make
  // a slug whose only exchange is the scope one refuse every discussion of
  // round 1 -- naming round 0, which no discussion can target.
  const root = fixtureRoot({ plan: { path: "docs/plans/PLAN_X.md", text: PLAN } });
  seed(root, "x", { "concerns.json": [concern()], "round-0.md": "# Scope\n", "plan-round-0.md": PLAN,
    "round-1.md": "# One\n", "plan-round-1.md": PLAN });
  assert.equal(runMain(root, ["--kind", "discuss", "--round", "1", "--discussion", "1", "--tier", "internal",
    "--plan", "docs/plans/PLAN_X.md", "--concerns", "C1", "--question", "q"]).code, 0);
  drop(root);
});

// ── an input asserted explicitly is not optional ───────────────────────────

test("an explicit --ledger that does not exist refuses, on the first exchange too", () => {
  // It used to be read as an empty ledger when nothing had run yet, which is
  // indistinguishable from a legitimate clean start -- so an operator who typed
  // --ledger BECAUSE they had concerns to carry in, and mistyped it, got a
  // package reporting zero concerns and no way to notice (#124 round 7).
  const root = fixtureRoot({ plan: { path: "docs/plans/PLAN_X.md", text: PLAN } });
  const { code, log } = runMain(root, ["--kind", "assess", "--round", "1", "--tier", "internal",
    "--plan", "docs/plans/PLAN_X.md", "--ledger", ".agents/reviews/x/typo.json"]);
  assert.equal(code, 1);
  assert.match(log, /--ledger \.agents\/reviews\/x\/typo\.json does not exist/);
  drop(root);
});

test("omitting --ledger on a first exchange still means an empty ledger", () => {
  const root = fixtureRoot({ plan: { path: "docs/plans/PLAN_X.md", text: PLAN } });
  assert.equal(runMain(root, ["--kind", "assess", "--round", "1", "--tier", "internal",
    "--plan", "docs/plans/PLAN_X.md", "--no-ledger"]).code, 0);
  drop(root);
});

// ── a scope exchange is the first exchange ─────────────────────────────────

test("a scope exchange is refused once an assessment has run", () => {
  // Started through the supported no-scope path, a late --kind scope used to be
  // accepted and told the other party there was no plan and no earlier
  // exchange, with an accepted assessment sitting in the same directory.
  const root = fixtureRoot();
  seed(root, "x", { "round-1.md": "# Assessment 1\n", "concerns.json": [concern()] });
  writeFileSync(join(root, "oracle.md"), "# The oracle\n\nBuild the thing.\n");
  const { code, log } = runMain(root, ["--kind", "scope", "--slug", "x", "--oracle", "oracle.md"]);
  assert.equal(code, 1);
  assert.match(log, /the scope exchange comes before the plan, and assessment\(s\) 1 have already run/);
  assert.match(log, /start a new slug/);
  assert.equal(existsSync(join(root, ".agents/reviews/x/round-0.prompt.md")), false, "and nothing was composed");
  drop(root);
});

test("a first scope exchange on an empty directory still runs", () => {
  const root = fixtureRoot();
  writeFileSync(join(root, "oracle.md"), "# The oracle\n\nBuild the thing.\n");
  assert.equal(runMain(root, ["--kind", "scope", "--slug", "x", "--oracle", "oracle.md", "--no-ledger"]).code, 0);
  drop(root);
});

test("the predecessor and the quoted assessment claim no authorship", () => {
  // Both lines are emitted to BOTH roles from the shared section, so neither
  // may say "your own" -- true for Astra, false for Claude (#124 round 7).
  const root = fixtureRoot({ plan: { path: "docs/plans/PLAN_X.md", text: PLAN } });
  seed(root, "x", { "concerns.json": [concern()], "round-1.md": "# One\n", "plan-round-1.md": PLAN });
  const prompt = promptOf(root, ["--kind", "assess", "--round", "2", "--tier", "internal", "--plan", "docs/plans/PLAN_X.md"]);
  assert.match(prompt, /the assessment from that exchange, in full/);
  assert.doesNotMatch(prompt, /your own assessment/i);
  drop(root);
});

// ── the standing prefix is the same bytes whatever the exchange is ─────────

test("the role block never asks for an assessment, and is identical across kinds", () => {
  // THE PROPERTY THAT DECIDES THE SHAPE of `4049965635`'s fix, so it is
  // asserted rather than asserted-about. The finding asked for a role block
  // conditional on `kind`; both assessors recommended against, because it is
  // the first bytes of `stablePrefix` and round 5 removed per-exchange
  // variation from it for exactly that reason. The contradiction is removable
  // by saying only what is true of every kind, and this test is what stops the
  // next fix reintroducing the variation.
  //
  // The narrow claim, not a ban on the WORD: "a disagreement that survives
  // investigation and discussion" is process language true of every exchange.
  // What must not appear is an instruction to PRODUCE an assessment, which is
  // what contradicted a discussion package.
  assert.doesNotMatch(roleBlock("astra"), /(?:return|produce|write)[^.]*\bassessment\b/i);

  const parts = { contract: "c", judgment: "j", oracle: "o", planPath: "docs/plans/PLAN_X.md", tier: "internal" };
  for (const role of ["astra", "claude"]) {
    assert.equal(
      stablePrefix({ ...parts, role, kind: "assess" }),
      stablePrefix({ ...parts, role, kind: "discuss" }),
      `${role}'s standing prefix is the same bytes whatever the exchange is`,
    );
  }
});

test("a lens belongs to an assessment, and a discussion refuses it", () => {
  // `--lens`'s own prose is "still read and assess the whole thing", which is
  // the instruction a focused discussion exists to avoid. USAGE documents it on
  // the assess line only; the parser took it anywhere, so the undocumented
  // combination shipped the contradiction. Removing the input beats branching
  // on it -- the question already carries the emphasis.
  const root = fixtureRoot({ plan: { path: "docs/plans/PLAN_X.md", text: PLAN } });
  seed(root, "x", { "concerns.json": [concern()], "round-1.md": "# One\n", "plan-round-1.md": PLAN });
  const { code, log } = runMain(root, ["--kind", "discuss", "--round", "1", "--discussion", "1",
    "--tier", "internal", "--plan", "docs/plans/PLAN_X.md", "--concerns", "C1", "--question", "q",
    "--lens", "failure modes"]);
  assert.equal(code, 1);
  assert.match(log, /--lens belongs to --kind assess/);
  assert.match(log, /Put the emphasis in --question/);
  drop(root);
});

test("a changed oracle belongs to an assessment, and a discussion refuses it", () => {
  // The second instance of the class the --lens refusal above closed, and the
  // worse one: --lens widened what the other party READ, --oracle-changed
  // changes what it MEASURES AGAINST while the package says the plan is
  // exactly what it last saw and everything unasked keeps its state. Nothing
  // would have told anyone -- `pin.changed` reaches the meta file and the
  // DRY-RUN log only, and the live completion log carries no oracle line.
  // (Codex, #124 round 13 `4050405459`; Astra recommended the refusal, the
  // Fable assessor reversed its own stop once I corrected the false log-line
  // premise I had given both of them.)
  const root = fixtureRoot({ plan: { path: "docs/plans/PLAN_X.md", text: PLAN } });
  const dir = seed(root, "x", { "concerns.json": [concern()], "round-1.md": "# One\n", "plan-round-1.md": PLAN });
  const pin = join(dir, "oracle.txt");
  writeFileSync(pin, `${ORACLE}\n`);
  const before = readFileSync(pin, "utf8");

  const { code, log } = runMain(root, ["--kind", "discuss", "--round", "1", "--discussion", "1",
    "--tier", "internal", "--plan", "docs/plans/PLAN_X.md", "--concerns", "C1", "--question", "q",
    "--oracle-changed", "David widened the scope"]);
  assert.equal(code, 1);
  assert.match(log, /--oracle-changed belongs to --kind assess/);
  assert.match(log, /--kind assess --round 2 --oracle-changed/, "the message must name the next round, or the caller loops");
  assert.equal(readFileSync(pin, "utf8"), before, "it refuses BEFORE pinOracle, so nothing is re-pinned");
  assert.equal(existsSync(join(dir, "round-1.discussion-1.prompt.md")), false, "and before any package is written");

  // The other half: an UNCHANGED oracle still discusses. Removing the input
  // would have cost a loop whose assessments took an external --oracle file.
  const ok = runMain(root, ["--kind", "discuss", "--round", "1", "--discussion", "1",
    "--tier", "internal", "--plan", "docs/plans/PLAN_X.md", "--concerns", "C1", "--question", "q",
    "--dry-run"]);
  assert.equal(ok.code, 0, ok.log);
  drop(root);
});

test("a discussion's emphasis heading does not tell it to assess", () => {
  const text = exchangeContext({ kind: "discuss", round: 1, discussion: 1, lens: null, concerns: [], question: "q" });
  assert.match(text, /none — answer the question asked/);
  assert.doesNotMatch(text, /assess evenly/, "that heading belongs to an assessment");
});

// ── a later assessment can read what settled an earlier concern ────────────

test("every assess and discuss package names the record directory and its convention", () => {
  // REPLACES THE ENUMERATION (#124 round 11 `4050124291`). Round 10 listed the
  // previous round's discussion files one by one; this round showed the list
  // misses older ones -- a concern settled in round 1's discussion is gone from
  // round 3's package once round 2 legitimately omits the settled concern.
  //
  // Completing the enumeration would have worked and kept the shape whose
  // correctness depends on listing every relevant file. Naming the directory
  // and the convention says one thing true at every corner, and closes the
  // scope reply (`round-0.md`) which no package ever named either.
  const root = fixtureRoot({ plan: { path: "docs/plans/PLAN_X.md", text: PLAN } });
  seed(root, "x", { "concerns.json": [concern()], "round-1.md": "# One\n", "plan-round-1.md": PLAN,
    "round-1.discussion-1.md": "# The reply that settled it\n",
    "round-2.md": "# Two\n", "plan-round-2.md": PLAN });

  const assess = promptOf(root, ["--kind", "assess", "--round", "3", "--tier", "internal",
    "--plan", "docs/plans/PLAN_X.md"]);
  assert.match(assess, /round-N\.discussion-M\.md/, "the convention, not a list of the files that exist");
  assert.match(assess, /round-0\.md/, "including the scope reply, which no package named before");
  assert.match(assess, /settled in one of the discussion files/);
  assert.doesNotMatch(assess, /The reply that settled it/, "named by convention, never inlined");
  // Round 2 ran no discussions, and the sentence is the same either way --
  // which is the property an enumeration could not have.
  assert.doesNotMatch(assess, /focused discussion 1 on that exchange/, "the enumeration is gone");

  const discuss = promptOf(root, ["--kind", "discuss", "--round", "2", "--discussion", "1",
    "--tier", "internal", "--plan", "docs/plans/PLAN_X.md", "--concerns", "C1", "--question", "q"]);
  assert.match(discuss, /round-N\.discussion-M\.md/, "a discussion package gets it too");
  drop(root);
});

test("a scope package does not point at a directory that holds nothing yet", () => {
  const root = fixtureRoot();
  writeFileSync(join(root, "oracle.md"), "# The oracle\n\nBuild the thing.\n");
  const { code, log } = runMain(root, ["--kind", "scope", "--slug", "x", "--tier", "internal",
    "--oracle", "oracle.md", "--no-ledger", "--prompt-only"]);
  assert.equal(code, 0);
  const prompt = readFileSync(join(root, ".agents/reviews/x/round-0.prompt.md"), "utf8");
  assert.doesNotMatch(prompt, /The whole record of this loop/, "there is no record yet");
  drop(root);
});

test("the record pointer names the resolved directory, not a placeholder", () => {
  // `4050265290`: the block emitted the literal `<slug>`. With an explicit
  // --slug differing from the plan filename, on a first assessment, nothing
  // else in the package names the directory -- the predecessor block only
  // exists from round 2, and a ledger `source` may be a person's name. A
  // pointer that names no path is not a pointer, and the value was already
  // computed at the call site.
  const root = fixtureRoot({ plan: { path: "docs/plans/PLAN_X.md", text: PLAN } });
  seed(root, "elsewhere", { "concerns.json": [concern()] });
  const prompt = promptOf(root, ["--kind", "assess", "--round", "1", "--tier", "internal",
    "--plan", "docs/plans/PLAN_X.md", "--slug", "elsewhere"]);
  assert.match(prompt, /\.agents\/reviews\/elsewhere\//, "the slug the operator chose, not the one the plan implies");
  assert.doesNotMatch(prompt, /<slug>/, "no placeholder survives into a composed package");
  assert.doesNotMatch(prompt, /reviews\/x\//, "and not the plan-derived slug");
  drop(root);
});

test("the discussion file is described as the reply, with its question beside it", () => {
  // Folded in with `4050265290` rather than earned: the canonical file is
  // promoted from `--output-last-message`, so it holds the reply alone and the
  // question stays in the `.prompt.md`. A recorded gap under David's lens
  // (#128) -- the reader recovers it from the directory it was just pointed
  // at -- corrected because it sits six lines from an edit already open.
  const root = fixtureRoot({ plan: { path: "docs/plans/PLAN_X.md", text: PLAN } });
  seed(root, "x", { "concerns.json": [concern()], "round-1.md": "# One\n", "plan-round-1.md": PLAN });
  const prompt = promptOf(root, ["--kind", "assess", "--round", "2", "--tier", "internal",
    "--plan", "docs/plans/PLAN_X.md"]);
  assert.match(prompt, /discussion-M\.prompt\.md/, "the question's actual home is named");
  assert.doesNotMatch(prompt, /a question and its answer/, "the false description is gone");
  drop(root);
});

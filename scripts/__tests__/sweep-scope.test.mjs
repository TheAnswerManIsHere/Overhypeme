// SYNCED FROM AI-Handbook — do not edit in a consumer repo. Local edits are overwritten by the next sync and their reasoning is lost; change the handbook instead.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { validateSpec, globToRegExp, payloadPrefix, scopeFiles, toRepoPath, partition, plan, assertWorkers, clearBriefs, parseArgs, ROOT_FILES, ALWAYS_IN_SCOPE } from "../sweep-scope.mjs";

const SPEC = {
  rule: "when a review loop stops",
  home: "docs/ai-context/working-modes.md#the-write-gate-rule-code-written-is-code-reviewed-david-2026-08-22",
  subShapes: [
    { id: "a", name: "a cap", example: "one triage" },
    { id: "b", name: "a write with no review after it", example: "fix, apply, continue" },
  ],
  notInClass: ["Past-tense history that names the retired rule as retired, with its replacement"],
  readInFull: ["docs/ai-context/working-modes.md", ".claude/agents/*.md"],
};

/** A throwaway git repo shaped like a payload; `consumer` puts it at the root, otherwise under core/. */
function fixture({ consumer = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "sweep-scope-"));
  const p = consumer ? "" : "core/";
  const files = {
    [`${p}.agents/core/claude-core.md`]: "a\nb\nc\n",
    [`${p}.agents/roles/review-proxy.md`]: "x\ny\n",
    [`${p}.claude/agents/fable-review-assessor.md`]: "one\n",
    [`${p}.agents/memory/note.md`]: "m\n",
    [`${p}docs/ai-context/working-modes.md`]: "# Modes\n\n#### The write-gate rule: code written is code reviewed (David, 2026-08-22)\n\n" + "w\n".repeat(46),
    [`${p}docs/ai-context/other.md`]: "o\n".repeat(10),
    [`${p}.claude/skills/bugfix/SKILL.md`]: "s\n".repeat(20),
    [`${p}scripts/tool.mjs`]: "// not markdown\n",
    "CLAUDE.md": "root\n",
    "AGENTS.md": "root\n",
    "README.md": "root\n",
    "docs/not-payload.md": "outside the payload\n",
  };
  for (const [f, body] of Object.entries(files)) {
    mkdirSync(join(root, f, ".."), { recursive: true });
    writeFileSync(join(root, f), body);
  }
  writeFileSync(join(root, "untracked.md"), "never added\n");
  const git = (...a) => execFileSync("git", a, { cwd: root, stdio: "pipe" });
  git("init", "-q");
  git("add", "--", ...Object.keys(files));
  return root;
}

test("a spec missing any of the four inputs refuses, naming the input", () => {
  assert.deepEqual(validateSpec(SPEC), []);
  assert.match(validateSpec({ ...SPEC, rule: "" }).join(), /rule/);
  assert.match(validateSpec({ ...SPEC, home: undefined }).join(), /home/);
  assert.match(validateSpec({ ...SPEC, subShapes: [SPEC.subShapes[0]] }).join(), /subShapes.*two or more/);
  assert.match(validateSpec({ ...SPEC, subShapes: [SPEC.subShapes[0], { ...SPEC.subShapes[1], id: "a" }] }).join(), /distinct/);
  assert.match(validateSpec({ ...SPEC, notInClass: [] }).join(), /notInClass/);
  assert.match(validateSpec({ ...SPEC, readInFull: "docs" }).join(), /readInFull/);
  assert.match(validateSpec("nope").join(), /object/);
});

test("globs: ** crosses directories, * does not", () => {
  assert.ok(globToRegExp(".claude/agents/*.md").test(".claude/agents/x.md"));
  assert.ok(!globToRegExp(".claude/agents/*.md").test(".claude/agents/deep/x.md"));
  assert.ok(globToRegExp(".claude/skills/**/*.md").test(".claude/skills/bugfix/SKILL.md"));
  assert.ok(globToRegExp("docs/ai-context/working-modes.md").test("docs/ai-context/working-modes.md"));
  assert.ok(!globToRegExp("docs/ai-context/working-modes.md").test("docs/ai-context/working-modesXmd"));
});

test("scope is git's tracked payload markdown plus the root files, and the directories a docs-shaped scope misses", () => {
  const root = fixture();
  assert.equal(payloadPrefix(root), "core/");
  const { files } = scopeFiles(root);
  for (const r of ROOT_FILES) assert.ok(files.includes(r), r);
  for (const d of ALWAYS_IN_SCOPE) assert.ok(files.some((f) => f.startsWith("core/" + d)), d);
  assert.ok(!files.includes("untracked.md"), "untracked files are not corpus");
  assert.ok(!files.includes("docs/not-payload.md"), "handbook-root docs outside the payload are not scope by default");
  assert.ok(!files.some((f) => f.endsWith(".mjs")), "prose only");
  assert.ok(scopeFiles(root, { include: ["docs/*.md"] }).files.includes("docs/not-payload.md"), "--include widens it");
  assert.throws(() => scopeFiles(root, { include: ["docs/proces/**"] }), /--include "docs\/proces\/\*\*" matches no tracked file/, "a mistyped include refuses");
  assert.throws(() => plan({ root, spec: SPEC, include: ["nope/*.md"] }), /matches no tracked file/);
});

test("a consumer has the payload at the root and needs no prefix", () => {
  const root = fixture({ consumer: true });
  assert.equal(payloadPrefix(root), "");
  assert.equal(toRepoPath("", "docs/ai-context/working-modes.md"), "docs/ai-context/working-modes.md");
  assert.equal(toRepoPath("core/", "docs/ai-context/working-modes.md"), "core/docs/ai-context/working-modes.md");
  assert.equal(toRepoPath("core/", "core/docs/x.md"), "core/docs/x.md", "already-prefixed stays");
  assert.equal(toRepoPath("core/", "CLAUDE.md"), "CLAUDE.md", "root files are never prefixed");
  const files = scopeFiles(root).files;
  assert.ok(files.includes(".agents/roles/review-proxy.md"));
  // The boundary is the payload's roots, never the prefix. A prefix test is
  // vacuously true at the root, so a consumer's whole product corpus came into
  // scope and fanned cold readers across it -- invisible here, because this
  // repository is almost entirely payload.
  assert.ok(!files.includes("docs/not-payload.md"), "a consumer's own docs stay out by default");
  assert.ok(scopeFiles(root, { include: ["docs/not-payload.md"] }).files.includes("docs/not-payload.md"), "--include still reaches them");
});

test("partition covers every file exactly once and keeps swept directories whole", () => {
  const files = ["a/1.md", "a/2.md", "b/1.md", "c/1.md", "full/x.md", "full/y.md"];
  const lines = { "a/1.md": 10, "a/2.md": 10, "b/1.md": 5, "c/1.md": 5, "full/x.md": 100, "full/y.md": 90 };
  const buckets = partition({ files, fullSet: new Set(["full/x.md", "full/y.md"]), lines }, 2);
  const seen = buckets.flatMap((b) => [...b.full, ...b.swept]).sort();
  assert.deepEqual(seen, [...files].sort());
  assert.deepEqual(buckets.map((b) => b.full), [["full/x.md"], ["full/y.md"]], "heaviest full reads spread first");
  const dirOf = (f) => f.split("/")[0];
  for (const b of buckets) for (const d of new Set(b.swept.map(dirOf))) {
    assert.ok(!buckets.some((o) => o !== b && o.swept.some((f) => dirOf(f) === d)), `directory ${d} split across workers`);
  }
  assert.deepEqual(partition({ files, fullSet: new Set(), lines }, 2), partition({ files, fullSet: new Set(), lines }, 2), "deterministic");
});

test("a readInFull glob may name an --include'd file outside the payload, as written", () => {
  const root = fixture();
  const spec = { ...SPEC, readInFull: [...SPEC.readInFull, "docs/not-payload.md"] };
  assert.throws(() => plan({ root, spec }), /matches no file/, "not in scope without --include");
  const r = plan({ root, spec, include: ["docs/*.md"] });
  assert.ok(r.fullSet.includes("docs/not-payload.md"), "matched repo-relative, not prefixed to core/");
  assert.ok(r.fullSet.includes("core/docs/ai-context/working-modes.md"), "payload-relative globs still prefix");
});

test("the CLI refuses an unknown flag, a valueless flag and a repeated flag, naming each", () => {
  assert.throws(() => parseArgs(["--spec", "s.json", "--incldue", "docs/**"]), /unknown flag --incldue/);
  assert.throws(() => parseArgs(["--spec", "s.json", "--workers"]), /--workers needs a value/);
  assert.throws(() => parseArgs(["--spec", "s.json", "--workers", "--out", "d"]), /--workers needs a value/);
  assert.throws(() => parseArgs(["--spec", "a", "--spec", "b"]), /--spec given twice/);
  assert.throws(() => parseArgs(["s.json"]), /unexpected argument/);
  assert.deepEqual(parseArgs(["--spec", "s.json", "--include", "a/*.md", "--include", "b/*.md", "--workers", "3", "--print-scope"]), { spec: "s.json", include: ["a/*.md", "b/*.md"], workers: "3", printScope: true });
});

test("--include reaches the whole tracked set, so the Markdown filter is a default and not a ceiling", () => {
  const root = fixture();
  // Agent-facing prose is not always in a .md -- a script can compose an
  // instruction in a string literal, and a sweep that cannot be pointed at it
  // would report the payload clean while that instruction sat outside it.
  const wide = scopeFiles(root, { include: ["core/scripts/*.mjs"] });
  assert.ok(wide.files.some((f) => f.endsWith(".mjs")), "an included non-Markdown file lands in scope");
  const plain = scopeFiles(root);
  assert.ok(!plain.files.some((f) => f.endsWith(".mjs")), "and never by default");
  assert.throws(() => scopeFiles(root, { include: ["core/scripts/nope.mjs"] }), /matches no tracked file/, "a zero-match include still refuses");
});

test("a home names a file AND a section; whether that section exists is the readers' job", () => {
  const root = fixture();
  // An anchorless home hands readers a file that may carry several live rules
  // -- the condition the sweep exists to detect, as its starting point.
  assert.throws(() => plan({ root, spec: { ...SPEC, home: "docs/ai-context/working-modes.md#" } }), /names no #section/);
  assert.throws(() => plan({ root, spec: { ...SPEC, home: "docs/ai-context/working-modes.md" } }), /names no #section/);
  assert.doesNotThrow(() => plan({ root, spec: SPEC }));
  // A WRONG anchor is deliberately accepted here. Verifying it needed GitHub's
  // slug algorithm, Setext headings, inline rendering and fence tracking --
  // a third of the script, five of six review rounds on #141, two regressions
  // of its own -- to re-check something step 1 of the skill already does:
  // read the home section first. Four cold readers open it within minutes.
  assert.doesNotThrow(
    () => plan({ root, spec: { ...SPEC, home: "docs/ai-context/working-modes.md#no-such-section" } }),
    "a nonexistent section is the readers' finding, not the script's",
  );
});

test("a worker count below two, non-integer or non-numeric refuses, naming the value", () => {
  for (const bad of [1, 0, -3, 2.5, "abc", "", NaN]) {
    assert.throws(() => assertWorkers(bad), /at least 2/, String(bad));
    assert.throws(() => plan({ root: fixture(), spec: SPEC, workers: bad }), /at least 2/, String(bad));
  }
  assert.equal(assertWorkers("4"), 4, "a numeric string from argv is fine");
});

test("a rerun with fewer workers leaves no stale brief behind", () => {
  const dir = mkdtempSync(join(tmpdir(), "sweep-out-"));
  for (const n of [1, 2, 3, 4]) writeFileSync(join(dir, `worker-${n}.md`), "old");
  writeFileSync(join(dir, "inventory.json"), "{}");
  writeFileSync(join(dir, "notes.md"), "mine");
  clearBriefs(dir);
  assert.deepEqual(readdirSync(dir).sort(), ["inventory.json", "notes.md"], "only the script's own worker-N.md files are removed");
});

test("plan refuses a home outside scope and a readInFull glob that matches nothing", () => {
  const root = fixture();
  assert.throws(() => plan({ root, spec: { ...SPEC, home: "docs/ai-context/missing.md" } }), /home .*not a tracked/);
  assert.throws(() => plan({ root, spec: { ...SPEC, readInFull: ["docs/ai-context/typo-*.md"] } }), /matches no file/);
  assert.throws(() => plan({ root, spec: { ...SPEC, notInClass: [] } }), /spec refused/);
});

test("plan reads the home in full, maps payload-relative globs, and writes one brief per worker carrying the whole spec", () => {
  const root = fixture();
  const r = plan({ root, spec: SPEC, workers: 3 });
  assert.equal(r.homeFile, "core/docs/ai-context/working-modes.md");
  assert.ok(r.fullSet.includes("core/docs/ai-context/working-modes.md"));
  assert.ok(r.fullSet.includes("core/.claude/agents/fable-review-assessor.md"), "a payload-relative glob reaches core/");
  assert.equal(r.briefs.length, 3);
  const all = r.buckets.flatMap((b) => [...b.full, ...b.swept]).sort();
  assert.deepEqual(all, [...r.files].sort(), "every in-scope file is assigned to exactly one worker");
  for (const brief of r.briefs) {
    assert.ok(brief.includes(SPEC.rule));
    assert.ok(brief.includes("`core/docs/ai-context/working-modes.md#the-write-gate-rule-code-written-is-code-reviewed-david-2026-08-22`"), "home is named, repo-relative, anchor kept");
    for (const s of SPEC.subShapes) assert.ok(brief.includes(`| **${s.id}** | ${s.name} | \`${s.example}\` |`), s.id);
    for (const x of SPEC.notInClass) assert.ok(brief.includes(x));
    assert.match(brief, /does\s+it cite the home section and agree with it\?/, "the structural test, as the doc states it");
    assert.match(brief, /uncited or\s+disagrees/, "residue is uncited or disagreeing, never a cited agreeing gloss");
    assert.match(brief, /cites the home and agrees is a\s+citation with context and is NOT a hit/, "cited restatements are not returned");
    // The two worst hits of the 2026-09-20 run cited the right FILE and named
    // the wrong rule inside it; a file-level test exempts exactly those.
    assert.match(brief, /including elsewhere in the home's own file/, "the test reaches other sections of the home file");
    assert.match(brief, /Citing the right file is not enough/, "section-level, not file-level");
    assert.ok(brief.includes("OPENED: n / READ IN FULL: n / SWEPT: n"), "the inventory declaration");
    assert.ok(brief.includes("Declined candidates"), "declined list is mandatory");
    assert.ok(/`high` \| `medium` \| `low`/.test(brief), "confidence survives to the report");
    assert.ok(brief.includes("Do not edit any file"));
  }
  const fullMentions = r.briefs.join("\n").match(/— read in full$/gm) ?? [];
  assert.equal(fullMentions.length, r.fullSet.length, "each full-read file is listed on exactly one brief");
});

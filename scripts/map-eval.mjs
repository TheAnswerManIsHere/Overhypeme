#!/usr/bin/env node
// SYNCED FROM AI-Handbook — do not edit in a consumer repo. Local edits are overwritten by the next sync and their reasoning is lost; change the handbook instead.
// map-eval.mjs — the eval that decides whether the map earns its keep.
//
// Protocol: docs/ai-context/agent-legible-codebase-eval.md. This script does
// the four mechanical parts of it and nothing else:
//
//   node scripts/map-eval.mjs keys                  build answer keys for .agents/map/eval-tasks.json
//   node scripts/map-eval.mjs prompts --out <dir>   one prompt per task: the question, never the answer
//   node scripts/map-eval.mjs prepare --ref <ref> --out <dir>
//                                                   a worktree at <ref> with all grading material removed
//   node scripts/map-eval.mjs score --runs <file>   recall, precision, tokens per arm and tier, and the verdict
//
// INDEPENDENCE IS THE WHOLE POINT. An answer key built by the tool under test
// grades the tool against itself. So this shares no module with map.mjs and
// never reads the map's index: a symbol's key comes from the compiler's own
// reference finder (the language service), and a relation's key from every
// compiler-parsed string and template literal carrying the relation's name.
// Compiler diagnostics are never the key — a removed export errors only at
// the barrel that re-exports it while its real callers stay silent. Every key
// is written unverified, and `score` refuses until a person has checked each
// one and set "verified": true.

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const MAP_DIR = ".agents/map";
const TASKS = `${MAP_DIR}/eval-tasks.json`;
const KEYS = `${MAP_DIR}/eval-keys.json`;
const RESULTS_DIR = `${MAP_DIR}/eval-results`;
/** What a worktree handed to an evaluated agent must never contain. */
export const GRADING_MATERIAL = [TASKS, KEYS, RESULTS_DIR];

/**
 * The pre-registered thresholds (docs/ai-context/agent-legible-codebase-eval.md).
 * Written before the first run; changing them after a run has been seen is
 * the one edit to this file that would invalidate the eval.
 */
export const THRESHOLDS = {
  keep: { minHiddenRecallGainPoints: 20, maxMedianTokenIncreasePct: 10 },
  disable: { belowHiddenRecallGainPoints: 10, aboveMedianTokenIncreasePct: 25 },
};

/** The protocol's matrix: every task, in both arms, run under this many distinct seeds. */
export const ARMS = ["A", "B"];
export const SEEDS_PER_TASK_PER_ARM = 2;

// ── pure functions (unit-tested on bare Node) ──────────────────────────────

/**
 * Everything wrong with a runs file, as readable lines; empty means it is the
 * complete matrix and may be scored. The runs are assembled by an agent from
 * many dispatches, so a missing, duplicated or malformed record is the normal
 * failure, and a verdict computed over one would decide nothing.
 */
export function runProblems(runs, tasks) {
  if (!Array.isArray(runs)) return ["the runs file is not a JSON array"];
  const ids = new Set(tasks.map((t) => t.id));
  const problems = [];
  const seen = new Map();
  runs.forEach((r, i) => {
    const at = `run ${i + 1}`;
    if (!r || typeof r !== "object") { problems.push(`${at}: not an object`); return; }
    if (!ids.has(r.task)) problems.push(`${at}: unknown task ${JSON.stringify(r.task)}`);
    if (!ARMS.includes(r.arm)) problems.push(`${at}: unknown arm ${JSON.stringify(r.arm)} (expected A or B)`);
    if (r.seed === undefined || r.seed === null || r.seed === "") problems.push(`${at}: no seed`);
    if (!Array.isArray(r.files)) problems.push(`${at}: files is not an array`);
    if (typeof r.tokens !== "number" || !Number.isFinite(r.tokens) || r.tokens < 0) problems.push(`${at}: tokens is not a measured number`);
    const k = `${r.task} / ${r.arm} / seed ${JSON.stringify(r.seed)}`;
    if (seen.has(k)) problems.push(`${at}: duplicates run ${seen.get(k)} (${k})`);
    else seen.set(k, i + 1);
  });
  for (const t of tasks) {
    for (const arm of ARMS) {
      const seeds = new Set(runs.filter((r) => r && r.task === t.id && r.arm === arm).map((r) => JSON.stringify(r.seed)));
      if (seeds.size !== SEEDS_PER_TASK_PER_ARM) problems.push(`${t.id} / ${arm}: ${seeds.size} distinct seed(s), the protocol needs ${SEEDS_PER_TASK_PER_ARM}`);
    }
  }
  return problems;
}

export function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Recall and precision of one answer against one key. */
export function scoreAnswer(answer, key) {
  const a = new Set(answer.map(normalizePath)), k = new Set(key.map(normalizePath));
  const hit = [...a].filter((x) => k.has(x)).length;
  return { recall: k.size ? hit / k.size : a.size ? 0 : 1, precision: a.size ? hit / a.size : k.size ? 0 : 1 };
}

export function normalizePath(p) {
  return String(p).trim().replace(/^\.\//, "").replace(/:\d+(:\d+)?$/, "");
}

/** The verdict the thresholds give, from per-arm summaries. */
export function verdict(a, b, t = THRESHOLDS) {
  const gain = (a.hidden.recall - b.hidden.recall) * 100;
  const tokenPct = b.medianTokens ? ((a.medianTokens - b.medianTokens) / b.medianTokens) * 100 : 0;
  let decision;
  if (gain >= t.keep.minHiddenRecallGainPoints && tokenPct <= t.keep.maxMedianTokenIncreasePct) decision = "keep";
  else if (gain < t.disable.belowHiddenRecallGainPoints || tokenPct > t.disable.aboveMedianTokenIncreasePct) decision = "disable";
  else decision = "david";
  return { decision, hiddenRecallGainPoints: Math.round(gain * 10) / 10, medianTokenChangePct: Math.round(tokenPct * 10) / 10 };
}

/** Per-arm, per-tier means and the arm's median tokens. */
export function summarize(runs, tasks, keys) {
  const tierOf = new Map(tasks.map((t) => [t.id, t.tier]));
  const out = {};
  for (const r of runs) {
    const key = keys[r.task];
    if (!key) throw new Error(`run for task ${r.task} has no answer key`);
    const s = scoreAnswer(r.files || [], key.files);
    const arm = (out[r.arm] ||= { tokens: [], tiers: {} });
    const tier = (arm.tiers[tierOf.get(r.task)] ||= { recall: [], precision: [] });
    tier.recall.push(s.recall);
    tier.precision.push(s.precision);
    if (typeof r.tokens === "number") arm.tokens.push(r.tokens);
  }
  const mean = (xs) => (xs.length ? xs.reduce((x, y) => x + y, 0) / xs.length : 0);
  const res = {};
  for (const [arm, v] of Object.entries(out)) {
    res[arm] = { medianTokens: median(v.tokens) };
    for (const tier of ["keyword", "structural", "hidden"]) {
      const t = v.tiers[tier] || { recall: [], precision: [] };
      res[arm][tier] = { recall: mean(t.recall), precision: mean(t.precision), n: t.recall.length };
    }
  }
  return res;
}

/** Relation token as a pattern: `stripe.products` matches `"stripe"."products"` too. */
export function relationPattern(name) {
  const parts = name.toLowerCase().split(".").map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`(^|[^\\w.$])"?${parts.join(`"?\\s*\\.\\s*"?`)}"?(?![\\w$])`, "i");
}

export function looksLikeSql(text) {
  // A statement, not a sentence: an upper-case keyword, or a lower-case one in
  // a shape prose does not take ("select id from", "insert into", "update x set").
  const statement =
    /\b(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|TRUNCATE|WITH)\b/.test(text) ||
    /\bselect\s+(?:\*|distinct\b|count\s*\(|[\w."]+(?:\s*,|\s+from\b))/i.test(text) ||
    /\b(?:insert\s+into|delete\s+from|create\s+table|alter\s+table|truncate\s+(?:table\s+)?[\w."]+|update\s+[\w."]+\s+set)\b/i.test(text);
  return statement && /\b(from|into|table|set|join)\b/i.test(text);
}

// ── compiler side ──────────────────────────────────────────────────────────

function fail(msg, fix) {
  const e = new Error(`${msg}\n  fix: ${fix}\n  why: docs/ai-context/agent-legible-codebase-eval.md`);
  e.exit = 1;
  throw e;
}

function repoRoot(cwd) {
  try { return realpathSync(execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" }).trim()); }
  catch { fail(`${cwd} is not inside a git checkout`, "run from inside the repository, or pass --root"); }
}

function listFiles(root) {
  return execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, maxBuffer: 1 << 28 })
    .toString("utf8").split("\0").filter(Boolean).filter((f) => existsSync(join(root, f)));
}

function globRe(glob) {
  let re = "";
  for (let i = 0; i < glob.length; ) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") { if (glob[i + 2] === "/") { re += "(?:.*/)?"; i += 3; } else { re += ".*"; i += 2; } }
    else if (c === "*") { re += "[^/]*"; i++; }
    else if (c === "?") { re += "[^/]"; i++; }
    else if (c === "{" && glob.indexOf("}", i) > i) { const e = glob.indexOf("}", i); re += "(?:" + glob.slice(i + 1, e).split(",").map((x) => x.replace(/[.+^$()|[\]\\]/g, "\\$&")).join("|") + ")"; i = e + 1; }
    else { re += c.replace(/[.+^$()|[\]\\]/g, "\\$&"); i++; }
  }
  return new RegExp("^" + re + "$");
}

/** The repository's own compiler, by the same rule as map.mjs, implemented separately. */
function loadCompiler(root, cfg) {
  const dirs = [root];
  for (const p of cfg.programs || []) {
    const f = p.tsconfig || p.extends;
    if (!f) continue;
    let d = dirname(join(root, f));
    while (d.startsWith(root) && d !== root) { dirs.push(d); d = dirname(d); }
  }
  for (const d of dirs) {
    const entry = join(d, "node_modules", "typescript");
    try { lstatSync(entry); } catch { continue; }
    let real;
    try { real = realpathSync(entry); } catch { continue; }
    if (existsSync(join(real, "package.json"))) return createRequire(import.meta.url)(real);
  }
  fail("this repository has no local TypeScript compiler (node_modules/typescript)", "install the repository's dependencies; an ambient compiler is never used");
}

/** One language service per declared program. */
function services(ts, root, cfg) {
  const files = listFiles(root);
  const parse = (rel) => ts.getParsedCommandLineOfConfigFile(join(root, rel), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} });
  const out = [];
  for (const p of cfg.programs || []) {
    let rootNames, options;
    if (p.tsconfig) { const c = parse(p.tsconfig); rootNames = c.fileNames; options = c.options; }
    else {
      const base = p.extends ? parse(p.extends).options : {
        allowJs: true, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, target: ts.ScriptTarget.ES2022, allowImportingTsExtensions: true,
      };
      options = { ...base, ...ts.convertCompilerOptionsFromJson(p.compilerOptions || {}, root).options };
      const res = (p.roots || []).map(globRe);
      rootNames = files.filter((f) => res.some((r) => r.test(f))).map((f) => join(root, f));
    }
    options = { ...options, noEmit: true, skipLibCheck: true };
    const versions = new Map();
    const host = {
      getScriptFileNames: () => rootNames,
      getScriptVersion: (f) => versions.get(f) || "0",
      getScriptSnapshot: (f) => (existsSync(f) ? ts.ScriptSnapshot.fromString(readFileSync(f, "utf8")) : undefined),
      getCurrentDirectory: () => root,
      getCompilationSettings: () => options,
      getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
      fileExists: ts.sys.fileExists, readFile: ts.sys.readFile, readDirectory: ts.sys.readDirectory,
      directoryExists: ts.sys.directoryExists, getDirectories: ts.sys.getDirectories, realpath: ts.sys.realpath,
    };
    out.push({ name: p.name || p.tsconfig || "supplementary", ls: ts.createLanguageService(host, ts.createDocumentRegistry()) });
  }
  return out;
}

function relOf(root, fileName) {
  let real = fileName;
  try { real = realpathSync(fileName); } catch {}
  if (!real.startsWith(root + sep)) return null;
  const r = real.slice(root.length + 1).split(sep).join("/");
  return r.split("/").includes("node_modules") ? null : r;
}

/** Files referencing a declaration, by the compiler's reference finder. */
function symbolKey(ts, root, svcs, ref) {
  const [file, name] = ref.split("#");
  const abs = join(root, file);
  const files = new Set();
  let found = false;
  for (const { ls } of svcs) {
    const program = ls.getProgram();
    const sf = program.getSourceFiles().find((s) => relOf(root, s.fileName) === file);
    if (!sf) continue;
    const checker = program.getTypeChecker();
    const mod = checker.getSymbolAtLocation(sf);
    const sym = mod && checker.getExportsOfModule(mod).find((e) => e.name === name);
    const decl = sym?.declarations?.find((d) => d.getSourceFile() === sf);
    if (!decl) continue;
    found = true;
    const pos = (decl.name ?? decl).getStart(sf);
    for (const group of ls.findReferences(sf.fileName, pos) || []) {
      for (const r of group.references) {
        const rel = relOf(root, r.fileName);
        if (rel && rel !== file) files.add(rel);
      }
    }
  }
  if (!found) fail(`no declared program exports ${name} from ${file}`, `correct the task's target.ref in ${TASKS}, or add a program that reaches ${abs}`);
  return [...files].sort();
}

/** Files whose string or template literals carry the relation's name. */
function relationKey(ts, root, svcs, name) {
  const re = relationPattern(name);
  const sql = new Set(), incidental = new Set();
  const seen = new Set();
  for (const { ls } of svcs) {
    for (const sf of ls.getProgram().getSourceFiles()) {
      const rel = relOf(root, sf.fileName);
      if (!rel || seen.has(rel)) continue;
      seen.add(rel);
      const visit = (n) => {
        let text = null;
        if (ts.isStringLiteralLike(n)) text = n.text;
        else if (ts.isTemplateExpression(n)) text = [n.head.text, ...n.templateSpans.map((s) => " " + s.literal.text)].join("");
        if (text !== null && re.test(text)) (looksLikeSql(text) ? sql : incidental).add(rel);
        if (ts.isTemplateExpression(n)) n.templateSpans.forEach((s) => visit(s.expression));
        else ts.forEachChild(n, visit);
      };
      visit(sf);
    }
  }
  for (const f of sql) incidental.delete(f);
  return { files: [...sql].sort(), incidental: [...incidental].sort() };
}

function readJson(root, rel) {
  const p = join(root, rel);
  if (!existsSync(p)) fail(`${rel} is missing`, "run the handbook sync to seed it, then complete it");
  return JSON.parse(readFileSync(p, "utf8"));
}

function cmdKeys(root, log) {
  const cfg = readJson(root, `${MAP_DIR}/config.json`);
  const { tasks } = readJson(root, TASKS);
  if (!tasks.length) fail(`${TASKS} holds no tasks`, "write the question set first (protocol: thirty tasks, ten per tier)");
  const ts = loadCompiler(root, cfg);
  const svcs = services(ts, root, cfg);
  const prior = existsSync(join(root, KEYS)) ? JSON.parse(readFileSync(join(root, KEYS), "utf8")) : {};
  const keys = {};
  for (const t of tasks) {
    let entry;
    if (t.target.kind === "symbol") entry = { files: symbolKey(ts, root, svcs, t.target.ref), method: "language-service findReferences" };
    else if (t.target.kind === "relation") {
      const r = relationKey(ts, root, svcs, t.target.name);
      const typed = t.target.symbol ? symbolKey(ts, root, svcs, t.target.symbol) : [];
      entry = { files: [...new Set([...r.files, ...typed])].sort(), incidental: r.incidental, method: `SQL-like literals carrying the name${t.target.symbol ? " + findReferences on the table symbol" : ""}` };
    } else entry = { files: [...(t.target.files || [])].sort(), method: "authored with the task" };
    const same = prior[t.id] && JSON.stringify(prior[t.id].files) === JSON.stringify(entry.files);
    keys[t.id] = { ...entry, verified: same ? !!prior[t.id].verified : false };
    log(`  ${t.id} (${t.tier}): ${entry.files.length} file(s)${keys[t.id].verified ? ", still verified" : ", NEEDS VERIFICATION"}`);
  }
  writeFileSync(join(root, KEYS), JSON.stringify(keys, null, 2) + "\n");
  log(`wrote ${KEYS}: check each key by hand, remove a file that is not a real answer, add one that is, and set "verified": true`);
  return 0;
}

function cmdPrompts(root, out, log) {
  const { tasks } = readJson(root, TASKS);
  mkdirSync(out, { recursive: true });
  for (const t of tasks) {
    writeFileSync(join(out, `${t.id}.txt`),
      `${t.question}\n\nAnswer with a JSON array of repository-relative file paths and nothing else. ` +
      `List every file that answers the question; do not list files that do not.\n`);
  }
  log(`wrote ${tasks.length} prompt(s) to ${out}; none carries an answer`);
  return 0;
}

function cmdPrepare(root, ref, out, log) {
  if (!ref || !out) fail("prepare needs --ref <git-ref> and --out <dir>", "for example: prepare --ref <pre-adoption-sha> --out ../eval-arm-b");
  const dest = resolve(out);
  if (existsSync(dest)) fail(`${dest} already exists`, "choose a fresh directory for each run");
  // The run repository shares nothing with this one: the tree at <ref> is
  // exported, the grading material is removed, and a fresh repository is made
  // with one commit. A linked worktree would share this repository's objects,
  // so `git show HEAD:<keys>` or a `git diff` would hand the answers to arm A.
  // Both arms get the same shape, so ordinary git inspection reveals nothing.
  mkdirSync(dest, { recursive: true });
  const tar = execFileSync("git", ["archive", "--format=tar", ref], { cwd: root, maxBuffer: 1 << 30 });
  execFileSync("tar", ["-x", "-C", dest], { input: tar, maxBuffer: 1 << 30 });
  const removed = [];
  for (const g of GRADING_MATERIAL) {
    if (existsSync(join(dest, g))) { rmSync(join(dest, g), { recursive: true, force: true }); removed.push(g); }
  }
  const git = (...a) => execFileSync("git", a, { cwd: dest, stdio: ["ignore", "ignore", "pipe"] });
  git("init", "-q");
  git("add", "-A");
  git("-c", "user.name=eval", "-c", "user.email=eval@localhost", "commit", "-q", "--no-gpg-sign", "-m", "eval run snapshot");
  log(`prepared ${dest} from ${ref} as a fresh one-commit repository; grading material excluded: ${removed.length ? removed.join(", ") : "none present"}`);
  return 0;
}

function cmdScore(root, runsFile, log) {
  if (!runsFile) fail("score needs --runs <file>", "the runs file is a JSON array of {task, arm, seed, files, tokens, toolCalls, seconds}");
  const { tasks } = readJson(root, TASKS);
  const keys = readJson(root, KEYS);
  const unverified = tasks.filter((t) => !keys[t.id]?.verified).map((t) => t.id);
  if (unverified.length) fail(`answer keys not yet verified by hand: ${unverified.join(", ")}`, `check each in ${KEYS} and set "verified": true`);
  const runs = JSON.parse(readFileSync(resolve(runsFile), "utf8"));
  const problems = runProblems(runs, tasks);
  if (problems.length) {
    fail(`the runs file is not the complete matrix, so no verdict is given:\n    ${problems.slice(0, 40).join("\n    ")}${problems.length > 40 ? `\n    … and ${problems.length - 40} more` : ""}`,
      `record exactly ${SEEDS_PER_TASK_PER_ARM} seeds per task per arm (A and B), each with files and tokens, and score again`);
  }
  const s = summarize(runs, tasks, keys);
  const v = verdict(s.A, s.B);
  log(JSON.stringify({ summary: s, verdict: v, thresholds: THRESHOLDS }, null, 2));
  mkdirSync(join(root, RESULTS_DIR), { recursive: true });
  return 0;
}

export function run(argv, { log = console.log, err = console.error, cwd = process.cwd() } = {}) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      // Every flag takes a value; a bare or empty one is refused rather than
      // read as absent, so --root "$UNSET" never falls back to the current checkout.
      const v = argv[i + 1];
      if (v === undefined || v === "" || v.startsWith("--")) { err(`${argv[i]} needs a value`); return 2; }
      flags[argv[i].slice(2)] = v;
      i++;
    } else pos.push(argv[i]);
  }
  try {
    const root = repoRoot("root" in flags ? resolve(cwd, flags.root) : cwd);
    switch (pos[0]) {
      case "keys": return cmdKeys(root, log);
      case "prompts": return cmdPrompts(root, resolve(flags.out || "eval-prompts"), log);
      case "prepare": return cmdPrepare(root, flags.ref, flags.out, log);
      case "score": return cmdScore(root, flags.runs, log);
      default:
        err("usage: node scripts/map-eval.mjs <keys|prompts --out <dir>|prepare --ref <ref> --out <dir>|score --runs <file>> [--root <dir>]");
        return 2;
    }
  } catch (e) {
    if (e.exit) { err(e.message); return e.exit; }
    throw e;
  }
}

function main() {
  process.exitCode = run(process.argv.slice(2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

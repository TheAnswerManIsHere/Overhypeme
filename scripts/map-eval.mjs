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
// grades the tool against itself. So this shares no module with map.mjs, and
// no key is ever built from the map's index (`prepare` runs one map query in
// a run repository, only to prove arm A's tool answers there). A symbol's key
// comes from the compiler's own reference finder (the language service), and
// a relation's key from every compiler-parsed string and template literal
// carrying the relation's name.
// Compiler diagnostics are never the key — a removed export errors only at
// the barrel that re-exports it while its real callers stay silent. Every key
// is written unverified, and `score` refuses until a person has checked each
// one and set "verified": true.

import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
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

/** The protocol's task set: this many tasks in each tier, every id distinct. */
export const TIERS = ["keyword", "structural", "hidden"];
export const TASKS_PER_TIER = 10;

// ── pure functions (unit-tested on bare Node) ──────────────────────────────

/**
 * Everything wrong with a task set, as readable lines; empty means it is the
 * protocol's set. A repeated id silently merges two questions (one key, one
 * prompt file, one row of the matrix), and a short tier is a different
 * experiment, so neither may reach a key or a verdict.
 */
export function taskProblems(tasks) {
  if (!Array.isArray(tasks)) return ["the task set is not a JSON array under \"tasks\""];
  const problems = [];
  const byId = new Map();
  tasks.forEach((t) => byId.set(t?.id, (byId.get(t?.id) || 0) + 1));
  const dup = [...byId].filter(([, n]) => n > 1).map(([id]) => JSON.stringify(id));
  if (dup.length) problems.push(`duplicate task id(s): ${dup.join(", ")}`);
  const unknown = tasks.filter((t) => !TIERS.includes(t?.tier)).map((t) => `${JSON.stringify(t?.id)} (tier ${JSON.stringify(t?.tier)})`);
  if (unknown.length) problems.push(`task(s) in no protocol tier: ${unknown.join(", ")}`);
  for (const tier of TIERS) {
    const ids = tasks.filter((t) => t?.tier === tier).map((t) => t.id);
    if (ids.length !== TASKS_PER_TIER) problems.push(`tier ${tier}: ${ids.length} task(s), the protocol needs ${TASKS_PER_TIER}${ids.length ? ` (${ids.join(", ")})` : ""}`);
  }
  return problems;
}

/**
 * Whether a regenerated key keeps its verification: only when everything the
 * person verifying was shown is unchanged, the answer files and the incidental
 * list both. A new incidental candidate is exactly what they never reviewed.
 */
export function keepsVerification(prior, entry) {
  if (!prior?.verified) return false;
  const same = (a, b) => JSON.stringify(a || []) === JSON.stringify(b || []);
  return same(prior.files, entry.files) && same(prior.incidental, entry.incidental);
}

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

/**
 * A relation's whole name as a pattern, each part bare or double-quoted:
 * `stripe.products` matches `"stripe"."products"`. An unqualified name (or
 * one qualified by `public`, the default schema) also matches `public.facts`,
 * while another schema's relation of the same name, `tenant.facts`, and a
 * longer name, `user_facts`, stay distinct.
 */
export function relationPattern(name) {
  const esc = (p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const ident = (p) => `(?:"${esc(p)}"|${esc(p)})`;
  let parts = name.toLowerCase().split(".");
  if (parts.length === 2 && parts[0] === "public") parts = [parts[1]];
  const dot = "\\s*\\.\\s*";
  const body = parts.length === 1 ? `(?:${ident("public")}${dot})?${ident(parts[0])}` : parts.map(ident).join(dot);
  // Not inside a longer name, a quoted one, or after another qualifier's dot.
  return new RegExp(`(?<![\\w$"])(?<!\\.\\s*)${body}(?![\\w$])`, "i");
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
  requireTaskSet(tasks);
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
    keys[t.id] = { ...entry, verified: keepsVerification(prior[t.id], entry) };
    log(`  ${t.id} (${t.tier}): ${entry.files.length} file(s)${keys[t.id].verified ? ", still verified" : ", NEEDS VERIFICATION"}`);
  }
  writeFileSync(join(root, KEYS), JSON.stringify(keys, null, 2) + "\n");
  log(`wrote ${KEYS}: check each key by hand, remove a file that is not a real answer, add one that is, and set "verified": true`);
  return 0;
}

function requireTaskSet(tasks) {
  const problems = taskProblems(tasks);
  if (problems.length) {
    fail(`${TASKS} is not the protocol's task set:\n    ${problems.join("\n    ")}`,
      `give every task a distinct id and write exactly ${TASKS_PER_TIER} per tier (${TIERS.join(", ")})`);
  }
}

function cmdPrompts(root, out, log) {
  const { tasks } = readJson(root, TASKS);
  requireTaskSet(tasks);
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
  const refuse = (msg, fix) => { rmSync(dest, { recursive: true, force: true }); fail(msg, fix); };
  // The arm-A agent is measured using the map, so the map must run here with
  // no install inside the measured run: the run repository gets its own copy
  // of the source checkout's installed dependencies, and their directories
  // are excluded in this repository's own .git/info/exclude, so git shows nothing.
  const provided = provideDependencies(root, dest);
  mkdirSync(join(dest, ".git", "info"), { recursive: true });
  appendFileSync(join(dest, ".git", "info", "exclude"), provided.map((d) => `/${d}\n`).join(""));
  if (!provided.some((d) => existsSync(join(dest, d, "typescript", "package.json")))) {
    refuse(`no node_modules/typescript is reachable from ${root}, so the map could not run in the prepared repository`,
      "install the repository's dependencies in this checkout, then prepare again; the run itself never installs");
  }
  // Where the tree carries an index, a query must answer from it as it stands:
  // a different installed compiler would make arm A's every query refuse.
  if (existsSync(join(dest, MAP_DIR, "index.json")) && existsSync(join(dest, "scripts", "map.mjs"))) {
    const probe = spawnSync(process.execPath, [join("scripts", "map.mjs"), "unresolved", "table"], { cwd: dest, encoding: "utf8" });
    if (probe.status !== 0) {
      let named = "unknown";
      try { named = JSON.parse(readFileSync(join(dest, MAP_DIR, "index.json"), "utf8")).compiler; } catch {}
      refuse(`a map query in the prepared repository does not answer (exit ${probe.status}); the index at ${ref} was built with compiler ${named}:\n    ${(probe.stderr || probe.stdout).trim().split("\n").slice(0, 3).join("\n    ")}`,
        `install the dependencies ${ref} declares in this checkout, so the compiler matches the committed index, then prepare again`);
    }
  }
  log(`prepared ${dest} from ${ref} as a fresh one-commit repository; grading material excluded: ${removed.length ? removed.join(", ") : "none present"}; dependencies provided: ${provided.join(", ")}`);
  return 0;
}

/**
 * Give a run repository its own copy of the source checkout's installed
 * dependencies, with no path back into the source checkout, where the
 * grading material is committed. Each node_modules directory beside a
 * tracked package.json is materialised: directories are recreated, files
 * hard-linked (copied across filesystems), and every symlink re-pointed by
 * where it really resolves: into the source checkout, at the run
 * repository's own copy of that path (a workspace package, a package
 * manager's store, a self-link); anywhere else, at that place unchanged.
 * The walk never follows a symlink, so it cannot copy the source tree in.
 * Hard links share inodes; nothing in either arm writes into node_modules.
 */
function provideDependencies(root, dest) {
  const dirs = new Set([""]);
  for (const f of listFiles(dest)) {
    if (/(^|\/)package\.json$/.test(f) && !f.split("/").includes("node_modules")) dirs.add(f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : "");
  }
  const provided = [];
  for (const d of [...dirs].sort()) {
    const src = join(root, d, "node_modules");
    if (!existsSync(src)) continue;
    materialise(root, dest, src, join(dest, d, "node_modules"));
    provided.push(d ? `${d}/node_modules` : "node_modules");
  }
  return provided;
}

function materialise(root, dest, from, to) {
  const st = lstatSync(from);
  if (st.isSymbolicLink()) {
    let real;
    try { real = realpathSync(from); } catch { return; } // dangling: it reaches nothing
    const inSource = real === root || real.startsWith(root + sep);
    symlinkSync(inSource ? relative(dirname(to), join(dest, relative(root, real))) || "." : real, to);
  } else if (st.isDirectory()) {
    mkdirSync(to, { recursive: true });
    for (const e of readdirSync(from)) materialise(root, dest, join(from, e), join(to, e));
  } else if (st.isFile()) {
    try { linkSync(from, to); }
    catch (e) { if (e.code === "EXDEV" || e.code === "EPERM") copyFileSync(from, to); else throw e; }
  }
}

function cmdScore(root, runsFile, log) {
  if (!runsFile) fail("score needs --runs <file>", "the runs file is a JSON array of {task, arm, seed, files, tokens, toolCalls, seconds}");
  const { tasks } = readJson(root, TASKS);
  requireTaskSet(tasks);
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

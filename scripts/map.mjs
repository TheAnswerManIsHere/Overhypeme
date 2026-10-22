#!/usr/bin/env node
// SYNCED FROM AI-Handbook — do not edit in a consumer repo. Local edits are overwritten by the next sync and their reasoning is lost; change the handbook instead.
// map.mjs — the agent-legible codebase tool.
//
// Builds a structural index of this repository from its own TypeScript
// compiler, answers one-hop questions about it, and runs four guards over it
// (freshness, headers, dependency boundaries, file size) plus the adoption
// check. The contract — answer semantics, the supported-form matrix, the
// three file sets, the back-out switch — is
// docs/ai-context/agent-legible-codebase.md, and this file implements it.
//
//   node scripts/map.mjs build                 regenerate the index
//   node scripts/map.mjs check                 every guard; what CI runs
//   node scripts/map.mjs deps <file>           what this file imports
//   node scripts/map.mjs dependents <file>     modules that import this file
//   node scripts/map.mjs dependents <file#sym> sites in other files referencing that declaration
//   node scripts/map.mjs route <METHOD> <path> which handler owns a route
//   node scripts/map.mjs routes <file>         routes registered in a file
//   node scripts/map.mjs table <name>          where a table or relation is used
//   node scripts/map.mjs purpose <file>        the file's authored purpose line
//   node scripts/map.mjs subsystem <tag>       files carrying a subsystem tag
//   node scripts/map.mjs unresolved [kind]     every site that could not be resolved
//   node scripts/map.mjs freeze | ratchet      write or lower the size baseline
//
// Flags: --json, --allow-stale, --root <dir>.
// Exit codes: 0 ok, 1 a guard failed or the tool could not run, 2 usage,
// 3 the index is stale and the query refused.
//
// Dependency-free except for the compiler, which is ALWAYS the indexed
// repository's own (`node_modules/typescript` reached from the repository,
// followed through its symlink). Node's ambient lookup is never used: a
// global or shared compiler is a different compiler from the one the
// repository builds with, and an index built by it would describe a program
// nobody compiles.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const TOOL_VERSION = "map.mjs/2";
const DOC = "docs/ai-context/agent-legible-codebase.md";
const MAP_DIR = ".agents/map";
const CONFIG_FILES = {
  config: "config.json",
  subsystems: "subsystems.json",
  architecture: "architecture.json",
  sizeBaseline: "size-baseline.json",
};
const SCHEMA_FILE = "config.schema.json";
const LOCKFILES = ["pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lock", "bun.lockb", "npm-shrinkwrap.json"];
const EXPRESS_VERBS = new Set(["get", "post", "put", "patch", "delete", "all", "options", "head"]);

// ════════════════════════════════════════════════════════════════════════════
// Pure functions. Exported for the payload unit test, which runs on bare Node:
// nothing above the compiler section may need a compiler.
// ════════════════════════════════════════════════════════════════════════════

const escapeRe = (s) => s.replace(/[.+^$()|[\]\\]/g, "\\$&");

/**
 * A glob as a whole-path regular expression. Supports `**` (any number of
 * directories, including none), `*` and `?` within one segment, and `{a,b}`
 * alternatives of literal text. Paths are repository-relative with `/`.
 */
export function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; ) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") { re += "(?:.*/)?"; i += 3; } else { re += ".*"; i += 2; }
    } else if (c === "*") { re += "[^/]*"; i += 1; }
    else if (c === "?") { re += "[^/]"; i += 1; }
    else if (c === "{" && glob.indexOf("}", i) > i) {
      const end = glob.indexOf("}", i);
      re += "(?:" + glob.slice(i + 1, end).split(",").map(escapeRe).join("|") + ")";
      i = end + 1;
    } else { re += escapeRe(c); i += 1; }
  }
  return new RegExp("^" + re + "$");
}

const globCache = new Map();
export function matchesAny(path, globs = []) {
  for (const g of globs) {
    let re = globCache.get(g);
    if (!re) { re = globToRegExp(g); globCache.set(g, re); }
    if (re.test(path)) return true;
  }
  return false;
}

/**
 * The leading comment block of a file: its `@purpose` sentence, its
 * `@subsystem` tag, and the offset where the comment carrying them ends.
 * Only comments before the first line of code count; a shebang is skipped.
 */
export function parseHeader(text) {
  let i = 0;
  if (text.charCodeAt(0) === 0xfeff) i = 1;
  if (text.startsWith("#!", i)) { const nl = text.indexOf("\n", i); i = nl === -1 ? text.length : nl + 1; }
  let purpose = null, subsystem = null, headerEnd = 0;
  const ws = /\s*/y;
  for (;;) {
    ws.lastIndex = i; ws.exec(text); i = ws.lastIndex;
    let body, end;
    if (text.startsWith("//", i)) {
      const nl = text.indexOf("\n", i);
      end = nl === -1 ? text.length : nl;
      body = text.slice(i + 2, end);
    } else if (text.startsWith("/*", i)) {
      const close = text.indexOf("*/", i + 2);
      if (close === -1) break;
      end = close + 2;
      body = text.slice(i + 2, close);
    } else break;
    const p = /@purpose[ \t]+(.*?)[ \t]*(?=[ \t]@[a-z]|\*\/|$)/m.exec(body);
    const s = /@subsystem[ \t]+([A-Za-z0-9][\w.-]*)/.exec(body);
    if (p && purpose === null) { purpose = p[1].replace(/^\*\s*/, "").trim() || null; headerEnd = end; }
    if (s && subsystem === null) { subsystem = s[1]; headerEnd = end; }
    i = end;
  }
  return { purpose, subsystem, headerEnd };
}

/** Non-blank lines after the header comment: the size the ratchet governs. */
export function sizeAfterHeader(text, headerEnd = 0) {
  let n = 0;
  for (const line of text.slice(headerEnd).split("\n")) if (line.trim() !== "") n += 1;
  return n;
}

const SQL_STOP = new Set([
  "select", "set", "of", "skip", "nowait", "where", "lateral", "values", "on", "as", "using", "with",
  "and", "or", "not", "null", "true", "false", "default", "if", "exists", "only", "returning", "join",
]);

/**
 * Relation names in SQL text. `\u0000N\u0000` marks the Nth interpolated
 * expression; one in a relation position is returned in `exprs`, for the
 * caller to resolve (a Drizzle table object) or report as a dynamic target.
 */
export function relationsInSql(text) {
  const names = new Set();
  const exprs = [];
  const ident = String.raw`(?:"[^"]+"|[A-Za-z_][\w$]*|\u0000\d+\u0000)`;
  const re = new RegExp(
    String.raw`\b(from|join|into|update|truncate|table|references)\s+(?:only\s+)?(?:if\s+(?:not\s+)?exists\s+)?(${ident}(?:\s*\.\s*${ident})?)`,
    "gi",
  );
  // `CREATE [UNIQUE] INDEX [CONCURRENTLY] [IF NOT EXISTS] [name] ON [ONLY] rel`.
  // ON is read only after INDEX: in `JOIN x ON a = b` it introduces a
  // condition, and `a` is a column.
  const onIndex = new RegExp(
    String.raw`\bindex\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?(?:(?!on\b)${ident}(?:\s*\.\s*${ident})?\s+)?(on)\s+(?:only\s+)?(${ident}(?:\s*\.\s*${ident})?)`,
    "gi",
  );
  const matches = [...text.matchAll(re), ...[...text.matchAll(onIndex)].map((m) => Object.assign([m[0], m[1], m[2]], { index: m.index }))];
  for (const m of matches) {
    const kw = m[1].toLowerCase();
    const raw = m[2];
    const after = text.slice(m.index + m[0].length);
    if ((kw === "from" || kw === "join") && after.startsWith("(")) continue; // a function call: unnest(…)
    const before = text.slice(0, m.index);
    if (kw === "from" && /extract\s*\(\s*\w+\s*$/i.test(before)) continue; // EXTRACT(EPOCH FROM x)
    if (kw === "from" && /\bdistinct\s*$/i.test(before)) continue; // IS DISTINCT FROM x
    if (kw === "from" && /^\s*(revoke|grant)\b/i.test(text)) continue; // privilege syntax names roles
    const parts = raw.split(/\s*\.\s*/).map((p) => p.replace(/^"|"$/g, ""));
    const ph = parts.map((p) => /^\u0000(\d+)\u0000$/.exec(p));
    if (ph.some(Boolean)) {
      if (parts.length === 1) exprs.push(Number(ph[0][1]));
      else exprs.push(-1); // a schema or name computed at runtime
      continue;
    }
    const lower = parts.map((p) => p.toLowerCase());
    if (SQL_STOP.has(lower[lower.length - 1])) continue;
    if (lower.length === 2 && lower[0] === "public") names.add(lower[1]);
    else names.add(lower.join("."));
  }
  return { names: [...names].sort(), exprs };
}

/** Does this text read as SQL that touches a relation? */
export function looksLikeSql(text) {
  // A statement, not a sentence: an upper-case keyword, or a lower-case one in
  // a shape prose does not take ("select id from", "insert into", "update x set").
  const statement =
    /\b(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|TRUNCATE|WITH)\b/.test(text) ||
    /\bselect\s+(?:\*|distinct\b|count\s*\(|[\w."]+(?:\s*,|\s+from\b))/i.test(text) ||
    /\b(?:insert\s+into|delete\s+from|create\s+table|alter\s+table|truncate\s+(?:table\s+)?[\w."]+|update\s+[\w."]+\s+set)\b/i.test(text);
  return statement && (/\b(from|into|table|set|join|references)\b/i.test(text) || /\bindex\b[^;]*?\bon\b/i.test(text));
}

/** Join an Express mount prefix and a route path. */
export function joinPaths(prefix, path) {
  const p = (prefix || "").replace(/\/+$/, "");
  const s = !path || path === "/" ? "" : path.startsWith("/") ? path : "/" + path;
  const out = p + s;
  return out === "" ? "/" : out;
}

/**
 * Does a registered route match a queried path? A query equal to the
 * registered pattern matches; otherwise `:param` matches one segment, `*`
 * anything, `regex:` sources are tested, and `prefix:` matches a prefix.
 */
export function routeMatches(registered, query) {
  if (registered === query) return true;
  if (registered.startsWith("regex:")) {
    const m = /^regex:\/(.*)\/([a-z]*)$/s.exec(registered);
    try { return m ? new RegExp(m[1], m[2]).test(query) : false; } catch { return false; }
  }
  if (registered.startsWith("prefix:")) return query.startsWith(registered.slice("prefix:".length));
  if (registered.startsWith("suffix:")) return query.endsWith(registered.slice("suffix:".length));
  if (registered === "*") return true;
  let body = "";
  for (const seg of registered.split("/").filter((s, i) => i > 0 || s !== "")) {
    if (seg.startsWith(":") && seg.endsWith("?")) body += "(?:/[^/]+)?";
    else if (seg.startsWith(":")) body += "/[^/]+";
    else if (seg === "*") body += "(?:/.*)?";
    // Express 5 named wildcards: `*name` takes one or more segments, and the
    // braced `{*name}` makes them optional.
    else if (/^\{\*[A-Za-z_$][\w$]*\}$/.test(seg)) body += "(?:/.*)?";
    else if (/^\*[A-Za-z_$][\w$]*$/.test(seg)) body += "/.+";
    else body += "/" + escapeRe(seg).replace(/\*/g, ".*");
  }
  return new RegExp("^" + body + "/?$").test(query);
}

/** JSON with every object's keys sorted, so equal content is equal bytes. */
export function stableStringify(value, indent) {
  const norm = (v) => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === "object") {
      const o = {};
      for (const k of Object.keys(v).sort()) if (v[k] !== undefined) o[k] = norm(v[k]);
      return o;
    }
    return v;
  };
  return JSON.stringify(norm(value), null, indent);
}

/** The index as bytes: one top-level key per line, one file per line under `files`. */
export function serializeIndex(index) {
  const lines = ["{"];
  const keys = Object.keys(index).sort();
  keys.forEach((k, ki) => {
    const comma = ki < keys.length - 1 ? "," : "";
    if (k === "files") {
      const names = Object.keys(index.files).sort();
      lines.push(`"files": {`);
      names.forEach((n, ni) => lines.push(`${JSON.stringify(n)}: ${stableStringify(index.files[n])}${ni < names.length - 1 ? "," : ""}`));
      lines.push(`}${comma}`);
    } else {
      lines.push(`${JSON.stringify(k)}: ${stableStringify(index[k])}${comma}`);
    }
  });
  lines.push("}");
  return lines.join("\n") + "\n";
}

/**
 * A small JSON Schema validator covering what config.schema.json uses: type,
 * enum, const, required, properties, patternProperties, additionalProperties,
 * items, minimum, minLength, pattern, and local `$ref`.
 */
export function validateSchema(schema, value, root = schema, at = "$") {
  const errs = [];
  if (schema.$ref) {
    const target = schema.$ref.replace(/^#\//, "").split("/").reduce((o, k) => o?.[k], root);
    return target ? validateSchema(target, value, root, at) : [`${at}: unresolvable $ref ${schema.$ref}`];
  }
  const typeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);
  if (schema.type) {
    const want = [].concat(schema.type);
    const got = typeOf(value);
    if (!want.includes(got) && !(got === "integer" && want.includes("number"))) {
      return [`${at}: expected ${want.join(" or ")}, got ${got}`];
    }
  }
  if (schema.const !== undefined && value !== schema.const) errs.push(`${at}: must be ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) errs.push(`${at}: must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(", ")}`);
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) errs.push(`${at}: must not be empty`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errs.push(`${at}: must match ${schema.pattern}`);
  }
  if (typeof value === "number" && schema.minimum !== undefined && value < schema.minimum) errs.push(`${at}: must be at least ${schema.minimum}`);
  if (Array.isArray(value) && schema.items) value.forEach((v, i) => errs.push(...validateSchema(schema.items, v, root, `${at}[${i}]`)));
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const r of schema.required || []) if (!(r in value)) errs.push(`${at}: missing required key "${r}"`);
    for (const [k, v] of Object.entries(value)) {
      const where = `${at}.${k}`;
      if (schema.properties && k in schema.properties) { errs.push(...validateSchema(schema.properties[k], v, root, where)); continue; }
      const pat = Object.entries(schema.patternProperties || {}).find(([p]) => new RegExp(p).test(k));
      if (pat) { errs.push(...validateSchema(pat[1], v, root, where)); continue; }
      if (schema.additionalProperties === false) errs.push(`${where}: unknown key`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        errs.push(...validateSchema(schema.additionalProperties, v, root, where));
      }
    }
  }
  return errs;
}

/** Hand-written answers in three sections; `resolved` never prints alone. */
export function formatAnswer({ banners = [], title, resolved = [], unresolved = [], coverage = [] }) {
  const out = [...banners.map((b) => `!! ${b}`), title];
  out.push(`resolved (${resolved.length}):`);
  for (const r of resolved) out.push(`  ${r}`);
  if (!resolved.length) out.push("  (none found)");
  out.push(`unresolved (${unresolved.length}):`);
  for (const u of unresolved) out.push(`  ${u}`);
  if (!unresolved.length) out.push("  (none)");
  out.push("coverage:");
  for (const c of coverage) out.push(`  ${c}`);
  return out.join("\n");
}

/** The same header line the sync recognises, within the same window. */
const BANNER_LINE = /^[ \t]*(?:<!--|\/\/|#|"\$comment":[ \t]*")[ \t]*SYNCED FROM AI-Handbook\b/;
export function carriesSyncBanner(text) {
  return text.split("\n", 40).some((l) => BANNER_LINE.test(l));
}

/** The three sets, from the enumerated files and the configuration. */
export function computeSets(files, cfg, isSynced) {
  const inc = cfg.sets?.indexed?.include || [];
  const exc = cfg.sets?.indexed?.exclude || [];
  const indexed = files.filter((f) => matchesAny(f, inc) && !matchesAny(f, exc));
  const codegen = (cfg.codegenOwned || []).flatMap((c) => c.paths || []);
  const hExc = cfg.sets?.headered?.exclude || [];
  const headered = indexed.filter((f) => !f.endsWith(".d.ts") && !matchesAny(f, hExc) && !matchesAny(f, codegen) && !isSynced(f));
  const sExc = cfg.sets?.sized?.exclude || [];
  const sized = headered.filter((f) => !matchesAny(f, sExc));
  return { indexed, headered, sized, codegen };
}

/** Nearest paths to a mistyped one, for "not found" answers. */
export function nearest(query, candidates, n = 5) {
  const base = query.split("/").pop().replace(/\.[^.]+$/, "").toLowerCase();
  const scored = candidates
    .map((c) => {
      const cb = c.split("/").pop().replace(/\.[^.]+$/, "").toLowerCase();
      const s = cb === base ? 0 : cb.includes(base) || base.includes(cb) ? 1 : c.toLowerCase().includes(base) ? 2 : 9;
      return [s, c];
    })
    .filter(([s]) => s < 9)
    .sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1]));
  return scored.slice(0, n).map(([, c]) => c);
}

// ════════════════════════════════════════════════════════════════════════════
// Repository, configuration and failures.
// ════════════════════════════════════════════════════════════════════════════

class MapError extends Error {
  constructor(rule, summary, { files = [], fix, anchor, code = 1 } = {}) {
    super(summary);
    Object.assign(this, { rule, files, fix, anchor, code });
  }
}

/** One guard failure: the rule, the files, the fix, and where it is explained. */
function failure(rule, summary, files, fix, anchor) {
  return { rule, summary, files, fix, anchor };
}

function renderFailure(f) {
  const lines = [`✗ ${f.rule}: ${f.summary}`];
  const shown = f.files.slice(0, 50);
  for (const x of shown) lines.push(`    ${x}`);
  if (f.files.length > shown.length) lines.push(`    … and ${f.files.length - shown.length} more`);
  lines.push(`  fix: ${f.fix}`);
  lines.push(`  why: ${DOC}#${f.anchor}`);
  return lines.join("\n");
}

export function repoRoot(start) {
  try {
    return realpathSync(execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: start, encoding: "utf8" }).trim());
  } catch {
    throw new MapError("repository", `${start} is not inside a git checkout`, {
      fix: "run the tool from inside the repository, or pass --root <checkout>",
      anchor: "the-tool",
    });
  }
}

function listFiles(root) {
  const out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    maxBuffer: 1 << 28,
  }).toString("utf8");
  return [...new Set(out.split("\0").filter(Boolean))].filter((f) => existsSync(join(root, f))).sort();
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** The four configuration files, each parsed or carrying its error. */
function readConfigs(root) {
  const out = {};
  for (const [key, name] of Object.entries(CONFIG_FILES)) {
    const p = join(root, MAP_DIR, name);
    if (!existsSync(p)) { out[key] = { missing: true, path: `${MAP_DIR}/${name}` }; continue; }
    try { out[key] = { value: readJson(p), path: `${MAP_DIR}/${name}` }; }
    catch (e) { out[key] = { error: e.message, path: `${MAP_DIR}/${name}` }; }
  }
  return out;
}

function schemaFailures(root, cfgs) {
  const fails = [];
  const schemaPath = join(root, MAP_DIR, SCHEMA_FILE);
  if (!existsSync(schemaPath)) {
    return [failure("schema", "the configuration schema is missing", [`${MAP_DIR}/${SCHEMA_FILE}`],
      "run the handbook sync, which delivers it", "configuration")];
  }
  const schema = readJson(schemaPath);
  const defs = { config: "config", subsystems: "subsystems", architecture: "architecture", sizeBaseline: "sizeBaseline" };
  for (const [key, def] of Object.entries(defs)) {
    const c = cfgs[key];
    if (c.missing) { fails.push(failure("schema", `${c.path} is missing`, [c.path], "run the handbook sync to seed it, then complete it", "configuration")); continue; }
    if (c.error) { fails.push(failure("schema", `${c.path} is not valid JSON: ${c.error}`, [c.path], `repair the JSON in ${c.path}`, "configuration")); continue; }
    const errs = validateSchema({ $ref: `#/$defs/${def}` }, c.value, schema);
    if (errs.length) fails.push(failure("schema", `${c.path} does not match the schema`, errs, `edit ${c.path} so each line above holds (schema: ${MAP_DIR}/${SCHEMA_FILE})`, "configuration"));
  }
  return fails;
}

function adoptionFailure(cfgs) {
  const pending = Object.values(cfgs).filter((c) => c.value && c.value.adopted !== true).map((c) => c.path);
  if (!pending.length) return null;
  return failure(
    "adoption",
    "this repository has received the map tool but has not adopted it",
    pending,
    `complete each file listed, set "adopted": true in it, then run \`node scripts/map.mjs build\` — the steps are in docs/ai-context/agent-legible-codebase.md#adopting-the-tool`,
    "adopting-the-tool",
  );
}

/** The repository's own compiler entry, never an ambient one. */
export function findCompilerEntry(root, extraDirs = []) {
  const seen = new Set();
  for (const dir of [root, ...extraDirs]) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    const entry = join(dir, "node_modules", "typescript");
    try { lstatSync(entry); } catch { continue; }
    let real;
    try { real = realpathSync(entry); } catch { continue; }
    const pkg = join(real, "package.json");
    if (!existsSync(pkg)) continue;
    return { entry, real, version: readJson(pkg).version };
  }
  return null;
}

function programDirs(root, cfg) {
  const dirs = [];
  for (const p of cfg.programs || []) {
    const f = p.tsconfig || p.extends;
    if (!f) continue;
    let d = dirname(join(root, f));
    while (d.startsWith(root) && d !== root) { dirs.push(d); d = dirname(d); }
  }
  return dirs;
}

function loadCompiler(root, cfg) {
  const found = findCompilerEntry(root, programDirs(root, cfg));
  if (!found) {
    throw new MapError("compiler", "this repository has no local TypeScript compiler (node_modules/typescript)", {
      fix: "install the repository's dependencies (for example `pnpm install` or `npm install`) so node_modules/typescript exists; an ambient or global compiler is deliberately never used",
      anchor: "the-compiler",
    });
  }
  return { ts: createRequire(import.meta.url)(found.real), version: found.version };
}

function compilerVersion(root, cfg) {
  return findCompilerEntry(root, programDirs(root, cfg))?.version ?? "none";
}

const sha = (buf) => createHash("sha256").update(buf).digest("hex");

/** The digest over every input whose change could change the index. */
function digestOf(root, inputs, compiler) {
  const h = createHash("sha256");
  for (const p of [...new Set(inputs)].sort()) {
    const abs = join(root, p);
    h.update(`${p}\t${existsSync(abs) ? sha(readFileSync(abs)) : "MISSING"}\n`);
  }
  h.update(`compiler\t${compiler}\ntool\t${TOOL_VERSION}\n`);
  return h.digest("hex");
}

function standingInputs(root, files) {
  return [
    ...files.filter((f) => /(^|\/)tsconfig[^/]*\.json$/.test(f) || /(^|\/)package\.json$/.test(f)),
    ...LOCKFILES.filter((l) => existsSync(join(root, l))),
    ...Object.values(CONFIG_FILES).map((n) => `${MAP_DIR}/${n}`),
  ];
}

// ════════════════════════════════════════════════════════════════════════════
// The compiler-backed build.
// ════════════════════════════════════════════════════════════════════════════

const LIBRARIES = [
  ["express", /\/node_modules\/(?:@types\/express(?:-serve-static-core)?|express)\//],
  ["pg", /\/node_modules\/(?:@types\/pg|pg)\//],
  ["drizzle", /\/node_modules\/drizzle-orm\//],
  ["wouter", /\/node_modules\/wouter\//],
];

function libraryOfDecls(decls = []) {
  for (const d of decls) {
    const f = d.getSourceFile().fileName;
    for (const [name, re] of LIBRARIES) if (re.test(f)) return name;
  }
  return null;
}

function createPrograms(ts, root, cfg, files) {
  const programs = [];
  const parseConfig = (rel) => {
    const abs = join(root, rel);
    if (!existsSync(abs)) {
      throw new MapError("programs", `the program configuration ${rel} named in ${MAP_DIR}/config.json does not exist`, {
        fix: `correct "programs" in ${MAP_DIR}/config.json`, anchor: "configuration",
      });
    }
    const host = { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} };
    const parsed = ts.getParsedCommandLineOfConfigFile(abs, {}, host);
    if (!parsed) throw new MapError("programs", `${rel} could not be parsed`, { fix: `repair ${rel}`, anchor: "configuration" });
    return parsed;
  };
  for (const p of cfg.programs || []) {
    let rootNames, options, name;
    if (p.tsconfig) {
      const parsed = parseConfig(p.tsconfig);
      rootNames = parsed.fileNames;
      options = parsed.options;
      name = p.name || p.tsconfig;
    } else {
      const base = p.extends ? parseConfig(p.extends).options : {
        allowJs: true, checkJs: false, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
        target: ts.ScriptTarget.ES2022, skipLibCheck: true, allowImportingTsExtensions: true, resolveJsonModule: true,
      };
      const conv = ts.convertCompilerOptionsFromJson(p.compilerOptions || {}, root);
      options = { ...base, ...conv.options };
      rootNames = files.filter((f) => matchesAny(f, p.roots || [])).map((f) => join(root, f));
      name = p.name || "supplementary";
    }
    options = { ...options, noEmit: true, skipLibCheck: true };
    delete options.composite;
    delete options.incremental;
    delete options.tsBuildInfoFile;
    const program = ts.createProgram({ rootNames, options });
    programs.push({ name, program, checker: program.getTypeChecker(), roots: new Set(rootNames.map((r) => realOr(r))) });
  }
  return programs;
}

function realOr(p) {
  try { return realpathSync(p); } catch { return p; }
}

/** Everything the index holds about one file, read with one program's checker. */
function extractFile(ts, prog, sf, ctx) {
  const { checker } = prog;
  const rel = ctx.rel(sf.fileName);
  const text = sf.text;
  const hdr = parseHeader(text);
  const rec = {
    program: prog.name,
    purpose: hdr.purpose,
    subsystem: hdr.subsystem,
    size: sizeAfterHeader(text, hdr.headerEnd),
    exports: [],
    imports: [],
    external: [],
    refs: {},
    sql: [],
    unresolved: [],
  };
  const lineOf = (node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const resolveAlias = (sym) => {
    let s = sym;
    for (let i = 0; s && s.flags & ts.SymbolFlags.Alias && i < 10; i++) {
      try { s = checker.getAliasedSymbol(s); } catch { break; }
    }
    return s;
  };
  const symAt = (node) => {
    try { return checker.getSymbolAtLocation(node); } catch { return undefined; }
  };
  // Syntax that annotates an expression without changing it: `(x)`, `x as T`,
  // `x satisfies T`, `<T>x`. Recognition always looks through it.
  const isWrapper = (n) => ts.isParenthesizedExpression(n) || ts.isAsExpression(n) ||
    !!ts.isSatisfiesExpression?.(n) || !!ts.isTypeAssertionExpression?.(n);
  const unwrap = (n) => { while (n && isWrapper(n)) n = n.expression; return n; };

  // ── exports ──────────────────────────────────────────────────────────────
  const modSym = symAt(sf);
  if (modSym) {
    for (const e of checker.getExportsOfModule(modSym)) {
      const target = resolveAlias(e);
      const decl = target?.declarations?.[0];
      const here = e.declarations?.find((d) => d.getSourceFile() === sf);
      const entry = { name: e.name, kind: kindOf(ts, decl), line: here ? lineOf(here) : null };
      // reexportOf names the canonical key whenever this export name is not
      // it: a re-export, a local alias, or a default export of a declaration
      // also exported by name. A query of any exported name follows it.
      const c = ctx.canon(prog, target);
      if (c && c !== `${rel}#${e.name}`) entry.reexportOf = c;
      else if (!c && e.flags & ts.SymbolFlags.Alias && decl && ctx.rel(decl.getSourceFile().fileName) === null) entry.reexportOf = "external";
      rec.exports.push(entry);
    }
  }

  const external = new Set();
  const addImport = (specNode, typeOnly) => {
    const spec = specNode.text;
    const line = lineOf(specNode);
    const msym = symAt(specNode);
    const decl = msym?.valueDeclaration || msym?.declarations?.[0];
    if (decl && ts.isSourceFile(decl)) {
      const t = ctx.rel(decl.fileName);
      if (t) { rec.imports.push({ line, spec, target: t, ...(typeOnly ? { typeOnly: true } : {}) }); return; }
    }
    if (spec.startsWith(".") || spec.startsWith("/") || ctx.isAliasSpec(spec)) {
      if (decl && !ts.isSourceFile(decl)) { external.add(spec); return; }
      rec.unresolved.push({ kind: "import", line, reason: "unsupported-form", detail: `module "${spec}" did not resolve` });
      return;
    }
    external.add(spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]);
  };

  // A same-file `const NAME = "literal"` interpolated into SQL is static text.
  const constString = (expr) => {
    if (!ts.isIdentifier(expr)) return null;
    const d = resolveAlias(symAt(expr))?.valueDeclaration;
    if (d && d.getSourceFile() === sf && ts.isVariableDeclaration(d) && d.initializer && ts.isStringLiteralLike(d.initializer) &&
      d.parent && ts.isVariableDeclarationList(d.parent) && d.parent.flags & ts.NodeFlags.Const) return d.initializer.text;
    return null;
  };
  const sqlText = (node, depth = 0) => {
    if (!node || depth > 4) return null;
    if (isWrapper(node)) return sqlText(node.expression, depth + 1);
    if (ts.isStringLiteralLike(node)) return { text: node.text, exprs: [] };
    if (ts.isTemplateExpression(node)) {
      let t = node.head.text;
      const exprs = [];
      node.templateSpans.forEach((sp) => {
        const lit = constString(sp.expression);
        if (lit !== null) t += lit + sp.literal.text;
        else { t += `\u0000${exprs.length}\u0000` + sp.literal.text; exprs.push(sp.expression); }
      });
      return { text: t, exprs };
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const a = sqlText(node.left, depth + 1), b = sqlText(node.right, depth + 1);
      if (!a || !b) return null;
      const shift = a.exprs.length;
      return { text: a.text + b.text.replace(/\u0000(\d+)\u0000/g, (_, n) => `\u0000${Number(n) + shift}\u0000`), exprs: [...a.exprs, ...b.exprs] };
    }
    if (ts.isObjectLiteralExpression(node)) {
      const p = node.properties.find((q) => ts.isPropertyAssignment(q) && q.name.getText(sf) === "text");
      return p ? sqlText(p.initializer, depth + 1) : null;
    }
    if (ts.isIdentifier(node)) {
      const s = resolveAlias(symAt(node));
      const d = s?.valueDeclaration;
      if (d && d.getSourceFile() === sf && ts.isVariableDeclaration(d) && d.initializer) return sqlText(d.initializer, depth + 1);
    }
    return null;
  };
  const addSql = (node, form, textInfo) => {
    const { names, exprs } = relationsInSql(textInfo.text);
    const site = { line: lineOf(node), form, relations: names, relExprs: [] };
    for (const idx of exprs) {
      const expr = idx >= 0 ? textInfo.exprs[idx] : null;
      const c = expr ? ctx.canon(prog, resolveAlias(symAt(ts.isPropertyAccessExpression(expr) ? expr.name : expr))) : null;
      site.relExprs.push(c);
    }
    rec.sql.push(site);
  };

  const typeLibrary = (expr) => {
    let type;
    try { type = checker.getTypeAtLocation(expr); } catch { return "unknown"; }
    const visit = (t, depth) => {
      if (!t || depth > 3) return null;
      if (t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return "unknown";
      if (t.isUnionOrIntersection && t.isUnionOrIntersection()) {
        let sawUnknown = false;
        for (const u of t.types) {
          const r = visit(u, depth + 1);
          if (r && r !== "unknown") return r;
          if (r === "unknown") sawUnknown = true;
        }
        return sawUnknown ? "unknown" : null;
      }
      for (const s of [t.aliasSymbol, t.getSymbol && t.getSymbol()]) {
        const lib = s ? libraryOfDecls(s.declarations) : null;
        if (lib) return lib;
      }
      return null;
    };
    return { lib: visit(type, 0), type };
  };

  // ── worker routes: a default-exported object with a `fetch` member ────────
  // The object may be wrapped (`{…} satisfies ExportedHandler`, `as`, parentheses)
  // or held in a same-file const; a miss here would drop every route silently.
  const exportedObject = (expr) => {
    let e = unwrap(expr);
    if (e && ts.isIdentifier(e)) {
      const d = resolveAlias(symAt(e))?.valueDeclaration;
      e = d && d.getSourceFile() === sf && ts.isVariableDeclaration(d) ? unwrap(d.initializer) : null;
    }
    return e && ts.isObjectLiteralExpression(e) ? e : null;
  };
  const isWorker = sf.statements.some((st) => {
    if (!ts.isExportAssignment(st) || st.isExportEquals) return false;
    const obj = exportedObject(st.expression);
    return !!obj && obj.properties.some((p) => p.name && p.name.getText(sf) === "fetch");
  });
  const regexSource = (node) => {
    if (!node) return null;
    if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) return node.text;
    if (ts.isIdentifier(node)) {
      const d = resolveAlias(symAt(node))?.valueDeclaration;
      if (d && ts.isVariableDeclaration(d) && d.initializer && d.initializer.kind === ts.SyntaxKind.RegularExpressionLiteral) return d.initializer.text;
    }
    return null;
  };
  const mentionsPath = (node) => node && /\bpathname\b/.test(node.getText(sf));

  const visit = (node) => {
    // imports
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      addImport(node.moduleSpecifier, ts.isImportDeclaration(node) ? !!node.importClause?.isTypeOnly : !!node.isTypeOnly);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteralLike(node.moduleReference.expression)) {
      addImport(node.moduleReference.expression, node.isTypeOnly);
    } else if (ts.isCallExpression(node) && node.arguments.length >= 1 &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      // The callee decides that this is a module load; the argument decides
      // only whether its target is known. A computed target is kept as an
      // unresolved site, never dropped (agent-legible-codebase.md, the matrix).
      if (ts.isStringLiteralLike(node.arguments[0])) addImport(node.arguments[0], false);
      else {
        const callee = node.expression.kind === ts.SyntaxKind.ImportKeyword ? "import" : "require";
        rec.unresolved.push({ kind: "import", line: lineOf(node), reason: "dynamic-target", detail: `${callee}(${node.arguments[0].getText(sf).slice(0, 60)}) loads a module whose name is computed` });
      }
    }

    // canonical symbol references
    if (ts.isIdentifier(node)) {
      const s = resolveAlias(symAt(node));
      const c = s ? ctx.canon(prog, s) : null;
      if (c && !c.startsWith(rel + "#")) {
        const r = rec.refs[c];
        if (r) r[1] += 1;
        else rec.refs[c] = [lineOf(node), 1];
      }
    }

    if (ts.isTaggedTemplateExpression(node)) {
      const s = resolveAlias(symAt(node.tag));
      if (s && s.name === "sql" && libraryOfDecls(s.declarations) === "drizzle") {
        const t = sqlText(node.template);
        if (t) addSql(node, "sql-tag", t);
      }
    }

    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      // Drizzle table declarations
      const csym = resolveAlias(symAt(ts.isPropertyAccessExpression(callee) ? callee.name : callee));
      if (csym && csym.name === "pgTable" && libraryOfDecls(csym.declarations) === "drizzle") {
        const nameArg = node.arguments[0];
        let holder = node.parent;
        while (holder && isWrapper(holder)) holder = holder.parent;
        const varName = holder && ts.isVariableDeclaration(holder) && ts.isIdentifier(holder.name) ? holder.name.text : null;
        if (nameArg && ts.isStringLiteralLike(nameArg)) {
          ctx.tables.push({ name: nameArg.text.toLowerCase(), file: rel, line: lineOf(node), symbol: varName ? `${rel}#${varName}` : null });
        } else {
          rec.unresolved.push({ kind: "table", line: lineOf(node), reason: "dynamic-target", detail: "pgTable name is not a literal" });
        }
      }
      if (ts.isPropertyAccessExpression(callee)) {
        const method = callee.name.text;
        const recv = callee.expression;
        // sql.raw("…")
        if (method === "raw") {
          const rs = resolveAlias(symAt(recv));
          if (rs && rs.name === "sql" && libraryOfDecls(rs.declarations) === "drizzle") {
            const t = sqlText(node.arguments[0]);
            if (t) addSql(node, "sql-raw", t);
            else rec.unresolved.push({ kind: "sql", line: lineOf(node), reason: "dynamic-target", detail: "sql.raw argument is computed" });
          }
        }
        // database operations
        if ((method === "query" || method === "execute") && node.arguments.length >= 1) {
          const arg = node.arguments[0];
          const isTag = ts.isTaggedTemplateExpression(arg);
          const { lib } = typeLibrary(recv);
          const known = (method === "query" && lib === "pg") || (method === "execute" && lib === "drizzle");
          ctx.candidates.sql += 1;
          if (known) {
            if (!isTag) {
              const t = sqlText(arg);
              if (t) addSql(node, method === "query" ? "pg-query" : "drizzle-execute", t);
              else rec.unresolved.push({ kind: "sql", line: lineOf(node), reason: "dynamic-target", detail: `${recv.getText(sf)}.${method}(…) statement is computed` });
            }
          } else if (!isTag) {
            const t = sqlText(arg);
            if (t && looksLikeSql(t.text)) {
              rec.unresolved.push({
                kind: "sql", line: lineOf(node), reason: "unsupported-form",
                detail: `${recv.getText(sf).slice(0, 40)}.${method}(…) carries SQL but its receiver ${lib === "unknown" ? "could not be resolved" : "is not a supported database client"}`,
                relations: relationsInSql(t.text).names,
              });
            }
          }
        }
        // Express registrations
        if (EXPRESS_VERBS.has(method) || method === "use") {
          const { lib, type } = typeLibrary(recv);
          const args = node.arguments;
          const literalPath = (a) => (a && ts.isStringLiteralLike(a) ? a.text : null);
          if (lib === "express") {
            ctx.candidates.route += 1;
            if (method === "use") {
              const typeOf = (a) => { try { return checker.getTypeAtLocation(a); } catch { return undefined; } };
              const isRouter = (t) => !!(t && t.getProperty && t.getProperty("use") && t.getProperty("get"));
              const isCallable = (t) => !!(t && t.getCallSignatures && t.getCallSignatures().length);
              // Three overloads, told apart by the first argument: a literal
              // path; a router or handler, meaning the path was omitted; or
              // anything else, which is a prefix the extractor cannot read.
              // That last one is recorded as unknown (path null), never as "".
              const p = literalPath(args[0]);
              const first = args[0] ? typeOf(args[0]) : undefined;
              const omitted = p === null && (isRouter(first) || isCallable(first));
              const rest = p !== null || !omitted ? args.slice(1) : args;
              for (const a of rest) {
                if (isRouter(typeOf(a))) {
                  ctx.mounts.push({ parent: ctx.routerId(prog, sf, recv), path: p !== null ? p : omitted ? "" : null, child: ctx.routerId(prog, sf, a), file: rel, line: lineOf(node) });
                }
              }
            } else if (args.length >= 2 && !(ts.isCallExpression(recv) && ts.isPropertyAccessExpression(recv.expression) && recv.expression.name.text === "route")) {
              const p = literalPath(args[0]);
              if (p === null) {
                rec.unresolved.push({ kind: "route", line: lineOf(node), reason: "dynamic-target", detail: `${method.toUpperCase()} path is computed` });
              } else {
                ctx.routes.push({
                  router: ctx.routerId(prog, sf, recv), method: method.toUpperCase(), path: p, file: rel, line: lineOf(node),
                  handler: ctx.handlerOf(prog, sf, args[args.length - 1]),
                });
              }
            } else if (ts.isCallExpression(recv) && ts.isPropertyAccessExpression(recv.expression) && recv.expression.name.text === "route") {
              const p = literalPath(recv.arguments[0]);
              if (p === null) rec.unresolved.push({ kind: "route", line: lineOf(node), reason: "dynamic-target", detail: "route(…) path is computed" });
              else ctx.routes.push({
                router: ctx.routerId(prog, sf, recv.expression.expression), method: method.toUpperCase(), path: p, file: rel, line: lineOf(node),
                handler: ctx.handlerOf(prog, sf, args[args.length - 1]),
              });
            }
          } else if (lib === "unknown" && method !== "use" && args.length >= 2 && literalPath(args[0])?.startsWith("/")) {
            ctx.candidates.route += 1;
            rec.unresolved.push({ kind: "route", line: lineOf(node), reason: "unsupported-form", detail: `${recv.getText(sf).slice(0, 40)}.${method}("${literalPath(args[0])}", …) has a receiver whose type could not be resolved` });
          }
          void type;
        }
        // worker: RE.test(x.pathname), RE.exec(x.pathname), x.pathname.match(RE), x.pathname.startsWith("…")
        if (isWorker) {
          if ((method === "test" || method === "exec") && mentionsPath(node.arguments[0])) {
            ctx.candidates.route += 1;
            const src = regexSource(recv);
            if (src) ctx.routes.push({ router: `${rel}#fetch`, method: "ANY", path: `regex:${src}`, file: rel, line: lineOf(node), handler: null });
            else rec.unresolved.push({ kind: "route", line: lineOf(node), reason: "dynamic-target", detail: "the path pattern is computed" });
          } else if ((method === "match" || method === "matchAll") && mentionsPath(recv)) {
            ctx.candidates.route += 1;
            const src = regexSource(node.arguments[0]);
            if (src) ctx.routes.push({ router: `${rel}#fetch`, method: "ANY", path: `regex:${src}`, file: rel, line: lineOf(node), handler: null });
            else rec.unresolved.push({ kind: "route", line: lineOf(node), reason: "dynamic-target", detail: "the path pattern is computed" });
          } else if ((method === "startsWith" || method === "endsWith") && mentionsPath(recv)) {
            ctx.candidates.route += 1;
            const a = node.arguments[0];
            if (a && ts.isStringLiteralLike(a)) ctx.routes.push({ router: `${rel}#fetch`, method: "ANY", path: method === "startsWith" ? `prefix:${a.text}` : `suffix:${a.text}`, file: rel, line: lineOf(node), handler: null });
            else rec.unresolved.push({ kind: "route", line: lineOf(node), reason: "dynamic-target", detail: "the path pattern is computed" });
          }
        }
      }
    }
    if (isWorker && ts.isBinaryExpression(node) &&
      [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken].includes(node.operatorToken.kind)) {
      const [a, b] = [node.left, node.right];
      const lit = ts.isStringLiteralLike(a) ? a : ts.isStringLiteralLike(b) ? b : null;
      const other = lit === a ? b : a;
      if (lit && mentionsPath(other) && lit.text.startsWith("/")) {
        ctx.candidates.route += 1;
        ctx.routes.push({ router: `${rel}#fetch`, method: "ANY", path: lit.text, file: rel, line: lineOf(node), handler: null });
      }
    }

    // wouter <Route path="…" component={…}>
    if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
      const s = resolveAlias(symAt(node.tagName));
      if (s && s.name === "Route" && libraryOfDecls(s.declarations) === "wouter") {
        ctx.candidates.route += 1;
        let path = "*", dynamic = false, handler = null;
        for (const a of node.attributes.properties) {
          if (!ts.isJsxAttribute(a)) continue;
          const an = a.name.getText(sf);
          if (an === "path") {
            if (a.initializer && ts.isStringLiteral(a.initializer)) path = a.initializer.text;
            else if (a.initializer && ts.isJsxExpression(a.initializer) && a.initializer.expression && ts.isStringLiteralLike(a.initializer.expression)) path = a.initializer.expression.text;
            else dynamic = true;
          }
          if (an === "component" && a.initializer && ts.isJsxExpression(a.initializer) && a.initializer.expression) {
            handler = ctx.handlerOf(prog, sf, a.initializer.expression);
          }
        }
        // The child form, `<Route path="…"><Page /></Route>`: a single element
        // child is the handler. Any other children (a render function, several
        // elements) are reported, since the page they render is not resolved.
        if (!handler && ts.isJsxOpeningElement(node) && ts.isJsxElement(node.parent)) {
          const kids = node.parent.children.filter((c) => !(ts.isJsxText(c) && c.containsOnlyTriviaWhiteSpaces));
          const only = kids.length === 1 ? kids[0] : null;
          const tag = only && (ts.isJsxSelfClosingElement(only) ? only.tagName : ts.isJsxElement(only) ? only.openingElement.tagName : null);
          if (tag) handler = ctx.handlerOf(prog, sf, tag);
          else if (kids.length && !dynamic) rec.unresolved.push({ kind: "route", line: lineOf(node), reason: "unsupported-form", detail: `Route ${path}'s children are not a single element, so its page is not resolved` });
        }
        if (dynamic) rec.unresolved.push({ kind: "route", line: lineOf(node), reason: "dynamic-target", detail: "Route path is computed" });
        else ctx.routes.push({ router: `${rel}#Router`, method: "PAGE", path, file: rel, line: lineOf(node), handler: handler ?? { file: rel, line: lineOf(node), inline: true } });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  rec.exports.sort((a, b) => a.name.localeCompare(b.name));
  rec.imports.sort((a, b) => a.line - b.line || (a.target || a.spec).localeCompare(b.target || b.spec));
  rec.external = [...external].sort();
  rec.sql.sort((a, b) => a.line - b.line || a.form.localeCompare(b.form));
  rec.unresolved.sort((a, b) => a.line - b.line || a.kind.localeCompare(b.kind));
  return rec;
}

function kindOf(ts, decl) {
  if (!decl) return "unknown";
  const k = ts.SyntaxKind;
  switch (decl.kind) {
    case k.FunctionDeclaration: return "function";
    case k.ClassDeclaration: return "class";
    case k.InterfaceDeclaration: return "interface";
    case k.TypeAliasDeclaration: return "type";
    case k.EnumDeclaration: return "enum";
    case k.ModuleDeclaration: return "namespace";
    case k.VariableDeclaration: return "variable";
    case k.SourceFile: return "module";
    default: return "other";
  }
}

/** Build the whole index in memory. Throws MapError for a refusal. */
export function buildIndex(root, cfg) {
  const { ts, version } = loadCompiler(root, cfg);
  const files = listFiles(root);
  const syncedCache = new Map();
  const isSynced = (f) => {
    if (!syncedCache.has(f)) {
      let head = "";
      try { head = readFileSync(join(root, f), "utf8").slice(0, 64 * 1024); } catch {}
      syncedCache.set(f, carriesSyncBanner(head));
    }
    return syncedCache.get(f);
  };
  const sets = computeSets(files, cfg, isSynced);
  const indexedSet = new Set(sets.indexed);
  const programs = createPrograms(ts, root, cfg, files);

  const rootPrefix = root + sep;
  const rel = (fileName) => {
    const real = realOr(fileName);
    if (!real.startsWith(rootPrefix)) return null;
    const r = real.slice(rootPrefix.length).split(sep).join("/");
    return r.split("/").includes("node_modules") ? null : r;
  };
  const aliasPrefixes = new Set();
  for (const p of programs) {
    for (const k of Object.keys(p.program.getCompilerOptions().paths || {})) aliasPrefixes.add(k.replace(/\*.*$/, ""));
  }

  const exportCaches = new Map();
  const ctx = {
    rel,
    tables: [],
    routes: [],
    mounts: [],
    candidates: { route: 0, sql: 0 },
    isAliasSpec: (spec) => [...aliasPrefixes].some((a) => a && spec.startsWith(a)),
    canon(prog, sym) {
      const decl = sym?.declarations?.[0];
      if (!decl) return null;
      const sf = decl.getSourceFile();
      const r = rel(sf.fileName);
      if (!r) return null;
      let cache = exportCaches.get(prog.checker);
      if (!cache) exportCaches.set(prog.checker, (cache = new Map()));
      let m = cache.get(sf.fileName);
      if (!m) {
        m = new Map();
        let ms;
        try { ms = prog.checker.getSymbolAtLocation(sf); } catch {}
        if (ms) {
          // One canonical export name per declaration, chosen without regard
          // to iteration order: the declaration's own name when it is exported
          // under it, else the first named alias alphabetically, `default` last.
          // Every other name the file exports for it carries reexportOf to
          // this one, which is what a query of that name follows.
          const names = new Map();
          for (const e of prog.checker.getExportsOfModule(ms)) {
            let t = e;
            for (let i = 0; t && t.flags & ts.SymbolFlags.Alias && i < 10; i++) {
              try { t = prog.checker.getAliasedSymbol(t); } catch { break; }
            }
            if (!names.has(t)) names.set(t, []);
            names.get(t).push(e.name);
          }
          for (const [t, ns] of names) {
            const own = t.declarations?.[0] ? declName(t.declarations[0], t) : null;
            const rank = (n) => (n === own ? 0 : n === "default" ? 2 : 1);
            m.set(t, [...ns].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))[0]);
          }
        }
        cache.set(sf.fileName, m);
      }
      const name = m.get(sym);
      return name ? `${r}#${name}` : null;
    },
    routerId(prog, sf, expr) {
      let s;
      try { s = prog.checker.getSymbolAtLocation(ts.isPropertyAccessExpression(expr) ? expr.name : expr); } catch {}
      for (let i = 0; s && s.flags & ts.SymbolFlags.Alias && i < 10; i++) s = prog.checker.getAliasedSymbol(s);
      const d = s?.valueDeclaration || s?.declarations?.[0];
      if (d) {
        const r = rel(d.getSourceFile().fileName) ?? "external";
        const line = d.getSourceFile().getLineAndCharacterOfPosition(d.getStart()).line + 1;
        return `${r}#${declName(d, s)}@${line}`;
      }
      const r = rel(sf.fileName);
      return `${r}@${sf.getLineAndCharacterOfPosition(expr.getStart(sf)).line + 1}`;
    },
    handlerOf(prog, sf, expr) {
      if (!expr) return null;
      if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) {
        return { file: rel(sf.fileName), line: sf.getLineAndCharacterOfPosition(expr.getStart(sf)).line + 1, inline: true };
      }
      let s;
      try { s = prog.checker.getSymbolAtLocation(ts.isPropertyAccessExpression(expr) ? expr.name : ts.isCallExpression(expr) ? expr.expression : expr); } catch {}
      for (let i = 0; s && s.flags & ts.SymbolFlags.Alias && i < 10; i++) s = prog.checker.getAliasedSymbol(s);
      const d = s?.valueDeclaration || s?.declarations?.[0];
      if (d && rel(d.getSourceFile().fileName)) {
        const dsf = d.getSourceFile();
        return { file: rel(dsf.fileName), line: dsf.getLineAndCharacterOfPosition(d.getStart()).line + 1, name: declName(d, s) };
      }
      return { file: rel(sf.fileName), line: sf.getLineAndCharacterOfPosition(expr.getStart(sf)).line + 1, inline: true };
    },
  };

  // A default export's symbol is named "default"; its declaration knows its real name.
  function declName(d, s) {
    const n = ts.getNameOfDeclaration(d);
    return n && ts.isIdentifier(n) ? n.text : s.name;
  }

  // Which program analyses which file: a root of the earliest program first,
  // then the earliest program that reached it through an import.
  const visited = new Set();
  const owner = new Map();
  for (const p of programs) {
    for (const sf of p.program.getSourceFiles()) {
      const r = rel(sf.fileName);
      if (!r) continue;
      visited.add(r);
      if (indexedSet.has(r) && !owner.has(r) && p.roots.has(realOr(sf.fileName))) owner.set(r, [p, sf]);
    }
  }
  for (const p of programs) {
    for (const sf of p.program.getSourceFiles()) {
      const r = rel(sf.fileName);
      if (r && indexedSet.has(r) && !owner.has(r)) owner.set(r, [p, sf]);
    }
  }
  const uncovered = sets.indexed.filter((f) => !visited.has(f));
  if (uncovered.length) {
    throw new MapError("coverage", `${uncovered.length} indexed file(s) were analysed by no declared program, so they would contribute no edges`, {
      files: uncovered,
      fix: `add a program that reaches them to "programs" in ${MAP_DIR}/config.json (a product tsconfig, or a supplementary program with "roots" and, for JavaScript, "allowJs"), or exclude them from sets.indexed`,
      anchor: "programs-and-file-sets",
    });
  }

  const out = {};
  for (const r of [...owner.keys()].sort()) {
    const [p, sf] = owner.get(r);
    out[r] = extractFile(ts, p, sf, ctx);
  }

  // ── finalize: tables, SQL expressions, route composition ─────────────────
  const tables = {};
  for (const t of ctx.tables) (tables[t.name] ||= []).push({ file: t.file, line: t.line, symbol: t.symbol });
  for (const k of Object.keys(tables)) tables[k].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  const bySymbol = new Map(ctx.tables.filter((t) => t.symbol).map((t) => [t.symbol, t.name]));
  for (const [r, rec] of Object.entries(out)) {
    for (const site of rec.sql) {
      const names = new Set(site.relations);
      let dynamic = false;
      for (const c of site.relExprs) {
        if (c && bySymbol.has(c)) names.add(bySymbol.get(c));
        else dynamic = true;
      }
      site.relations = [...names].sort();
      delete site.relExprs;
      if (dynamic) rec.unresolved.push({ kind: "sql", line: site.line, reason: "dynamic-target", detail: "a relation in this statement is interpolated at runtime" });
    }
    rec.unresolved.sort((a, b) => a.line - b.line || a.kind.localeCompare(b.kind));
    void r;
  }

  const childOf = new Map();
  for (const m of ctx.mounts) {
    if (!childOf.has(m.child)) childOf.set(m.child, []);
    childOf.get(m.child).push(m);
  }
  // A prefix is a string, or unknown: { unknown: "<file>:<line>" } names the
  // mount whose path the extractor could not read. Unknown is carried through
  // nested mounts and never composed into a path.
  const memo = new Map();
  const prefixes = (router, seen = new Set()) => {
    if (memo.has(router)) return memo.get(router);
    if (seen.has(router)) return [""];
    seen.add(router);
    const ms = childOf.get(router);
    const res = !ms ? [""] : ms.flatMap((m) => prefixes(m.parent, seen).map((p) =>
      typeof p !== "string" ? p : m.path === null ? { unknown: `${m.file}:${m.line}` } : joinPaths(p, m.path)));
    const uniq = [...new Map(res.map((p) => [typeof p === "string" ? `s:${p}` : `u:${p.unknown}`, p])).values()];
    memo.set(router, uniq);
    return uniq;
  };
  const routes = [];
  for (const r of ctx.routes) {
    const composed = r.method === "ANY" || r.method === "PAGE" ? [r.path] : prefixes(r.router).map((p) => (typeof p === "string" ? joinPaths(p, r.path) : p));
    for (const full of composed) {
      if (typeof full !== "string") {
        out[r.file].unresolved.push({ kind: "route", line: r.line, reason: "dynamic-target", detail: `${r.method} "${r.path}" is mounted under a computed prefix at ${full.unknown}` });
        continue;
      }
      routes.push({ method: r.method, path: full, file: r.file, line: r.line, handler: r.handler, ...(full !== r.path ? { registeredAs: r.path } : {}) });
    }
  }
  for (const r of Object.values(out)) r.unresolved.sort((a, b) => a.line - b.line || a.kind.localeCompare(b.kind) || a.detail.localeCompare(b.detail));
  routes.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method) || a.file.localeCompare(b.file) || a.line - b.line);
  const mounts = ctx.mounts
    .map(({ file, line, path, child, parent }) => ({ file, line, path, child, parent }))
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.child.localeCompare(b.child));

  const digestInputs = [...new Set([...sets.indexed, ...visited, ...standingInputs(root, files)])].sort();
  return {
    index: {
      tool: TOOL_VERSION,
      compiler: version,
      inputsDigest: digestOf(root, digestInputs, version),
      digestInputs,
      sets: { indexed: sets.indexed, headered: sets.headered, sized: sets.sized },
      files: out,
      routes,
      mounts,
      tables,
      candidates: ctx.candidates,
    },
    sets,
    files,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// Guards.
// ════════════════════════════════════════════════════════════════════════════

function headerFailures(index, vocab) {
  const missing = [], unknown = [];
  for (const f of index.sets.headered) {
    const r = index.files[f];
    if (!r) continue;
    const lack = [!r.purpose && "@purpose", !r.subsystem && "@subsystem"].filter(Boolean);
    if (lack.length) missing.push(`${f}  (missing ${lack.join(" and ")})`);
    else if (!vocab[r.subsystem]) unknown.push(`${f}  (@subsystem ${r.subsystem})`);
  }
  const fails = [];
  if (missing.length) fails.push(failure("headers", `${missing.length} file(s) lack a purpose line or subsystem tag`, missing,
    "add a leading comment carrying `@purpose <one sentence>` and `@subsystem <tag>` (inside the existing doc comment if the file has one), then run `node scripts/map.mjs build`",
    "the-header-convention"));
  if (unknown.length) fails.push(failure("headers", `${unknown.length} file(s) carry a subsystem tag that ${MAP_DIR}/subsystems.json does not define`, unknown,
    `use a tag defined in ${MAP_DIR}/subsystems.json, or add the tag there with the document that governs it`, "the-header-convention"));
  return fails;
}

/** Where a file sits in each boundary dimension. */
function classifier(index, arch, vocab, codegen) {
  // A package path is repository-relative; "." or "./" is the repository root,
  // which holds every file a more specific (longer) package does not.
  const base = (p) => p.path.replace(/^\.(?:\/|$)/, "").replace(/\/+$/, "");
  const pkgs = [...(arch.packages || [])].sort((a, b) => base(b).length - base(a).length);
  const pkgOf = (f) => pkgs.find((p) => { const b = base(p); return b === "" || f === b || f.startsWith(b + "/"); }) || null;
  const layerOf = (f, p) => {
    if (!p) return null;
    const b = base(p);
    const local = b === "" ? f : f.slice(b.length + 1);
    const ls = [...(p.layers || [])].sort((a, b) => b.prefix.length - a.prefix.length);
    return ls.find((l) => local.startsWith(l.prefix))?.name ?? null;
  };
  const headered = new Set(index.sets.headered);
  const stemOf = (f) => f.split("/").pop().replace(/(\.(test|spec))?(\.[cm]?[jt]sx?)$/, "").replace(/\.(test|spec)$/, "");
  const subOf = (f) => {
    const r = index.files[f];
    if (headered.has(f)) return r?.subsystem ?? null;
    if (matchesAny(f, codegen)) return { infra: true };
    const dir = f.split("/").slice(0, -1);
    const stem = stemOf(f);
    const tryDirs = [dir.join("/")];
    if (dir[dir.length - 1] === "__tests__") tryDirs.push(dir.slice(0, -1).join("/"));
    for (const d of tryDirs) {
      for (const h of headered) {
        if (h.startsWith(d + "/") && !h.slice(d.length + 1).includes("/") && stemOf(h) === stem) return index.files[h]?.subsystem ?? null;
      }
    }
    return { infra: true };
  };
  const isInfra = (s) => (s && typeof s === "object" && s.infra) || (typeof s === "string" && vocab[s]?.infrastructure === true);
  return { pkgOf, layerOf, subOf, isInfra };
}

function boundaryFailures(index, arch, vocab, codegen) {
  const { pkgOf, layerOf, subOf, isInfra } = classifier(index, arch, vocab, codegen);
  const exemptions = new Map((arch.exemptions || []).map((e) => [`${e.file}|${e.target}|${e.dimension}`, { e, used: false }]));
  const viol = { package: [], layer: [], subsystem: [] };
  const allowPkg = arch.allowPackages || {};
  const allowSub = arch.allowSubsystems || {};
  for (const f of index.sets.indexed) {
    const rec = index.files[f];
    if (!rec) continue;
    for (const imp of rec.imports) {
      const t = imp.target;
      if (!index.files[t]) continue;
      const pf = pkgOf(f), pt = pkgOf(t);
      const check = (dim, broken, detail) => {
        if (!broken) return;
        const ex = exemptions.get(`${f}|${t}|${dim}`);
        if (ex) { ex.used = true; return; }
        viol[dim].push(`${f}:${imp.line} → ${t}  (${detail})`);
      };
      if (pf && pt && pf !== pt) check("package", !(allowPkg[pf.name] || []).includes(pt.name), `${pf.name} may not import ${pt.name}`);
      if (pf && pt && pf === pt) {
        const lf = layerOf(f, pf), lt = layerOf(t, pt);
        if (lf && lt && lf !== lt) check("layer", !((pf.allowLayers || {})[lf] || []).includes(lt), `${pf.name}: ${lf} may not import ${lt}`);
      }
      const sf = subOf(f), st = subOf(t);
      if (typeof sf === "string" && typeof st === "string" && sf !== st && !isInfra(st)) {
        check("subsystem", !(allowSub[sf] || []).includes(st), `${sf} may not import ${st}`);
      }
    }
  }
  const fails = [];
  const fixFor = {
    package: `remove the import, or allow it in "allowPackages" in ${MAP_DIR}/architecture.json if the dependency is intended, or add a dated, reasoned entry to "exemptions" for an existing edge being retired`,
    layer: `move the code to the layer that may depend on it, or allow the edge in that package's "allowLayers" in ${MAP_DIR}/architecture.json, or add a dated, reasoned entry to "exemptions"`,
    subsystem: `route the dependency through an infrastructure subsystem, or allow it in "allowSubsystems" in ${MAP_DIR}/architecture.json, or add a dated, reasoned entry to "exemptions"`,
  };
  for (const dim of ["package", "layer", "subsystem"]) {
    if (viol[dim].length) fails.push(failure("boundaries", `${viol[dim].length} import(s) cross a ${dim} boundary the manifest does not allow`, viol[dim], fixFor[dim], "dependency-boundaries"));
  }
  const dead = [...exemptions.values()].filter((x) => !x.used).map(({ e }) => `${e.file} → ${e.target}  (${e.dimension}, ${e.date})`);
  if (dead.length) fails.push(failure("boundaries", `${dead.length} exemption(s) no longer match any violating import`, dead,
    `delete these entries from "exemptions" in ${MAP_DIR}/architecture.json — the edge they excused is gone`, "dependency-boundaries"));
  return fails;
}

function sizeFailures(index, baseline) {
  const cap = baseline.cap;
  const grown = [];
  for (const f of index.sets.sized) {
    const size = index.files[f]?.size ?? 0;
    const allow = Math.max(cap, baseline.baselines?.[f] ?? 0);
    if (size > allow) grown.push(`${f}  (${size} lines, allowed ${allow})`);
  }
  // An allowance follows every shrink: a baseline the file no longer needs
  // (gone, out of the sized set, back within the cap, or smaller than its
  // baseline) fails until ratchet lowers or releases it, so a split file
  // cannot quietly regrow to its old allowance.
  const sized = new Set(index.sets.sized);
  const stale = [];
  for (const [f, n] of Object.entries(baseline.baselines || {})) {
    const size = index.files[f]?.size;
    if (!sized.has(f) || size === undefined) stale.push(`${f}  (baseline ${n}; the file is gone or no longer sized)`);
    else if (size <= cap) stale.push(`${f}  (baseline ${n}; now ${size} lines, within the cap of ${cap})`);
    else if (size < n) stale.push(`${f}  (baseline ${n}; now ${size} lines)`);
  }
  return [
    ...(grown.length
      ? [failure("size", `${grown.length} file(s) exceed their size allowance`, grown,
          `split the file so it fits within ${cap} non-blank lines (a frozen file may only shrink); baselines are never raised by hand`, "the-size-ratchet")]
      : []),
    ...(stale.length
      ? [failure("size", `${stale.length} baseline(s) allow more than their file now needs`, stale,
          "run `node scripts/map.mjs ratchet`, which lowers or releases them, and commit the result", "the-size-ratchet")]
      : []),
  ];
}

// ════════════════════════════════════════════════════════════════════════════
// Commands.
// ════════════════════════════════════════════════════════════════════════════

const indexPath = (root) => join(root, MAP_DIR, "index.json");
const provenancePath = (root) => join(root, MAP_DIR, "provenance.json");

function requireConfig(cfgs) {
  const c = cfgs.config;
  if (c.missing || c.error) {
    throw new MapError("configuration", `${c.path} is ${c.missing ? "missing" : "not valid JSON"}`, {
      fix: "run the handbook sync to seed it, then complete it", anchor: "configuration",
    });
  }
  return c.value;
}

function writeBuilt(root, index) {
  const bytes = serializeIndex(index);
  const p = indexPath(root);
  const prev = existsSync(p) ? readFileSync(p, "utf8") : null;
  mkdirSync(dirname(p), { recursive: true });
  if (prev === bytes && existsSync(provenancePath(root))) return { changed: false };
  writeFileSync(p, bytes);
  let head = "unknown", dirty = false;
  try {
    head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const status = execFileSync("git", ["status", "--porcelain", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean).map((l) => l.slice(3));
    const inputs = new Set(index.digestInputs);
    dirty = status.some((s) => inputs.has(s));
  } catch {}
  writeFileSync(provenancePath(root), stableStringify({ builtFrom: head, inputsDifferedFromBase: dirty, note: "provenance only; freshness is decided by inputsDigest in the index, never by this file" }, 2) + "\n");
  return { changed: true };
}

function cmdBuild(root, log) {
  const cfgs = readConfigs(root);
  const cfg = requireConfig(cfgs);
  const { index } = buildIndex(root, cfg);
  const { changed } = writeBuilt(root, index);
  log(`map: ${Object.keys(index.files).length} files indexed (${index.sets.headered.length} headered, ${index.sets.sized.length} sized), ` +
    `${index.routes.length} routes, ${Object.keys(index.tables).length} tables; compiler ${index.compiler}; ` +
    (changed ? `wrote ${MAP_DIR}/index.json` : "index unchanged"));
  return 0;
}

function cmdCheck(root, log, err) {
  const cfgs = readConfigs(root);
  if (cfgs.config.value && cfgs.config.value.enabled === false) {
    log(`map disabled by ${MAP_DIR}/config.json`);
    return 0;
  }
  const fails = schemaFailures(root, cfgs);
  const adoption = adoptionFailure(cfgs);
  if (adoption) fails.push(adoption);
  if (!fails.length) {
    const cfg = cfgs.config.value;
    let built;
    try { built = buildIndex(root, cfg); }
    catch (e) {
      if (!(e instanceof MapError)) throw e;
      fails.push(failure(e.rule, e.message, e.files, e.fix, e.anchor));
    }
    if (built) {
      const { index, sets } = built;
      const p = indexPath(root);
      if (!existsSync(p)) {
        fails.push(failure("freshness", "the index has never been built", [`${MAP_DIR}/index.json`], "run `node scripts/map.mjs build` and commit the result", "freshness"));
      } else if (readFileSync(p, "utf8") !== serializeIndex(index)) {
        fails.push(failure("freshness", "the committed index does not match the code", [`${MAP_DIR}/index.json`],
          "run `node scripts/map.mjs build` and commit the regenerated index (never edit it by hand)", "freshness"));
      }
      const vocab = cfgs.subsystems.value.subsystems || {};
      fails.push(...headerFailures(index, vocab));
      fails.push(...boundaryFailures(index, cfgs.architecture.value, vocab, sets.codegen));
      fails.push(...sizeFailures(index, cfgs.sizeBaseline.value));
    }
  }
  if (!fails.length) {
    log("✓ map: index fresh; headers, boundaries and sizes hold.");
    return 0;
  }
  err(fails.map(renderFailure).join("\n\n"));
  err(`\n${fails.length} map guard failure(s). To stand the guards down while this is resolved, set "enabled": false in ${MAP_DIR}/config.json (${DOC}#backing-out).`);
  return 1;
}

function sizesNow(root, cfg) {
  const files = listFiles(root);
  const isSynced = (f) => { try { return carriesSyncBanner(readFileSync(join(root, f), "utf8").slice(0, 65536)); } catch { return false; } };
  const { sized } = computeSets(files, cfg, isSynced);
  const sizes = {};
  for (const f of sized) {
    const t = readFileSync(join(root, f), "utf8");
    sizes[f] = sizeAfterHeader(t, parseHeader(t).headerEnd);
  }
  return sizes;
}

function cmdBaseline(root, mode, log) {
  const cfgs = readConfigs(root);
  const cfg = requireConfig(cfgs);
  const b = cfgs.sizeBaseline.value;
  if (!b) throw new MapError("configuration", `${MAP_DIR}/size-baseline.json is missing or invalid`, { fix: "run the handbook sync to seed it", anchor: "the-size-ratchet" });
  const sizes = sizesNow(root, cfg);
  const baselines = { ...(b.baselines || {}) };
  const changes = [];
  if (mode === "freeze") {
    // freeze grandfathers the files that were already over the cap when a
    // repository adopts the guard; after adoption it would grant an
    // allowance from nothing, so it refuses.
    if (b.adopted === true) {
      throw new MapError("size", "freeze only runs before the size baseline is adopted; this one is adopted", {
        fix: "split the oversized file so it fits within the cap, or run `node scripts/map.mjs ratchet` to lower allowances; " +
          "to bring a file under governance deliberately, set \"adopted\": false, freeze, and set it back in the same reviewed change",
        anchor: "the-size-ratchet",
      });
    }
    for (const [f, n] of Object.entries(sizes)) {
      if (n > b.cap && !(f in baselines)) { baselines[f] = n; changes.push(`froze ${f} at ${n}`); }
    }
  } else {
    for (const [f, n] of Object.entries(baselines)) {
      if (!(f in sizes) || sizes[f] <= b.cap) { delete baselines[f]; changes.push(`released ${f} (now within the cap or gone)`); }
      else if (sizes[f] < n) { baselines[f] = sizes[f]; changes.push(`lowered ${f} ${n} → ${sizes[f]}`); }
      else if (sizes[f] > n) changes.push(`left ${f} at ${n}: it has grown to ${sizes[f]}, and a baseline is never raised`);
    }
  }
  const sorted = Object.fromEntries(Object.entries(baselines).sort(([a], [x]) => a.localeCompare(x)));
  writeFileSync(join(root, MAP_DIR, CONFIG_FILES.sizeBaseline), JSON.stringify({ ...b, baselines: sorted }, null, 2) + "\n");
  for (const c of changes) log(`  ${c}`);
  log(`map: ${mode} made ${changes.length} change(s); rebuilding the index, whose freshness covers the baseline file`);
  return cmdBuild(root, log);
}

/** Load the index for a query, refusing a stale one unless allowed. */
function loadForQuery(root, opts) {
  const cfgs = readConfigs(root);
  const cfg = cfgs.config.value || {};
  const p = indexPath(root);
  if (!existsSync(p)) {
    throw new MapError("freshness", "there is no index to query", { fix: "run `node scripts/map.mjs build`", anchor: "freshness", code: 3 });
  }
  const index = readJson(p);
  const banners = [];
  if (cfg.enabled === false) banners.push(`DISABLED: the map is switched off in ${MAP_DIR}/config.json; this answer is from whatever index is present`);
  if (Object.values(cfgs).some((c) => c.value && c.value.adopted !== true)) banners.push("UNADOPTED: this repository has not completed adoption; answers may be partial");
  let current = index.digestInputs || [];
  try {
    const files = listFiles(root);
    const isSynced = (f) => { try { return carriesSyncBanner(readFileSync(join(root, f), "utf8").slice(0, 65536)); } catch { return false; } };
    current = [...current, ...computeSets(files, cfg, isSynced).indexed, ...standingInputs(root, files)];
  } catch {}
  const fresh = digestOf(root, current, compilerVersion(root, cfg)) === index.inputsDigest;
  if (!fresh) {
    if (!opts.allowStale) {
      throw new MapError("freshness", "the index is stale: the code, configuration or compiler changed since it was built", {
        fix: "run `node scripts/map.mjs build` (then re-run this query); --allow-stale answers from the old index with a warning",
        anchor: "freshness", code: 3,
      });
    }
    banners.push("STALE: the code changed since this index was built; run `node scripts/map.mjs build`");
  }
  return { index, banners };
}

function notFound(what, q, candidates) {
  const near = nearest(q, candidates);
  return new MapError("query", `${what} ${q} is not in the index${near.length ? `; nearest: ${near.join(", ")}` : ""}`, {
    fix: "check the path is repository-relative and inside sets.indexed (`node scripts/map.mjs purpose <file>` shows whether it is governed)",
    anchor: "queries",
  });
}

function answer(opts, log, a) {
  if (opts.json) log(JSON.stringify({ banners: a.banners, resolved: a.resolvedData, unresolved: a.unresolvedData, coverage: a.coverage }, null, 2));
  else log(formatAnswer({ ...a, resolved: a.resolvedData.map(a.fmt), unresolved: a.unresolvedData.map((u) => `${u.file}:${u.line}  ${u.reason}  ${u.detail}`) }));
  return 0;
}

const unresolvedOf = (index, kind, filter = () => true) => {
  const out = [];
  for (const [f, r] of Object.entries(index.files)) for (const u of r.unresolved) if (u.kind === kind && filter(f, u)) out.push({ file: f, ...u });
  return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
};

function cmdDeps(root, file, opts, log) {
  const { index, banners } = loadForQuery(root, opts);
  const r = index.files[file];
  if (!r) throw notFound("file", file, Object.keys(index.files));
  return answer(opts, log, {
    banners, title: `deps ${file}`,
    resolvedData: r.imports.filter((i) => i.target).map((i) => ({ file: i.target, line: i.line, typeOnly: !!i.typeOnly })),
    fmt: (d) => `${d.file}  (imported at line ${d.line}${d.typeOnly ? ", type-only" : ""})`,
    unresolvedData: r.unresolved.filter((u) => u.kind === "import").map((u) => ({ file, ...u })),
    coverage: [
      `module edges read by the ${r.program} program: import, export … from, import(), require(); ${r.imports.length} found`,
      `external packages: ${r.external.length ? r.external.join(", ") : "none"}`,
    ],
  });
}

function cmdDependents(root, target, opts, log) {
  const { index, banners } = loadForQuery(root, opts);
  const hash = target.indexOf("#");
  if (hash === -1) {
    if (!index.files[target]) throw notFound("file", target, Object.keys(index.files));
    const res = [];
    for (const [f, r] of Object.entries(index.files)) for (const i of r.imports) if (i.target === target) res.push({ file: f, line: i.line });
    res.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
    const stem = target.split("/").pop().replace(/\.[^.]+$/, "");
    return answer(opts, log, {
      banners, title: `dependents ${target}  (modules importing or re-exporting this file; for a declaration's users ask for <file>#<symbol>)`,
      resolvedData: res, fmt: (d) => `${d.file}:${d.line}`,
      unresolvedData: unresolvedOf(index, "import", (_, u) => u.reason === "dynamic-target" || u.detail.includes(stem)),
      coverage: [`module edges across ${Object.keys(index.files).length} indexed files; every computed import() or require() is listed above, since its target could be this file`],
    });
  }
  const file = target.slice(0, hash), name = target.slice(hash + 1);
  const rec = index.files[file];
  if (!rec) throw notFound("file", file, Object.keys(index.files));
  if (!rec.exports.some((e) => e.name === name)) {
    throw new MapError("query", `${file} exports no ${name}; it exports: ${rec.exports.map((e) => e.name).join(", ") || "nothing"}`, {
      fix: "name a declaration the file exports, as <file>#<name>", anchor: "queries",
    });
  }
  // Every exported name resolves to one canonical key: an alias, a barrel
  // re-export or a default export carries reexportOf, and refs are keyed by
  // the canonical alone.
  const entry = rec.exports.find((e) => e.name === name);
  const external = entry.reexportOf === "external";
  const key = entry.reexportOf && !external ? entry.reexportOf : target;
  const res = [];
  if (!external) {
    for (const [f, r] of Object.entries(index.files)) {
      const hit = r.refs[key];
      if (hit) res.push({ file: f, line: hit[0], count: hit[1] });
    }
  }
  res.sort((a, b) => a.file.localeCompare(b.file));
  return answer(opts, log, {
    banners, title: `dependents ${target}${key !== target ? `  → ${key}` : ""}  (sites in other files referencing this declaration, through any alias or re-export)`,
    resolvedData: res, fmt: (d) => `${d.file}:${d.line}${d.count > 1 ? `  (+${d.count - 1} more in file)` : ""}`,
    unresolvedData: (() => { const st = relatedStems(index, key); return unresolvedOf(index, "import", (_, u) => u.reason === "dynamic-target" || [...st].some((s) => u.detail.includes(`/${s}"`) || u.detail.includes(`"${s}"`))); })(),
    coverage: [
      external
        ? `${target} re-exports a declaration from outside the indexed set; its users are not indexed, so no reference is listed`
        : `canonical symbol references in other files, across ${Object.keys(index.files).length} indexed files; the file itself is read directly; an unresolved import above could hide a user`,
      `${unresolvedOf(index, "import").length} unresolved imports in the repository in all: \`node scripts/map.mjs unresolved import\` lists them`,
    ],
  });
}

function cmdRoute(root, method, path, opts, log) {
  const { index, banners } = loadForQuery(root, opts);
  const m = method.toUpperCase();
  const res = index.routes.filter((r) => (m === "ANY" || r.method === m || r.method === "ANY" || r.method === "ALL") && routeMatches(r.path, path));
  return answer(opts, log, {
    banners, title: `route ${m} ${path}`,
    resolvedData: res,
    fmt: (r) => `${r.method} ${r.path}  registered ${r.file}:${r.line}${r.registeredAs ? ` as "${r.registeredAs}"` : ""}` +
      (r.handler ? `  handler ${r.handler.inline ? "inline" : `${r.handler.name} at`} ${r.handler.file}:${r.handler.line}` : ""),
    unresolvedData: unresolvedOf(index, "route"),
    coverage: [`${index.candidates.route} route candidates examined (Express registrations with mounts, wouter <Route>, Worker fetch path tests); ${index.mounts.length} mounts composed`],
  });
}

function cmdRoutes(root, file, opts, log) {
  const { index, banners } = loadForQuery(root, opts);
  if (!index.files[file]) throw notFound("file", file, Object.keys(index.files));
  return answer(opts, log, {
    banners, title: `routes ${file}`,
    resolvedData: index.routes.filter((r) => r.file === file),
    fmt: (r) => `${r.method} ${r.path}  line ${r.line}${r.handler && !r.handler.inline ? `  handler ${r.handler.name} at ${r.handler.file}:${r.handler.line}` : ""}`,
    unresolvedData: unresolvedOf(index, "route", (f) => f === file),
    coverage: ["Express registrations with mounts, wouter <Route>, Worker fetch path tests"],
  });
}

function relatedStems(index, target) {
  const stems = new Set();
  const stemOf = (f) => f.split("/").pop().replace(/\.[^.]+$/, "");
  const file = target.split("#")[0];
  stems.add(stemOf(file));
  for (const [f, r] of Object.entries(index.files)) {
    if (r.exports.some((e) => e.reexportOf === target) || r.imports.some((i) => i.target === file && /(^|\/)index\.[^/]+$/.test(f))) {
      stems.add(stemOf(f));
      stems.add(f.split("/").slice(-3, -2)[0] || "");
    }
  }
  stems.delete("");
  return stems;
}

function cmdUnresolved(root, kind, opts, log) {
  const { index, banners } = loadForQuery(root, opts);
  const kinds = kind ? [kind] : ["import", "route", "sql", "table"];
  const res = kinds.flatMap((k) => unresolvedOf(index, k));
  return answer(opts, log, {
    banners, title: `unresolved ${kind ?? "(all kinds)"}  (every site the extractor examined and could not resolve)`,
    resolvedData: [], fmt: String, unresolvedData: res,
    coverage: [`${Object.keys(index.files).length} indexed files; reasons: dynamic-target (computed at runtime) or unsupported-form (a shape the extractor does not analyse)`],
  });
}

function cmdTable(root, nameArg, opts, log) {
  const { index, banners } = loadForQuery(root, opts);
  const name = nameArg.toLowerCase().replace(/^public\./, "");
  const decls = index.tables[name] || [];
  const res = [];
  for (const d of decls) res.push({ kind: "declaration", file: d.file, line: d.line, symbol: d.symbol });
  for (const d of decls) {
    if (!d.symbol) continue;
    for (const [f, r] of Object.entries(index.files)) {
      const hit = r.refs[d.symbol];
      if (hit) res.push({ kind: "typed", file: f, line: hit[0], count: hit[1] });
    }
  }
  for (const [f, r] of Object.entries(index.files)) {
    for (const s of r.sql) if (s.relations.includes(name)) res.push({ kind: s.form, file: f, line: s.line });
  }
  res.sort((a, b) => a.kind.localeCompare(b.kind) || a.file.localeCompare(b.file) || a.line - b.line);
  return answer(opts, log, {
    banners, title: `table ${name}  (${decls.length ? "declared with Drizzle" : "external relation: not declared by any Drizzle pgTable"})`,
    resolvedData: res,
    fmt: (d) => `${d.kind.padEnd(15)} ${d.file}:${d.line}${d.symbol ? `  ${d.symbol}` : ""}${d.count > 1 ? `  (+${d.count - 1} more in file)` : ""}`,
    unresolvedData: unresolvedOf(index, "sql", (_, u) => (u.relations || []).includes(name)),
    coverage: [
      `${index.candidates.sql} database-operation candidates examined: Drizzle sql\`\` and sql.raw, Drizzle execute, pg Client/Pool query, typed table-symbol references`,
      `${unresolvedOf(index, "sql", (_, u) => !(u.relations || []).includes(name)).length + unresolvedOf(index, "table").length} other unresolved database sites name no relation statically and could touch any table: \`node scripts/map.mjs unresolved sql\` lists them`,
    ],
  });
}

function cmdPurpose(root, file, opts, log) {
  const { index, banners } = loadForQuery(root, opts);
  const r = index.files[file];
  if (!r) throw notFound("file", file, Object.keys(index.files));
  const sets = ["indexed", "headered", "sized"].filter((s) => index.sets[s].includes(file));
  return answer(opts, log, {
    banners, title: `purpose ${file}`,
    resolvedData: [{ purpose: r.purpose, subsystem: r.subsystem, size: r.size, sets }],
    fmt: (d) => `${d.purpose ?? "(no purpose line)"}  [subsystem ${d.subsystem ?? "none"}; ${d.size} lines; sets: ${d.sets.join(", ")}]`,
    unresolvedData: [], coverage: ["the file's leading comment, as indexed"],
  });
}

function cmdSubsystem(root, tag, opts, log) {
  const { index, banners } = loadForQuery(root, opts);
  const res = Object.entries(index.files).filter(([, r]) => r.subsystem === tag).map(([f, r]) => ({ file: f, purpose: r.purpose }));
  return answer(opts, log, {
    banners, title: `subsystem ${tag}`, resolvedData: res, fmt: (d) => `${d.file}  — ${d.purpose ?? ""}`,
    unresolvedData: [], coverage: [`${index.sets.headered.length} headered files; header-exempt files carry no tag`],
  });
}

const USAGE = `usage: node scripts/map.mjs <build|check|deps|dependents|route|routes|table|purpose|subsystem|unresolved|freeze|ratchet> [args] [--json] [--allow-stale] [--root <dir>]
see ${DOC}`;

export function run(argv, { log = console.log, err = console.error, cwd = process.cwd() } = {}) {
  const opts = { json: false, allowStale: false };
  const pos = [];
  let rootArg = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") opts.json = true;
    else if (a === "--allow-stale") opts.allowStale = true;
    else if (a === "--root") {
      // A bare or empty --root is an operator mistake, never "the current
      // checkout": refuse before any configuration is read or file written.
      const v = argv[++i];
      if (v === undefined || v === "" || v.startsWith("--")) { err(`--root needs a directory\n${USAGE}`); return 2; }
      rootArg = v;
    }
    else if (a === "--ratchet") pos.unshift("ratchet");
    else pos.push(a);
  }
  const [cmd, ...args] = pos;
  const need = (n) => {
    if (args.length < n) { err(USAGE); return false; }
    return true;
  };
  try {
    const root = repoRoot(rootArg !== null ? resolve(cwd, rootArg) : cwd);
    switch (cmd) {
      case "build": return cmdBuild(root, log);
      case "check": return cmdCheck(root, log, err);
      case "deps": return need(1) ? cmdDeps(root, args[0], opts, log) : 2;
      case "dependents": return need(1) ? cmdDependents(root, args[0], opts, log) : 2;
      case "route": return need(2) ? cmdRoute(root, args[0], args[1], opts, log) : 2;
      case "routes": return need(1) ? cmdRoutes(root, args[0], opts, log) : 2;
      case "table": return need(1) ? cmdTable(root, args[0], opts, log) : 2;
      case "purpose": return need(1) ? cmdPurpose(root, args[0], opts, log) : 2;
      case "subsystem": return need(1) ? cmdSubsystem(root, args[0], opts, log) : 2;
      case "unresolved": return cmdUnresolved(root, args[0], opts, log);
      case "freeze": return cmdBaseline(root, "freeze", log);
      case "ratchet": return cmdBaseline(root, "ratchet", log);
      default: err(USAGE); return 2;
    }
  } catch (e) {
    if (e instanceof MapError) {
      err(renderFailure(failure(e.rule, e.message, e.files || [], e.fix, e.anchor)));
      return e.code;
    }
    throw e;
  }
}

function main() {
  process.exitCode = run(process.argv.slice(2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

void fileURLToPath;
void relative;

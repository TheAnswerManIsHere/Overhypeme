#!/usr/bin/env node
// Docs-accuracy gate for the repo-native agent context system.
//
// Two checks, run over the shared context docs:
//   1. LINK CHECK  — every relative markdown link resolves to a real file/dir.
//   2. PATH CHECK  — every backticked token that looks like a repo path
//                    (starts with a known top-level dir, no glob/placeholder)
//                    points at something that actually exists.
//
// The point: a confidently-wrong doc is worse than no doc. This turns
// "hope the docs stay true" into a merge gate. Dependency-free (plain Node),
// so it runs in the Build job without install.
//
// Run locally:  node scripts/check-docs-accuracy.mjs   (or: pnpm run check:docs)

import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ── Which files get which check ───────────────────────────────────────────────
// LINK check runs on all of these. PATH check runs on the durable "library"
// only — the shared source-of-truth docs that MUST stay accurate. CLAUDE.md is
// deliberately path-check-exempt: it cites historical/transient example
// filenames (e.g. a *_TEST_RUN.md that David deletes after Replit runs it),
// which is expected, not a bug. .claude/skills is link-check-only for the same
// reason: third-party/vendored skills (see
// .claude/skills/VENDORED_SKILLS_NOTICE.md) describe generic auditing
// heuristics with illustrative example paths (e.g. citing `.github/SECURITY.md`
// as something to check for in whatever repo the skill is later run against)
// that were never meant to resolve inside this repo specifically. Their
// internal cross-references (SKILL.md → references/*.md) still must resolve,
// so they keep the LINK check.
const LIBRARY_DIRS = ["docs/ai-context", "docs/engineering", "docs/manual"];
const LIBRARY_EXTRA = ["AGENTS.md", ".agents/PLANS.md"];
const LINK_ONLY_EXTRA = ["CLAUDE.md"];
const LINK_ONLY_DIRS = [".claude/skills"];

// Nested CLAUDE.md memory files (e.g. lib/api-zod/CLAUDE.md) load contextually
// when working under their directory and carry relative links that must
// resolve from that directory — the root CLAUDE.md entry above does not reach
// them, which is how a broken link shipped in the first nested memory file.
const NESTED_SKIP_BASENAMES = new Set(["node_modules", ".git", "dist", "build", "coverage"]);
// Full relative paths (not basenames) so this only matches the specific
// ephemeral root, not any directory that happens to be named "worktrees".
const NESTED_SKIP_PATHS = new Set([".claude/worktrees"]); // per-session ephemeral, see .gitignore
function findNestedClaudeMds(dir = "") {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return [];
  const out = [];
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    const rel = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!NESTED_SKIP_BASENAMES.has(entry.name) && !NESTED_SKIP_PATHS.has(rel)) {
        out.push(...findNestedClaudeMds(rel));
      }
    } else if (entry.name === "CLAUDE.md" && dir !== "") {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function walk(dir) {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return [];
  const out = [];
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    const rel = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(rel));
    else if (entry.name.endsWith(".md")) out.push(rel);
  }
  return out;
}

function pathExists(relPath) {
  const clean = relPath.replace(/\/$/, "");
  return existsSync(join(ROOT, clean));
}

// Blanks out fenced code blocks (```…``` / ~~~…~~~, any nesting depth) so
// illustrative markdown inside an example — a skill teaching other skills how
// to structure their own reference links, e.g. — never reads as a real,
// checkable link. Matches CommonMark's fence-closing rule (same character,
// length >= opener) so a nested shorter fence doesn't prematurely close the
// outer one.
function stripFencedBlocks(text) {
  const FENCE_LINE_RE = /^\s{0,3}(`{3,}|~{3,})/;
  let fenceChar = null;
  let fenceLen = 0;
  return text
    .split("\n")
    .map((line) => {
      const m = line.match(FENCE_LINE_RE);
      if (m) {
        const [marker] = m;
        const char = marker.trim()[0];
        const len = marker.trim().length;
        if (fenceChar === null) {
          fenceChar = char;
          fenceLen = len;
          return "";
        }
        if (char === fenceChar && len >= fenceLen) {
          fenceChar = null;
          fenceLen = 0;
          return "";
        }
      }
      return fenceChar !== null ? "" : line;
    })
    .join("\n");
}

// ── Collect target files ──────────────────────────────────────────────────────
const libraryFiles = [...LIBRARY_DIRS.flatMap(walk), ...LIBRARY_EXTRA].filter(
  (f) => existsSync(join(ROOT, f)),
);

const linkFiles = [
  ...libraryFiles,
  ...LINK_ONLY_EXTRA,
  ...LINK_ONLY_DIRS.flatMap(walk),
  ...findNestedClaudeMds(),
].filter((f) => existsSync(join(ROOT, f)));

const errors = [];

// ── 1. LINK CHECK ─────────────────────────────────────────────────────────────
// Matches `](target)` where target is not an http(s) link or a pure anchor.
// Skips `{template}` placeholders — e.g. Claude Code's `{baseDir}` skill-
// authoring convention, substituted at runtime and never a literal repo path.
const LINK_RE = /\]\((?!https?:\/\/|#|mailto:)([^)]+)\)/g;
for (const file of linkFiles) {
  const text = stripFencedBlocks(readFileSync(join(ROOT, file), "utf8"));
  const fileDir = dirname(join(ROOT, file));
  for (const m of text.matchAll(LINK_RE)) {
    const target = m[1].split("#")[0].trim();
    if (!target || target.startsWith("{")) continue;
    const abs = resolve(fileDir, target);
    if (!existsSync(abs.replace(/\/$/, ""))) {
      errors.push(`${file}: broken link → ${m[1]}`);
    }
  }
}

// ── 2. PATH CHECK ─────────────────────────────────────────────────────────────
// A backticked token is treated as a repo path only if it starts with a known
// top-level dir AND contains no glob/placeholder/expression characters. This is
// deliberately conservative: better to skip an ambiguous token than false-alarm
// on a code symbol like `resolveEnrichment()` or a value like `he/him`.
const TOP_LEVEL = /^(docs|lib|artifacts|scripts|cloudflare|\.agents|\.claude|\.github)\//;
const SKIP_CHARS = /[*<>{}|()@=:\s…]/; // glob, placeholder, expression, or prose
const BACKTICK_RE = /`([^`]+)`/g;
for (const file of libraryFiles) {
  const text = readFileSync(join(ROOT, file), "utf8");
  const seen = new Set();
  for (const m of text.matchAll(BACKTICK_RE)) {
    let tok = m[1].trim().replace(/[.,;]+$/, ""); // strip trailing prose punctuation
    if (!tok || seen.has(tok)) continue;
    if (!TOP_LEVEL.test(tok)) continue;
    if (SKIP_CHARS.test(tok)) continue;
    seen.add(tok);
    if (!pathExists(tok)) {
      errors.push(`${file}: cited path does not exist → \`${tok}\``);
    }
  }
}

// ── Report ────────────────────────────────────────────────────────────────────
if (errors.length) {
  console.error(`\n✗ docs-accuracy: ${errors.length} problem(s) found:\n`);
  for (const e of errors) console.error("  " + e);
  console.error(
    "\nFix the doc to name the real path/link (the code is the source of truth),\n" +
      "or, for an intentional glob/placeholder, add a * / <> so it's not checked.\n",
  );
  process.exit(1);
}

console.log(
  `✓ docs-accuracy: ${linkFiles.length} files, all relative links resolve and ` +
    `all cited repo paths exist.`,
);

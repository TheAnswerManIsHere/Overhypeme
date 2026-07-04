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
// which is expected, not a bug.
const LIBRARY_DIRS = ["docs/ai-context", "docs/engineering"];
const LIBRARY_EXTRA = ["AGENTS.md", ".agents/PLANS.md"];
const LINK_ONLY_EXTRA = ["CLAUDE.md"];

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

// ── Collect target files ──────────────────────────────────────────────────────
const libraryFiles = [
  ...LIBRARY_DIRS.flatMap(walk),
  ...LIBRARY_EXTRA,
  ...walk(".claude/skills"),
].filter((f) => existsSync(join(ROOT, f)));

const linkFiles = [...libraryFiles, ...LINK_ONLY_EXTRA].filter((f) =>
  existsSync(join(ROOT, f)),
);

const errors = [];

// ── 1. LINK CHECK ─────────────────────────────────────────────────────────────
// Matches `](target)` where target is not an http(s) link or a pure anchor.
const LINK_RE = /\]\((?!https?:\/\/|#|mailto:)([^)]+)\)/g;
for (const file of linkFiles) {
  const text = readFileSync(join(ROOT, file), "utf8");
  const fileDir = dirname(join(ROOT, file));
  for (const m of text.matchAll(LINK_RE)) {
    const target = m[1].split("#")[0].trim();
    if (!target) continue;
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

/**
 * Regenerate the public legal pages from `docs/legal/`.
 *
 * `docs/legal/*.md` is the single source of truth for each legal document's
 * text and version (launch Phase 14, plan S-a). This script only ever READS
 * those files and writes a committed generated module per document under
 * `src/generated/legal/`, the shape `generate:help` established.
 *
 * Two rules the generated pages depend on, enforced here:
 *   1. **The version names the exact text.** Every document carries a
 *      `version:` in its front matter, and `docs/legal/versions.lock.json`
 *      records the sha256 of the body published under each version. A body
 *      that changes while its version does not fails generation, because an
 *      acceptance record stores only the version: two texts under one version
 *      would make "which text did this member accept?" unanswerable.
 *   2. **Nothing executable reaches the page.** The source may use only the
 *      plain Markdown vocabulary below; raw HTML fails generation.
 *
 * Usage:
 *   pnpm --filter @workspace/overhype-me run generate:legal        (write)
 *   pnpm --filter @workspace/overhype-me run check:legal-content   (CI: fail on drift)
 *
 * @purpose Generates the public legal pages (Terms, Privacy, Copyright, Guidelines) from docs/legal/*.md and refuses a text change without a version change.
 * @subsystem public-site
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import rehypeStringify from "rehype-stringify";
import { visit } from "unist-util-visit";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const LEGAL_DIR = resolve(REPO_ROOT, "docs", "legal");
const LOCK_FILE = resolve(LEGAL_DIR, "versions.lock.json");
const OUT_DIR = resolve(__dirname, "..", "src", "generated", "legal");

/** The documents, in footer order. The slug is the page's address. */
export const LEGAL_SLUGS = ["terms", "privacy", "copyright", "guidelines"] as const;
export type LegalSlug = (typeof LEGAL_SLUGS)[number];

const ALLOWED_NODES = new Set([
  "root", "heading", "paragraph", "text", "emphasis", "strong", "inlineCode",
  "link", "list", "listItem", "blockquote", "table", "tableRow", "tableCell",
  "thematicBreak", "break",
]);

export class LegalGenerationError extends Error {}

function fail(message: string): never {
  throw new LegalGenerationError(message);
}

export interface ParsedLegalDoc {
  slug: string;
  title: string;
  version: string;
  summary: string;
  body: string;
}

/** Front matter is three `key: value` lines between `---` fences; nothing else is read. */
export function parseLegalDoc(slug: string, source: string): ParsedLegalDoc {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(source.replace(/\r\n/g, "\n"));
  if (!m) fail(`docs/legal/${slug}.md: missing front matter (--- title / version / summary ---)`);
  const fields: Record<string, string> = {};
  for (const line of m[1]!.split("\n")) {
    const kv = /^([a-z]+):\s*(.+)$/.exec(line.trim());
    if (!kv) fail(`docs/legal/${slug}.md: unreadable front-matter line ${JSON.stringify(line)}`);
    fields[kv[1]!] = kv[2]!.trim();
  }
  for (const key of ["title", "version", "summary"]) {
    if (!fields[key]) fail(`docs/legal/${slug}.md: front matter needs "${key}"`);
  }
  if (!/^\d{4}-\d{2}-\d{2}(\.\d+)?$/.test(fields.version!)) {
    fail(`docs/legal/${slug}.md: version must be a date, optionally with a .N suffix (got ${fields.version})`);
  }
  return { slug, title: fields.title!, version: fields.version!, summary: fields.summary!, body: m[2]!.trim() + "\n" };
}

export function bodyHash(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

export type VersionLock = Record<string, { version: string; sha256: string }>;

/**
 * Rule 1. A document whose version is unchanged must have an unchanged body;
 * a changed version must not reuse an older version string (the lock holds the
 * latest version only, so "unchanged" means equal to the locked one).
 */
export function checkVersionRule(doc: ParsedLegalDoc, lock: VersionLock): void {
  const locked = lock[doc.slug];
  if (!locked) return;
  const hash = bodyHash(doc.body);
  if (locked.version === doc.version && locked.sha256 !== hash) {
    fail(
      `docs/legal/${doc.slug}.md: the text changed but its version (${doc.version}) did not. ` +
        `Change the version in its front matter: an accepted version must name exactly one text.`,
    );
  }
  if (locked.version !== doc.version && doc.version < locked.version) {
    fail(`docs/legal/${doc.slug}.md: version ${doc.version} is older than the published ${locked.version}.`);
  }
}

/** The same executable-content checks as generate-help-content.ts, kept equal on purpose. */
const EXECUTABLE: [RegExp, string][] = [
  [/<script[\s>]/i, "<script>"],
  [/<iframe[\s>]/i, "<iframe>"],
  [/<object[\s>]/i, "<object>"],
  [/<embed[\s>]/i, "<embed>"],
  [/\son[a-z]+\s*=/i, "an inline event handler"],
  [/javascript:/i, "a javascript: URL"],
  [/data:text\/html/i, "a data:text/html URL"],
];

export function renderLegalHtml(slug: string, body: string): string {
  const processor = unified().use(remarkParse).use(remarkGfm).use(remarkRehype).use(rehypeStringify);
  const tree = processor.parse(body);
  visit(tree as never, (node: { type: string; url?: string }) => {
    if (!ALLOWED_NODES.has(node.type)) {
      fail(`docs/legal/${slug}.md: "${node.type}" is not allowed in a legal document (plain Markdown only)`);
    }
    if (node.type === "link" && node.url && !/^(\/|https:\/\/|mailto:)/.test(node.url)) {
      fail(`docs/legal/${slug}.md: link "${node.url}" must be a site path, an https URL or a mailto`);
    }
  });
  const html = processor.stringify(processor.runSync(tree) as never) as string;
  for (const [re, label] of EXECUTABLE) {
    if (re.test(html)) fail(`docs/legal/${slug}.md: rendered HTML contains ${label}`);
  }
  return html;
}

function moduleFor(doc: ParsedLegalDoc, html: string): string {
  return [
    "// @generated by scripts/generate-legal-content.ts — DO NOT EDIT.",
    `// Source of truth: docs/legal/${doc.slug}.md. Run: pnpm --filter @workspace/overhype-me run generate:legal`,
    "",
    `export const slug = ${JSON.stringify(doc.slug)};`,
    `export const title = ${JSON.stringify(doc.title)};`,
    `export const version = ${JSON.stringify(doc.version)};`,
    `export const summary = ${JSON.stringify(doc.summary)};`,
    `export const html = ${JSON.stringify(html)};`,
    "",
  ].join("\n");
}

function indexModule(docs: ParsedLegalDoc[]): string {
  return [
    "// @generated by scripts/generate-legal-content.ts — DO NOT EDIT.",
    "// Source of truth: docs/legal/. Run: pnpm --filter @workspace/overhype-me run generate:legal",
    "",
    "export interface LegalDocMeta { slug: string; title: string; version: string; summary: string }",
    "",
    "/** Each document's address is `/${slug}`. Routes, the set-up redirect and the name sheet read this list. */",
    `export const LEGAL_SLUGS = ${JSON.stringify(docs.map((d) => d.slug))} as const;`,
    "",
    `export const LEGAL_DOCS: LegalDocMeta[] = ${JSON.stringify(
      docs.map(({ slug, title, version, summary }) => ({ slug, title, version, summary })),
      null,
      2,
    )};`,
    "",
    "/** The current version of each document, which an acceptance record stores. */",
    `export const LEGAL_VERSIONS: Record<string, string> = ${JSON.stringify(
      Object.fromEntries(docs.map((d) => [d.slug, d.version])),
      null,
      2,
    )};`,
    "",
  ].join("\n");
}

function main(): void {
  const check = process.argv.includes("--check");
  const onDisk = readdirSync(LEGAL_DIR).filter((f) => f.endsWith(".md") && f !== "README.md").map((f) => f.slice(0, -3)).sort();
  const expected = [...LEGAL_SLUGS].sort();
  if (JSON.stringify(onDisk) !== JSON.stringify(expected)) {
    fail(`docs/legal/ holds ${onDisk.join(", ")}; expected exactly ${expected.join(", ")}`);
  }
  const lock: VersionLock = existsSync(LOCK_FILE) ? JSON.parse(readFileSync(LOCK_FILE, "utf8")) : {};
  const docs = LEGAL_SLUGS.map((slug) => parseLegalDoc(slug, readFileSync(resolve(LEGAL_DIR, `${slug}.md`), "utf8")));

  const outputs = new Map<string, string>();
  const nextLock: VersionLock = {};
  for (const doc of docs) {
    checkVersionRule(doc, lock);
    outputs.set(resolve(OUT_DIR, `${doc.slug}.ts`), moduleFor(doc, renderLegalHtml(doc.slug, doc.body)));
    nextLock[doc.slug] = { version: doc.version, sha256: bodyHash(doc.body) };
  }
  outputs.set(resolve(OUT_DIR, "index.ts"), indexModule(docs));
  outputs.set(LOCK_FILE, JSON.stringify(nextLock, null, 2) + "\n");

  const stale = [...outputs].filter(([path, text]) => !existsSync(path) || readFileSync(path, "utf8") !== text).map(([p]) => p);
  if (check) {
    if (stale.length) {
      fail(
        `Legal pages are out of date with docs/legal/:\n  ${stale.map((p) => p.replace(REPO_ROOT + "/", "")).join("\n  ")}\n` +
          "Run: pnpm --filter @workspace/overhype-me run generate:legal",
      );
    }
    console.log("Legal pages are in sync with docs/legal/.");
    return;
  }
  mkdirSync(OUT_DIR, { recursive: true });
  for (const [path, text] of outputs) writeFileSync(path, text);
  console.log(`Wrote ${outputs.size} files (${stale.length} changed).`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    if (err instanceof LegalGenerationError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}

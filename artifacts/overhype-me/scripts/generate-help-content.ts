/**
 * Regenerate the in-app admin help content from `docs/manual/`.
 *
 * `docs/manual/*.md` is the single source of truth; this script only ever
 * READS it. Output is a committed generated module tree under
 * `src/generated/help/`, in the shape `generate:field-docs` established —
 * except the direction is inverted (source in `docs/`, artifact in code),
 * which is why the freshness gate lives in the always-on Build job rather
 * than the Frontend Test suite: `scripts/classify-ci-paths.mjs` treats all of
 * `docs/**` as inert, so a chapter-only PR skips the heavy suites entirely.
 *
 * Generation FAILS rather than emitting a plausible-but-wrong artifact when:
 *   - disk and the README contents table disagree about which chapters exist;
 *   - a chapter's number disagrees across any of its four representations
 *     (table ordinal, filename prefix, `# Chapter N` heading, the previous
 *     chapter's `**Next:** chapter N` footer);
 *   - a link cannot be classified, or its `#fragment` does not resolve to a
 *     real heading in its *rendered destination*;
 *   - the source uses markdown outside the declared vocabulary (parsers
 *     degrade unknown syntax to a paragraph instead of throwing, so this is
 *     checked explicitly);
 *   - the emitted HTML contains anything executable.
 *
 * Usage:  pnpm --filter @workspace/overhype-me run generate:help
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { resolve, dirname, relative, join } from "node:path";
import { fileURLToPath } from "node:url";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import rehypeStringify from "rehype-stringify";
import { toString as mdastToString } from "mdast-util-to-string";
import { visit } from "unist-util-visit";
import GithubSlugger from "github-slugger";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const MANUAL_DIR = resolve(REPO_ROOT, "docs", "manual");
const OUT_DIR = resolve(__dirname, "..", "src", "generated", "help");

const GITHUB_BLOB = "https://github.com/TheAnswerManIsHere/Overhypeme/blob/main";
const GITHUB_TREE = "https://github.com/TheAnswerManIsHere/Overhypeme/tree/main";
const GITHUB_RAW = "https://raw.githubusercontent.com/TheAnswerManIsHere/Overhypeme/main";

/** In-app route base. Chapter routes are `${HELP_BASE}/${slug}`. */
const HELP_BASE = "/admin/help";

/**
 * The markdown vocabulary `docs/manual/` actually uses. Anything outside this
 * fails generation instead of silently rendering as a paragraph — the failure
 * mode that makes a converter swap invisible. `html` is allowed only for
 * comments (see assertVocabulary).
 */
const ALLOWED_NODES = new Set([
  "root", "heading", "paragraph", "text", "emphasis", "strong", "inlineCode",
  "code", "link", "list", "listItem", "blockquote", "table", "tableRow",
  "tableCell", "thematicBreak", "break", "delete", "html", "image",
]);

class GenerationError extends Error {}

function fail(message: string): never {
  throw new GenerationError(message);
}

// ── Heading anchors ──────────────────────────────────────────────────────────
// Must match GitHub's algorithm exactly, so a link that works on GitHub works
// in-app and vice versa. `github-slugger` IS that algorithm — notably it keeps
// underscores, which a hand-rolled `[^a-z0-9 -]` strip does not (that mistake
// reports false breakage on any heading containing an identifier).

interface Section { id: string; title: string; depth: number }

function collectSections(tree: unknown): Section[] {
  const slugger = new GithubSlugger();
  const sections: Section[] = [];
  visit(tree as never, "heading", (node: { depth: number }) => {
    const title = mdastToString(node as never);
    sections.push({ id: slugger.slug(title), title, depth: node.depth });
  });
  return sections;
}

/** Heading anchors for an arbitrary repo markdown file, cached. */
const anchorCache = new Map<string, Set<string>>();
function anchorsOfFile(absPath: string): Set<string> {
  const cached = anchorCache.get(absPath);
  if (cached) return cached;
  const tree = parseMarkdown(readFileSync(absPath, "utf8"));
  const set = new Set(collectSections(tree).map((s) => s.id));
  anchorCache.set(absPath, set);
  return set;
}

function parseMarkdown(src: string): unknown {
  return unified().use(remarkParse).use(remarkGfm).parse(src);
}

// ── Documents ────────────────────────────────────────────────────────────────

interface HelpDoc {
  /** URL slug. Chapters: the filename without `.md`. README: `""` (the index). */
  slug: string;
  kind: "readme" | "chapter";
  /** Chapter ordinal; undefined for the README. */
  number?: number;
  title: string;
  file: string;
  source: string;
  sections: Section[];
  html: string;
}

/**
 * The contents table in README.md is the Manual's declared source of truth for
 * chapter numbers and order — filename sort is wrong (`10-` sorts before `2-`)
 * and a hand-kept list here would be a second source of truth.
 */
function parseContentsTable(readmeSrc: string): { number: number; file: string }[] {
  // Read from the PARSED table node, not a raw-source regex. A table-shaped
  // line inside a fenced code block or an HTML comment is not part of the
  // rendered Contents table, but a source regex cannot tell the difference —
  // so a decoy row could supply an expected ordinal while a real row was
  // removed or reordered, and the disk/number checks would still pass.
  const tree = parseMarkdown(readmeSrc) as { children: unknown[] };
  const rows: { number: number; file: string }[] = [];

  // Bind to the table that FOLLOWS the `## Contents` heading. Picking the
  // largest candidate meant any other numbered-link table — especially one
  // earlier in the file — could stand in for the declared source of truth
  // while the real Contents table lost or reordered a row.
  const children = tree.children as { type: string; depth?: number; children?: unknown[] }[];
  const contentsAt = children.findIndex(
    (n) => n.type === "heading" && mdastToString(n as never).trim().toLowerCase() === "contents",
  );
  if (contentsAt === -1) fail("README.md has no `## Contents` heading to read the chapter table from.");

  for (const node of children.slice(contentsAt + 1)) {
    // Stop at the next heading of the same or higher level — the Contents
    // table is the one inside that section, not merely somewhere after it.
    if (node.type === "heading" && (node.depth ?? 6) <= (children[contentsAt].depth ?? 2)) break;
    if (node.type !== "table") continue;
    const bodyRows = (node.children ?? []).slice(1) as { children?: unknown[] }[];
    const parsed: { number: number; file: string }[] = [];
    for (const row of bodyRows) {
      const cells = (row.children ?? []) as unknown[];
      if (cells.length < 2) continue;
      const num = Number(mdastToString(cells[0] as never).trim());
      if (!Number.isInteger(num)) continue;
      // The chapter cell must contain a real link; its label and target must
      // agree, which is the invariant the old regex encoded inline.
      let target: string | null = null;
      let label: string | null = null;
      visit(cells[1] as never, "link", (link: { url: string }) => {
        if (target === null) {
          target = link.url.replace(/^\.\//, "");
          label = mdastToString(link as never).trim();
        }
      });
      if (target === null) continue;
      if (label !== target) {
        fail(`README contents table row ${num}: label \`${label}\` does not match link target \`${target}\`.`);
      }
      parsed.push({ number: num, file: target });
    }
    if (parsed.length > 0) { rows.push(...parsed); break; }
  }

  if (rows.length === 0) fail("Could not parse any rows from the rendered README contents table.");
  return rows;
}

/**
 * Every representation of a chapter's number must agree. README.md itself
 * states the rule and notes that nothing enforced it; membership alone does
 * not, because reordering a table row leaves every file still present.
 */
function assertNumbering(rows: { number: number; file: string }[], sources: Map<string, string>): void {
  const onDisk = readdirSync(MANUAL_DIR).filter((f) => /^\d+-.*\.md$/.test(f)).sort();
  const inTable = rows.map((r) => r.file).slice().sort();
  const missingFromTable = onDisk.filter((f) => !inTable.includes(f));
  const missingFromDisk = inTable.filter((f) => !onDisk.includes(f));
  if (missingFromTable.length) fail(`Chapter file(s) on disk but absent from the README contents table: ${missingFromTable.join(", ")}`);
  if (missingFromDisk.length) fail(`Chapter file(s) in the README contents table but absent from disk: ${missingFromDisk.join(", ")}`);

  rows.forEach((row, i) => {
    const expected = i + 1;
    if (row.number !== expected) {
      fail(`README contents table is out of order: row ${i + 1} is numbered ${row.number}. Rows must be sequential from 1.`);
    }
    // 2. Filename prefix.
    const prefix = Number(row.file.split("-")[0]);
    if (prefix !== row.number) {
      fail(`Chapter number disagreement: contents table says ${row.number} but the filename is \`${row.file}\`.`);
    }
    // 3. The chapter's own `# Chapter N · Title` heading — read from the
    //    PARSED tree's first depth-1 heading, not by regex over raw source. A
    //    fenced code example containing a line like `# Chapter 4 · …` would
    //    satisfy a source regex while the real H1 said something else.
    const tree = parseMarkdown(sources.get(row.file)!) as { children: { type: string; depth?: number }[] };
    const h1 = tree.children.find((n) => n.type === "heading" && n.depth === 1);
    if (!h1) fail(`\`${row.file}\` has no top-level \`# Chapter N · Title\` heading.`);
    const headingMatch = /^Chapter\s+(\d+)\s+·\s+(.+)$/.exec(mdastToString(h1 as never).trim());
    if (!headingMatch) {
      fail(`\`${row.file}\`'s first heading is not of the form \`# Chapter N · Title\`: "${mdastToString(h1 as never).trim().slice(0, 60)}".`);
    }
    if (Number(headingMatch[1]) !== row.number) {
      fail(`Chapter number disagreement in \`${row.file}\`: contents table says ${row.number}, its heading says ${headingMatch[1]}.`);
    }
    // 4. The PREVIOUS chapter's `**Next:** chapter N` footer — the README calls
    //    this "the easiest of the three to miss".
    if (i > 0) {
      const prev = rows[i - 1];
      const nextNum = parsedNextFooter(sources.get(prev.file)!);
      if (nextNum === null) {
        fail(`\`${prev.file}\` has no rendered \`**Next:** chapter N\` footer, but chapter ${row.number} follows it.`);
      }
      if (nextNum !== row.number) {
        fail(`\`${prev.file}\` footer points at chapter ${nextNum}, but chapter ${row.number} follows it.`);
      }
    }
  });

  // The last chapter must NOT have a Next footer pointing anywhere.
  const last = rows[rows.length - 1];
  const lastNext = parsedNextFooter(sources.get(last.file)!);
  if (lastNext !== null) {
    fail(`\`${last.file}\` is the last chapter but its footer points at chapter ${lastNext}.`);
  }
}

/**
 * The chapter number in a RENDERED `**Next:** chapter N` footer, or null.
 *
 * Read from the parsed tree for the same reason the H1 is: a fenced code
 * example whose first line is `**Next:** chapter 7` would satisfy a raw-source
 * regex, and the four-representation gate would stay green on a chapter with
 * no usable footer at all. Only a top-level paragraph counts.
 */
/**
 * A chapter's display title, from its top-level H1 only.
 *
 * NOT `sections[0]`: `collectSections` visits every heading at any depth, so a
 * heading nested inside an introductory blockquote would come first and be
 * published as the chapter's title in the sidebar and every search result.
 * Same document-order-versus-top-level-order confusion as the search-index
 * misattribution — this is that class's fourth site.
 */
function chapterTitle(tree: unknown, file: string): string {
  const children = (tree as { children: { type: string; depth?: number }[] }).children;
  const h1 = children.find((n) => n.type === "heading" && n.depth === 1);
  if (!h1) fail(`\`${file}\` has no top-level heading to take a title from.`);
  return mdastToString(h1 as never).trim().replace(/^Chapter\s+\d+\s+·\s+/, "");
}

function parsedNextFooter(src: string): number | null {
  const tree = parseMarkdown(src) as { children: { type: string; children?: unknown[] }[] };
  // Search from the END. A chapter must END with its navigation footer; an
  // earlier `**Next:** chapter N` paragraph is not that footer, and accepting
  // one let the gate pass on a chapter whose real footer had been removed.
  // Only the closing run of the document is eligible — the footer is followed
  // at most by the "Verified against …" provenance line.
  const tail = tree.children.slice(-4);
  for (const node of tail) {
    if (node.type !== "paragraph") continue;
    // Structure, not flattened text: the paragraph must OPEN with a `strong`
    // node reading "Next:". `mdastToString` discards the bold marks, so a
    // plain `Next: chapter 6` line anywhere in the chapter would otherwise
    // satisfy the gate with no real footer present.
    const first = (node.children ?? [])[0] as { type: string } | undefined;
    if (!first || first.type !== "strong") continue;
    if (mdastToString(first as never).trim() !== "Next:") continue;
    const m = /^chapter\s+(\d+)/.exec(
      mdastToString(node as never).trim().slice("Next:".length).trim(),
    );
    if (m) return Number(m[1]);
  }
  return null;
}

// ── Vocabulary ───────────────────────────────────────────────────────────────

/**
 * True only if the block is entirely HTML comments and whitespace.
 *
 * A greedy `/^<!--[\s\S]*-->$/` is NOT sufficient: it also accepts
 * `<!-- a --> <b>visible</b> <!-- b -->`, because the `[\s\S]*` swallows the
 * markup between the two comments. `remarkRehype` then drops the whole node
 * while GitHub renders the `<b>` — a rendering-parity break that generation
 * would have waved through.
 */
function isOnlyComments(raw: string): boolean {
  let rest = raw.trim();
  if (rest === "") return false;
  while (rest.length > 0) {
    if (!rest.startsWith("<!--")) return false;
    const end = rest.indexOf("-->");
    if (end === -1) return false;
    rest = rest.slice(end + 3).trim();
  }
  return true;
}

/**
 * GitHub's alert syntax (`> [!NOTE]`, `[!WARNING]`, …) parses as an ordinary
 * blockquote, so the node-type check above cannot see it — but GitHub renders
 * a titled, coloured callout while this converter emits a plain quotation with
 * a literal `[!NOTE]` in it. That is exactly the silent degradation decision 16
 * requires generation to reject rather than ship.
 */
const GITHUB_ALERT = /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/;

function assertVocabulary(tree: unknown, file: string): void {
  visit(tree as never, (node: { type: string; value?: string; children?: unknown[] }) => {
    if (!ALLOWED_NODES.has(node.type)) {
      fail(
        `\`${file}\` uses markdown that this generator does not support: node type \`${node.type}\`. ` +
        `Either add it to ALLOWED_NODES (and verify it converts to the same thing GitHub renders) or change the source.`,
      );
    }
    if (node.type === "html" && !isOnlyComments(node.value ?? "")) {
      fail(
        `\`${file}\` contains raw HTML that is not purely comments: ${(node.value ?? "").trim().slice(0, 80)}. ` +
        `Raw HTML is dropped during conversion, so it would render on GitHub but vanish in-app.`,
      );
    }
    if (node.type === "blockquote" && GITHUB_ALERT.test(mdastToString(node as never))) {
      fail(
        `\`${file}\` uses GitHub alert syntax (\`> [!NOTE]\` and friends). GitHub renders a titled callout; ` +
        `this converter would emit a plain blockquote containing the literal marker. Rewrite it as ordinary ` +
        `markdown, or teach the generator a faithful alert transform first.`,
      );
    }
  });
}

// ── Link rewriting ───────────────────────────────────────────────────────────

interface LinkTargets {
  /** chapter filename -> slug */
  chapterSlug: Map<string, string>;
  /** doc slug -> its rendered anchors */
  renderedAnchors: Map<string, Set<string>>;
}

function rewriteLinks(tree: unknown, file: string, ownAnchors: Set<string>, targets: LinkTargets): void {
  // `image` is in the supported vocabulary, so its `src` needs the same
  // treatment: an untouched relative src would resolve under `/admin/help/…`
  // and 404, while resolving correctly on GitHub. Rewriting it to the GitHub
  // raw/blob URL keeps the two renderings equivalent.
  visit(tree as never, "image", (node: { url: string; alt?: string }) => {
    if (/^(https?:)?\/\//.test(node.url) || node.url.startsWith("data:")) return;
    const abs = resolve(MANUAL_DIR, node.url.split("#")[0]);
    if (!existsSync(abs)) {
      fail(`\`${file}\` embeds an image at \`${node.url}\`, which does not exist.`);
    }
    node.url = `${GITHUB_RAW}/${relative(REPO_ROOT, abs)}`;
  });

  visit(tree as never, "link", (node: { url: string; data?: Record<string, unknown> }) => {
    const url = node.url;
    if (/^(https?:)?\/\//.test(url) || url.startsWith("mailto:")) {
      node.data = { ...(node.data ?? {}), hProperties: { target: "_blank", rel: "noopener noreferrer" } };
      return;
    }

    const hashAt = url.indexOf("#");
    const rawTarget = hashAt === -1 ? url : url.slice(0, hashAt);
    const fragment = hashAt === -1 ? "" : url.slice(hashAt + 1);

    // Bare in-page anchor.
    if (rawTarget === "") {
      if (!fragment) fail(`\`${file}\` has an empty link target.`);
      if (!ownAnchors.has(fragment)) {
        fail(`\`${file}\` links to in-page anchor \`#${fragment}\`, which is not a heading in that document.`);
      }
      return;
    }

    const cleaned = rawTarget.replace(/^\.\//, "");
    const absTarget = resolve(MANUAL_DIR, rawTarget);
    const repoRel = relative(REPO_ROOT, absTarget);

    // Intra-manual: a chapter, or the README (which renders at the help index).
    const isIntraManual = absTarget.startsWith(MANUAL_DIR + "/") || absTarget === MANUAL_DIR;
    if (isIntraManual && cleaned.endsWith(".md")) {
      const base = cleaned.split("/").pop()!;
      const destSlug = base === "README.md" ? "" : targets.chapterSlug.get(base);
      if (destSlug === undefined) {
        fail(`\`${file}\` links to \`${url}\`, which is inside docs/manual/ but is not a known chapter or the README.`);
      }
      // The basename alone is not enough: a mistyped directory with a real
      // basename would rewrite to a working in-app route while the same link
      // stayed broken on GitHub. Require the path to BE the canonical file.
      if (absTarget !== join(MANUAL_DIR, base)) {
        fail(
          `\`${file}\` links to \`${url}\`, which resolves to \`${repoRel}\` — not the canonical ` +
          `\`docs/manual/${base}\`. It would work in-app and 404 on GitHub.`,
        );
      }
      // Fragments validate against the RENDERED destination, not the source
      // file. They coincide for chapters and diverge everywhere else, which is
      // how a perfectly valid source anchor can still land nowhere in-app.
      if (fragment) {
        const destAnchors = targets.renderedAnchors.get(destSlug);
        if (!destAnchors) {
          fail(`\`${file}\` links to \`${url}\`, but nothing renders \`${base}\` in-app.`);
        }
        if (!destAnchors.has(fragment)) {
          fail(`\`${file}\` links to \`${url}\`, but \`#${fragment}\` is not a heading in its rendered destination.`);
        }
      }
      node.url = destSlug === "" ? `${HELP_BASE}${fragment ? `#${fragment}` : ""}` : `${HELP_BASE}/${destSlug}${fragment ? `#${fragment}` : ""}`;
      // Carries the UNBASED path, not a boolean marker. The renderer needs it
      // to (a) prefix the router base — these are raw anchors inside generated
      // HTML, so wouter's <Link> base handling never sees them — and (b) route
      // the click instead of letting the browser do a full document load.
      //
      // The value must be the path itself rather than "true": once the base is
      // prefixed onto `href`, the href alone can no longer tell you what the
      // unbased path was, which is the ambiguity that broke base handling when
      // BASE_PATH is itself a route prefix.
      node.data = { ...(node.data ?? {}), hProperties: { "data-help-internal": node.url } };
      return;
    }

    // Everything else repo-relative resolves to GitHub, in a new tab.
    if (!existsSync(absTarget)) {
      fail(`\`${file}\` links to \`${url}\`, which does not exist at \`${repoRel}\`.`);
    }
    const isDir = statSync(absTarget).isDirectory();
    if (fragment && !isDir) {
      // The target file is in this repo, so its anchors are checkable — and
      // there is no reason to check intra-manual fragments but not these.
      if (!anchorsOfFile(absTarget).has(fragment)) {
        fail(`\`${file}\` links to \`${url}\`, but \`#${fragment}\` is not a heading in \`${repoRel}\`.`);
      }
    }
    node.url = `${isDir ? GITHUB_TREE : GITHUB_BLOB}/${repoRel}${fragment ? `#${fragment}` : ""}`;
    node.data = { ...(node.data ?? {}), hProperties: { target: "_blank", rel: "noopener noreferrer", "data-external": "true" } };
  });
}

// ── Search index ─────────────────────────────────────────────────────────────

interface SearchEntry { doc: string; section: string; sectionTitle: string; text: string }

/**
 * Rendered-VISIBLE text only, attributed to its nearest preceding heading.
 * `mdastToString` on a link yields its label, never its href — which is the
 * point: indexing hrefs would flood results with `../ai-context/…` tokens on a
 * corpus this link-dense, and an admin cannot see them to search for them.
 *
 * Attribution is established here, during conversion, because section identity
 * comes from headings the same pass is transforming.
 */
function buildSearchEntries(tree: unknown, docSlug: string, sections: Section[]): SearchEntry[] {
  interface Pos { start: number; end: number }
  const posOf = (n: { position?: { start: { offset?: number }; end: { offset?: number } } }): Pos | null =>
    n.position?.start.offset === undefined || n.position.end.offset === undefined
      ? null
      : { start: n.position.start.offset, end: n.position.end.offset };

  // Headings in DOCUMENT ORDER, at any depth. `collectSections` already walks
  // the whole tree, so pairing by index against top-level children only would
  // desynchronise the moment a heading appeared inside a blockquote or list —
  // every later section would then be attributed to the wrong anchor, and
  // search results would link somewhere unrelated. Matching on source position
  // keeps the two orderings aligned by construction.
  const headings: { section: Section; pos: Pos }[] = [];
  let hIdx = 0;
  visit(tree as never, "heading", (node: never) => {
    const pos = posOf(node);
    const section = sections[hIdx++];
    if (pos && section) headings.push({ section, pos });
  });

  // Visible text only. `html` is deliberately absent: comment nodes are dropped
  // during conversion, so indexing their text would make keywords searchable
  // that an admin cannot see anywhere on the page — decision 14's exact
  // prohibition. `code` IS included: fenced blocks render visibly.
  const chunks: { text: string; at: number }[] = [];
  for (const type of ["text", "inlineCode", "code"] as const) {
    visit(tree as never, type, (node: { value?: string }) => {
      const pos = posOf(node as never);
      if (!pos || !node.value) return;
      // Skip text that IS a heading's own words — the heading title is added
      // to its section explicitly below, and counting it twice would weight it.
      if (headings.some((h) => pos.start >= h.pos.start && pos.end <= h.pos.end)) return;
      chunks.push({ text: node.value, at: pos.start });
    });
  }
  chunks.sort((a, b) => a.at - b.at);

  const entries: SearchEntry[] = [];
  for (let i = 0; i < headings.length; i++) {
    const { section, pos } = headings[i];
    const nextStart = i + 1 < headings.length ? headings[i + 1].pos.start : Infinity;
    const body = chunks
      .filter((c) => c.at >= pos.end && c.at < nextStart)
      .map((c) => c.text);
    const text = [section.title, ...body].join(" ").replace(/\s+/g, " ").trim();
    if (text) entries.push({ doc: docSlug, section: section.id, sectionTitle: section.title, text });
  }
  return entries;
}

// ── HTML ─────────────────────────────────────────────────────────────────────

const toHtmlProcessor = unified()
  // `allowDangerousHtml` is deliberately NOT set: raw HTML nodes are dropped
  // rather than passed through, which is what makes the no-executable-content
  // property hold for chapters written later by anyone.
  .use(remarkRehype)
  .use(rehypeStringify);

function toHtml(tree: unknown, sections: Section[]): string {
  const hast = toHtmlProcessor.runSync(tree as never) as { children: unknown[] };
  // Attach heading ids so fragments have something to land on.
  let idx = -1;
  visit(hast as never, "element", (node: { tagName: string; properties: Record<string, unknown> }) => {
    if (/^h[1-6]$/.test(node.tagName)) {
      idx += 1;
      const section = sections[idx];
      if (section) node.properties = { ...node.properties, id: section.id };
    }
  });
  return toHtmlProcessor.stringify(hast as never);
}

/**
 * Asserted on the generator's own output, so it holds for chapters written
 * later by anyone — which review alone does not guarantee.
 */
function assertNoExecutableContent(html: string, file: string): void {
  const checks: [RegExp, string][] = [
    [/<script[\s>]/i, "<script>"],
    [/<iframe[\s>]/i, "<iframe>"],
    [/<object[\s>]/i, "<object>"],
    [/<embed[\s>]/i, "<embed>"],
    [/\son[a-z]+\s*=/i, "an inline event handler"],
    [/javascript:/i, "a javascript: URL"],
    [/data:text\/html/i, "a data:text/html URL"],
  ];
  for (const [re, label] of checks) {
    if (re.test(html)) fail(`Generated HTML for \`${file}\` contains ${label}.`);
  }
}

// ── Emit ─────────────────────────────────────────────────────────────────────

function tsLiteral(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function build(): Map<string, string> {
  const readmeFile = "README.md";
  const readmeSrc = readFileSync(join(MANUAL_DIR, readmeFile), "utf8");
  const rows = parseContentsTable(readmeSrc);

  const sources = new Map<string, string>();
  for (const row of rows) sources.set(row.file, readFileSync(join(MANUAL_DIR, row.file), "utf8"));
  assertNumbering(rows, sources);

  const chapterSlug = new Map<string, string>();
  for (const row of rows) chapterSlug.set(row.file, row.file.replace(/\.md$/, ""));

  // Pass 1: parse + collect anchors, so link rewriting can validate fragments
  // against every rendered destination rather than only the source file.
  const parsed: { file: string; slug: string; kind: "readme" | "chapter"; number?: number; tree: unknown; sections: Section[] }[] = [];
  const renderedAnchors = new Map<string, Set<string>>();

  const docsInOrder = [
    { file: readmeFile, slug: "", kind: "readme" as const, number: undefined },
    ...rows.map((r) => ({ file: r.file, slug: chapterSlug.get(r.file)!, kind: "chapter" as const, number: r.number })),
  ];

  for (const doc of docsInOrder) {
    const src = doc.file === readmeFile ? readmeSrc : sources.get(doc.file)!;
    const tree = parseMarkdown(src);
    assertVocabulary(tree, doc.file);
    const sections = collectSections(tree);
    renderedAnchors.set(doc.slug, new Set(sections.map((s) => s.id)));
    parsed.push({ ...doc, tree, sections });
  }

  // Pass 2: rewrite links, convert, assert.
  const targets: LinkTargets = { chapterSlug, renderedAnchors };
  const docs: HelpDoc[] = [];
  const searchEntries: SearchEntry[] = [];

  for (const doc of parsed) {
    rewriteLinks(doc.tree, doc.file, renderedAnchors.get(doc.slug)!, targets);
    const html = toHtml(doc.tree, doc.sections);
    assertNoExecutableContent(html, doc.file);

    const title = doc.kind === "readme" ? "About this manual" : chapterTitle(doc.tree, doc.file);

    docs.push({
      slug: doc.slug, kind: doc.kind, number: doc.number, title,
      file: `docs/manual/${doc.file}`, source: "", sections: doc.sections, html,
    });

    // Decision 17 (David, 2026-08-16): the README renders but is NOT indexed.
    // Keeping it out is what lets every search result name a chapter and a
    // section with no exceptions. Accepted cost: README text is readable
    // in-app but not findable.
    if (doc.kind === "chapter") {
      searchEntries.push(...buildSearchEntries(doc.tree as never, doc.slug, doc.sections));
    }
  }

  // ── Files ──
  const files = new Map<string, string>();
  const banner = `// @generated by scripts/generate-help-content.ts — DO NOT EDIT.\n// Source of truth: docs/manual/. Run: pnpm --filter @workspace/overhype-me run generate:help\n`;

  const manifest = docs.map((d) => ({
    slug: d.slug, kind: d.kind, number: d.number, title: d.title, file: d.file,
    // Emitted rather than reassembled at runtime, so the blob-URL shape has one
    // source of truth instead of a second copy in the page component.
    githubUrl: `${GITHUB_BLOB}/${d.file}`,
    sections: d.sections.filter((s) => s.depth >= 2),
  }));

  files.set(
    "manifest.ts",
    `${banner}
export interface HelpSection { id: string; title: string; depth: number }
export interface HelpDocMeta {
  /** URL slug; "" is the help index, which renders the Manual's charter. */
  slug: string;
  kind: "readme" | "chapter";
  number?: number;
  title: string;
  /** Repo path of the source document. */
  file: string;
  /** Canonical GitHub URL for that document, for the "edit on GitHub" link. */
  githubUrl: string;
  sections: HelpSection[];
}

export const HELP_DOCS: HelpDocMeta[] = ${tsLiteral(manifest)};

export const HELP_INDEX_DOC: HelpDocMeta = HELP_DOCS[0];
export const HELP_CHAPTERS: HelpDocMeta[] = HELP_DOCS.filter((d) => d.kind === "chapter");

export function findHelpDoc(slug: string): HelpDocMeta | undefined {
  return HELP_DOCS.find((d) => d.slug === slug);
}
`,
  );

  for (const doc of docs) {
    const name = doc.slug === "" ? "_index" : doc.slug;
    files.set(`content/${name}.ts`, `${banner}\nexport const html = ${tsLiteral(doc.html)};\n`);
  }

  const loaderEntries = docs
    .map((d) => `  ${JSON.stringify(d.slug)}: () => import("./content/${d.slug === "" ? "_index" : d.slug}"),`)
    .join("\n");
  files.set(
    "content.ts",
    `${banner}
/**
 * Per-document dynamic imports. Each chapter is its own chunk, so opening the
 * help index does not pull 160 KB of prose for chapters nobody read, and no
 * other admin route can reach any of it.
 */
const LOADERS: Record<string, () => Promise<{ html: string }>> = {
${loaderEntries}
};

export function loadHelpContent(slug: string): Promise<{ html: string }> | undefined {
  return LOADERS[slug]?.();
}
`,
  );

  files.set(
    "searchIndex.ts",
    `${banner}
export interface HelpSearchEntry {
  /** Chapter slug. The README is deliberately absent — see decision 17. */
  doc: string;
  section: string;
  sectionTitle: string;
  text: string;
}

export const HELP_SEARCH_INDEX: HelpSearchEntry[] = ${tsLiteral(searchEntries)};
`,
  );

  return files;
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main(): void {
  let files: Map<string, string>;
  try {
    files = build();
  } catch (err) {
    if (err instanceof GenerationError) {
      console.error(`generate:help FAILED\n\n  ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  const check = process.argv.includes("--check");
  const existing = new Map<string, string>();
  if (existsSync(OUT_DIR)) {
    const walk = (dir: string, prefix = ""): void => {
      for (const entry of readdirSync(dir)) {
        const abs = join(dir, entry);
        if (statSync(abs).isDirectory()) walk(abs, `${prefix}${entry}/`);
        else existing.set(`${prefix}${entry}`, readFileSync(abs, "utf8"));
      }
    };
    walk(OUT_DIR);
  }

  const stale =
    existing.size !== files.size ||
    [...files].some(([name, body]) => existing.get(name) !== body);

  if (check) {
    if (stale) {
      console.error(
        "generate:help --check FAILED: src/generated/help/ is out of date with docs/manual/.\n" +
        "Run: pnpm --filter @workspace/overhype-me run generate:help\n",
      );
      process.exit(1);
    }
    console.log(`generate:help --check: up to date (${files.size} files).`);
    return;
  }

  if (!stale) {
    console.log(`generate:help: already up to date (${files.size} files).`);
    return;
  }

  rmSync(OUT_DIR, { recursive: true, force: true });
  for (const [name, body] of files) {
    const abs = join(OUT_DIR, name);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body, "utf8");
  }
  console.log(`generate:help: wrote ${files.size} files to ${relative(REPO_ROOT, OUT_DIR)}`);
}

main();

/**
 * Guard: fact text that reaches the DOM must be highlighted through
 * `renderFactSegments` (normally via `<HighlightedFactText>`), never by
 * splitting an already-rendered sentence on the bare name.
 *
 * Why this exists: the split-on-name approach was independently reinvented in
 * FIVE places (FactCard, Home's pronoun previews, Home's cold mobile hero,
 * Home's cold desktop hero, WelcomeModal). Every copy had the same defect —
 * `{NAME_POSSESSIVE}` renders as "James's", so splitting on "James" leaves the
 * "'s" outside the highlight — and each was fixed only when someone noticed it
 * on that particular surface. Per CLAUDE.md, a failure pattern that recurs
 * becomes a deterministic check rather than a note someone has to remember.
 *
 * The flat `renderFact()` is still legitimate for handing personalized text to
 * a NON-DOM consumer (an API payload, a canvas that does its own segmenting).
 * Those uses are allowlisted below and must stay justified.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// Vitest runs with the package root as cwd. Resolving from `import.meta.url`
// does not work here — the jsdom environment hands back a non-file URL.
const SRC = join(process.cwd(), "src");

/**
 * Files permitted to import the flat `renderFact`. Each entry needs a reason —
 * if you are adding one to put text on screen, use `<HighlightedFactText>`
 * instead, or the name will silently render unhighlighted.
 */
const FLAT_RENDER_ALLOWLIST: Record<string, string> = {
  "pages/FactDetail.tsx":
    "passes personalized text to MemeStudio as `factText` (a prop, not DOM). " +
    "The meme canvas highlights from `rawFactText` via renderFactSegments.",
};

/**
 * `file:line` (the `.split(` line) entries permitted to have a `text-primary`
 * paint somewhere in their lookahead window despite not being the fact-name
 * anti-pattern. The 40-line window is a heuristic, not a parse of the
 * enclosing expression — it can span into unrelated code that happens to
 * both split a string and use the brand colour nearby. Each entry needs a
 * reason the split target isn't fact text.
 */
const SPLIT_PAINT_ALLOWLIST: Record<string, string> = {
  "components/admin/EnrichmentEditor.tsx:1616":
    "splits a validation error message on `\"; \"` to list individual issues, " +
    "not fact text; the nearby `text-primary` paints an unrelated " +
    "\"Re-run classification\" button link.",
};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === "__tests__" || entry === "__demo__") continue;
      out.push(...sourceFiles(full));
      continue;
    }
    if (!/\.tsx?$/.test(entry)) continue;
    if (/\.test\.tsx?$/.test(entry)) continue;
    out.push(full);
  }
  return out;
}

/**
 * Does this file bring the flat `renderFact` export into scope, in any form?
 * Matches the module by its final path segment ("render-fact", optionally
 * with a .ts/.tsx extension) rather than one exact specifier string, so the
 * `@/lib/...` alias, any relative depth (`../lib/render-fact`,
 * `./render-fact`), and re-exports are all covered — not just the alias form
 * the first version of this guard checked (Codex review, PR #262: a
 * namespace import or relative path was a silent bypass).
 */
function referencesFlatRenderFact(src: string): boolean {
  const DECL_RE =
    /\b(import|export)\s+(?:type\s+)?([^;]*?)\s+from\s+["'](?:[^"']*\/)?render-fact(?:\.tsx?)?["']/g;

  let match: RegExpExecArray | null;
  while ((match = DECL_RE.exec(src))) {
    const keyword = match[1];
    const clause = match[2];

    // `export * from ".../render-fact"` — re-exports everything, including
    // renderFact, with no local name to trace usage through. Always counts;
    // it needs its own allowlist justification like any other reference.
    if (/^\*\s*$/.test(clause.trim())) return true;

    const namespaceAlias = clause.match(/\*\s*as\s+(\w+)/)?.[1];
    if (namespaceAlias) {
      // `export * as X from ".../render-fact"` — a barrel re-export. It
      // exposes the flat renderFact to every consumer of *this* module
      // under a specifier that no longer ends in "render-fact", so those
      // consumers are invisible to this same scan. Always counts, whether
      // or not this file itself reads X.renderFact (Codex review, PR #265:
      // checking local usage let a barrel re-export pass unreported).
      if (keyword === "export") return true;

      // `import * as X from ".../render-fact"` — only an offense if the
      // flat export is actually read off the namespace, so a namespace
      // import used solely for renderFactSegments/tokenizeFact/hasPronouns
      // doesn't false-positive. Covers direct member access
      // (`X.renderFact(`) and destructuring off the namespace, with or
      // without a type annotation between the binding and the initializer
      // (`const { renderFact } = X` / `const { renderFact }: T = X`) — the
      // latter being invisible to a plain `X.renderFact` search (Codex
      // review, PR #265).
      const memberAccess = new RegExp(`\\b${namespaceAlias}\\.renderFact\\b`);
      const destructured = new RegExp(
        `\\b(?:const|let|var)\\s*\\{[^}]*\\brenderFact\\b[^}]*\\}\\s*(?::[^=]+)?=\\s*${namespaceAlias}\\b`,
      );
      if (memberAccess.test(src) || destructured.test(src)) return true;
      continue;
    }

    // Named import/export list — `{ renderFact }`, `{ renderFact as x }`,
    // `{ renderFactSegments, renderFact }`. The word boundary means this does
    // not false-positive on `renderFactSegments`.
    if (/\brenderFact\b/.test(clause)) return true;
  }
  return false;
}

describe("fact-text highlighting guard", () => {
  it("resolves the source tree it is meant to scan", () => {
    // If this fails the two guards below would silently pass on an empty scan.
    expect(existsSync(join(SRC, "lib", "render-fact.ts"))).toBe(true);
  });

  it("only allowlisted modules import the flat renderFact", () => {
    const offenders: string[] = [];

    for (const file of sourceFiles(SRC)) {
      const rel = relative(SRC, file).split("\\").join("/");
      if (rel === "lib/render-fact.ts") continue; // the module that defines it

      const src = readFileSync(file, "utf8");
      if (!referencesFlatRenderFact(src)) continue;

      if (!(rel in FLAT_RENDER_ALLOWLIST)) offenders.push(rel);
    }

    expect(
      offenders,
      `These modules import the flat renderFact(). If the text is going on screen, ` +
        `render it with <HighlightedFactText> so the personalized name — including a ` +
        `{NAME_POSSESSIVE} apostrophe-s — is highlighted. If it is genuinely not DOM ` +
        `text, add it to FLAT_RENDER_ALLOWLIST with a reason.`,
    ).toEqual([]);
  });

  it("no module highlights a name by splitting rendered text", () => {
    const offenders: string[] = [];

    // How far past a `.split(` to look for the brand-colour paint. Not a
    // full parse of the enclosing JSX expression (Codex review, PR #262:
    // the original 5-line window missed a paint past line 4, a common
    // outcome once JSX gets reformatted) — a generous bounded window, cut
    // short at the next top-level declaration so it can't bleed into an
    // unrelated component further down the file.
    const MAX_LOOKAHEAD = 40;
    // No leading `\s*`: an indented (nested) declaration inside the same
    // component must not be mistaken for the start of the next top-level
    // one — that would cut the lookahead window short and let a paint
    // within range slip through unreported (Codex review, PR #265).
    const TOP_LEVEL_DECL_RE = /^(export\s+)?(default\s+)?(async\s+)?(function|const|class)\s+[A-Za-z]/;
    // Matches the literal `className="text-primary"` form AND any computed
    // form (`cn(...)`, a template literal, a ternary) as long as the
    // "text-primary" token appears somewhere in the expression.
    const HIGHLIGHT_CLASS_RE = /className=(?:"[^"]*\btext-primary\b[^"]*"|\{[^}]*\btext-primary\b[^}]*\})/;

    for (const file of sourceFiles(SRC)) {
      const rel = relative(SRC, file).split("\\").join("/");
      const lines = readFileSync(file, "utf8").split("\n");

      lines.forEach((line, i) => {
        if (!line.includes(".split(")) return;
        // The anti-pattern: split a rendered sentence, then paint one piece
        // with the brand colour. Look ahead for that paint, stopping at the
        // next top-level declaration so an unrelated later component can't
        // be mistaken for this one's paint.
        let windowEnd = i;
        for (let j = i + 1; j < lines.length && j < i + MAX_LOOKAHEAD; j++) {
          if (TOP_LEVEL_DECL_RE.test(lines[j])) break;
          windowEnd = j;
        }
        const window = lines.slice(i, windowEnd + 1).join("\n");
        const key = `${rel}:${i + 1}`;
        if (HIGHLIGHT_CLASS_RE.test(window) && !(key in SPLIT_PAINT_ALLOWLIST)) {
          offenders.push(key);
        }
      });
    }

    expect(
      offenders,
      `Highlighting by splitting rendered text drops the possessive "'s" (a ` +
        `{NAME_POSSESSIVE} token renders as "James's", so splitting on "James" ` +
        `leaves "'s" unhighlighted). Use <HighlightedFactText>, which works from ` +
        `the raw template via renderFactSegments. If this really isn't fact text, ` +
        `add it to SPLIT_PAINT_ALLOWLIST with a reason.`,
    ).toEqual([]);
  });
});

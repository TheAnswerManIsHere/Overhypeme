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
      const importsFlat = /import\s*\{[^}]*\brenderFact\b[^}]*\}\s*from\s*["']@\/lib\/render-fact["']/.test(src);
      if (!importsFlat) continue;

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

    for (const file of sourceFiles(SRC)) {
      const rel = relative(SRC, file).split("\\").join("/");
      const lines = readFileSync(file, "utf8").split("\n");

      lines.forEach((line, i) => {
        if (!line.includes(".split(")) return;
        // The anti-pattern: split a rendered sentence, then paint one piece
        // with the brand colour. Look ahead a few lines for that paint.
        const window = lines.slice(i, i + 5).join("\n");
        if (/className="text-primary"/.test(window)) {
          offenders.push(`${rel}:${i + 1}`);
        }
      });
    }

    expect(
      offenders,
      `Highlighting by splitting rendered text drops the possessive "'s" (a ` +
        `{NAME_POSSESSIVE} token renders as "James's", so splitting on "James" ` +
        `leaves "'s" unhighlighted). Use <HighlightedFactText>, which works from ` +
        `the raw template via renderFactSegments.`,
    ).toEqual([]);
  });
});

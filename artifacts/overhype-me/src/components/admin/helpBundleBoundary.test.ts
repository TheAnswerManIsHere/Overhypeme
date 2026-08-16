import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(__dirname, "..", "..");

/**
 * The help content is ~160 KB of prose. If it ever lands in the entry chunk or
 * a shared admin chunk, every admin screen pays for it — and NOTHING else in
 * this plan would notice: no test fails, nothing errors, admin pages just get
 * heavier. A single eager `import` from App.tsx or AdminLayout.tsx is all it
 * takes.
 *
 * This asserts the boundary as an IMPORT-GRAPH property, which is where the
 * regression actually lives. Following only STATIC imports from the app entry,
 * `src/generated/help/**` must be unreachable — a lazy `import()` is what
 * creates the chunk split, so reaching the content statically is precisely the
 * bug. That makes the check deterministic and fast, and it fails with the
 * offending import chain rather than a byte count that drifts.
 */

const EXT = [".ts", ".tsx", ".js", ".jsx"];

class UnresolvedSpecifier extends Error {}

/**
 * Resolve a source-local specifier, FAILING CLOSED.
 *
 * Returning `null` for anything unresolvable is what made this check
 * dangerous: a perfectly valid Vite import with a query suffix — say
 * `@/generated/help/content/3-moderation.ts?raw` — matched the regex, failed
 * every filesystem candidate, and was then silently dropped from the graph.
 * The prose would ship inside the importing chunk while this suite stayed
 * green. So query/hash suffixes are stripped (Vite resolves the file, the
 * suffix only picks a transform), and a source-local specifier that still
 * cannot be resolved throws rather than being ignored.
 */
function resolveImport(fromFile: string, spec: string): string | null {
  const clean = spec.split("?")[0].split("#")[0];
  let base: string;
  if (clean.startsWith("@/")) base = join(SRC, clean.slice(2));
  else if (clean.startsWith(".")) base = resolve(dirname(fromFile), clean);
  else return null; // bare package specifier — genuinely not our source graph

  const candidates = [
    base,
    ...EXT.map((e) => base + e),
    ...EXT.map((e) => join(base, "index" + e)),
  ];
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  // Non-code assets (css, svg, json) are legitimately unresolvable as modules
  // we would traverse, and cannot carry help prose.
  if (/\.(css|svg|png|jpe?g|webp|json|txt|wasm)$/.test(clean)) return null;
  throw new UnresolvedSpecifier(
    `Could not resolve source-local import "${spec}" from ${rel(fromFile)}. ` +
    `Failing closed: an unresolved specifier could be a real edge into generated help content.`,
  );
}

/**
 * Static VALUE import specifiers only. Two exclusions, both load-bearing:
 *
 *   - `import(...)` — a dynamic import is what CREATES the chunk split, so
 *     following it would flag the correct design as a leak.
 *   - `import type` / `export type` — erased by the compiler, so they cost
 *     nothing at runtime. Counting them reports a leak that cannot exist,
 *     which is how this check would end up being disabled for crying wolf.
 */
function staticImportsOf(file: string): string[] {
  const src = readFileSync(file, "utf8");
  const withoutDynamic = src.replace(/\bimport\s*\(/g, "DYNAMIC_IMPORT(");
  const specs: string[] = [];
  for (const re of [
    /\bimport\s+(?!type\b)[^;]*?\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
    /\bexport\s+(?!type\b)[^;]*?\bfrom\s*["']([^"']+)["']/g,
  ]) {
    for (const m of withoutDynamic.matchAll(re)) specs.push(m[1]);
  }
  // `import { type X, y }` is a value import of y; the inline `type` modifier
  // is handled by TypeScript, not here — the specifier still resolves.
  return specs;
}

/** Every file statically reachable from `entry`, with the path that got there. */
function staticallyReachable(entry: string): Map<string, string[]> {
  const seen = new Map<string, string[]>();
  const queue: { file: string; path: string[] }[] = [{ file: entry, path: [entry] }];
  while (queue.length) {
    const { file, path } = queue.shift()!;
    if (seen.has(file)) continue;
    seen.set(file, path);
    for (const spec of staticImportsOf(file)) {
      const target = resolveImport(file, spec);
      if (target && !seen.has(target)) queue.push({ file: target, path: [...path, target] });
    }
  }
  return seen;
}

const rel = (f: string) => f.slice(SRC.length + 1);
const isGeneratedHelp = (f: string) => rel(f).startsWith("generated/help/");

describe("help bundle boundary", () => {
  it("cannot reach generated help content statically from the app entry", () => {
    const reachable = staticallyReachable(join(SRC, "App.tsx"));
    const leaked = [...reachable.keys()].filter(isGeneratedHelp);
    const chains = leaked.map((f) => reachable.get(f)!.map(rel).join("\n      → "));
    expect(
      leaked.map(rel),
      leaked.length
        ? `Help content is statically reachable from App.tsx, so it lands in the entry or a shared chunk:\n\n      ${chains.join("\n\n      ")}\n`
        : "",
    ).toEqual([]);
  });

  it("cannot reach generated help content statically from AdminLayout", () => {
    // AdminLayout renders on EVERY admin screen, so anything it can reach is
    // paid for by screens that have nothing to do with help. It imports
    // helpMap, which is why helpMap holds string literals and imports nothing
    // generated.
    const reachable = staticallyReachable(join(SRC, "components", "admin", "AdminLayout.tsx"));
    const leaked = [...reachable.keys()].filter(isGeneratedHelp);
    expect(leaked.map(rel), `AdminLayout can statically reach: ${leaked.map(rel).join(", ")}`).toEqual([]);
  });

  // (Codex) App's walk stops at lazy imports and AdminLayout's walk goes
  // outward from the layout, so NEITHER sees a non-help admin page importing
  // help content directly — e.g. pages/admin/facts.tsx. Vite would put the
  // prose in that route's chunk with this suite green. Walk each admin page
  // entry itself.
  it("cannot reach generated help content from any non-help admin route", () => {
    const pagesDir = join(SRC, "pages", "admin");
    const entries = readdirSync(pagesDir)
      .filter((f) => /\.tsx?$/.test(f) && !/\.test\./.test(f) && f !== "help.tsx");
    expect(entries.length, "found no admin page entries to check").toBeGreaterThan(8);

    const offenders: string[] = [];
    for (const entry of entries) {
      const reachable = staticallyReachable(join(pagesDir, entry));
      for (const f of reachable.keys()) {
        if (isGeneratedHelp(f)) offenders.push(`${entry} → ${rel(f)}`);
      }
    }
    expect(offenders, `admin routes reaching help content: ${offenders.join(", ")}`).toEqual([]);
  });

  it("keeps the search index out of the help page's own initial chunk", () => {
    // Even inside help, the index is the single largest artifact and most
    // visits never search — so it is dynamically imported too.
    const reachable = staticallyReachable(join(SRC, "pages", "admin", "help.tsx"));
    const leaked = [...reachable.keys()].filter((f) => rel(f).startsWith("generated/help/searchIndex"));
    expect(leaked.map(rel)).toEqual([]);
  });

  // GUARDS THE GUARD. If the traversal silently resolved nothing, every
  // assertion above would pass vacuously — which is the failure mode that
  // makes a green check worse than no check.
  it("actually traverses the graph (guards the assertions above)", () => {
    const fromApp = [...staticallyReachable(join(SRC, "App.tsx")).keys()].map(rel);
    expect(fromApp.length).toBeGreaterThan(10);
    expect(fromApp).toContain("lib/analytics.ts");
    // AdminLayout is deliberately NOT here: every admin page is lazy-loaded,
    // which is why the entry chunk stays clear of admin code at all.
    expect(fromApp).not.toContain("components/admin/AdminLayout.tsx");

    const fromLayout = [...staticallyReachable(join(SRC, "components", "admin", "AdminLayout.tsx")).keys()].map(rel);
    expect(fromLayout).toContain("components/admin/helpMap.ts");
  });

  it("detects a leak when one is deliberately introduced", () => {
    // Proves the traversal can SEE generated/help at all — otherwise "no leak"
    // might just mean "never looked there". Uses the help page, which reaches
    // the manifest statically by design.
    const reachable = staticallyReachable(join(SRC, "pages", "admin", "help.tsx"));
    const found = [...reachable.keys()].filter(isGeneratedHelp).map(rel);
    expect(found).toContain("generated/help/manifest.ts");
  });
});

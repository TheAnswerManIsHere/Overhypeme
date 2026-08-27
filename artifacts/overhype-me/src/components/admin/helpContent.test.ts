import { describe, it, expect } from "vitest";
import { readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { HELP_DOCS, HELP_CHAPTERS, findHelpDoc } from "@/generated/help/manifest";
import { HELP_SEARCH_INDEX } from "@/generated/help/searchIndex";
import { loadHelpContent } from "@/generated/help/content";
import { searchHelp } from "./helpSearch";
import { internalHelpTarget, INTERNAL_HELP_PATH } from "./helpLinkGuard";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..", "..");

/**
 * The REAL rendered HTML, not the escaped TS source around it. Asserting
 * against the source means writing regexes that account for JSON escaping,
 * which is both fragile and easy to get accidentally-passing.
 */
async function allGeneratedHtml(): Promise<{ slug: string; html: string }[]> {
  const out: { slug: string; html: string }[] = [];
  for (const doc of HELP_DOCS) {
    const mod = await loadHelpContent(doc.slug);
    out.push({ slug: doc.slug || "_index", html: mod!.html });
  }
  return out;
}

/** Every `href` value in a document, unescaped. */
function hrefsIn(html: string): string[] {
  return [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
}

describe("generated help content", () => {
  // The freshness gate itself runs in the always-on Build job (see
  // .github/workflows/build.yml) rather than here, because docs/** is inert
  // for this suite — a chapter-only PR skips Frontend Test entirely, so a
  // staleness assertion living here would never run on the exact change that
  // can invalidate the artifact. What IS worth asserting here are the
  // properties of whatever got committed.

  it("renders every chapter in the manual", () => {
    const chapterFiles = readdirSync(resolve(REPO_ROOT, "docs", "manual"))
      .filter((f) => /^\d+-.*\.md$/.test(f));
    expect(HELP_CHAPTERS).toHaveLength(chapterFiles.length);
  });

  it("renders the README as the help index, not as a chapter", () => {
    const index = HELP_DOCS.find((d) => d.kind === "readme");
    expect(index).toBeDefined();
    expect(index!.slug).toBe("");
    expect(index!.file).toBe("docs/manual/README.md");
  });

  it("numbers chapters sequentially from 1", () => {
    expect(HELP_CHAPTERS.map((c) => c.number)).toEqual(
      HELP_CHAPTERS.map((_, i) => i + 1),
    );
  });

  // NO EXECUTABLE CONTENT. The generator asserts this on its own output, but
  // asserting it again on the committed artifact is what catches a hand-edit
  // to a generated file — the one attack the generator cannot see.
  it("contains nothing executable", async () => {
    for (const { slug, html } of await allGeneratedHtml()) {
      expect(html, `${slug}: <script>`).not.toMatch(/<script[\s>]/i);
      expect(html, `${slug}: <iframe>`).not.toMatch(/<iframe[\s>]/i);
      expect(html, `${slug}: <object>/<embed>`).not.toMatch(/<(object|embed)[\s>]/i);
      expect(html, `${slug}: inline handler`).not.toMatch(/\son[a-z]+\s*=/i);
      expect(html, `${slug}: javascript: URL`).not.toMatch(/javascript:/i);
    }
  });

  it("gives every heading an id, so fragments have somewhere to land", () => {
    for (const doc of HELP_DOCS) {
      for (const section of doc.sections) {
        expect(section.id, `${doc.slug} has a section with no id`).toBeTruthy();
      }
    }
  });

  it("rewrites intra-manual links to in-app routes and off-manual links to GitHub", async () => {
    const ch12 = (await allGeneratedHtml()).find((d) => d.slug === "12-background-work")!;
    // The README link that had no rendered destination before the review loop.
    expect(ch12.html).toContain("/admin/help#contents");
    // Off-manual links leave the console, explicitly.
    expect(ch12.html).toMatch(/https:\/\/github\.com\/TheAnswerManIsHere\/Overhypeme\/blob\/main\/docs\//);
  });

  // Every href must be absolute (GitHub, opened in a new tab) or an in-app
  // route. A leftover relative `.md` path is a link that looks live and 404s.
  it("leaves no unrewritten relative markdown link", async () => {
    for (const { slug, html } of await allGeneratedHtml()) {
      const relative = hrefsIn(html).filter(
        (h) => !/^https?:/.test(h) && !h.startsWith("/admin/help") && !h.startsWith("#") && !h.startsWith("mailto:"),
      );
      expect(relative, `${slug} has unrewritten href(s): ${relative.join(", ")}`).toEqual([]);
    }
  });

  // Generated anchors are raw <a> inside injected HTML, so wouter's <Link>
  // base handling never sees them. The marker is what lets the page prefix the
  // router base and route the click instead of reloading the document — under a
  // non-root BASE_PATH an unmarked link navigates clean out of the app.
  it("marks every in-app link so the page can make it base-aware and routed", async () => {
    let internal = 0;
    for (const { slug, html } of await allGeneratedHtml()) {
      for (const m of html.matchAll(/<a\b([^>]*)>/g)) {
        const attrs = m[1];
        const href = /href="([^"]*)"/.exec(attrs)?.[1] ?? "";
        if (!href.startsWith("/admin/help")) continue;
        internal++;
        expect(attrs, `${slug}: unmarked in-app link -> ${href}`).toMatch(/\bdata-help-internal="/);
      }
    }
    expect(internal, "found no in-app links to check").toBeGreaterThan(5);
  });

  /**
   * THE GENERATOR/CONSUMER CONTRACT, asserted against real generated anchors.
   *
   * This is the test that was missing: the guard's own unit test exercised
   * standalone strings and passed happily while the generator was writing the
   * literal "true" into the attribute the consumer reads a PATH out of — so
   * every in-app link silently fell back to a full page navigation. A test
   * that never touches the artifact cannot see a contract break.
   */
  it("emits a data-help-internal value the guard accepts, matching the href", async () => {
    let checked = 0;
    for (const { slug, html } of await allGeneratedHtml()) {
      for (const m of html.matchAll(/<a\b([^>]*\bdata-help-internal="([^"]*)"[^>]*)>/g)) {
        const attrs = m[1];
        const marker = m[2];
        const href = /href="([^"]*)"/.exec(attrs)?.[1] ?? "";
        checked++;
        expect(marker, `${slug}: marker and href disagree`).toBe(href);

        // Through the real consumer, via a stub element — no DOM needed. The
        // guard returns the split target, so reassembling it must reproduce
        // the marker exactly: that is the generator/consumer contract.
        const el = { getAttribute: (k: string) => (k === "data-help-internal" ? marker : null) } as unknown as Element;
        const target = internalHelpTarget(el);
        expect(target, `${slug}: guard rejected a generated link -> ${marker}`).not.toBeNull();
        expect(
          INTERNAL_HELP_PATH.test(target!.path),
          `${slug}: guard returned a path that is not a help route -> ${target!.path}`,
        ).toBe(true);
        expect(
          target!.path + (target!.fragment ? `#${target!.fragment}` : ""),
          `${slug}: guard's split does not reassemble to the marker`,
        ).toBe(marker);
      }
    }
    expect(checked, "found no generated in-app links to check").toBeGreaterThan(5);
  });

  it("emits no relative image sources", async () => {
    for (const { slug, html } of await allGeneratedHtml()) {
      for (const m of html.matchAll(/<img\b[^>]*\bsrc="([^"]*)"/g)) {
        expect(/^(https?:|data:)/.test(m[1]), `${slug}: relative image src -> ${m[1]}`).toBe(true);
      }
    }
  });

  it("opens every off-manual link in a new tab, and no in-app link", async () => {
    for (const { slug, html } of await allGeneratedHtml()) {
      for (const m of html.matchAll(/<a\b([^>]*)>/g)) {
        const attrs = m[1];
        const href = /href="([^"]*)"/.exec(attrs)?.[1] ?? "";
        if (/^https?:/.test(href)) {
          expect(attrs, `${slug}: external link without target=_blank -> ${href}`).toContain('target="_blank"');
          expect(attrs, `${slug}: external link without rel=noopener -> ${href}`).toContain("noopener");
        } else {
          expect(attrs, `${slug}: in-app link should not open a new tab -> ${href}`).not.toContain('target="_blank"');
        }
      }
    }
  });
});

describe("help search index", () => {
  const titleFor = (slug: string) => findHelpDoc(slug)?.title ?? slug;

  it("is populated and attributes every entry to a real chapter section", () => {
    expect(HELP_SEARCH_INDEX.length).toBeGreaterThan(50);
    for (const entry of HELP_SEARCH_INDEX) {
      const doc = findHelpDoc(entry.doc);
      expect(doc, `index entry for unknown doc "${entry.doc}"`).toBeDefined();
      expect(doc!.kind).toBe("chapter");
      const ids = doc!.sections.map((s) => s.id);
      // Depth-1 (the chapter title) is a legitimate attribution but is filtered
      // out of `sections`, so accept it explicitly rather than loosening this.
      expect(
        ids.includes(entry.section) || entry.section.startsWith("chapter-"),
        `${entry.doc}#${entry.section} is not a section of that chapter`,
      ).toBe(true);
    }
  });

  // DECISION 17 (David, 2026-08-16): the README renders but is NOT indexed.
  // Excluding it is what lets every result name a chapter and a section with
  // no exceptions.
  it("excludes the README", () => {
    expect(HELP_SEARCH_INDEX.some((e) => e.doc === "")).toBe(false);
    const readmeOnly = "Chapter quality bar";
    expect(searchHelp(HELP_SEARCH_INDEX, readmeOnly, titleFor)).toHaveLength(0);
  });

  // The NEGATIVE half is the half that does the work here. An index built over
  // raw HTML, or one that indexed hrefs, would pass a positive-only test.
  it("indexes visible link text but NOT link targets", () => {
    // "Visual Concept" is a glossary link LABEL used throughout the manual.
    const byLabel = searchHelp(HELP_SEARCH_INDEX, "Visual Concept", titleFor);
    expect(byLabel.length).toBeGreaterThan(0);

    // These appear ONLY inside hrefs and markup, never as text an admin can read.
    for (const invisible of ["ai-context/glossary.md", "https://github.com", "</p>", "hProperties"]) {
      expect(
        searchHelp(HELP_SEARCH_INDEX, invisible, titleFor),
        `"${invisible}" is not visible on the page and must not be searchable`,
      ).toHaveLength(0);
    }
  });

  it("returns hits that land on a real anchor", () => {
    const hits = searchHelp(HELP_SEARCH_INDEX, "moderation", titleFor);
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) {
      const doc = findHelpDoc(hit.doc)!;
      const ids = doc.sections.map((s) => s.id);
      expect(ids.includes(hit.section) || hit.section.startsWith("chapter-")).toBe(true);
    }
  });

  it("ignores queries too short to be useful", () => {
    expect(searchHelp(HELP_SEARCH_INDEX, "a", titleFor)).toHaveLength(0);
    expect(searchHelp(HELP_SEARCH_INDEX, "  ", titleFor)).toHaveLength(0);
  });
});

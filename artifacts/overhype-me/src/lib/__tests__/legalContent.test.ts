/**
 * The legal pages' two generation rules (launch Phase 14, plan S-a): a changed
 * text needs a changed version, and nothing executable reaches the page. Plus
 * the committed pages are what the sources generate today.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  LEGAL_SLUGS,
  LegalGenerationError,
  bodyHash,
  checkVersionRule,
  parseLegalDoc,
  renderLegalHtml,
} from "../../../scripts/generate-legal-content";
import { LEGAL_DOCS, LEGAL_VERSIONS } from "@/generated/legal";
import { setupRedirectFor } from "@/lib/setup-redirect";

const doc = (version: string, body: string) =>
  parseLegalDoc("terms", `---\ntitle: Terms\nversion: ${version}\nsummary: s\n---\n${body}`);

describe("legal document versions", () => {
  it("refuses a changed text under an unchanged version", () => {
    const published = doc("2026-11-17", "Old text.");
    const lock = { terms: { version: "2026-11-17", sha256: bodyHash(published.body) } };
    expect(() => checkVersionRule(doc("2026-11-17", "New text."), lock)).toThrow(LegalGenerationError);
  });

  it("accepts a changed text under a new version, and an unchanged text under the same one", () => {
    const published = doc("2026-11-17", "Old text.");
    const lock = { terms: { version: "2026-11-17", sha256: bodyHash(published.body) } };
    expect(() => checkVersionRule(doc("2026-11-18", "New text."), lock)).not.toThrow();
    expect(() => checkVersionRule(doc("2026-11-17", "Old text."), lock)).not.toThrow();
  });

  it("refuses a version older than the published one", () => {
    const lock = { terms: { version: "2026-11-17", sha256: "x" } };
    expect(() => checkVersionRule(doc("2026-11-01", "Any."), lock)).toThrow(LegalGenerationError);
  });

  it("requires front matter with a date version", () => {
    expect(() => parseLegalDoc("terms", "No front matter")).toThrow(LegalGenerationError);
    expect(() => doc("soon", "x")).toThrow(LegalGenerationError);
  });
});

describe("legal document rendering", () => {
  it("refuses raw HTML and script links", () => {
    expect(() => renderLegalHtml("terms", "Hello <script>alert(1)</script>")).toThrow(LegalGenerationError);
    expect(() => renderLegalHtml("terms", "[x](javascript:alert(1))")).toThrow(LegalGenerationError);
  });

  it("renders tables and links", () => {
    const html = renderLegalHtml("terms", "| a | b |\n|---|---|\n| 1 | [Privacy](/privacy) |\n");
    expect(html).toContain("<table>");
    expect(html).toContain('<a href="/privacy">Privacy</a>');
  });
});

describe("the committed legal pages", () => {
  const repo = resolve(__dirname, "../../../../..");
  it("are generated from the current sources, at the versions in their front matter", () => {
    expect(LEGAL_DOCS.map((d) => d.slug)).toEqual([...LEGAL_SLUGS]);
    for (const slug of LEGAL_SLUGS) {
      const parsed = parseLegalDoc(slug, readFileSync(resolve(repo, "docs/legal", `${slug}.md`), "utf8"));
      expect(LEGAL_VERSIONS[slug]).toBe(parsed.version);
    }
  });

  it("name the operator", () => {
    const terms = readFileSync(resolve(repo, "docs/legal/terms.md"), "utf8");
    expect(terms).toContain("Availeron Consulting, Inc.");
    expect(terms).toContain("745 5th Ave., Suite 500, New York, NY 10151");
  });

  it("are never redirected away from, whatever state an account is in", () => {
    for (const state of ["suspended", "deletion_pending", "unverified", "unonboarded"]) {
      for (const slug of LEGAL_SLUGS) expect(setupRedirectFor(state, `/${slug}`)).toBeNull();
    }
  });
});

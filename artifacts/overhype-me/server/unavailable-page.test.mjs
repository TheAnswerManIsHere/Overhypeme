// @vitest-environment node
/**
 * The explanation page Cloudflare sends a refused visitor to must stay
 * script-free (launch Phase 14, increment 3). Our own file carries no script,
 * and every email address on it sits inside Cloudflare's email_off markers, so
 * the edge's Email Address Obfuscation leaves it alone instead of rewriting it
 * and adding its decoder script (Issue #1124).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const html = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "unavailable.html"),
  "utf8",
);

describe("public/unavailable.html", () => {
  it("carries no script", () => {
    expect(html).not.toMatch(/<script\b/i);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
  });

  it("keeps every email address inside email_off markers", () => {
    const outside = html.replace(/<!--email_off-->[\s\S]*?<!--\/email_off-->/g, "");
    const comments = /<!--[\s\S]*?-->/g;
    expect(outside.replace(comments, "")).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    expect(html).toMatch(/<!--email_off--><a href="mailto:support@overhype\.me">support@overhype\.me<\/a><!--\/email_off-->/);
  });
});

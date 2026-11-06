/**
 * Regression test: the display face in our emails rendered smeared in Outlook
 * on Windows (password-reset email, 2026-11-06).
 *
 * The display stack is 'Oswald','Impact','Arial Narrow'. Clients that do not
 * load the Google web font (Outlook on Windows among them) fall to Impact.
 * Impact ships in one weight only, and that weight is already heavy, so a
 * style asking for font-weight 600 or 700 makes the renderer synthesise a
 * fake bold by thickening every outline: counters close up and letters blur.
 *
 * The invariant: no style that names the display stack asks for a bold
 * weight. Oswald still renders bold because the web font is loaded at 700
 * only, and CSS font matching serves that face for a 400 request without
 * synthesising anything.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

process.env.RESEND_API_KEY = process.env.RESEND_API_KEY ?? "re_test_dummy";

import { buildEmailShell, buildPasswordResetEmail, ctaButton } from "../lib/email.js";

const BOLD_WEIGHT = /font-weight:\s*(bold|bolder|[6-9]00)\b/i;

/** Every inline style (style="…") or VML center style naming Impact. */
function impactStyles(source: string): string[] {
  return [...source.matchAll(/style="([^"]*)"/g)]
    .map((m) => m[1] ?? "")
    .filter((style) => /Impact/.test(style));
}

describe("email display font weight", () => {
  it("the password-reset email never asks Impact for a bold weight", () => {
    const { html } = buildPasswordResetEmail("https://example.test/reset-password?token=abc");
    const styles = impactStyles(html);
    assert.ok(styles.length >= 3, "expected the wordmark, heading and button to use the display stack");
    for (const style of styles) assert.doesNotMatch(style, BOLD_WEIGHT, style);
  });

  it("the CTA button's Outlook (VML) label and its anchor are not bold", () => {
    const html = ctaButton("https://example.test", "Go");
    const styles = impactStyles(html);
    assert.equal(styles.length, 2);
    for (const style of styles) assert.doesNotMatch(style, BOLD_WEIGHT, style);
  });

  it("no email template source asks the display stack for a bold weight", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const files = ["../lib/email.ts", "../lib/adminNotify.ts", "../lib/userNotify.ts", "../jobs/factOfTheDay.ts"];
    let checked = 0;
    for (const rel of files) {
      const src = readFileSync(path.join(here, rel), "utf8");
      for (const style of impactStyles(src)) {
        checked++;
        assert.doesNotMatch(style, BOLD_WEIGHT, `${rel}: ${style}`);
      }
    }
    assert.ok(checked > 20, `expected to check every display-stack style, checked ${checked}`);
  });

  it("loads Oswald at 700 only, so a 400 request is served the real bold face", () => {
    const html = buildEmailShell("<p>x</p>", "f");
    const m = html.match(/family=Oswald:wght@([0-9;]+)/);
    assert.ok(m, "Oswald import must be present");
    assert.equal(m?.[1], "700");
  });
});

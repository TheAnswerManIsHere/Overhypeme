/**
 * Regression test: the display face in our emails rendered smeared in Outlook
 * on Windows (password-reset email, 2026-11-06).
 *
 * Clients that do not load the Oswald web font walk down the display stack.
 * It used to fall to Impact, which ships in one weight only, already heavy;
 * our bold request made the renderer synthesise a fake bold by thickening
 * every outline, so counters closed up and letters blurred.
 *
 * The invariant: every font the display stack can fall to has a real bold
 * face, and no email style names a single-weight display font. The stack is
 * bold-capable from top to bottom, so headings stay bold everywhere without
 * any client faking it.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

process.env.RESEND_API_KEY = process.env.RESEND_API_KEY ?? "re_test_dummy";

import { buildPasswordResetEmail, ctaButton } from "../lib/email.js";

/** Fonts with a real bold face on the platforms they ship on. */
const BOLD_CAPABLE = new Set([
  "Oswald",
  "Arial Narrow",
  "Roboto Condensed",
  "sans-serif-condensed",
  "Helvetica Neue",
  "Arial",
  "sans-serif",
]);

/** Single-weight display faces that must never appear in an email stack. */
const SINGLE_WEIGHT = /\b(Impact|Haettenscheidt|Bebas|Anton)\b/i;

const TEMPLATE_FILES = ["../lib/email.ts", "../lib/adminNotify.ts", "../lib/userNotify.ts", "../jobs/factOfTheDay.ts"];

/** Every inline style (including a VML <center> label) that carries a display-stack font. */
function displayStyles(source: string): string[] {
  return [...source.matchAll(/style="([^"]*)"/g)]
    .map((m) => m[1] ?? "")
    .filter((style) => /Oswald|Arial Narrow|mso-font-alt|Impact/.test(style));
}

function stackOf(style: string): string[] {
  const m = style.match(/font-family:([^;]+)/);
  return m ? (m[1] ?? "").split(",").map((f) => f.trim().replace(/^['"]|['"]$/g, "")) : [];
}

function assertBoldCapable(style: string, where: string): void {
  assert.doesNotMatch(style, SINGLE_WEIGHT, `${where}: single-weight font in ${style}`);
  for (const font of stackOf(style)) {
    assert.ok(BOLD_CAPABLE.has(font), `${where}: "${font}" is not a known bold-capable font`);
  }
  const alt = style.match(/mso-font-alt:\s*'([^']+)'/);
  if (alt) assert.ok(BOLD_CAPABLE.has(alt[1] ?? ""), `${where}: mso-font-alt "${alt[1]}" is not bold-capable`);
}

describe("email display font stack", () => {
  it("the password-reset email falls back only to fonts with a real bold", () => {
    const { html } = buildPasswordResetEmail("https://example.test/reset-password?token=abc");
    const styles = displayStyles(html ?? "");
    assert.ok(styles.length >= 3, "expected the wordmark, heading and button to use the display stack");
    for (const style of styles) assertBoldCapable(style, "password reset");
    assert.doesNotMatch(html ?? "", /Impact/);
  });

  it("the CTA button's Outlook (VML) label and its anchor use bold-capable fonts", () => {
    const styles = displayStyles(ctaButton("https://example.test", "Go"));
    assert.equal(styles.length, 2);
    for (const style of styles) assertBoldCapable(style, "ctaButton");
  });

  it("no email template names a single-weight display font", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    let checked = 0;
    for (const rel of TEMPLATE_FILES) {
      const src = readFileSync(path.join(here, rel), "utf8");
      for (const style of displayStyles(src)) {
        checked++;
        assertBoldCapable(style, rel);
      }
    }
    assert.ok(checked > 20, `expected to check every display-stack style, checked ${checked}`);
  });
});

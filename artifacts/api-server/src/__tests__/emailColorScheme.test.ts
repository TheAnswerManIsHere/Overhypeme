/**
 * Regression test for the dark-mode email inversion bug: Apple Mail (and
 * similar clients) auto-invert HTML email that doesn't declare a color
 * scheme, assuming it was authored for light mode. Since every Overhype.me
 * email template is dark-only (see EMAIL_COLORS in email.ts), an inverted
 * render produces a light-background email with a black-on-white body —
 * the opposite of what was sent. `buildEmailShell()` must declare
 * dark-only support so clients don't apply that transform.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

process.env.RESEND_API_KEY = process.env.RESEND_API_KEY ?? "re_test_dummy";

import { buildEmailShell } from "../lib/email.js";

describe("buildEmailShell color-scheme declaration", () => {
  it("declares a dark-only color-scheme meta tag", () => {
    const html = buildEmailShell("<p>body</p>", "footer");
    assert.match(html, /<meta name="color-scheme" content="dark" \/>/);
  });

  it("declares dark-only supported-color-schemes for Apple Mail", () => {
    const html = buildEmailShell("<p>body</p>", "footer");
    assert.match(html, /<meta name="supported-color-schemes" content="dark" \/>/);
  });

  it("declares color-scheme: dark in CSS as a client fallback", () => {
    const html = buildEmailShell("<p>body</p>", "footer");
    assert.match(html, /color-scheme:\s*dark/);
  });

  it("places the color-scheme declarations before the body content", () => {
    const html = buildEmailShell("<p>UNIQUE_BODY_MARKER</p>", "footer");
    const metaIndex = html.indexOf('name="color-scheme"');
    const bodyIndex = html.indexOf("UNIQUE_BODY_MARKER");
    assert.ok(metaIndex > -1, "color-scheme meta tag must be present");
    assert.ok(bodyIndex > -1, "body marker must be present");
    assert.ok(metaIndex < bodyIndex, "color-scheme declaration must precede body content");
  });
});

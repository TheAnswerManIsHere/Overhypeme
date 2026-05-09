/**
 * Phase-4 composite module tests.
 *
 * Exercises `composeMeme` end-to-end with template imageSource (no network,
 * no GCS) so the test is fully self-contained. Confirms the byte-identity
 * invariant the verification checklist requires: identical inputs produce
 * identical bytes across multiple invocations.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { composeMeme } from "../lib/memeComposite.js";

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

describe("Phase 4 — composeMeme", () => {
  it("produces a JPEG buffer for a template imageSource", async () => {
    const result = await composeMeme({
      factTextTemplate: "{NAME} {singular|plural} a fact.",
      name: "Alex",
      pronouns: "they/them",
      imageSource: { type: "template", templateId: "action" },
      aspectRatio: "landscape",
    });
    assert.equal(result.mime, "image/jpeg");
    assert.ok(result.buffer.length > 0, "buffer must be non-empty");
    // Magic bytes for JPEG: FF D8 FF.
    assert.equal(result.buffer[0], 0xff);
    assert.equal(result.buffer[1], 0xd8);
    assert.equal(result.buffer[2], 0xff);
  });

  it("produces byte-identical output for identical inputs across invocations", async () => {
    const input = {
      factTextTemplate: "{NAME} {singular|plural} push.",
      name: "Alex",
      pronouns: "they/them" as const,
      imageSource: { type: "template" as const, templateId: "fire" },
      aspectRatio: "square" as const,
    };
    const a = await composeMeme(input);
    const b = await composeMeme(input);
    assert.equal(sha256(a.buffer), sha256(b.buffer), "two identical compose calls must hash equal");
  });

  it("produces different output when name changes (token substitution active)", async () => {
    const base = {
      factTextTemplate: "{NAME} pushes a fact.",
      pronouns: "they/them",
      imageSource: { type: "template" as const, templateId: "fire" },
      aspectRatio: "landscape" as const,
    };
    const a = await composeMeme({ ...base, name: "Alex" });
    const b = await composeMeme({ ...base, name: "Jordan" });
    assert.notEqual(sha256(a.buffer), sha256(b.buffer));
  });

  it("token substitution conjugates singular for he/him and plural for they/them", async () => {
    // The composite must call renderPersonalized — verify by observing that
    // a fact template with {singular|plural} substitution produces different
    // bytes for he/him vs they/them (the verb form differs).
    const base = {
      factTextTemplate: "{NAME} {pushes|push} the boundary.",
      name: "Sam",
      imageSource: { type: "template" as const, templateId: "ocean" },
      aspectRatio: "landscape" as const,
    };
    const heRender = await composeMeme({ ...base, pronouns: "he/him" });
    const theyRender = await composeMeme({ ...base, pronouns: "they/them" });
    assert.notEqual(sha256(heRender.buffer), sha256(theyRender.buffer));
  });
});

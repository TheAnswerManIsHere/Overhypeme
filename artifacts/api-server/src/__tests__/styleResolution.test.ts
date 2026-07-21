/**
 * Unit tests for the shared render-style resolution (plan §11.1-11.3).
 *
 * `normalizeStyleCopy` / `computeStyleCopyDigest` / `freezeRenderStyleSnapshot`
 * / `isValidRenderStyleSnapshot` are pure. `resolveRenderStyle` is DB-backed —
 * seeds isolated `look_styles` rows under a unique test-id prefix and cleans
 * them up, never touching real seeded style rows.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { inArray } from "drizzle-orm";
import { db, lookStylesTable } from "@workspace/db";
import {
  normalizeStyleCopy,
  computeStyleCopyDigest,
  resolveRenderStyle,
  freezeRenderStyleSnapshot,
  isValidRenderStyleSnapshot,
  RENDER_STYLE_COPY_MAX_CHARS,
  RENDER_STYLE_SNAPSHOT_VERSION,
} from "../lib/imagePrompt/styleResolution";
import { DEFAULT_PHOTOREALISTIC_STYLE } from "../lib/imagePrompt/compilers/nanoBanana2";

describe("normalizeStyleCopy", () => {
  it("accepts a normal short suffix and trims outer whitespace", () => {
    const r = normalizeStyleCopy("  Rendered in cinematic film style.  ");
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.value, "Rendered in cinematic film style.");
  });

  it("rejects empty / whitespace-only input", () => {
    assert.deepEqual(normalizeStyleCopy(""), { ok: false, reason: "empty_suffix" });
    assert.deepEqual(normalizeStyleCopy("   "), { ok: false, reason: "empty_suffix" });
  });

  it("rejects an embedded newline (multi-line copy-paste mistake)", () => {
    const r = normalizeStyleCopy("Line one\nLine two");
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "copy_invalid");
  });

  it("rejects an embedded control character", () => {
    const withControlChar = `Anime style${String.fromCharCode(7)}extra`; // BEL
    const r = normalizeStyleCopy(withControlChar);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "copy_invalid");
  });

  it("rejects copy over RENDER_STYLE_COPY_MAX_CHARS", () => {
    const r = normalizeStyleCopy("x".repeat(RENDER_STYLE_COPY_MAX_CHARS + 1));
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "copy_too_long");
  });

  it("accepts copy at exactly the max", () => {
    const r = normalizeStyleCopy("x".repeat(RENDER_STYLE_COPY_MAX_CHARS));
    assert.equal(r.ok, true);
  });

  it("preserves ordinary punctuation and Unicode", () => {
    const s = "Rendered in ukiyo-e style — bold outlines, muted pigment (葛飾北斎風).";
    const r = normalizeStyleCopy(s);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.value, s);
  });
});

describe("computeStyleCopyDigest", () => {
  it("is deterministic and 64 lowercase hex chars", () => {
    const d1 = computeStyleCopyDigest("Photorealistic rendering.");
    const d2 = computeStyleCopyDigest("Photorealistic rendering.");
    assert.equal(d1, d2);
    assert.match(d1, /^[0-9a-f]{64}$/);
  });

  it("differs for different input", () => {
    assert.notEqual(computeStyleCopyDigest("A"), computeStyleCopyDigest("B"));
  });
});

describe("freezeRenderStyleSnapshot / isValidRenderStyleSnapshot", () => {
  it("freezes a selected result into a valid snapshot", () => {
    const snap = freezeRenderStyleSnapshot(
      { selection: "selected", styleId: "anime-test", variant: "i2i", prompt: "Reimagine this in anime style.", copyDigest: computeStyleCopyDigest("Reimagine this in anime style.") },
      "frozen",
    );
    assert.equal(snap.version, RENDER_STYLE_SNAPSHOT_VERSION);
    assert.equal(isValidRenderStyleSnapshot(snap), true);
  });

  it("rejects a malformed / bare-cast snapshot", () => {
    assert.equal(isValidRenderStyleSnapshot(null), false);
    assert.equal(isValidRenderStyleSnapshot({}), false);
    assert.equal(isValidRenderStyleSnapshot({ version: 2, selection: "default" }), false);
    assert.equal(
      isValidRenderStyleSnapshot({
        version: 1, selection: "default", styleId: null, variant: "i2i",
        prompt: "x", copyDigest: "tooshort", resolutionSource: "frozen",
      }),
      false,
    );
  });
});

describe("resolveRenderStyle (DB-backed)", () => {
  const TEST_ACTIVE_ID = "__test_style_active__";
  const TEST_INACTIVE_ID = "__test_style_inactive__";
  const TEST_EMPTY_SUFFIX_ID = "__test_style_empty__";
  const TEST_OVERLONG_ID = "__test_style_overlong__";
  const seededIds = [TEST_ACTIVE_ID, TEST_INACTIVE_ID, TEST_EMPTY_SUFFIX_ID, TEST_OVERLONG_ID];

  before(async () => {
    await db.insert(lookStylesTable).values([
      {
        id: TEST_ACTIVE_ID, label: "Test Active", isActive: true,
        promptSuffix: "Rendered in test style.",
        promptSuffixReference: "Reimagine this in test style.",
      },
      {
        id: TEST_INACTIVE_ID, label: "Test Inactive", isActive: false,
        promptSuffix: "Rendered in inactive style.",
        promptSuffixReference: "Reimagine this in inactive style.",
      },
      {
        id: TEST_EMPTY_SUFFIX_ID, label: "Test Empty Suffix", isActive: true,
        promptSuffix: "",
        promptSuffixReference: "Reimagine this (t2i suffix intentionally empty).",
      },
      {
        id: TEST_OVERLONG_ID, label: "Test Overlong", isActive: true,
        promptSuffix: "x".repeat(RENDER_STYLE_COPY_MAX_CHARS + 5),
        promptSuffixReference: "x".repeat(RENDER_STYLE_COPY_MAX_CHARS + 5),
      },
    ]).onConflictDoNothing();
  });

  after(async () => {
    await db.delete(lookStylesTable).where(inArray(lookStylesTable.id, seededIds));
  });

  it("resolves to default (photorealistic) when styleId is absent", async () => {
    const r = await resolveRenderStyle(undefined, "i2i");
    assert.equal(r.selection, "default");
    if (r.selection === "default") {
      assert.equal(r.styleId, null);
      assert.equal(r.prompt, DEFAULT_PHOTOREALISTIC_STYLE);
    }
  });

  it("resolves to default when styleId is literally 'none'", async () => {
    const r = await resolveRenderStyle("none", "t2i");
    assert.equal(r.selection, "default");
    if (r.selection === "default") assert.equal(r.styleId, "none");
  });

  it("resolves a valid active style, i2i uses promptSuffixReference", async () => {
    const r = await resolveRenderStyle(TEST_ACTIVE_ID, "i2i");
    assert.equal(r.selection, "selected");
    if (r.selection === "selected") {
      assert.equal(r.prompt, "Reimagine this in test style.");
      assert.equal(r.variant, "i2i");
    }
  });

  it("resolves a valid active style, t2i uses promptSuffix", async () => {
    const r = await resolveRenderStyle(TEST_ACTIVE_ID, "t2i");
    assert.equal(r.selection, "selected");
    if (r.selection === "selected") assert.equal(r.prompt, "Rendered in test style.");
  });

  it("invalid: not_found for a missing style id", async () => {
    const r = await resolveRenderStyle("__does_not_exist__", "i2i");
    assert.equal(r.selection, "invalid");
    if (r.selection === "invalid") assert.equal(r.reason, "not_found");
  });

  it("invalid: inactive for a deactivated style", async () => {
    const r = await resolveRenderStyle(TEST_INACTIVE_ID, "i2i");
    assert.equal(r.selection, "invalid");
    if (r.selection === "invalid") assert.equal(r.reason, "inactive");
  });

  it("invalid: empty_suffix when the mode-specific column is empty", async () => {
    const r = await resolveRenderStyle(TEST_EMPTY_SUFFIX_ID, "t2i");
    assert.equal(r.selection, "invalid");
    if (r.selection === "invalid") assert.equal(r.reason, "empty_suffix");
  });

  it("invalid: copy_too_long for an over-budget custom suffix (never masquerades as default)", async () => {
    const r = await resolveRenderStyle(TEST_OVERLONG_ID, "i2i");
    assert.equal(r.selection, "invalid");
    if (r.selection === "invalid") assert.equal(r.reason, "copy_too_long");
  });

  it("a selected result carries a stable digest that differs across styles", async () => {
    const active = await resolveRenderStyle(TEST_ACTIVE_ID, "i2i");
    const def = await resolveRenderStyle(undefined, "i2i");
    assert.equal(active.selection, "selected");
    assert.equal(def.selection, "default");
    if (active.selection === "selected" && def.selection === "default") {
      assert.notEqual(active.copyDigest, def.copyDigest);
    }
  });
});

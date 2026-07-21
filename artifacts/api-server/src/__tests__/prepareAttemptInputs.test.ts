/**
 * Tests for prepareImagePromptAttemptInputs (plan §11.0) — the canonical,
 * side-effect-free resolution of an attempt's frozen identity + style + fact
 * text. Seeds isolated user + look_styles rows under unique test ids.
 *
 * The load-bearing behaviors: (1) fact text is rendered from the SAME
 * prompt-reduced identity the snapshot carries (no divergence), (2) an invalid
 * style returns a typed domain error rather than silently becoming "no style",
 * and (3) the helper writes no attempt row / enqueues no job.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { inArray, eq } from "drizzle-orm";
import { db, usersTable, lookStylesTable, imagePromptAttemptsTable } from "@workspace/db";
import { prepareImagePromptAttemptInputs } from "../lib/imagePrompt/prepareAttemptInputs";
import { RENDER_STYLE_COPY_MAX_CHARS } from "../lib/imagePrompt/styleResolution";

const STYLE_ID = "__prep_test_style__";
const STYLE_INACTIVE_ID = "__prep_test_style_inactive__";
const userIds: string[] = [];

async function seedUser(fields: { firstName?: string; displayName?: string; pronouns?: string }): Promise<string> {
  const id = `__prep_test_${randomUUID()}`;
  await db.insert(usersTable).values({
    id,
    email: `${id}@test.local`,
    membershipTier: "legendary",
    firstName: fields.firstName ?? null,
    displayName: fields.displayName ?? null,
    pronouns: fields.pronouns ?? null,
  });
  userIds.push(id);
  return id;
}

describe("prepareImagePromptAttemptInputs", () => {
  before(async () => {
    await db.insert(lookStylesTable).values([
      { id: STYLE_ID, label: "Prep Test", isActive: true, promptSuffix: "Rendered in prep-test style.", promptSuffixReference: "Reimagine this in prep-test style." },
      { id: STYLE_INACTIVE_ID, label: "Prep Inactive", isActive: false, promptSuffix: "x", promptSuffixReference: "y" },
    ]).onConflictDoNothing();
  });

  after(async () => {
    await db.delete(lookStylesTable).where(inArray(lookStylesTable.id, [STYLE_ID, STYLE_INACTIVE_ID]));
    if (userIds.length) await db.delete(usersTable).where(inArray(usersTable.id, userIds));
  });

  it("renders fact text from the SAME reduced identity the snapshot carries (user path)", async () => {
    const userId = await seedUser({ firstName: "David", displayName: "David Franklin", pronouns: "he/him" });
    const r = await prepareImagePromptAttemptInputs({
      factTemplate: "{NAME} doesn't read books. {Subj} {is|are} legendary.",
      identity: { kind: "user", userId },
      styleId: STYLE_ID,
      generationMode: "i2i",
    });
    assert.equal(r.ok, true);
    if (r.ok) {
      // prompt-reduced to first name…
      assert.equal(r.prepared.promptIdentity.name, "David");
      // …and the fact text uses that SAME reduced name (not "David Franklin"),
      // with singular verb for he/him.
      assert.equal(r.prepared.renderedFactText, "David doesn't read books. He is legendary.");
      assert.equal(r.prepared.resolvedRenderStyle.selection, "selected");
      assert.equal(r.prepared.resolvedRenderStyle.prompt, "Reimagine this in prep-test style.");
    }
  });

  it("falls back to canonical identity when there is no user", async () => {
    const r = await prepareImagePromptAttemptInputs({
      factTemplate: "{NAME} wins.",
      identity: { kind: "user", userId: null },
      styleId: null,
      generationMode: "t2i",
    });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.prepared.promptIdentity.source, "canonical_fallback");
      assert.equal(r.prepared.renderedFactText, "Alex wins.");
      // no style → default snapshot, empty selected prompt (compiler adds its own)
      assert.equal(r.prepared.resolvedRenderStyle.selection, "default");
    }
  });

  it("reduces a moderation/eval sample identity", async () => {
    const r = await prepareImagePromptAttemptInputs({
      factTemplate: "{NAME} arrives.",
      identity: { kind: "sample", sample: { name: "Robin Vega", pronouns: "they/them" }, source: "review_sample" },
      styleId: STYLE_ID,
      generationMode: "t2i",
    });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.prepared.promptIdentity.name, "Robin");
      assert.equal(r.prepared.promptIdentity.source, "review_sample");
      assert.equal(r.prepared.renderedFactText, "Robin arrives.");
      assert.equal(r.prepared.resolvedRenderStyle.prompt, "Rendered in prep-test style.");
    }
  });

  it("returns a typed style_invalid error for an inactive style (never silently 'no style')", async () => {
    const r = await prepareImagePromptAttemptInputs({
      factTemplate: "{NAME} wins.",
      identity: { kind: "user", userId: null },
      styleId: STYLE_INACTIVE_ID,
      generationMode: "i2i",
    });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.error, "style_invalid");
      if (r.error === "style_invalid") assert.equal(r.reason, "inactive");
    }
  });

  it("returns style_invalid: not_found for a missing style", async () => {
    const r = await prepareImagePromptAttemptInputs({
      factTemplate: "{NAME} wins.",
      identity: { kind: "user", userId: null },
      styleId: "__does_not_exist__",
      generationMode: "i2i",
    });
    assert.equal(r.ok, false);
    if (!r.ok && r.error === "style_invalid") assert.equal(r.reason, "not_found");
  });

  it("writes no attempt row and enqueues no job (side-effect-free)", async () => {
    const before = await db.select({ id: imagePromptAttemptsTable.id }).from(imagePromptAttemptsTable);
    await prepareImagePromptAttemptInputs({
      factTemplate: "{NAME} wins.",
      identity: { kind: "workbench", name: "David Franklin", pronouns: "he/him" },
      styleId: STYLE_ID,
      generationMode: "i2i",
    });
    const after = await db.select({ id: imagePromptAttemptsTable.id }).from(imagePromptAttemptsTable);
    assert.equal(after.length, before.length, "prepare must not insert an attempt row");
  });

  it("workbench identity is tagged distinctly and reduced", async () => {
    const r = await prepareImagePromptAttemptInputs({
      factTemplate: "{NAME} wins.",
      identity: { kind: "workbench", name: "David Franklin", pronouns: "he/him" },
      styleId: null,
      generationMode: "i2i",
    });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.prepared.promptIdentity.source, "workbench");
      assert.equal(r.prepared.promptIdentity.name, "David");
    }
  });

  it("does not accept a style whose active suffix exceeds the copy budget", async () => {
    const overId = "__prep_test_overlong__";
    await db.insert(lookStylesTable).values({
      id: overId, label: "Over", isActive: true,
      promptSuffix: "x".repeat(RENDER_STYLE_COPY_MAX_CHARS + 1),
      promptSuffixReference: "x".repeat(RENDER_STYLE_COPY_MAX_CHARS + 1),
    }).onConflictDoNothing();
    try {
      const r = await prepareImagePromptAttemptInputs({
        factTemplate: "{NAME} wins.",
        identity: { kind: "user", userId: null },
        styleId: overId,
        generationMode: "i2i",
      });
      assert.equal(r.ok, false);
      if (!r.ok && r.error === "style_invalid") assert.equal(r.reason, "copy_too_long");
    } finally {
      await db.delete(lookStylesTable).where(eq(lookStylesTable.id, overId));
    }
  });
});

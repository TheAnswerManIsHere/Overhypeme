/**
 * Core behavior tests for the approved-fact-text lock service.
 *
 * Covers the branch matrix: protected confirmation gate (missing / invalid /
 * stale / valid), the no-op normalized-text short-circuit, root→variant
 * signature invalidation + dependent-cycle blocking, and the staging restart
 * (incl. the durable prep-in-progress rejection). Signature-preservation and
 * audit-row invariants are asserted directly against the DB.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { db } from "@workspace/db";
import { usersTable, factsTable, pendingReviewsTable, asyncJobsTable, factTextEditHistoryTable } from "@workspace/db/schema";
import { eq, inArray } from "drizzle-orm";
import { APPROVED_FACT_TEXT_EDIT_PHRASE } from "@workspace/api-zod";

import { confirmedFactTextEdit } from "../lib/confirmedFactTextEdit.js";
import { hashFactText } from "../lib/enrichmentVersioning.js";

const PREFIX = "t_cfte_";
const factIds: number[] = [];
let adminId: string;

const SIG = { engineRevision: 1, codeVersions: {} } as unknown as Record<string, unknown>;

async function seedFact(text: string, overrides: Partial<typeof factsTable.$inferInsert> = {}): Promise<number> {
  const [f] = await db
    .insert(factsTable)
    .values({ text, submittedById: adminId, isActive: true, enrichmentStatus: "ok", lastProcessedSignature: SIG, ...overrides } as typeof factsTable.$inferInsert)
    .returning({ id: factsTable.id });
  factIds.push(f!.id);
  return f!.id;
}

async function rowOf(id: number) {
  const [r] = await db.select().from(factsTable).where(eq(factsTable.id, id)).limit(1);
  return r!;
}

function goodConfirm(oldText: string) {
  return { phrase: APPROVED_FACT_TEXT_EDIT_PHRASE, reason: "correcting an extreme approval error", expectedOldTextHash: hashFactText(oldText) };
}

before(async () => {
  adminId = `${PREFIX}${randomUUID().slice(0, 8)}`;
  await db.insert(usersTable).values({ id: adminId, email: `${adminId}@t.dev`, isAdmin: true } as typeof usersTable.$inferInsert);
});

after(async () => {
  if (factIds.length) {
    await db.delete(factTextEditHistoryTable).where(inArray(factTextEditHistoryTable.factId, factIds));
    await db.delete(pendingReviewsTable).where(inArray(pendingReviewsTable.stagingFactId, factIds));
    await db.delete(asyncJobsTable).where(inArray(asyncJobsTable.dedupeKey, factIds.flatMap((id) => [`enrichment:fact:${id}`, `fact_pexels:fact:${id}`])));
    await db.delete(factsTable).where(inArray(factsTable.id, factIds));
  }
  await db.delete(usersTable).where(eq(usersTable.id, adminId));
});

describe("confirmedFactTextEdit — protected branch", () => {
  it("no confirmation → confirmation_required with a populated impact", async () => {
    const id = await seedFact(`${PREFIX}${randomUUID()} keeps it real.`);
    const out = await confirmedFactTextEdit({ factId: id, rawText: "A brand new wording entirely.", performedBy: adminId, nonTextUpdates: {} });
    assert.equal(out.kind, "confirmation_required");
    if (out.kind === "confirmation_required") {
      assert.equal(out.impact.protected, true);
      assert.equal(out.impact.protectionReason, "active");
      assert.equal(out.impact.expectedOldTextHash, hashFactText((await rowOf(id)).text));
    }
    // Nothing written.
    assert.deepEqual((await rowOf(id)).lastProcessedSignature, SIG);
  });

  it("wrong phrase → invalid_confirmation (no write)", async () => {
    const id = await seedFact(`${PREFIX}${randomUUID()} original.`);
    const old = (await rowOf(id)).text;
    const out = await confirmedFactTextEdit({ factId: id, rawText: "New wording here.", performedBy: adminId, nonTextUpdates: {}, confirmation: { phrase: "nope", reason: "long enough reason", expectedOldTextHash: hashFactText(old) } });
    assert.equal(out.kind, "invalid_confirmation");
    assert.equal((await rowOf(id)).text, old);
  });

  it("stale hash → stale_baseline (no write)", async () => {
    const id = await seedFact(`${PREFIX}${randomUUID()} original.`);
    const out = await confirmedFactTextEdit({ factId: id, rawText: "New wording here.", performedBy: adminId, nonTextUpdates: {}, confirmation: { phrase: APPROVED_FACT_TEXT_EDIT_PHRASE, reason: "a sufficiently long reason", expectedOldTextHash: hashFactText("something else entirely") } });
    assert.equal(out.kind, "stale_baseline");
  });

  it("valid confirmation → commits, clears signature, preserves enrichmentStatus, writes ONE audit row", async () => {
    const id = await seedFact(`${PREFIX}${randomUUID()} original.`);
    const old = (await rowOf(id)).text;
    const out = await confirmedFactTextEdit({ factId: id, rawText: "The corrected wording.", performedBy: adminId, nonTextUpdates: {}, confirmation: goodConfirm(old) });
    assert.equal(out.kind, "protected_committed");
    const row = await rowOf(id);
    assert.equal(row.text, "The corrected wording.");
    assert.equal(row.lastProcessedSignature, null, "signature cleared → stale_for_reprocess");
    assert.equal(row.enrichmentStatus, "ok", "enrichmentStatus preserved on the protected branch");
    const audit = await db.select().from(factTextEditHistoryTable).where(eq(factTextEditHistoryTable.factId, id));
    assert.equal(audit.length, 1);
    assert.equal(audit[0]!.oldText, old);
    assert.equal(audit[0]!.newText, "The corrected wording.");
    assert.equal(audit[0]!.performedBy, adminId);
  });

  it("normalization-equivalent text → no_text_change (no audit, signature intact)", async () => {
    const id = await seedFact("{Subj} {keeps|keep} it locked.");
    const out = await confirmedFactTextEdit({ factId: id, rawText: "{Subj} keeps it locked.", performedBy: adminId, nonTextUpdates: {} });
    assert.equal(out.kind, "no_text_change");
    assert.deepEqual((await rowOf(id)).lastProcessedSignature, SIG);
    assert.equal((await db.select().from(factTextEditHistoryTable).where(eq(factTextEditHistoryTable.factId, id))).length, 0);
  });
});

describe("confirmedFactTextEdit — root → variant dependency", () => {
  it("clears child variant signatures on a confirmed root edit and reports the count", async () => {
    const root = await seedFact(`${PREFIX}${randomUUID()} root.`);
    const c1 = await seedFact("child one.", { parentId: root });
    const c2 = await seedFact("child two.", { parentId: root });
    const old = (await rowOf(root)).text;
    const out = await confirmedFactTextEdit({ factId: root, rawText: "root reworded.", performedBy: adminId, nonTextUpdates: {}, confirmation: goodConfirm(old) });
    assert.equal(out.kind, "protected_committed");
    if (out.kind === "protected_committed") assert.equal(out.affectedVariantCount, 2);
    assert.equal((await rowOf(c1)).lastProcessedSignature, null);
    assert.equal((await rowOf(c2)).lastProcessedSignature, null);
  });

  it("returns the UPDATED parentId when a variant is promoted to root in the same PATCH (Codex #228 P2)", async () => {
    // A variant is protected (it was ever-approved, per its own history) and the
    // same PATCH both re-words it AND clears parentId (promoting it to root).
    // The route decides root-only side effects from outcome.fact.parentId, so
    // this MUST reflect the post-update state, not the pre-update isRoot flag.
    const parent = await seedFact(`${PREFIX}${randomUUID()} parent.`);
    const variant = await seedFact("variant text.", { parentId: parent });
    const old = (await rowOf(variant)).text;
    const out = await confirmedFactTextEdit({
      factId: variant,
      rawText: "promoted root wording.",
      performedBy: adminId,
      nonTextUpdates: { parentId: null },
      confirmation: goodConfirm(old),
    });
    assert.equal(out.kind, "protected_committed");
    if (out.kind === "protected_committed") {
      assert.equal(out.fact.parentId, null, "the returned row must show the NEW (root) parentage");
      assert.equal(out.fact.text, "promoted root wording.");
    }
  });

  it("blocks (dependent_variant_in_progress) when a child is mid-review — no write", async () => {
    const root = await seedFact(`${PREFIX}${randomUUID()} root2.`);
    const child = await seedFact("child.", { parentId: root, isActive: false });
    await db.insert(pendingReviewsTable).values({ submittedText: "x", status: "pending", stagingFactId: child, workflowStage: "concept_review", candidateVersionId: null } as typeof pendingReviewsTable.$inferInsert);
    const old = (await rowOf(root)).text;
    const out = await confirmedFactTextEdit({ factId: root, rawText: "root reworded.", performedBy: adminId, nonTextUpdates: {}, confirmation: goodConfirm(old) });
    assert.equal(out.kind, "dependent_variant_in_progress");
    assert.equal((await rowOf(root)).text, old, "root text unchanged while blocked");
  });
});

describe("confirmedFactTextEdit — staging branch", () => {
  it("first-time staging edit restarts prep (text written, signature cleared, enrichmentStatus pending, review → prep_pending)", async () => {
    const id = await seedFact(`${PREFIX}${randomUUID()} staging.`, { isActive: false, enrichmentStatus: "ok" });
    const [rev] = await db.insert(pendingReviewsTable).values({ submittedText: "x", status: "pending", stagingFactId: id, workflowStage: "concept_review", candidateVersionId: null } as typeof pendingReviewsTable.$inferInsert).returning({ id: pendingReviewsTable.id });
    const out = await confirmedFactTextEdit({ factId: id, rawText: "edited staging wording.", performedBy: adminId, nonTextUpdates: {} });
    assert.equal(out.kind, "staging_restarted");
    const row = await rowOf(id);
    assert.equal(row.text, "edited staging wording.");
    assert.equal(row.lastProcessedSignature, null);
    assert.equal(row.enrichmentStatus, "pending");
    const [r] = await db.select({ stage: pendingReviewsTable.workflowStage }).from(pendingReviewsTable).where(eq(pendingReviewsTable.id, rev!.id));
    assert.equal(r!.stage, "prep_pending");
    // No audit row for a never-approved staging edit.
    assert.equal((await db.select().from(factTextEditHistoryTable).where(eq(factTextEditHistoryTable.factId, id))).length, 0);
  });

  it("rejects (staging_prep_in_progress) when a durable prep job is nonterminal", async () => {
    const id = await seedFact(`${PREFIX}${randomUUID()} staging2.`, { isActive: false });
    const [rev] = await db.insert(pendingReviewsTable).values({ submittedText: "x", status: "pending", stagingFactId: id, workflowStage: "prep_pending", candidateVersionId: null } as typeof pendingReviewsTable.$inferInsert).returning({ id: pendingReviewsTable.id });
    void rev;
    await db.insert(asyncJobsTable).values({ queue: "enrichment", payload: {}, dedupeKey: `enrichment:fact:${id}`, status: "processing" } as typeof asyncJobsTable.$inferInsert);
    const old = (await rowOf(id)).text;
    const out = await confirmedFactTextEdit({ factId: id, rawText: "should be blocked.", performedBy: adminId, nonTextUpdates: {} });
    assert.equal(out.kind, "staging_prep_in_progress");
    assert.equal((await rowOf(id)).text, old);
  });
});

/**
 * The fold and cast fill (plan docs/plans/PLAN_GAG_DIRECT_RENDER.md, E and
 * Testing Plan, "The fold"): idempotent and reversible; each result state; a
 * subject's role, a silent character's role and an allow-mode override with
 * guidance all reach the scene; an ordinary legacy gag with a second-speaker
 * bubble gets a cast; a refresh's pending operations and picks are untouched.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { db, factsTable, factGagsTable, factGagFoldArchiveTable, usersTable } from "@workspace/db";
import { insertLiveFact } from "@workspace/db/live-fact-fixture";
import { asyncJobsTable } from "@workspace/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import {
  EMPTY_VISUAL_STRATEGY_OVERRIDE,
  buildPlaceholderFactEnrichment,
  castSourceKey,
  type VisualPromptStrategyOverride,
} from "@workspace/api-zod";

import { foldGagContent } from "../lib/gags/fold.js";
import { GAG_FOLD_QUEUE, gagFoldReport, revertGagFold, runGagFold, startGagFold, type GagFoldDeps } from "../lib/gags/foldJob.js";
import { normaliseGagContent } from "../lib/gags/resolver.js";
import type { CastExtractionInput } from "../lib/gags/castExtraction.js";
import request from "supertest";
import gagFoldRouter from "../routes/gagFold.js";
import { buildTestApp } from "./helpers/buildTestApp.js";

const RUN = randomUUID().slice(0, 8);
const base = (scene: string, extra: Partial<VisualPromptStrategyOverride> = {}): VisualPromptStrategyOverride =>
  ({ ...EMPTY_VISUAL_STRATEGY_OVERRIDE, coreSceneOverride: scene, ...extra });

/** A stub extractor: binds every speaker, plus "dog" when the scene mentions one. */
const calls: CastExtractionInput[] = [];
const stub: GagFoldDeps = {
  extract: async (input) => {
    calls.push(input);
    const speakers = input.bubbles.map((b) => b.entity).filter((e) => e !== "subject" && input.scene.toLowerCase().includes(e.toLowerCase()));
    const unbound = input.bubbles.map((b) => b.entity).filter((e) => e !== "subject" && !speakers.includes(e));
    const cast = [...speakers.map((label) => ({ label, description: `the ${label}` })), ...(input.scene.includes("dog") ? [{ label: "dog", description: "the dog" }] : [])];
    return { cast, unboundSpeakers: unbound, extraction: { promptVersion: "v2", extractedAt: "2026-11-17T00:00:00.000Z", sourceKey: castSourceKey(input.scene, input.bubbles) } };
  },
};

describe("the fold, as a pure function", () => {
  it("leaves a version with nothing in the extra fields alone", () => {
    assert.deepEqual(foldGagContent(base("{NAME} lifts a car.")), { kind: "nothing" });
  });

  it("keeps a depiction description its mode never rendered (use_ai_plan) in the archive only, out of the scene", () => {
    const out = foldGagContent(base("{NAME} lifts a car.", { subjectRealizationOverride: { mode: "use_ai_plan", description: "{NAME} in a tracksuit" } }));
    assert.equal(out.kind, "converted");
    if (out.kind !== "converted") return;
    assert.equal(out.content.coreSceneOverride, "{NAME} lifts a car.", "inactive direction is not switched on");
    assert.equal(out.content.subjectRealizationOverride, undefined);
    assert.ok(out.moved.some((m) => m.includes("archived only")));
  });

  it("moves every field by meaning into the scene: roles (the subject's and a silent character's), details, composition, extras, prohibitions, allow-mode guidance", () => {
    const out = foldGagContent(base("{NAME} lifts a car.", {
      moderatorIntent: "make it heroic",
      notesForModerator: "never shown",
      subjectRealizationOverride: { mode: "custom", description: "{NAME} in a tracksuit" },
      roleBindings: [{ entity: "subject", visualRole: "strains under the weight" }, { entity: "mechanic", visualRole: "watches, stunned, saying nothing" }],
      requiredVisualDetails: ["a red sedan", "oil on the floor"],
      compositionGuidance: ["low angle"],
      styleAgnosticPromptAdditions: ["garage lights flicker"],
      forbiddenVisualDetails: ["a crowd"],
      negativePromptAdditions: ["Don't show a crane"],
      violencePolicyOverride: { mode: "allow", intensity: "strong", guidance: "the car's bumper falls off" },
      supportingTextPolicyOverride: { mode: "allow", guidance: "a sign reads GARAGE" },
    }));
    assert.equal(out.kind, "converted");
    if (out.kind !== "converted") return;
    assert.equal(
      out.content.coreSceneOverride,
      "{NAME} lifts a car. {NAME} in a tracksuit. {NAME}: strains under the weight. mechanic: watches, stunned, saying nothing. "
        + "Also in the picture: a red sedan; oil on the floor. Composition: low angle. garage lights flicker. No a crowd. Don't show a crane. "
        + "the car's bumper falls off. a sign reads GARAGE.",
    );
    const c = out.content;
    assert.equal(c.moderatorIntent, undefined, "intent is kept in the archive only");
    assert.equal(c.notesForModerator, undefined);
    assert.equal(c.subjectRealizationOverride, undefined);
    assert.equal(c.violencePolicyOverride, undefined);
    assert.equal(c.supportingTextPolicyOverride, undefined);
    for (const k of ["requiredVisualDetails", "forbiddenVisualDetails", "roleBindings", "compositionGuidance", "styleAgnosticPromptAdditions", "negativePromptAdditions"] as const) {
      assert.deepEqual(c[k], [], k);
    }
  });

  it("lists, and does not convert, what would change the picture", () => {
    const cases: Array<[string, Partial<VisualPromptStrategyOverride>]> = [
      ["violence soften", { violencePolicyOverride: { mode: "soften", intensity: "mild" } }],
      ["violence suppress", { violencePolicyOverride: { mode: "suppress", intensity: "nonviolent", guidance: "x" } }],
      ["allow at a gentler intensity", { violencePolicyOverride: { mode: "allow", intensity: "mild" } }],
      ["supporting text forbid", { supportingTextPolicyOverride: { mode: "forbid" } }],
      ["supporting text require", { supportingTextPolicyOverride: { mode: "require", guidance: "a sign" } }],
      ["a depiction mode with no description", { subjectRealizationOverride: { mode: "age_transformed_human", description: "" } }],
    ];
    for (const [name, extra] of cases) {
      const out = foldGagContent(base("{NAME} lifts a car.", { requiredVisualDetails: ["a sedan"], ...extra }));
      assert.equal(out.kind, "listed", name);
      if (out.kind === "listed") assert.ok(out.reasons.length > 0, name);
    }
  });

  it("lists a version the scene could not hold, and truncates nothing", () => {
    const out = foldGagContent(base("x".repeat(2900), { requiredVisualDetails: ["y".repeat(300)] }));
    assert.equal(out.kind, "listed");
    if (out.kind === "listed") assert.match(out.reasons[0]!, /too long/);
  });
});

describe("the fold job", () => {
  const factIds: number[] = [];
  const gagIds: number[] = [];
  let adminId = "";

  async function fact(gag: VisualPromptStrategyOverride, pending?: VisualPromptStrategyOverride) {
    const f = await insertLiveFact({ text: `{NAME} fold test ${RUN} ${randomUUID().slice(0, 6)}`, enrichment: buildPlaceholderFactEnrichment() }, gag);
    factIds.push(f.id);
    const g = f.gags[0]!;
    gagIds.push(g.id);
    if (pending) await db.update(factGagsTable).set({ pendingContent: pending, pendingBy: adminId, pendingAt: new Date() }).where(eq(factGagsTable.id, g.id));
    return { factId: f.id, gagId: g.id };
  }
  const row = async (gagId: number) => (await db.select().from(factGagsTable).where(eq(factGagsTable.id, gagId)))[0]!;
  const mine = (r: Awaited<ReturnType<typeof gagFoldReport>>) => ({
    forModerator: r.forModerator.filter((v) => gagIds.includes(v.gagId)),
    castMissing: r.castMissing.filter((v) => gagIds.includes(v.gagId)),
  });

  before(async () => {
    adminId = `t-fold-${RUN}`;
    await db.insert(usersTable).values({ id: adminId, email: `${adminId}@test.local`, isAdmin: true, membershipTier: "legendary" });
  });
  after(async () => {
    await db.update(factsTable).set({ isActive: false }).where(inArray(factsTable.id, factIds));
    await db.delete(factGagFoldArchiveTable).where(inArray(factGagFoldArchiveTable.factId, factIds));
    await db.delete(factGagsTable).where(inArray(factGagsTable.factId, factIds));
    await db.delete(factsTable).where(inArray(factsTable.id, factIds));
    await db.delete(asyncJobsTable).where(eq(asyncJobsTable.queue, GAG_FOLD_QUEUE));
    await db.delete(usersTable).where(eq(usersTable.id, adminId));
  });

  it("converts the approved and pending versions independently, keeps each original, reads each cast, and leaves the refresh's operations alone", async () => {
    const approved = base("{NAME} lifts a car.", { requiredVisualDetails: ["a dog barking"] });
    const pending = base("{NAME} lifts a bus.", { roleBindings: [{ entity: "driver", visualRole: "honks" }], bubbles: [{ type: "speech", entity: "driver", text: "Hey!" }] });
    const { gagId } = await fact(approved, pending);
    const before = await row(gagId);

    const a = await runGagFold({ gagId, stage: "approved" }, stub);
    const p = await runGagFold({ gagId, stage: "pending" }, stub);
    assert.equal(a.ok, true, JSON.stringify(a));
    assert.equal(p.ok, true, JSON.stringify(p));

    const after = await row(gagId);
    const ac = normaliseGagContent(after.approvedContent)!;
    const pc = normaliseGagContent(after.pendingContent)!;
    assert.equal(ac.coreSceneOverride, "{NAME} lifts a car. Also in the picture: a dog barking.");
    assert.deepEqual(ac.requiredVisualDetails, []);
    assert.deepEqual(ac.cast, [{ label: "dog", description: "the dog" }], "the cast is read from the folded scene");
    assert.equal(pc.coreSceneOverride, "{NAME} lifts a bus. driver: honks.");
    assert.deepEqual(pc.cast, [{ label: "driver", description: "the driver" }]);
    assert.equal(after.pendingBy, before.pendingBy, "the change's author is untouched");

    const archive = await db.select().from(factGagFoldArchiveTable).where(eq(factGagFoldArchiveTable.gagId, gagId));
    assert.equal(archive.length, 2);
    assert.deepEqual(archive.find((x) => x.stage === "approved")!.originalContent, before.approvedContent);
    assert.deepEqual(archive.find((x) => x.stage === "pending")!.originalContent, before.pendingContent);
  });

  it("is idempotent: a second run is a no-op and the report reads already converted, cast extracted", async () => {
    const { gagId } = await fact(base("{NAME} juggles.", { compositionGuidance: ["wide shot"] }));
    assert.equal((await runGagFold({ gagId, stage: "approved" }, stub)).ok, true);
    const once = await row(gagId);
    const n = calls.length;
    const again = await runGagFold({ gagId, stage: "approved" }, stub);
    assert.deepEqual(again, { ok: true, result: { skipped: true, reason: "already_current" } });
    assert.equal(calls.length, n, "no second model call");
    assert.deepEqual(await row(gagId), once, "twice == once");
    assert.equal((await db.select().from(factGagFoldArchiveTable).where(eq(factGagFoldArchiveTable.gagId, gagId))).length, 1);
    const report = await gagFoldReport();
    assert.equal(mine(report).castMissing.some((v) => v.gagId === gagId), false);
    assert.equal(report.fold.already_converted >= 1, true);
  });

  it("gives an ordinary legacy gag with a second-speaker bubble its cast, folding nothing", async () => {
    const { gagId } = await fact(base("{NAME} sings; mom covers her ears.", { bubbles: [{ type: "speech", entity: "mom", text: "Stop!" }] }));
    assert.equal(mine(await gagFoldReport()).castMissing.find((v) => v.gagId === gagId)?.cast, "missing");
    const res = await runGagFold({ gagId, stage: "approved" }, stub);
    assert.equal(res.ok, true);
    const c = normaliseGagContent((await row(gagId)).approvedContent)!;
    assert.equal(c.coreSceneOverride, "{NAME} sings; mom covers her ears.");
    assert.deepEqual(c.cast, [{ label: "mom", description: "the mom" }]);
    assert.equal(c.castExtraction?.sourceKey, castSourceKey(c.coreSceneOverride, c.bubbles));
    assert.equal((await db.select().from(factGagFoldArchiveTable).where(eq(factGagFoldArchiveTable.gagId, gagId))).length, 0, "nothing folded, nothing archived");
  });

  it("writes nothing when the cast reading fails, and retries", async () => {
    const original = base("{NAME} sings.", { requiredVisualDetails: ["a microphone"] });
    const { gagId } = await fact(original);
    const before = await row(gagId);
    const res = await runGagFold({ gagId, stage: "approved" }, { extract: async () => { throw new Error("model down"); } });
    assert.equal(res.ok, false);
    assert.deepEqual(await row(gagId), before);
  });

  it("lands the fold but not the cast when the scene does not show a speaker, and lists the version", async () => {
    const { gagId } = await fact(base("{NAME} sings alone.", { compositionGuidance: ["close up"], bubbles: [{ type: "speech", entity: "nurse", text: "Shh" }] }));
    const res = await runGagFold({ gagId, stage: "approved" }, stub);
    assert.equal(res.ok, true);
    const c = normaliseGagContent((await row(gagId)).approvedContent)!;
    assert.equal(c.coreSceneOverride, "{NAME} sings alone. Composition: close up.");
    assert.equal(c.castExtraction, undefined);
    // The report reads the job's result; record it as the worker would.
    await db.insert(asyncJobsTable).values({ queue: GAG_FOLD_QUEUE, payload: { gagId, stage: "approved" }, dedupeKey: `gag_fold:${gagId}:approved`, status: "done", result: (res as { result: object }).result });
    const listed = mine(await gagFoldReport()).castMissing.find((v) => v.gagId === gagId && v.stage === "approved");
    assert.equal(listed?.cast, "failed");
    assert.match(listed!.reasons[0]!, /does not show bubble speaker "nurse"/);
  });

  it("does not convert a listed version, and the report names why", async () => {
    const { gagId } = await fact(base("{NAME} boxes.", { violencePolicyOverride: { mode: "soften", intensity: "mild" } }));
    const res = await runGagFold({ gagId, stage: "approved" }, stub);
    assert.equal(res.ok, true);
    const c = normaliseGagContent((await row(gagId)).approvedContent)!;
    assert.equal(c.violencePolicyOverride?.mode, "soften", "the override stays for a moderator");
    assert.ok(c.castExtraction, "the cast is still read: every version gets one");
    const listed = mine(await gagFoldReport()).forModerator.find((v) => v.gagId === gagId);
    assert.match(listed!.reasons[0]!, /violence is set to soften/);
  });

  it("gives up, to retry, when the version changed while its cast was read", async () => {
    const { gagId } = await fact(base("{NAME} skates.", { compositionGuidance: ["wide"] }));
    const res = await runGagFold({ gagId, stage: "approved" }, {
      extract: async (input) => {
        await db.update(factGagsTable).set({ approvedContent: base("{NAME} skates fast.") }).where(eq(factGagsTable.id, gagId));
        return stub.extract(input);
      },
    });
    assert.equal(res.ok, false);
    assert.equal(normaliseGagContent((await row(gagId)).approvedContent)!.coreSceneOverride, "{NAME} skates fast.", "the moderator's change stands");
  });

  it("reverses a conversion while the version is as the fold left it, and refuses once it changed", async () => {
    const original = base("{NAME} dives.", { requiredVisualDetails: ["a shark"] });
    const { gagId } = await fact(original);
    const before = (await row(gagId)).approvedContent;
    await runGagFold({ gagId, stage: "approved" }, stub);
    const [a] = await db.select().from(factGagFoldArchiveTable).where(eq(factGagFoldArchiveTable.gagId, gagId));
    assert.equal(await revertGagFold(a!.id), "reverted");
    assert.deepEqual((await row(gagId)).approvedContent, before);
    assert.equal(await revertGagFold(a!.id), "already_reverted");

    const { gagId: g2 } = await fact(base("{NAME} dives again.", { requiredVisualDetails: ["a whale"] }));
    await runGagFold({ gagId: g2, stage: "approved" }, stub);
    await db.update(factGagsTable).set({ approvedContent: base("{NAME} edited after.") }).where(eq(factGagsTable.id, g2));
    const [b] = await db.select().from(factGagFoldArchiveTable).where(eq(factGagFoldArchiveTable.gagId, g2));
    assert.equal(await revertGagFold(b!.id), "changed_since");
  });

  it("the report is the dry run: it writes nothing; a run queues only versions with work, and dedupes", async () => {
    const { gagId } = await fact(base("{NAME} naps.", { styleAgnosticPromptAdditions: ["snoring loudly"] }));
    const before = await row(gagId);
    const report = await gagFoldReport();
    assert.deepEqual(await row(gagId), before, "the report wrote nothing");
    assert.ok(report.fold.would_convert >= 1);
    const first = await startGagFold();
    const keys = (await db.select({ k: asyncJobsTable.dedupeKey }).from(asyncJobsTable).where(eq(asyncJobsTable.queue, GAG_FOLD_QUEUE))).map((r) => r.k);
    assert.ok(keys.includes(`gag_fold:${gagId}:approved`));
    const second = await startGagFold();
    assert.ok(second.deduped >= 1, "a queued version is not queued twice");
    assert.ok(first.requested >= 1);
  });

  it("counts a job taken back after a server stop (recovering) as queued, so the panel keeps polling (Issue #1000, PR #1026 round 1)", async () => {
    const { gagId } = await fact(base("{NAME} juggles.", { styleAgnosticPromptAdditions: ["three flaming torches"] }));
    await startGagFold();
    const key = `gag_fold:${gagId}:approved`;
    const queuedBefore = (await gagFoldReport()).jobs.queued;
    await db.update(asyncJobsTable).set({ status: "recovering", recoveryProtocol: 1 })
      .where(and(eq(asyncJobsTable.queue, GAG_FOLD_QUEUE), eq(asyncJobsTable.dedupeKey, key)));
    const report = await gagFoldReport();
    assert.ok(queuedBefore >= 1);
    assert.equal(report.jobs.queued, queuedBefore, "the recovering job still counts as queued");
  });
});

describe("the fold's routes", () => {
  const member = `t-fold-member-${RUN}`;
  const admin = `t-fold-admin-${RUN}`;
  before(async () => {
    await db.insert(usersTable).values([
      { id: member, email: `${member}@test.local`, isAdmin: false, membershipTier: "legendary" },
      { id: admin, email: `${admin}@test.local`, isAdmin: true, membershipTier: "legendary" },
    ]);
  });
  after(async () => {
    await db.delete(usersTable).where(inArray(usersTable.id, [member, admin]));
  });

  it("are admin-only: a member can neither read the report, start a run, nor reverse a fold", async () => {
    const app = buildTestApp({ kind: "authenticated", userId: member }, gagFoldRouter);
    assert.equal((await request(app).get("/api/admin/gag-fold")).status, 403);
    assert.equal((await request(app).post("/api/admin/gag-fold/run")).status, 403);
    assert.equal((await request(app).post("/api/admin/gag-fold/archive/1/revert")).status, 403);
  });

  it("answer an admin with the report, and a reversal of an unknown conversion with 404", async () => {
    const app = buildTestApp({ kind: "authenticated", userId: admin }, gagFoldRouter);
    const res = await request(app).get("/api/admin/gag-fold");
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.forModerator) && Array.isArray(res.body.castMissing));
    assert.equal((await request(app).post("/api/admin/gag-fold/archive/999999999/revert")).status, 404);
  });
});

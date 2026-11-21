/**
 * The list of gags a user may be offered, as Phase 7's picker and AI-picture
 * flow will read it (plan docs/plans/PLAN_THREE_GAGS.md, increment 2, step 7;
 * decisions 2, 3, 13 and 15): `availableGags` and `resolveOfferedGag`.
 *
 *   - default first, then slot order; only approved versions;
 *   - a new gag and a pending change are never offered; the approved version
 *     keeps being served while a change waits;
 *   - a removed gag is gone; a fact that is not live offers nothing;
 *   - a caller naming no gag gets the default; naming one that is not
 *     available is refused, never quietly replaced by another.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { and, eq, inArray } from "drizzle-orm";
import { db, factsTable, usersTable, factGagsTable } from "@workspace/db";
import { insertLiveFact } from "@workspace/db/live-fact-fixture";
import { factEnrichmentVersionsTable, imagePromptAttemptsTable, pendingReviewsTable } from "@workspace/db/schema";
import { EMPTY_VISUAL_STRATEGY_OVERRIDE, buildPlaceholderFactEnrichment, type VisualPromptStrategyOverride } from "@workspace/api-zod";

import { availableGags, GagNotAvailableError, resolveOfferedGag } from "../lib/gags/resolver.js";
import { removeGag, saveGagContent } from "../lib/gags/gagStore.js";
import { withCast } from "./helpers/gagCast.js";
import { giveExampleSet } from "./helpers/gagExampleSets.js";
import { publishDraft } from "../lib/gags/publish.js";
import { GoLiveError } from "../lib/gags/goLive.js";

const RUN = randomUUID().slice(0, 8);
const scene = (text: string): VisualPromptStrategyOverride => withCast({ ...EMPTY_VISUAL_STRATEGY_OVERRIDE, coreSceneOverride: text });

let adminId = "";
const factIds: number[] = [];

/** A live fact whose gags are approved in the order given (slot 1, 2, 3). */
async function liveFact(...scenes: string[]): Promise<{ factId: number; gagIds: number[] }> {
  const f = await insertLiveFact({ text: `{NAME} available ${RUN} ${randomUUID().slice(0, 6)}`, enrichment: buildPlaceholderFactEnrichment() }, scene(scenes[0] ?? "{NAME} one."));
  factIds.push(f.id);
  const ids = [f.gags[0]!.id];
  for (const [i, text] of scenes.slice(1).entries()) {
    const [row] = await db.insert(factGagsTable).values({ factId: f.id, slot: i + 2, approvedContent: scene(text) as never, approvedCarriedOver: true }).returning({ id: factGagsTable.id });
    ids.push(row!.id);
  }
  return { factId: f.id, gagIds: ids };
}

const scenes = async (factId: number) => (await availableGags(factId)).map((g) => g.content.coreSceneOverride);

before(async () => {
  adminId = `t-avail-${RUN}`;
  await db.insert(usersTable).values({ id: adminId, email: `${adminId}@test.local`, isAdmin: true, membershipTier: "legendary" });
});

after(async () => {
  if (factIds.length) {
    await db.update(factsTable).set({ isActive: false }).where(inArray(factsTable.id, factIds));
    await db.delete(factGagsTable).where(inArray(factGagsTable.factId, factIds));
    await db.delete(imagePromptAttemptsTable).where(inArray(imagePromptAttemptsTable.factId, factIds));
    await db.update(factEnrichmentVersionsTable).set({ sourceReviewId: null }).where(inArray(factEnrichmentVersionsTable.factId, factIds));
    await db.delete(pendingReviewsTable).where(inArray(pendingReviewsTable.stagingFactId, factIds));
    await db.delete(factEnrichmentVersionsTable).where(inArray(factEnrichmentVersionsTable.factId, factIds));
    await db.delete(factsTable).where(inArray(factsTable.id, factIds));
  }
  await db.delete(usersTable).where(eq(usersTable.id, adminId));
});

describe("availableGags: what a user may be offered", () => {
  it("lists the approved versions, default first, in slot order", async () => {
    const { factId, gagIds } = await liveFact("{NAME} one.", "{NAME} two.", "{NAME} three.");
    const list = await availableGags(factId);
    assert.deepEqual(list.map((g) => g.gagId), gagIds);
    assert.deepEqual(list.map((g) => g.slot), [1, 2, 3]);
    assert.ok(list.every((g) => Array.isArray(g.content.roleBindings)), "content comes through the one normalising reader");
  });

  it("never offers a draft-only gag or a draft change; the published version keeps being served", async () => {
    const { factId, gagIds } = await liveFact("{NAME} one.");
    await db.insert(factGagsTable).values({ factId, slot: 2, pendingContent: scene("{NAME} a new gag.") as never });
    await saveGagContent(factId, gagIds[0]!, scene("{NAME} one, changed."), { adminId, reviewId: null });
    assert.deepEqual(await scenes(factId), ["{NAME} one."]);
  });

  it("drops a removed gag, and offers nothing for a fact that is not live", async () => {
    const { factId, gagIds } = await liveFact("{NAME} one.", "{NAME} two.");
    await db.update(factGagsTable).set({ removedAt: new Date() }).where(eq(factGagsTable.id, gagIds[0]!));
    assert.deepEqual(await scenes(factId), ["{NAME} two."]);
    await db.update(factsTable).set({ isActive: false }).where(eq(factsTable.id, factId));
    assert.deepEqual(await availableGags(factId), []);
  });

  it("a removal and a change in the draft reach users only when the draft is published, all at once (plan 1F)", async () => {
    const { factId, gagIds } = await liveFact("{NAME} one.", "{NAME} two.");
    for (const [i, id] of gagIds.entries()) await giveExampleSet(factId, id, scene(["{NAME} one.", "{NAME} two."][i]!), "approved");
    await removeGag(factId, gagIds[0]!, { adminId, reviewId: null });
    const changed = scene("{NAME} two, changed.");
    await saveGagContent(factId, gagIds[1]!, changed, { adminId, reviewId: null });
    assert.deepEqual(await scenes(factId), ["{NAME} one.", "{NAME} two."], "the published set is still served");
    // The draft does not meet the go-live rule yet (the change has no renders): nothing is published.
    await assert.rejects(() => db.transaction((tx) => publishDraft(tx, factId, adminId)), GoLiveError);
    assert.deepEqual(await scenes(factId), ["{NAME} one.", "{NAME} two."]);
    const picks = await giveExampleSet(factId, gagIds[1]!, changed, "pending");
    const result = await db.transaction((tx) => publishDraft(tx, factId, adminId));
    assert.deepEqual(result, { published: 1, removed: 1, unchanged: 0 });
    const list = await availableGags(factId);
    assert.deepEqual(list.map((g) => g.content.coreSceneOverride), ["{NAME} two, changed."]);
    assert.deepEqual(list[0]!.examples, picks, "the draft's picks are the published examples");
  });
});

describe("resolveOfferedGag: the one way a non-moderator caller picks a gag", () => {
  it("gives the default when no gag is named, and the named one when it is available", async () => {
    const { factId, gagIds } = await liveFact("{NAME} one.", "{NAME} two.");
    assert.equal((await resolveOfferedGag(factId, null)).gagId, gagIds[0]);
    assert.equal((await resolveOfferedGag(factId, gagIds[1]!)).gagId, gagIds[1]);
  });

  it("refuses a gag that is not available, rather than drawing another", async () => {
    const { factId, gagIds } = await liveFact("{NAME} one.");
    const [hidden] = await db.insert(factGagsTable).values({ factId, slot: 2, pendingContent: scene("{NAME} hidden.") as never }).returning({ id: factGagsTable.id });
    await assert.rejects(() => resolveOfferedGag(factId, hidden!.id), GagNotAvailableError);
    const other = await liveFact("{NAME} another fact's gag.");
    await assert.rejects(() => resolveOfferedGag(factId, other.gagIds[0]!), GagNotAvailableError, "a gag of another fact is not this fact's");
    await db.update(factsTable).set({ isActive: false }).where(eq(factsTable.id, factId));
    await assert.rejects(() => resolveOfferedGag(factId, null), GagNotAvailableError, "a fact that is not live offers nothing");
    assert.ok(gagIds.length === 1 && (await db.select().from(factGagsTable).where(and(eq(factGagsTable.factId, factId)))).length === 2);
  });
});

/**
 * @purpose Insert a live fact together with the approved gag the database requires of it, for seeds and tests.
 * @subsystem moderation
 *
 * Since migration 0139 a fact may be active only while it has a non-removed
 * gag with an approved version (the deferred trigger
 * enforce_live_fact_has_approved_gag). A seed or test that wants a live fact
 * therefore inserts both in one transaction; this is the one helper that does.
 *
 * The gag is written as a live fact stood before examples existed: an
 * approved version with no example render, marked carried over. Product code
 * never calls this; a live fact in the product is made by moderation
 * (activateFact), and an approved version there always has its example.
 */
import { db } from "./index";
import { factsTable, type Fact } from "./schema/facts";
import { factGagsTable, type FactGag } from "./schema/factGags";

type InsertFact = typeof factsTable.$inferInsert;

type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface LiveFactFixture {
  /** The fact row. `isActive` is forced to true. */
  fact: Omit<InsertFact, "isActive">;
  /** The gag's content: a visual-strategy override object with a non-empty scene. */
  gag: unknown;
  /** Extra approved gags for slots 2 and 3, if wanted. */
  moreGags?: unknown[];
}

/** Insert live facts and their approved gags in one transaction (or the caller's). */
export async function insertLiveFacts(
  rows: LiveFactFixture[],
  executor?: Executor,
): Promise<Array<Fact & { gags: FactGag[] }>> {
  const run = async (tx: Executor) => {
    const out: Array<Fact & { gags: FactGag[] }> = [];
    for (const row of rows) {
      // A gag may hold published content only on a fact approved for
      // production (migration 0157), so a fixture's live fact carries a
      // legacy approval unless the caller says otherwise (a test of an older
      // migration passes approvedAt: null, with that rule's trigger off).
      const approval = "approvedAt" in row.fact
        ? {}
        : { approvedAt: new Date(), approvalSource: "legacy" as const };
      const [fact] = await tx.insert(factsTable).values({ ...row.fact, ...approval, isActive: true }).returning();
      const contents = [row.gag, ...(row.moreGags ?? [])];
      const gags = await tx
        .insert(factGagsTable)
        .values(contents.map((content, i) => ({
          factId: fact!.id,
          slot: i + 1,
          approvedContent: content,
          approvedCarriedOver: true,
        })))
        .returning();
      out.push({ ...fact!, gags });
    }
    return out;
  };
  return executor ? run(executor) : db.transaction(run);
}

/** One live fact and its approved gag. */
export async function insertLiveFact(
  fact: Omit<InsertFact, "isActive">,
  gag: unknown,
  executor?: Executor,
): Promise<Fact & { gags: FactGag[] }> {
  const [row] = await insertLiveFacts([{ fact, gag }], executor);
  return row!;
}

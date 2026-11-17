/**
 * recordAdminAction's two modes (PR #1033's build report, answered on Issue
 * #1018): inside the change's transaction a failed record fails the change;
 * after a change that already committed, a failed record is logged and
 * swallowed, so the admin is never shown an error for a change that happened
 * and the work after it still runs.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { db } from "@workspace/db";
import { recordAdminAction } from "../lib/adminActions";

// A fact id no row has: the foreign key refuses the insert.
const NO_SUCH_FACT = -424242;

describe("recordAdminAction", () => {
  it("after a committed change (no executor): a failed record resolves, it does not throw", async () => {
    await recordAdminAction({ factId: NO_SUCH_FACT }, null, "gag_save");
  });

  it("inside the change's transaction: a failed record throws and rolls the change back", async () => {
    await assert.rejects(db.transaction(async (tx) => {
      await recordAdminAction({ factId: NO_SUCH_FACT }, null, "gag_save", {}, tx);
    }));
  });
});

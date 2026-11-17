/**
 * Make the next child-job insert for one fact fail inside its transaction, as
 * a server stop or a database error between a write and its child would
 * (Issue #1000 §F). Scoped by a trigger to `payload->>'factId'`, so suites
 * sharing the test database are untouched. Returns the cleanup.
 */
import { randomUUID } from "node:crypto";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

export async function blockChildJobsForFact(factId: number): Promise<() => Promise<void>> {
  const name = `test_block_child_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  await db.execute(sql.raw(`
    CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'child job blocked for the test'; END $$;
    CREATE TRIGGER ${name} BEFORE INSERT ON async_jobs FOR EACH ROW
      WHEN (NEW.payload->>'factId' = '${Number(factId)}' AND NEW.queue = 'fact_visual_concepts')
      EXECUTE FUNCTION ${name}();`));
  return async () => {
    await db.execute(sql.raw(`DROP TRIGGER IF EXISTS ${name} ON async_jobs; DROP FUNCTION IF EXISTS ${name}();`));
  };
}

/**
 * Drives the exporter's snapshot binding against a seeded source (Codex round 1, finding 4263097705).
 *
 *   DATABASE_URL=<seeded source> tsx legacyFixtureSnapshotProbe.ts concurrent <render attempt id>
 *   DATABASE_URL=<seeded source> tsx legacyFixtureSnapshotProbe.ts recycle
 *
 * `concurrent` makes a current render stale through a separate connection after the rows were read and
 * before the predicates are evaluated, then prints the recorded outcome for that attempt. `recycle`
 * destroys the pool's bound connection mid-pass and prints whether the export stopped.
 */
import pg from "pg";

process.env.DB_POOL_MAX = "1";
const [mode, attemptId] = process.argv.slice(2);
const url = process.env.DATABASE_URL!;

const { runExport } = await import("../../testing/legacyFixture/export");
const { evaluatePredicatesInSnapshot } = await import("../../testing/legacyFixture/predicates");
const { pool } = await import("@workspace/db");

const during = async () => {
  if (mode === "concurrent") {
    const writer = new pg.Client({ connectionString: url });
    await writer.connect();
    await writer.query("UPDATE image_prompt_attempts SET review_render_input_hash = repeat('0', 64) WHERE id = $1", [Number(attemptId)]);
    await writer.end();
  } else {
    const bound = await pool.connect();
    bound.release(true); // destroyed: the pool opens a fresh, unbound connection for the readers
  }
};

try {
  const result = await runExport({ sourceUrl: url, sourceCommit: "probe", evaluatePredicates: (id) => evaluatePredicatesInSnapshot(id, during) });
  console.log(JSON.stringify({ stopped: false, outcome: result.manifest?.predicates.renderAttempts[String(attemptId)] ?? null, stops: result.stops }));
} catch (err) {
  console.log(JSON.stringify({ stopped: true, reason: err instanceof Error ? err.message : String(err) }));
}
await pool.end();
process.exit(0);

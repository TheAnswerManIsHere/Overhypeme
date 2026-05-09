import { db, pool } from "@workspace/db";
import { sql } from "drizzle-orm";

async function main() {
  const FACT_TEXT_PATTERNS = [
    "a fact",
    "test fact",
    "for-preference",
    "no-pref-yet",
    "oor",
    "upsertable",
    "yours",
    "already-gone",
    "to-soft-delete",
    "idempotent",
    "distinct framing",
    "cap fact",
    "soft del cap",
    "legendary fact",
    "slug uniqueness",
    "seed",
    "share-target",
    "source-fact",
    "double",
    "single-high",
    "single-low",
    "solo-fact",
    "with-links",
    "hashtag-test-fact",
    "secret content nobody should see",
    "Push the limits",
    "Alex pushes the limits.",
    "{NAME} pushes the limits.",
    "{NAME} {pushes|push} the limit.",
    "{NAME} fought a bear",
  ];
  const FACT_LIKES = [
    "variant%",
    "hero-%",
    "unique-fact-%",
    "phase3 fact %",
    "import-test-%",
  ];

  const params: any[] = [];
  const exactPlaceholders = FACT_TEXT_PATTERNS.map((t) => {
    params.push(t);
    return `$${params.length}`;
  });
  const likePlaceholders = FACT_LIKES.map((t) => {
    params.push(t);
    return `$${params.length}`;
  });

  const matchSql = `
    SELECT id FROM facts
    WHERE LOWER(text) IN (${exactPlaceholders.map((p) => `LOWER(${p})`).join(",")})
       OR ${likePlaceholders.map((p) => `text ILIKE ${p}`).join(" OR ")}
  `;

  const client = await pool.connect();
  try {
    const r = await client.query(matchSql, params);
    const ids: number[] = r.rows.map((x: any) => x.id);
    console.log(`Matched ${ids.length} test-fact rows`);

    if (ids.length > 0) {
      // Dependent tables (some cascade, some not — be explicit)
      await client.query(`DELETE FROM transient_renders WHERE fact_id = ANY($1::int[])`, [ids]);
      await client.query(`DELETE FROM memes WHERE fact_id = ANY($1::int[])`, [ids]);
      await client.query(`DELETE FROM upload_image_metadata WHERE fact_id = ANY($1::int[])`, [ids]);
      await client.query(`DELETE FROM user_fact_preferences WHERE fact_id = ANY($1::int[])`, [ids]);
      await client.query(`DELETE FROM user_ai_images WHERE fact_id = ANY($1::int[])`, [ids]);
      await client.query(`DELETE FROM fact_hashtags WHERE fact_id = ANY($1::int[])`, [ids]);
      // Comments / ratings / external_links may exist with cascade FK; rely on cascade.
      const del = await client.query(`DELETE FROM facts WHERE id = ANY($1::int[])`, [ids]);
      console.log(`Deleted ${del.rowCount} facts`);
    }

    // Test users
    const ur = await client.query(
      `SELECT id FROM users WHERE email ILIKE '%@test.local' OR id ILIKE 't_%'`
    );
    const uids: string[] = ur.rows.map((x: any) => x.id);
    console.log(`Matched ${uids.length} test users`);
    if (uids.length > 0) {
      await client.query(`DELETE FROM activity_feed WHERE user_id = ANY($1::text[])`, [uids]);
      await client.query(`DELETE FROM transient_renders WHERE user_id = ANY($1::text[])`, [uids]);
      await client.query(`DELETE FROM session_data WHERE user_id = ANY($1::text[])`, [uids]).catch(() => {});
      await client.query(`DELETE FROM memes WHERE created_by_id = ANY($1::text[])`, [uids]);
      await client.query(`DELETE FROM upload_image_metadata WHERE user_id = ANY($1::text[])`, [uids]);
      await client.query(`DELETE FROM user_fact_preferences WHERE user_id = ANY($1::text[])`, [uids]);
      await client.query(`DELETE FROM user_ai_images WHERE user_id = ANY($1::text[])`, [uids]);
      await client.query(`DELETE FROM facts WHERE submitted_by_id = ANY($1::text[])`, [uids]);
      const du = await client.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [uids]);
      console.log(`Deleted ${du.rowCount} users + dependents`);
    }

    // Orphan hashtags created by tests (h_* prefix)
    const oh = await client.query(`
      DELETE FROM hashtags
      WHERE name LIKE 'h_%'
        AND id NOT IN (SELECT DISTINCT hashtag_id FROM fact_hashtags)
    `);
    console.log(`Deleted ${oh.rowCount} orphan test hashtags`);

    // Final post-check
    const pc = await client.query(matchSql, params);
    console.log(`Post-check: ${pc.rowCount} test-fact rows remain`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

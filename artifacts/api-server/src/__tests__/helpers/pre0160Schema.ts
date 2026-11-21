/**
 * Migration 0160 (Issue #1018, increment 2.1c) dropped the override, signature
 * and projection columns from `facts` and the `fact_enrichment_versions` table.
 * The tests of older migrations that read them (0073, 0139, 0151, 0159) first
 * put them back as they stood before 0160 — the schema those migrations ran
 * against — and end by running 0160 itself, which drops them again (as
 * migration0151's test does for 0153).
 *
 * The DDL below is the shape `pg_dump` printed for them at `375f730`, the
 * commit before 0160, less the constraints no test exercises by name.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Migration 0160's SQL, as the file holds it. */
export const MIGRATION_0160 = readFileSync(
  path.resolve(__dirname, "../../../../../lib/db/migrations/0160_taxonomy_drops.sql"),
  "utf8",
);

/** Put back the columns and the table 0160 dropped. Idempotent. */
export async function restorePre0160Schema(): Promise<void> {
  await db.execute(sql.raw(`
    ALTER TABLE facts ADD COLUMN IF NOT EXISTS enrichment_overrides jsonb NOT NULL DEFAULT '{}'::jsonb;
    ALTER TABLE facts ADD COLUMN IF NOT EXISTS enrichment_baseline_changed boolean NOT NULL DEFAULT false;
    ALTER TABLE facts ADD COLUMN IF NOT EXISTS last_processed_signature jsonb;
    ALTER TABLE facts ADD COLUMN IF NOT EXISTS primary_archetype varchar(64);
    ALTER TABLE facts ADD COLUMN IF NOT EXISTS subtype varchar(64);
    ALTER TABLE facts ADD COLUMN IF NOT EXISTS overhype_fit varchar(16);
    ALTER TABLE facts ADD COLUMN IF NOT EXISTS adult_suitability varchar(24);
    CREATE TABLE IF NOT EXISTS fact_enrichment_versions (
      id bigserial PRIMARY KEY,
      fact_id integer NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
      version_no integer NOT NULL,
      status varchar(16) NOT NULL,
      enrichment jsonb,
      enrichment_ai_derived jsonb,
      enrichment_overrides jsonb NOT NULL DEFAULT '{}'::jsonb,
      visual_override jsonb,
      fact_text_hash text,
      signature jsonb,
      source varchar(24) NOT NULL,
      source_review_id integer REFERENCES pending_reviews(id) ON DELETE SET NULL,
      note text,
      created_by varchar REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      promoted_at timestamptz,
      superseded_at timestamptz,
      rejected_at timestamptz,
      CONSTRAINT fev_open_candidate_holds_no_gag CHECK ((((status)::text <> 'candidate'::text) OR ((visual_override IS NULL) AND (NOT COALESCE((enrichment ? 'visualPromptStrategyOverride'::text), false)))))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS "UQ_fev_fact_version_no" ON fact_enrichment_versions (fact_id, version_no);
    CREATE UNIQUE INDEX IF NOT EXISTS "UQ_fev_one_candidate_per_fact" ON fact_enrichment_versions (fact_id) WHERE ((status)::text = 'candidate'::text);
  `));
}

/** Run migration 0160, which drops them again. */
export async function rerun0160(): Promise<void> {
  await db.execute(sql.raw(MIGRATION_0160));
}

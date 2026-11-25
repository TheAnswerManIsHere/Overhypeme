/**
 * The eval harness's tables and columns, which migration 0170 dropped, put back
 * in the shape the baseline gave them. Tests of migrations older than 0170 that
 * name them (0102, 0145, and 0170's own) restore them first, run the migration
 * under test, then drop them again with 0170 so the shared test database ends as
 * the migrations leave it. Idempotent.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const M0170 = readFileSync(
  path.resolve(__dirname, "../../../../../lib/db/migrations/0170_drop_eval_harness.sql"),
  "utf8",
);

export async function restoreEvalHarnessSchema(): Promise<void> {
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS eval_runs (
      id bigserial PRIMARY KEY,
      label text,
      run_profile jsonb,
      created_by varchar REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE image_prompt_attempts ADD COLUMN IF NOT EXISTS moderator_rating smallint;
    ALTER TABLE image_prompt_attempts ADD COLUMN IF NOT EXISTS failure_tag varchar(16);
    ALTER TABLE image_prompt_attempts ADD COLUMN IF NOT EXISTS eval_notes text;
    ALTER TABLE image_prompt_attempts ADD COLUMN IF NOT EXISTS eval_by varchar;
    ALTER TABLE image_prompt_attempts ADD COLUMN IF NOT EXISTS eval_at timestamptz;
    ALTER TABLE image_prompt_attempts ADD COLUMN IF NOT EXISTS eval_run_id bigint;
    ALTER TABLE image_prompt_attempts ADD COLUMN IF NOT EXISTS eval_scenario_key varchar(40);
    ALTER TABLE image_prompt_attempts ADD COLUMN IF NOT EXISTS eval_input_hash text;
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'image_prompt_attempts_eval_run_id_eval_runs_id_fk') THEN
        ALTER TABLE image_prompt_attempts ADD CONSTRAINT image_prompt_attempts_eval_run_id_eval_runs_id_fk
          FOREIGN KEY (eval_run_id) REFERENCES eval_runs(id) ON DELETE SET NULL;
      END IF;
    END $$;
    CREATE INDEX IF NOT EXISTS "IDX_ipa_eval_run_fact_created" ON image_prompt_attempts (eval_run_id, fact_id, created_at DESC) WHERE eval_run_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS "IDX_ipa_eval_fact_run_created" ON image_prompt_attempts (fact_id, eval_run_id, created_at DESC) WHERE eval_run_id IS NOT NULL;
  `));
}

/** Drop them again, as 0170 does. */
export async function dropEvalHarnessSchema(): Promise<void> {
  await db.execute(sql.raw(M0170));
}

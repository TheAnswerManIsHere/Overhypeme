/**
 * The `engines` table as it stood before migration 0138 dropped it (engines
 * live only in code, decisions.md 2026-11-14). Historical migrations that
 * retire engine rows (0103, 0104, 0110) are replayed by tests against the
 * state they originally ran on, so those tests recreate a minimal copy: only
 * the columns the migrations and the tests touch, and the six video columns
 * 0110 drops. The test that creates it drops it again.
 */
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

export async function createLegacyEnginesTable(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS engines (
      id varchar PRIMARY KEY, provider varchar NOT NULL, endpoint_id varchar NOT NULL, label varchar NOT NULL,
      kind varchar NOT NULL, param_schema jsonb NOT NULL,
      allowed_durations_sec jsonb, default_duration_sec integer,
      supported_modes jsonb, default_mode varchar(32),
      audio_handling varchar(32) NOT NULL DEFAULT 'none',
      estimated_cost_usd_per_second numeric(10, 6))`);
}

export async function dropLegacyEnginesTable(): Promise<void> {
  await db.execute(sql`DROP TABLE IF EXISTS engines`);
}

export async function insertLegacyEngine(id: string, kind: string, endpointId: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO engines (id, provider, endpoint_id, label, kind, param_schema)
    VALUES (${id}, 'fal', ${endpointId}, ${id}, ${kind}, '{"params":[]}'::jsonb)`);
}

export async function legacyEngineIds(prefix: string): Promise<string[]> {
  const res = await db.execute(sql`SELECT id FROM engines WHERE id LIKE ${`${prefix}%`} ORDER BY id`);
  return (res.rows as Array<{ id: string }>).map((r) => r.id);
}

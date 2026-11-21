/**
 * Turn off, and back on, the rule migration 0157 added: a gag holds published
 * content only on a fact approved for production
 * (`fact_gags_published_needs_approved_fact`). For tests that replay an older
 * migration on data in its own era's shape, before facts carried an approval
 * record (0152) and before that rule existed. Always paired: off in `before`,
 * on in `after`.
 */
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

export async function publishedGagRuleOff(): Promise<void> {
  await db.execute(sql`ALTER TABLE fact_gags DISABLE TRIGGER fact_gags_published_needs_approved_fact`);
}

export async function publishedGagRuleOn(): Promise<void> {
  await db.execute(sql`ALTER TABLE fact_gags ENABLE TRIGGER fact_gags_published_needs_approved_fact`);
}

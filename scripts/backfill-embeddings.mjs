/**
 * One-shot script to backfill pgvector embeddings for all facts that don't have one.
 * Run with: node scripts/backfill-embeddings.mjs
 */
import pg from "pg";
import OpenAI from "openai";

const { Client } = pg;

const MODEL = "text-embedding-3-small";
const DIMENSIONS = 1536;
const BATCH_DELAY_MS = 200; // be gentle on the API

const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

// Uses the same Replit AI Integrations env vars as the API server
const openai = new OpenAI({
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
});

const { rows: facts } = await db.query(
  "SELECT id, text FROM facts WHERE embedding IS NULL ORDER BY id"
);

console.log(`Backfilling ${facts.length} facts...`);
let done = 0;
let failed = 0;

for (const fact of facts) {
  try {
    const response = await openai.embeddings.create({
      model: MODEL,
      input: fact.text.trim(),
      dimensions: DIMENSIONS,
    });
    const vec = response.data[0].embedding;
    const vecStr = `[${vec.join(",")}]`;
    await db.query("UPDATE facts SET embedding = $1::vector WHERE id = $2", [vecStr, fact.id]);
    done++;
    if (done % 5 === 0) console.log(`  ${done}/${facts.length} done`);
    await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
  } catch (err) {
    console.error(`  FAILED fact ${fact.id}:`, err.message);
    failed++;
  }
}

await db.end();
console.log(`\nDone. Processed: ${done}, Failed: ${failed}`);

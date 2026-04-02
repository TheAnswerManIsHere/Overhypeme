#!/usr/bin/env node
/**
 * backfill-pexels-images.mjs
 *
 * One-shot script that runs the LLM → Pexels image pipeline for every ROOT
 * fact that doesn't yet have pexels_images populated.
 *
 * Usage:
 *   node scripts/backfill-pexels-images.mjs [--all] [--limit N] [--dry-run]
 *
 * Options:
 *   --all       Also re-process facts that already have pexels_images
 *   --limit N   Stop after N facts (default: unlimited)
 *   --dry-run   Print what would be processed without calling any APIs
 *
 * Required environment variables (same as the API server):
 *   DATABASE_URL   — PostgreSQL connection string
 *   OPENAI_API_KEY — OpenAI API key
 *   PEXELS_API_KEY — Pexels API key
 *
 * The script processes facts sequentially with a 1-second delay between each
 * to stay comfortably within Pexels' 200 req/hr free-tier limit (each fact
 * uses 3 Pexels calls).
 */

import postgres from "postgres";

// ── CLI args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const ALL     = args.includes("--all");
const DRY_RUN = args.includes("--dry-run");
const limitIdx = args.indexOf("--limit");
const LIMIT   = limitIdx >= 0 ? parseInt(args[limitIdx + 1] ?? "0", 10) : 0;

// ── Pexels ────────────────────────────────────────────────────────────────────
const PEXELS_BASE = "https://api.pexels.com/v1";

async function searchPhotoIds(query, count = 5) {
  const apiKey = process.env.PEXELS_API_KEY;
  if (!apiKey) { console.warn("  [pexels] PEXELS_API_KEY not set"); return []; }
  const url = new URL(`${PEXELS_BASE}/search`);
  url.searchParams.set("query", query);
  url.searchParams.set("orientation", "landscape");
  url.searchParams.set("per_page", String(Math.min(count, 80)));
  url.searchParams.set("page", "1");
  try {
    const res = await fetch(url.toString(), {
      headers: { Authorization: apiKey },
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) { console.warn(`  [pexels] ${res.status} for "${query}"`); return []; }
    const data = await res.json();
    return data.photos.slice(0, count).map(p => p.id);
  } catch (err) {
    console.warn(`  [pexels] error for "${query}":`, err.message);
    return [];
  }
}

// ── OpenAI ────────────────────────────────────────────────────────────────────
const KEYWORD_SYSTEM_PROMPT = `You extract Pexels stock photo search keywords from personalized fact templates.
Fact templates use tokens like {NAME}, {SUBJ}, {OBJ}, {POSS}, {REFL} for the subject person, and verb alternation like {does|do}.
Classify the fact as "action" (person doing something) or "abstract" (cosmic/metaphysical/impossible to photograph).
Return THREE search keyword strings optimized for Pexels stock photo results:
  "male" — best query for male-presenting photos, "female" — best query for female-presenting photos, "neutral" — best gender-neutral query.
Return ONLY valid JSON: {"fact_type":"action","keywords":{"male":"...","female":"...","neutral":"..."}}`;

async function extractImageKeywords(factText) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not set");
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({
      model: "gpt-4o-mini",
      max_tokens: 150,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: KEYWORD_SYSTEM_PROMPT },
        { role: "user",   content: `Fact template: "${factText}"` },
      ],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI API error: ${res.status}`);
  const data = await res.json();
  const raw = data.choices?.[0]?.message?.content ?? "{}";
  const parsed = JSON.parse(raw);
  const factType = parsed.fact_type === "abstract" ? "abstract" : "action";
  const fallback = factType === "abstract" ? "dramatic cinematic landscape atmosphere" : "person professional portrait";
  const kw = parsed.keywords ?? {};
  return {
    fact_type: factType,
    keywords: {
      male:    typeof kw.male    === "string" && kw.male.trim()    ? kw.male.trim()    : fallback,
      female:  typeof kw.female  === "string" && kw.female.trim()  ? kw.female.trim()  : fallback,
      neutral: typeof kw.neutral === "string" && kw.neutral.trim() ? kw.neutral.trim() : fallback,
    },
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) { console.error("DATABASE_URL is not set"); process.exit(1); }

  const sql = postgres(dbUrl, { ssl: false, max: 2 });

  // Fetch root facts that need processing
  const rows = ALL
    ? await sql`SELECT id, text FROM facts WHERE parent_id IS NULL AND is_active = true ORDER BY id`
    : await sql`SELECT id, text FROM facts WHERE parent_id IS NULL AND is_active = true AND pexels_images IS NULL ORDER BY id`;

  const toProcess = LIMIT > 0 ? rows.slice(0, LIMIT) : rows;

  console.log(`\n🖼  Pexels image backfill`);
  console.log(`   Mode:      ${ALL ? "re-process all" : "missing only"}`);
  console.log(`   Facts:     ${toProcess.length} root facts to process`);
  console.log(`   Dry run:   ${DRY_RUN}`);
  if (!toProcess.length) { console.log("\n✅ Nothing to do."); await sql.end(); return; }

  let success = 0, failed = 0;

  for (let i = 0; i < toProcess.length; i++) {
    const fact = toProcess[i];
    const prefix = `[${i + 1}/${toProcess.length}] fact #${fact.id}`;
    console.log(`\n${prefix}`);
    console.log(`  "${fact.text.slice(0, 80)}${fact.text.length > 80 ? "…" : ""}"`);

    if (DRY_RUN) { console.log("  → (dry run, skipping)"); continue; }

    try {
      const { fact_type, keywords } = await extractImageKeywords(fact.text);
      console.log(`  type=${fact_type}  male="${keywords.male}"  female="${keywords.female}"  neutral="${keywords.neutral}"`);

      const [male, female, neutral] = await Promise.all([
        searchPhotoIds(keywords.male,    5),
        searchPhotoIds(keywords.female,  5),
        searchPhotoIds(keywords.neutral, 5),
      ]);

      const pexelsImages = { fact_type, male, female, neutral };
      await sql`UPDATE facts SET pexels_images = ${sql.json(pexelsImages)} WHERE id = ${fact.id}`;

      const total = male.length + female.length + neutral.length;
      console.log(`  ✓ stored ${total} photo IDs (${male.length}m / ${female.length}f / ${neutral.length}n)`);
      success++;
    } catch (err) {
      console.error(`  ✗ failed:`, err.message);
      failed++;
    }

    // Throttle: 1 fact every ~1.2s keeps us well under 200 Pexels req/hr (3 calls per fact)
    if (i < toProcess.length - 1) await new Promise(r => setTimeout(r, 1200));
  }

  console.log(`\n📊 Done: ${success} succeeded, ${failed} failed, ${toProcess.length - success - failed} skipped`);
  await sql.end();
}

main().catch(err => { console.error(err); process.exit(1); });

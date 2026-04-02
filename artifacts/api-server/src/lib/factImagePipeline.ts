/**
 * Fact Image Pipeline
 *
 * For each fact template, calls gpt-4o-mini to extract contextually relevant
 * Pexels search keywords (three gender variants), then fetches the top 5 photo
 * IDs per variant and stores them on the fact record.
 *
 * Runs async (non-blocking) on fact create/edit. Should never throw — callers
 * fire-and-forget with void.
 */

import { getOpenAIClient } from "@workspace/integrations-openai-ai-server";
import { searchPhotoIds } from "./pexelsClient";
import { db } from "@workspace/db";
import { factsTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface FactPexelsImages {
  fact_type: "action" | "abstract";
  male:    number[];
  female:  number[];
  neutral: number[];
  keywords?: {
    male:    string;
    female:  string;
    neutral: string;
  };
}

interface LLMKeywordResult {
  fact_type: "action" | "abstract";
  keywords: {
    male:    string;
    female:  string;
    neutral: string;
  };
}

// ─── LLM keyword extraction ───────────────────────────────────────────────────

const KEYWORD_SYSTEM_PROMPT = `You extract Pexels stock photo search keywords from personalized fact templates.

Fact templates use tokens like {NAME}, {SUBJ}, {OBJ}, {POSS}, {REFL} for the subject person, and verb alternation like {does|do}.

Your job:
1. Identify the core visual concept of the fact — ignore the impossibility or humor.
2. Classify it:
   - "action" = a person doing something physical, social, or occupational
   - "abstract" = cosmic, metaphysical, conceptual, or impossible to photograph (e.g. controlling gravity, being the internet, existing since the beginning of time)
3. Return THREE search keyword strings optimized for Pexels stock photo results:
   - "male"    — best query to get male-presenting photos of the concept
   - "female"  — best query to get female-presenting photos of the concept
   - "neutral" — best query that doesn't imply gender (uses "person" or is concept-only)
   For abstract facts, all three can be identical (dramatic/conceptual backgrounds).
   The queries should NOT just be the same string with a different gender prefix — consider what will produce the best stock photo results for each.

Return ONLY valid JSON — no explanation, no markdown:
{"fact_type":"action","keywords":{"male":"man lifting weights gym","female":"woman lifting weights gym","neutral":"person strength training gym"}}`;

async function extractImageKeywords(factText: string): Promise<LLMKeywordResult> {
  const openai = getOpenAIClient();

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    max_tokens: 150,
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: KEYWORD_SYSTEM_PROMPT },
      { role: "user",   content: `Fact template: "${factText}"` },
    ],
  });

  const raw = response.choices[0]?.message?.content ?? "{}";
  const parsed = JSON.parse(raw) as Partial<LLMKeywordResult>;

  const factType = parsed.fact_type === "abstract" ? "abstract" : "action";
  const keywords = parsed.keywords ?? {};

  // Fallbacks if the model omits a variant
  const fallback = factType === "abstract"
    ? "dramatic cinematic landscape atmosphere"
    : "person professional portrait";

  return {
    fact_type: factType,
    keywords: {
      male:    typeof keywords.male    === "string" && keywords.male.trim()    ? keywords.male.trim()    : fallback,
      female:  typeof keywords.female  === "string" && keywords.female.trim()  ? keywords.female.trim()  : fallback,
      neutral: typeof keywords.neutral === "string" && keywords.neutral.trim() ? keywords.neutral.trim() : fallback,
    },
  };
}

// ─── Pipeline orchestration ───────────────────────────────────────────────────

/**
 * Runs the full LLM → Pexels pipeline for a single fact and persists the result.
 * Only operates on root facts (parentId = null) — variants inherit the parent's images.
 * Safe to call fire-and-forget: catches all errors internally.
 */
export async function runFactImagePipeline(factId: number, factText: string): Promise<void> {
  try {
    // 1. Extract keywords via OpenAI
    const { fact_type, keywords } = await extractImageKeywords(factText);

    // 2. Search Pexels for each gender variant in parallel
    const [male, female, neutral] = await Promise.all([
      searchPhotoIds(keywords.male,    5),
      searchPhotoIds(keywords.female,  5),
      searchPhotoIds(keywords.neutral, 5),
    ]);

    const pexelsImages: FactPexelsImages = { fact_type, male, female, neutral, keywords };

    // 3. Persist to DB
    await db
      .update(factsTable)
      .set({ pexelsImages })
      .where(eq(factsTable.id, factId));

    const total = male.length + female.length + neutral.length;
    console.log(`[factImagePipeline] fact ${factId}: ${total} photo IDs (type=${fact_type}, keywords=${JSON.stringify(keywords)})`);
  } catch (err) {
    console.error(`[factImagePipeline] Failed for fact ${factId}:`, err);
  }
}

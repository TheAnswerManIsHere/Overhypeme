/**
 * Fact Image Pipeline
 *
 * For each fact template, calls gpt-4o-mini to extract contextually relevant
 * Pexels search keywords (three gender variants), then fetches up to 80 photos
 * per variant in a single request (Pexels max per_page) and stores them on the
 * fact record.
 *
 * One HTTP request per gender variant — no deduplication, no exhaustion
 * tracking. The full photo library is seeded at fact creation time. The
 * client shuffles locally and cycles through the stored list.
 *
 * Retries up to 4 times with exponential backoff on transient failures.
 * Persistent failures are captured as Sentry issues.
 *
 * Runs async (non-blocking) on fact create/edit. Should never throw — callers
 * fire-and-forget with void.
 */

import * as Sentry from "@sentry/node";
import { getOpenAIClient } from "@workspace/integrations-openai-ai-server";
import { searchPhotos } from "./pexelsClient";
import type { PexelsPhotoEntry } from "./pexelsClient";
import { db } from "@workspace/db";
import { factsTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";

// ─── Types ────────────────────────────────────────────────────────────────────

export type { PexelsPhotoEntry };

export interface FactPexelsImages {
  fact_type: "action" | "abstract";
  male:    PexelsPhotoEntry[];
  female:  PexelsPhotoEntry[];
  neutral: PexelsPhotoEntry[];
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
   - "male"    — always include "man" naturally in the phrase (even for abstract facts — e.g. "man gravity concept", "man dark energy power")
   - "female"  — always include "woman" naturally in the phrase (e.g. "woman gravity concept", "woman space power")
   - "neutral" — use "person" or omit the gender term; can be concept-only for pure abstracts

   RULES:
   - NEVER make male and female identical — they must reflect the right gender.
   - DO NOT just prepend "man"/"woman" mechanically — integrate the gender naturally.
   - For abstract facts the neutral keyword can be concept-only, but male/female must still show a person of that gender in the scene.
   - Think about what Pexels will actually return: specific, visual, photographic language works better than abstract nouns alone.

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
  const keywords = (parsed.keywords ?? {}) as { male?: string; female?: string; neutral?: string };

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

// ─── Retry helper ────────────────────────────────────────────────────────────

/**
 * Runs `fn` up to `maxAttempts` times with exponential backoff between each
 * failed attempt. Throws the last error if every attempt fails.
 *
 * Delays: 1 s → 2 s → 4 s (before retries 2, 3, 4 respectively).
 */
const MAX_PIPELINE_ATTEMPTS = 4; // 1 initial + 3 retries
const BASE_RETRY_DELAY_MS   = 1_000;

async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_PIPELINE_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_PIPELINE_ATTEMPTS) {
        const delay = BASE_RETRY_DELAY_MS * 2 ** (attempt - 1); // 1s, 2s, 4s
        console.warn(
          `[factImagePipeline] ${label} attempt ${attempt}/${MAX_PIPELINE_ATTEMPTS} failed — retrying in ${delay}ms:`,
          err instanceof Error ? err.message : err,
        );
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  throw lastErr;
}

// ─── Pipeline orchestration ───────────────────────────────────────────────────

/**
 * Runs the full LLM → Pexels pipeline for a single fact and persists the result.
 * Fetches up to 80 photos per gender variant in one request each (Pexels max).
 * Only operates on root facts (parentId = null) — variants inherit parent images.
 * Safe to call fire-and-forget: catches all errors internally.
 *
 * Retries up to 4 times total (1 initial + 3 retries) with exponential backoff
 * (1 s, 2 s, 4 s) so transient OpenAI / Pexels / network hiccups don't leave
 * a fact permanently without images.
 */
export async function runFactImagePipeline(factId: number, factText: string): Promise<void> {
  try {
    await withRetry(async () => {
      // 1. Extract keywords via OpenAI
      const { fact_type, keywords } = await extractImageKeywords(factText);

      // 2. Fetch photos per variant — count comes from admin config
      const { getConfigInt } = await import("./adminConfig");
      const pexelsCount = await getConfigInt("pexels_photos_per_gender", 80);
      const [male, female, neutral] = await Promise.all([
        searchPhotos(keywords.male,    pexelsCount),
        searchPhotos(keywords.female,  pexelsCount),
        searchPhotos(keywords.neutral, pexelsCount),
      ]);

      const pexelsImages: FactPexelsImages = { fact_type, male, female, neutral, keywords };

      // 3. Persist to DB
      await db
        .update(factsTable)
        .set({ pexelsImages })
        .where(eq(factsTable.id, factId));

      console.log(
        `[factImagePipeline] fact ${factId}: ${male.length}m/${female.length}f/${neutral.length}n photos` +
        ` (type=${fact_type}, keywords=${JSON.stringify(keywords)})`,
      );
    }, `fact ${factId}`);
  } catch (err) {
    console.error(`[factImagePipeline] All ${MAX_PIPELINE_ATTEMPTS} attempts exhausted for fact ${factId}:`, err);
    Sentry.captureException(err, {
      tags: { pipeline: "factImagePipeline" },
      extra: { factId, factText: factText.slice(0, 200) },
    });
  }
}

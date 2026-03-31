import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { db } from "@workspace/db";
import { factsTable, hashtagsTable, commentsTable } from "@workspace/db/schema";
import { desc, eq, sql, ilike, or } from "drizzle-orm";
import { getOpenAIClient } from "@workspace/integrations-openai-ai-server";
import { z } from "zod";
import { getSessionId, getSession } from "../lib/auth";
import { embedText, findSimilarFacts, isEmbeddingEnabled } from "../lib/embeddings";

const router: IRouter = Router();

const CheckDuplicateBody = z.object({ text: z.string().min(10).max(1000) });
const SuggestHashtagsBody = z.object({ text: z.string().min(5).max(1000) });

const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 30;
const rateCounts = new Map<string, { count: number; windowStart: number }>();

setInterval(() => {
  const cutoff = Date.now() - RATE_WINDOW_MS;
  for (const [key, entry] of rateCounts) {
    if (entry.windowStart < cutoff) rateCounts.delete(key);
  }
}, RATE_WINDOW_MS).unref();

function rateLimitKey(req: Request): string {
  const sid = getSessionId(req);
  if (sid) return `sid:${sid}`;
  return `ip:${req.ip ?? "unknown"}`;
}

function checkRateLimit(key: string): boolean {
  const now = Date.now();
  const entry = rateCounts.get(key);
  if (!entry || now - entry.windowStart > RATE_WINDOW_MS) {
    rateCounts.set(key, { count: 1, windowStart: now });
    return true;
  }
  if (entry.count >= RATE_MAX) return false;
  entry.count++;
  return true;
}

async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const sid = getSessionId(req);
  if (!sid) { res.status(401).json({ error: "Authentication required" }); return; }
  const session = await getSession(sid);
  if (!session) { res.status(401).json({ error: "Authentication required" }); return; }
  next();
}

function requireRateLimit(req: Request, res: Response, next: NextFunction): void {
  const key = rateLimitKey(req);
  if (!checkRateLimit(key)) {
    res.status(429).json({ error: "Too many requests. Please slow down." });
    return;
  }
  next();
}

export async function moderateComment(commentId: number, text: string): Promise<void> {
  try {
    const response = await getOpenAIClient().chat.completions.create({
      model: "gpt-5-mini",
      max_completion_tokens: 256,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You are a spam and abuse detector for a humor website about Chuck Norris jokes. " +
            "Analyze comments and determine if they are spam, abuse, hate speech, or completely off-topic. " +
            "Respond ONLY with JSON: {\"spam\": true/false, \"reason\": \"short reason or empty string\"}. " +
            "Be lenient with playful Chuck Norris humor, rough language in a comedic context, and enthusiasm. " +
            "Only flag clear spam (links, promotions), actual hate speech, or obvious abuse.",
        },
        { role: "user", content: `Comment: ${text}` },
      ],
    });

    const raw = response.choices[0]?.message?.content ?? "{}";
    let parsed: { spam?: boolean; reason?: string } = {};
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    if (parsed.spam === true) {
      const [flagged] = await db
        .update(commentsTable)
        .set({ flagged: true, flagReason: parsed.reason ?? "Spam detected by AI" })
        .where(eq(commentsTable.id, commentId))
        .returning({ factId: commentsTable.factId });
      if (flagged) {
        await db
          .update(factsTable)
          .set({ commentCount: sql`GREATEST(${factsTable.commentCount} - 1, 0)` })
          .where(eq(factsTable.id, flagged.factId));
      }
    }
  } catch (err) {
    console.error("[AI] Comment moderation error:", err);
  }
}

export interface DuplicateCheckResult {
  isDuplicate: boolean;
  confidence: number;
  matchingFactId?: number;
  matchingFactText?: string;
}

// Cosine similarity threshold above which a fact is flagged as a duplicate.
const DUPLICATE_THRESHOLD = 0.92;

export async function checkDuplicateInternal(text: string): Promise<DuplicateCheckResult> {
  // --- Vector path: fast O(log n) search via pgvector ---
  if (isEmbeddingEnabled()) {
    try {
      const embedding = await embedText(text);
      const neighbors = await findSimilarFacts(embedding, {
        limit: 5,
        threshold: DUPLICATE_THRESHOLD,
      });
      if (neighbors.length > 0) {
        const best = neighbors[0];
        return {
          isDuplicate: true,
          confidence: Math.round(best.similarity * 100),
          matchingFactId: best.id,
          matchingFactText: best.text,
        };
      }
      return { isDuplicate: false, confidence: 0 };
    } catch (err) {
      console.error("[AI] Vector duplicate check failed, falling back to GPT:", err);
    }
  }

  // --- GPT fallback path: keyword pre-filter + chat model ---
  const words = text
    .toLowerCase()
    .split(/\s+/)
    .filter((w: string) => w.length > 4)
    .slice(0, 5);

  if (words.length === 0) return { isDuplicate: false, confidence: 0 };

  const conditions = words.map((w: string) => ilike(factsTable.text, `%${w}%`));
  const candidates = await db
    .select({ id: factsTable.id, text: factsTable.text })
    .from(factsTable)
    .where(or(...conditions))
    .orderBy(desc(factsTable.score))
    .limit(10);

  if (candidates.length === 0) return { isDuplicate: false, confidence: 0 };

  const candidateList = candidates.map((f, i) => `[${i + 1}] (ID:${f.id}) ${f.text}`).join("\n");

  const response = await getOpenAIClient().chat.completions.create({
    model: "gpt-5-mini",
    max_completion_tokens: 256,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "You are a duplicate detector for Chuck Norris facts. " +
          "Given a new submission and a list of existing facts, determine if the new one is a duplicate or very similar. " +
          "Respond ONLY with JSON: {\"isDuplicate\": true/false, \"confidence\": 0-100, \"matchIndex\": number_or_null}. " +
          "matchIndex is the 1-based index from the candidate list, or null if not a duplicate.",
      },
      { role: "user", content: `New submission: "${text}"\n\nExisting facts:\n${candidateList}` },
    ],
  });

  const raw = response.choices[0]?.message?.content ?? "{}";
  let result: { isDuplicate?: boolean; confidence?: number; matchIndex?: number | null } = {};
  try {
    result = JSON.parse(raw);
  } catch {
    return { isDuplicate: false, confidence: 0 };
  }

  if (result.isDuplicate && result.matchIndex != null) {
    const match = candidates[result.matchIndex - 1];
    return {
      isDuplicate: true,
      confidence: result.confidence ?? 90,
      matchingFactId: match?.id,
      matchingFactText: match?.text,
    };
  }
  return { isDuplicate: false, confidence: result.confidence ?? 0 };
}

router.post("/ai/check-duplicate", requireAuth, requireRateLimit, async (req: Request, res: Response) => {
  const bodyParsed = CheckDuplicateBody.safeParse(req.body);
  if (!bodyParsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  try {
    const result = await checkDuplicateInternal(bodyParsed.data.text);
    res.json(result);
  } catch (err) {
    console.error("[AI] check-duplicate error:", err);
    res.json({ isDuplicate: false, confidence: 0 });
  }
});

router.post("/ai/suggest-hashtags", requireAuth, requireRateLimit, async (req: Request, res: Response) => {
  const bodyParsed = SuggestHashtagsBody.safeParse(req.body);
  if (!bodyParsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const { text } = bodyParsed.data;

  try {
    const existing = await db
      .select({ name: hashtagsTable.name })
      .from(hashtagsTable)
      .orderBy(desc(hashtagsTable.factCount))
      .limit(40);

    const existingNames = existing.map((h) => h.name);

    const response = await getOpenAIClient().chat.completions.create({
      model: "gpt-5-mini",
      max_completion_tokens: 256,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You suggest hashtags for Chuck Norris facts on a humor website. " +
            "Return a JSON object with a single key 'hashtags' containing an array of 3-5 lowercase strings (no # prefix, letters/numbers/underscores only). " +
            "Prefer tags from the existing list when relevant. You may add 1-2 new tags if needed. " +
            "Example output: {\"hashtags\": [\"strength\",\"supernatural\",\"wisdom\"]}",
        },
        {
          role: "user",
          content: `Fact: "${text}"\n\nExisting hashtags: ${existingNames.join(", ")}`,
        },
      ],
    });

    const raw = response.choices[0]?.message?.content ?? "{}";
    let tags: string[] = [];
    try {
      const parsed2 = JSON.parse(raw) as Record<string, unknown>;
      const arr = Array.isArray(parsed2.hashtags) ? parsed2.hashtags : [];
      tags = (arr as unknown[])
        .filter((t): t is string => typeof t === "string")
        .map((t) => t.toLowerCase().replace(/[^a-z0-9_]/g, ""))
        .filter((t) => t.length > 0)
        .slice(0, 5);
    } catch {
      tags = [];
    }

    res.json({ hashtags: tags });
  } catch (err) {
    console.error("[AI] suggest-hashtags error:", err);
    res.json({ hashtags: [] });
  }
});

export default router;

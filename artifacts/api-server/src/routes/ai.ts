import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { db } from "@workspace/db";
import { factsTable, hashtagsTable, commentsTable } from "@workspace/db/schema";
import { eq, sql } from "drizzle-orm";
import { getOpenAIClient } from "@workspace/integrations-openai-ai-server";
import { z } from "zod";
import { getSessionId, getSession } from "../lib/auth";
import { embedText, findSimilarFacts } from "../lib/embeddings";
import { validateTemplate } from "../lib/templateGrammar";

const router: IRouter = Router();

const CheckDuplicateBody    = z.object({ text: z.string().min(10).max(1000) });
const SuggestHashtagsBody   = z.object({ text: z.string().min(5).max(1000) });
const TokenizeFactBody      = z.object({ text: z.string().min(5).max(2000) });
const SuggestPronounsBody   = z.object({ name: z.string().min(1).max(200) });

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
            "You are a spam and abuse detector for a humor website about personalized facts and jokes. " +
            "Analyze comments and determine if they are spam, abuse, hate speech, or completely off-topic. " +
            "Respond ONLY with JSON: {\"spam\": true/false, \"reason\": \"short reason or empty string\"}. " +
            "Be lenient with playful humor, rough language in a comedic context, and enthusiasm. " +
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

// Cosine similarity threshold for the pre-submission duplicate check.
// Using 0.82 (not 0.92) because the query is raw plain-English text while
// stored embeddings are from canonically-rendered templates — that surface
// difference eats ~5-8 similarity points even for genuine duplicates.
const DUPLICATE_THRESHOLD = 0.82;

export async function checkDuplicateInternal(text: string): Promise<DuplicateCheckResult> {
  const embedding = await embedText(text);
  const neighbors = await findSimilarFacts(embedding, {
    limit: 5,
    threshold: DUPLICATE_THRESHOLD,
  });

  if (neighbors.length === 0) return { isDuplicate: false, confidence: 0 };

  const best = neighbors[0];
  return {
    isDuplicate: true,
    confidence: Math.round(best.similarity * 100),
    matchingFactId: best.id,
    matchingFactText: best.text,
  };
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
            "You suggest hashtags for personalized facts on a humor website called Overhype.me. " +
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

const TOKENIZE_SYSTEM_PROMPT = `You are a fact-template tokenizer for a personalized humor website called Overhype.me.
Users write facts in plain English about a person. You convert them into a template using a closed token set.

TOKEN RULES:
1. Replace the person's name with {NAME}
2. Replace subject pronouns (he, she) with {SUBJ}; capitalize to {Subj} when sentence-starting
3. Replace object pronouns (him, her) with {OBJ}; capitalize to {Obj} when needed
4. Replace possessive adjectives (his, her as adjective) with {POSS}; capitalize to {Poss} when needed
5. Replace possessive pronouns (his, hers as standalone pronoun) with {POSS_PRO}; capitalize to {Poss_Pro} when needed
6. Replace reflexive pronouns (himself, herself) with {REFL}; capitalize to {Refl} when needed
7. For ANY verb or auxiliary that conjugates differently for "they" vs "he/she", use {singular_form|plural_form} syntax.
   Examples: {doesn't|don't}  {isn't|aren't}  {was|were}  {does|do}  {has|have}  {pushes|push}  {counts|count}
   The LEFT form is used for he/she; the RIGHT form is used for they.
8. Keep everything else exactly as written.

IMPORTANT:
- Capitalize tokens at the start of sentences: {Subj} not {SUBJ}, etc.
- Verb conjugation is the hardest part. Identify EVERY third-person singular verb that would change with "they". Don't miss any.
- "they" triggers plural: "he sleeps" → "{SUBJ} {sleeps|sleep}", "he doesn't" → "{SUBJ} {doesn't|don't}", "he was" → "{SUBJ} {was|were}"
- Return ONLY valid JSON: {"template": "...the tokenized template..."}
- Do NOT explain, do NOT add any other keys.`;

router.post("/ai/tokenize-fact", requireRateLimit, async (req: Request, res: Response) => {
  const bodyParsed = TokenizeFactBody.safeParse(req.body);
  if (!bodyParsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const { text } = bodyParsed.data;

  try {
    const openai = getOpenAIClient();
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 1024,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: TOKENIZE_SYSTEM_PROMPT },
        { role: "user",   content: `Convert this fact to a template:\n\n"${text}"` },
      ],
    });

    const raw = completion.choices[0]?.message?.content ?? "{}";
    let template = text;
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (typeof parsed.template === "string" && parsed.template.length > 0) {
        template = parsed.template;
      }
    } catch {
      template = text;
    }

    const grammarResult = validateTemplate(template);
    if (!grammarResult.valid) {
      res.status(422).json({
        error: `AI produced a template with invalid grammar: ${grammarResult.error}. Please review and correct the template manually.`,
        template,
        grammarError: grammarResult.error,
      });
      return;
    }

    res.json({ template });
  } catch (err) {
    console.error("[AI] tokenize-fact error:", err);
    res.status(500).json({ error: "Tokenization failed" });
  }
});

router.post("/ai/suggest-pronouns", requireRateLimit, async (req: Request, res: Response) => {
  const bodyParsed = SuggestPronounsBody.safeParse(req.body);
  if (!bodyParsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const { name } = bodyParsed.data;

  try {
    const openai = getOpenAIClient();
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 64,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You infer the most likely subject and object pronouns for a given personal name. " +
            "Return ONLY valid JSON with keys 'subject' and 'object'. " +
            "Use 'he'/'him' for typically masculine names, 'she'/'her' for typically feminine names, " +
            "and 'they'/'them' for ambiguous, gender-neutral, or non-binary names. " +
            "Default to 'they'/'them' when uncertain. " +
            "Example output: {\"subject\": \"she\", \"object\": \"her\"}",
        },
        {
          role: "user",
          content: `Name: "${name}"`,
        },
      ],
    });

    const raw = completion.choices[0]?.message?.content ?? "{}";
    let subject = "they";
    let object  = "them";
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (typeof parsed.subject === "string" && parsed.subject.length > 0) subject = parsed.subject.toLowerCase();
      if (typeof parsed.object  === "string" && parsed.object.length  > 0) object  = parsed.object.toLowerCase();
    } catch {
      // fall back to they/them
    }

    res.json({ subject, object });
  } catch (err) {
    console.error("[AI] suggest-pronouns error:", err);
    res.status(500).json({ error: "Suggestion failed" });
  }
});

export default router;

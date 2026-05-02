import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { db } from "@workspace/db";
import { factsTable, hashtagsTable, commentsTable } from "@workspace/db/schema";
import { eq, sql, desc } from "drizzle-orm";
import { getOpenAIClient } from "@workspace/integrations-openai-ai-server";
import { z } from "zod";
import { getSessionId, getSession } from "../lib/auth";
import { createRateLimiter } from "../lib/rateLimit";
import { verifyCaptcha } from "../lib/captcha";
import { embedText, findSimilarFacts } from "../lib/embeddings";
import { validateTemplate } from "../lib/templateGrammar";
import { renderCanonical } from "../lib/renderCanonical";
import { completeGovernance, enforceGovernance } from "../lib/resourceGovernance";
import { logger } from "../lib/logger";

const router: IRouter = Router();
const requireRateLimit = createRateLimiter();

const CheckDuplicateBody    = z.object({ text: z.string().min(10).max(1000) });
const SuggestHashtagsBody   = z.object({ text: z.string().min(5).max(1000) });
const TokenizeFactBody      = z.object({ text: z.string().min(5).max(2000), captchaToken: z.string().optional() });
const SuggestPronounsBody   = z.object({ name: z.string().min(1).max(200) });

async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const sid = getSessionId(req);
  if (!sid) { res.status(401).json({ error: "Authentication required" }); return; }
  const session = await getSession(sid);
  if (!session) { res.status(401).json({ error: "Authentication required" }); return; }
  next();
}

export async function moderateComment(commentId: number, text: string): Promise<void> {
  try {
    const response = await getOpenAIClient().chat.completions.create({
      model: "gpt-4o-mini",
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
    logger.error({ err }, "[AI] Comment moderation error");
  }
}

export interface DuplicateCheckResult {
  isDuplicate: boolean;
  confidence: number;
  matchingFactId?: number;
  matchingFactText?: string;
  matchingCanonicalText?: string;
  llmChecked?: boolean;
}

// Stage 1: vector recall threshold — cast a wide net and pass candidates to the LLM.
// Anything below this is geometrically too distant to be a paraphrase.
const STAGE1_THRESHOLD = 0.65;

// Stage 2 fallback: if the LLM call fails, fall back to this vector-only threshold.
const VECTOR_FALLBACK_THRESHOLD = 0.75;

// Token pattern: {NAME}, {SUBJ}, {does|do}, etc.
const TEMPLATE_TOKEN_RE = /\{[A-Z_]+\}|\{[A-Za-z_]+\}|\{[^}|]+\|[^}]+\}/;

type Neighbor = { id: number; text: string; canonicalText: string | null; similarity: number };

/**
 * Stage 2: Ask the LLM whether any of the vector candidates is a true duplicate
 * of the new entry. One batched call handles all candidates.
 * Returns which candidate index (1-based) is a duplicate, or null.
 */
async function llmDuplicateCheck(
  newText: string,
  candidates: Neighbor[],
): Promise<{ isDuplicate: boolean; matchIndex: number | null }> {
  const openai = getOpenAIClient();
  const candidateList = candidates
    .map((c, i) => `${i + 1}. "${c.canonicalText ?? c.text}"`)
    .join("\n");

  const prompt =
    `You are a duplicate detector for a template-based facts database. ` +
    `Entries may use tokens like {NAME} and {SUBJ} for the subject person.\n\n` +
    `New entry:\n"${newText}"\n\n` +
    `Candidate existing entries:\n${candidateList}\n\n` +
    `Do any candidates express the same fact or joke as the new entry, ` +
    `even if worded differently? Paraphrases and minor rewrites count as duplicates. ` +
    `Respond with JSON only: {"isDuplicate": true|false, "matchIndex": <1-based index or null>}`;

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" },
    temperature: 0,
    max_tokens: 60,
  });

  const content = response.choices[0]?.message?.content ?? "{}";
  const parsed = JSON.parse(content) as { isDuplicate?: boolean; matchIndex?: number | null };
  return {
    isDuplicate: parsed.isDuplicate === true,
    matchIndex: typeof parsed.matchIndex === "number" ? parsed.matchIndex : null,
  };
}

export async function checkDuplicateInternal(text: string): Promise<DuplicateCheckResult> {
  // Render template tokens to canonical form so embeddings compare apples-to-apples.
  const textToEmbed = TEMPLATE_TOKEN_RE.test(text) ? renderCanonical(text) : text;
  const embedding = await embedText(textToEmbed);

  // Stage 1 — vector recall: retrieve top-5 with threshold:0 (for UI display),
  // but only forward candidates that clear STAGE1_THRESHOLD to the LLM.
  const neighbors = await findSimilarFacts(embedding, { limit: 5, threshold: 0 });

  if (neighbors.length === 0) return { isDuplicate: false, confidence: 0 };

  const best = neighbors[0];
  const candidates = neighbors.filter((n) => n.similarity >= STAGE1_THRESHOLD);

  // Stage 2 — LLM precision: let the model decide if any candidate is truly
  // the same fact. Fall back to vector threshold if the LLM call fails.
  if (candidates.length > 0) {
    try {
      const { isDuplicate, matchIndex } = await llmDuplicateCheck(textToEmbed, candidates);
      const matched =
        matchIndex !== null && matchIndex >= 1 && matchIndex <= candidates.length
          ? candidates[matchIndex - 1]
          : candidates[0];
      return {
        isDuplicate,
        confidence: Math.round(best.similarity * 100),
        matchingFactId: matched.id,
        matchingFactText: matched.text,
        matchingCanonicalText: matched.canonicalText ?? matched.text,
        llmChecked: true,
      };
    } catch (err) {
      logger.error({ err }, "[AI] LLM duplicate check failed, falling back to vector threshold");
    }
  }

  // Vector-only result (no candidates above Stage 1 threshold, or LLM failed)
  return {
    isDuplicate: best.similarity >= VECTOR_FALLBACK_THRESHOLD,
    confidence: Math.round(best.similarity * 100),
    matchingFactId: best.id,
    matchingFactText: best.text,
    matchingCanonicalText: best.canonicalText ?? best.text,
    llmChecked: false,
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
    logger.error({ err }, "[AI] check-duplicate error");
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
    const gate = enforceGovernance(req, res, {
      path: "ai",
      provider: "openai",
      model: "gpt-4o-mini",
      estimatedCostUsd: 0.005,
      payloadBytes: Buffer.byteLength(JSON.stringify(req.body ?? {}), "utf8"),
    });
    if (!gate.ok) return;
    const started = Date.now();
    const existing = await db
      .select({ name: hashtagsTable.name })
      .from(hashtagsTable)
      .orderBy(desc(hashtagsTable.factCount))
      .limit(40);

    const existingNames = existing.map((h) => h.name);

    const response = await getOpenAIClient().chat.completions.create({
      model: "gpt-4o-mini",
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

    const body = { hashtags: tags };
    completeGovernance(req, { provider: "openai", latencyMs: Date.now() - started, failed: false, actualCostUsd: 0.005, responseStatus: 200, responseBody: body, idempotencyKey: gate.idempotencyKey });
    res.json(body);
  } catch (err) {
    completeGovernance(req, { provider: "openai", latencyMs: 0, failed: true, actualCostUsd: 0 });
    logger.error({ err }, "[AI] suggest-hashtags error");
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
  const { text, captchaToken } = bodyParsed.data;

  // Captcha gate — bypass for: admin, legendary/premium, or users who already
  // completed onboarding (captchaVerified in session or persisted on user row).
  // Membership/admin/captcha state on `req.user` is always fresh from the
  // database (rebuilt by authMiddleware on every authenticated request).
  const isAdmin = req.isAuthenticated() && !!req.user.isRealAdmin;
  const isLegendary = req.isAuthenticated() && req.user.membershipTier === "legendary";
  const isCaptchaVerified = req.isAuthenticated() && !!req.user.captchaVerified;

  const captchaRequired = !isAdmin && !isLegendary && !isCaptchaVerified;

  if (captchaRequired) {
    if (!captchaToken || !(await verifyCaptcha(captchaToken))) {
      res.status(400).json({ error: "CAPTCHA verification failed" });
      return;
    }
  }

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
    logger.error({ err }, "[AI] tokenize-fact error");
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
    logger.error({ err }, "[AI] suggest-pronouns error");
    res.status(500).json({ error: "Suggestion failed" });
  }
});

export default router;

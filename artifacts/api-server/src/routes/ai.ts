import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { db } from "@workspace/db";
import { factsTable, commentsTable, pendingReviewsTable } from "@workspace/db/schema";
import { eq, sql, and } from "drizzle-orm";
import { callUtilityLLM } from "../lib/utilityLLM";
import { z } from "zod";
import { getSessionId, getSession } from "../lib/auth";
import { createRateLimiter, RATE_WINDOW_MS } from "../lib/rateLimit";
import { sanitizeHashtagsForPersistence } from "../lib/hashtags";
import { verifyCaptcha } from "../lib/captcha";
import { embedText, findSimilarFacts } from "../lib/embeddings";
import {
  tokenizePlainTextToTemplate,
  isAlreadyTokenizedNoPlainName,
  hasNoLikelySubjectReference,
} from "../lib/factTokenizer";
import { renderCanonical } from "../lib/renderCanonical";
import { completeGovernance, enforceGovernance } from "../lib/resourceGovernance";
import { logger } from "../lib/logger";
import { requireRole } from "../middlewares/tierMiddleware";
import {
  isVisualStrategyRenderedTextPath,
  getVisualStrategyRenderedTextKind,
  normalizeRoleEntity,
} from "@workspace/api-zod";

const router: IRouter = Router();
const requireRateLimit = createRateLimiter();

// Local, not imported from routes/admin.ts, to avoid a routes→routes import cycle.
const requireAdmin = requireRole("admin");

const CheckDuplicateBody    = z.object({ text: z.string().min(10).max(1000) });
const TokenizeFactBody      = z.object({ text: z.string().min(5).max(2000), captchaToken: z.string().optional() });
const SuggestPronounsBody   = z.object({ name: z.string().min(1).max(200) });
const SuggestHashtagsBody   = z.object({ text: z.string().min(5).max(2000) });
const TokenizeEnrichmentBody = z.object({
  entries: z
    .array(
      z.object({
        path: z.string().min(1).max(120),
        value: z.string().max(2000),
        kind: z.enum(["prose", "entity"]),
      }),
    )
    .max(80),
  subjectContext: z.object({ names: z.array(z.string().trim().min(1).max(100)).max(10) }).optional(),
});

// Dedicated limiter so the suggestion affordance is throttled independently of
// the global AI limiter (it fires once per Preview, not per keystroke).
const requireSuggestHashtagsRateLimit = createRateLimiter("ai_suggest_hashtags", 20, RATE_WINDOW_MS);

const SUGGEST_HASHTAGS_LIMIT = 6;

const SUGGEST_HASHTAGS_SYSTEM_PROMPT =
  "You generate discovery hashtags for a short humorous \"fact\" about a person. " +
  "Return ONLY valid JSON of the form {\"hashtags\": [\"tag1\", \"tag2\", ...]}. " +
  "Provide 3-6 lowercase, single-word, alphanumeric tags that describe the fact's " +
  "TOPIC or THEME so people can find it (e.g. strength, coffee, legendary). " +
  "The person's name shown in the fact is a placeholder for whoever the meme is " +
  "about — never tag the name. Never use the app name (overhype/overhypeme). " +
  "No '#', no spaces, no punctuation, no duplicates.";

/**
 * Pure, model-injectable core of the suggest-hashtags endpoint (mirrors the
 * `enrichFactWithModel` seam so it's unit-testable without a live OpenAI key).
 *
 * The frontend passes the tokenized TEMPLATE; we render it to canonical plain
 * English before prompting so the model reasons over a readable sentence instead
 * of `{NAME}`/`{SUBJ}` tokens (same principle the enrichment pipeline uses). The
 * deterministic sanitizer — not the prompt — is the real guarantee that subject/
 * app-name tags never leak. Always returns an array; never throws.
 */
export async function suggestHashtagsForText(
  text: string,
  callModel: typeof callUtilityLLM = callUtilityLLM,
): Promise<string[]> {
  try {
    const canonical = renderCanonical(text);
    const completion = await callModel({
      maxTokens: 128,
      temperature: 0.3,
      responseFormat: { type: "json_object" },
      messages: [
        { role: "system", content: SUGGEST_HASHTAGS_SYSTEM_PROMPT },
        { role: "user", content: `Fact:\n\n"${canonical}"` },
      ],
    });
    const raw = completion.choices[0]?.message?.content ?? "{}";
    let candidates: unknown[] = [];
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (Array.isArray(parsed.hashtags)) candidates = parsed.hashtags;
    } catch {
      return [];
    }
    return sanitizeHashtagsForPersistence(candidates, { limit: SUGGEST_HASHTAGS_LIMIT });
  } catch (err) {
    logger.warn({ errType: err instanceof Error ? err.name : typeof err, textLength: text.length }, "[AI] suggest-hashtags model error");
    return [];
  }
}

// Test seam: lets route-level tests force success/failure without a live model.
// Mirrors `__setPlanGeneratorForTest` in the image-prompt pipeline. Always reset
// in an afterEach so a fake can't leak into the next test.
let suggestHashtagsImpl: typeof suggestHashtagsForText = suggestHashtagsForText;
export function __setSuggestHashtagsForTest(fn: typeof suggestHashtagsForText | null): void {
  suggestHashtagsImpl = fn ?? suggestHashtagsForText;
}

async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const sid = getSessionId(req);
  if (!sid) { res.status(401).json({ error: "Authentication required" }); return; }
  const session = await getSession(sid);
  if (!session) { res.status(401).json({ error: "Authentication required" }); return; }
  next();
}

export async function moderateComment(commentId: number, text: string): Promise<void> {
  try {
    const response = await callUtilityLLM({
      maxTokens: 256,
      responseFormat: { type: "json_object" },
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

  const response = await callUtilityLLM({
    messages: [{ role: "user", content: prompt }],
    responseFormat: { type: "json_object" },
    temperature: 0,
    maxTokens: 60,
  });

  const content = response.choices[0]?.message?.content ?? "{}";
  const parsed = JSON.parse(content) as { isDuplicate?: boolean; matchIndex?: number | null };
  return {
    isDuplicate: parsed.isDuplicate === true,
    matchIndex: typeof parsed.matchIndex === "number" ? parsed.matchIndex : null,
  };
}

export async function checkDuplicateInternal(text: string): Promise<DuplicateCheckResult> {
  const normalizedText = text.trim().toLowerCase();

  // Fast pre-check: exact text match against approved facts (avoids embedding round-trip).
  const [exactFact] = await db
    .select({ id: factsTable.id, text: factsTable.text, canonicalText: factsTable.canonicalText })
    .from(factsTable)
    .where(and(eq(factsTable.isActive, true), sql`LOWER(TRIM(${factsTable.text})) = ${normalizedText}`))
    .limit(1);
  if (exactFact) {
    return {
      isDuplicate: true,
      confidence: 100,
      matchingFactId: exactFact.id,
      matchingFactText: exactFact.text,
      matchingCanonicalText: exactFact.canonicalText ?? exactFact.text,
      llmChecked: false,
    };
  }

  // Fast pre-check: exact text match against pending reviews still awaiting decision.
  const [exactReview] = await db
    .select({ submittedText: pendingReviewsTable.submittedText })
    .from(pendingReviewsTable)
    .where(and(
      eq(pendingReviewsTable.status, "pending"),
      sql`LOWER(TRIM(${pendingReviewsTable.submittedText})) = ${normalizedText}`,
    ))
    .limit(1);
  if (exactReview) {
    return {
      isDuplicate: true,
      confidence: 100,
      matchingFactText: exactReview.submittedText,
      matchingCanonicalText: renderCanonical(exactReview.submittedText),
      llmChecked: false,
    };
  }

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
    // Tokenization is a narrow structural transform — use the dedicated
    // tokenizer model (a reasoning mini), not the global utility engine, so
    // other utility calls are unaffected. The deterministic net inside the
    // core is the real correctness guarantee; the model just improves
    // first-pass quality.
    const { rawTemplate, template, passes, grammarError } = await tokenizePlainTextToTemplate(text);

    // Post-process logging: the deterministic net is the real guarantee —
    // even with the hardened prompt the model intermittently leaves a
    // person-subject verb un-conjugated ("{Subj} keeps" → "They keeps"), and
    // the net wraps it as {keeps|keep}.
    if (passes.nameCollapsed) {
      logger.info(
        { before: rawTemplate.slice(0, 500), after: template.slice(0, 500) },
        "[tokenize-fact] collapsed name-subject conjugation pair ({NAME} {x|y} → {NAME} x)",
      );
    }
    if (passes.contractionExpanded) {
      logger.info(
        { before: rawTemplate.slice(0, 500), after: template.slice(0, 500) },
        "[tokenize-fact] expanded subject contraction ({Subj}'s → {Subj} {is|are})",
      );
    }
    if (passes.conjugated) {
      logger.info(
        { before: rawTemplate.slice(0, 500), after: template.slice(0, 500) },
        "[tokenize-fact] auto-conjugated person-subject verb",
      );
    }
    if (passes.collapsed) {
      logger.info(
        { before: rawTemplate.slice(0, 500), after: template.slice(0, 500) },
        "[tokenize-fact] collapsed identical conjugation branch ({x|x} → x)",
      );
    }

    if (grammarError) {
      res.status(422).json({
        error: `AI produced a template with invalid grammar: ${grammarError}. Please review and correct the template manually.`,
        template,
        grammarError,
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
    const completion = await callUtilityLLM({
      maxTokens: 64,
      responseFormat: { type: "json_object" },
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

// POST /ai/suggest-hashtags → { hashtags: string[] }
// A deliberate, non-blocking pre-submit affordance (like tokenize / duplicate-
// check) — NOT moderation prep. Auth is the real boundary (it's only used from
// the authenticated submit page). Model/parse failures degrade to an empty list
// so the form is never blocked; only bad bodies (400) and missing auth (401) are
// hard failures.
router.post("/ai/suggest-hashtags", requireAuth, requireSuggestHashtagsRateLimit, async (req: Request, res: Response) => {
  const bodyParsed = SuggestHashtagsBody.safeParse(req.body);
  if (!bodyParsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  try {
    const hashtags = await suggestHashtagsImpl(bodyParsed.data.text);
    res.json({ hashtags });
  } catch (err) {
    logger.warn({ errType: err instanceof Error ? err.name : typeof err }, "[AI] suggest-hashtags route error");
    res.json({ hashtags: [] });
  }
});

// Test seam: lets route-level tests force success/failure without a live model.
// Mirrors `__setSuggestHashtagsForTest` above. Always reset in an afterEach.
let tokenizeCoreImpl: typeof tokenizePlainTextToTemplate = tokenizePlainTextToTemplate;
export function __setTokenizeCoreForTest(fn: typeof tokenizePlainTextToTemplate | null): void {
  tokenizeCoreImpl = fn ?? tokenizePlainTextToTemplate;
}

/** Run `fn` over `items` with at most `limit` in flight, preserving result order. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

interface TokenizeEnrichmentResultEntry {
  path: string;
  value: string;
  changed: boolean;
  usedLlm: boolean;
  error?: string;
  errorKind?: "grammar" | "entity" | "path";
}

// POST /ai/tokenize-enrichment → { results: TokenizeEnrichmentResultEntry[] }
// Admin-only batch tokenize for Visual-Concept authoring: admins write plain
// English in each VSO field and this converts every changed field to a
// personalization-token template in one call, reusing the same tokenizer core
// as fact submission. No captcha — this is an authenticated admin tool, not a
// public-facing affordance. Every path/kind is validated BEFORE any LLM call
// so a malformed or lying batch never spends a model call.
router.post(
  "/ai/tokenize-enrichment",
  requireAdmin,
  requireRateLimit,
  async (req: Request, res: Response) => {
    const bodyParsed = TokenizeEnrichmentBody.safeParse(req.body);
    if (!bodyParsed.success) {
      res.status(400).json({ error: "Invalid input" });
      return;
    }
    const { entries, subjectContext } = bodyParsed.data;
    const subjectNames = subjectContext?.names ?? [];

    for (const entry of entries) {
      if (!isVisualStrategyRenderedTextPath(entry.path)) {
        res.status(400).json({ error: `Unknown or invalid path: ${entry.path}` });
        return;
      }
      // Client kind lie: e.g. an entity path submitted as kind:"prose" would
      // wrongly run the LLM prose-tokenizer over a plain role label.
      if (getVisualStrategyRenderedTextKind(entry.path) !== entry.kind) {
        res.status(400).json({ error: `kind mismatch for path: ${entry.path}` });
        return;
      }
    }

    let usedLlmCount = 0;
    let skippedCount = 0;
    let grammarErrorCount = 0;

    const results = await mapWithConcurrency(entries, 4, async (entry): Promise<TokenizeEnrichmentResultEntry> => {
      if (!entry.value.trim()) {
        return { path: entry.path, value: entry.value, changed: false, usedLlm: false };
      }

      if (entry.kind === "entity") {
        const { value, error } = normalizeRoleEntity(entry.value, subjectNames);
        if (error) {
          return {
            path: entry.path,
            value: entry.value,
            changed: false,
            usedLlm: false,
            error,
            errorKind: "entity",
          };
        }
        return { path: entry.path, value, changed: value !== entry.value, usedLlm: false };
      }

      const skipLlm =
        isAlreadyTokenizedNoPlainName(entry.value, subjectNames) ||
        hasNoLikelySubjectReference(entry.value, subjectNames);
      if (skipLlm) skippedCount++;

      const core = await tokenizeCoreImpl(entry.value, { skipLlm, subjectNames, purpose: "visual_strategy" });
      if (core.usedLlm) usedLlmCount++;
      if (core.grammarError) {
        grammarErrorCount++;
        return {
          path: entry.path,
          value: core.template,
          changed: core.template !== entry.value,
          usedLlm: core.usedLlm,
          error: core.grammarError,
          errorKind: "grammar",
        };
      }
      return {
        path: entry.path,
        value: core.template,
        changed: core.template !== entry.value,
        usedLlm: core.usedLlm,
      };
    });

    // Count-only logging — never the field text itself.
    logger.info(
      { entries: entries.length, usedLlm: usedLlmCount, skipped: skippedCount, grammarErrors: grammarErrorCount },
      "[tokenize-enrichment] batch complete",
    );

    res.json({ results });
  },
);

export default router;

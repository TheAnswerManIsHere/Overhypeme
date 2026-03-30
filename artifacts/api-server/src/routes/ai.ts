import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { factsTable, hashtagsTable, commentsTable } from "@workspace/db/schema";
import { desc, ilike, or, eq } from "drizzle-orm";
import { openai } from "@workspace/integrations-openai-ai-server";
import { z } from "zod";

const router: IRouter = Router();

const CheckDuplicateBody = z.object({ text: z.string().min(10).max(1000) });
const SuggestHashtagsBody = z.object({ text: z.string().min(5).max(1000) });

export async function moderateComment(commentId: number, text: string): Promise<void> {
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-5-mini",
      max_completion_tokens: 256,
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
      await db
        .update(commentsTable)
        .set({ flagged: true, flagReason: parsed.reason ?? "Spam detected by AI" })
        .where(eq(commentsTable.id, commentId));
    }
  } catch (err) {
    console.error("[AI] Comment moderation error:", err);
  }
}

router.post("/ai/check-duplicate", async (req: Request, res: Response) => {
  const parsed = CheckDuplicateBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const { text } = parsed.data;

  const words = text
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 4)
    .slice(0, 5);

  let candidates: { id: number; text: string }[] = [];
  if (words.length > 0) {
    const conditions = words.map((w) => ilike(factsTable.text, `%${w}%`));
    candidates = await db
      .select({ id: factsTable.id, text: factsTable.text })
      .from(factsTable)
      .where(or(...conditions))
      .orderBy(desc(factsTable.score))
      .limit(10);
  }

  if (candidates.length === 0) {
    res.json({ isDuplicate: false, confidence: 0 });
    return;
  }

  const candidateList = candidates
    .map((f, i) => `[${i + 1}] (ID:${f.id}) ${f.text}`)
    .join("\n");

  const response = await openai.chat.completions.create({
    model: "gpt-5-mini",
    max_completion_tokens: 256,
    messages: [
      {
        role: "system",
        content:
          "You are a duplicate detector for Chuck Norris facts. " +
          "Given a new submission and a list of existing facts, determine if the new one is a duplicate or very similar. " +
          "Respond ONLY with JSON: {\"isDuplicate\": true/false, \"confidence\": 0-100, \"matchIndex\": number_or_null}. " +
          "matchIndex is the 1-based index from the candidate list, or null if not a duplicate.",
      },
      {
        role: "user",
        content: `New submission: "${text}"\n\nExisting facts:\n${candidateList}`,
      },
    ],
  });

  const raw = response.choices[0]?.message?.content ?? "{}";
  let result: { isDuplicate?: boolean; confidence?: number; matchIndex?: number | null } = {};
  try {
    result = JSON.parse(raw);
  } catch {
    res.json({ isDuplicate: false, confidence: 0 });
    return;
  }

  if (result.isDuplicate && result.matchIndex != null) {
    const match = candidates[result.matchIndex - 1];
    res.json({
      isDuplicate: true,
      confidence: result.confidence ?? 90,
      matchingFactId: match?.id,
      matchingFactText: match?.text,
    });
  } else {
    res.json({ isDuplicate: false, confidence: result.confidence ?? 0 });
  }
});

router.post("/ai/suggest-hashtags", async (req: Request, res: Response) => {
  const parsed = SuggestHashtagsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const { text } = parsed.data;

  const existing = await db
    .select({ name: hashtagsTable.name })
    .from(hashtagsTable)
    .orderBy(desc(hashtagsTable.factCount))
    .limit(40);

  const existingNames = existing.map((h) => h.name);

  const response = await openai.chat.completions.create({
    model: "gpt-5-mini",
    max_completion_tokens: 256,
    messages: [
      {
        role: "system",
        content:
          "You suggest hashtags for Chuck Norris facts on a humor website. " +
          "Return ONLY a JSON array of 3-5 lowercase hashtag strings (no # prefix, letters/numbers/underscores only). " +
          "Prefer tags from the existing list when relevant. You may add 1-2 new tags if needed. " +
          "Example output: [\"strength\",\"supernatural\",\"wisdom\"]",
      },
      {
        role: "user",
        content: `Fact: "${text}"\n\nExisting hashtags: ${existingNames.join(", ")}`,
      },
    ],
  });

  const raw = response.choices[0]?.message?.content ?? "[]";
  let tags: string[] = [];
  try {
    const parsed2 = JSON.parse(raw);
    if (Array.isArray(parsed2)) {
      tags = parsed2
        .filter((t): t is string => typeof t === "string")
        .map((t) => t.toLowerCase().replace(/[^a-z0-9_]/g, ""))
        .filter((t) => t.length > 0)
        .slice(0, 5);
    }
  } catch {
    tags = [];
  }

  res.json({ hashtags: tags });
});

export default router;

/**
 * One-shot script to (re)tokenize all facts through the LLM tokenizer, upgrading
 * legacy/plain-English text into the full {NAME}/{SUBJ}/…/{verb|verb} template.
 *
 * This is NOT the routine repair path — for fixing missed verb conjugations on
 * existing facts use the deterministic, no-LLM `backfill-conjugate-verbs.ts`.
 * This script re-runs the model and is kept for a deeper re-pass when wanted.
 *
 * It imports the SAME prompt + tokenizer model the live route uses
 * (`factTokenizer.ts`) so the two can't drift, applies the SAME deterministic
 * post-processing as the live route (`postProcessTokenizedTemplate`: strip
 * hallucinated tokens, collapse {NAME}-subject pairs, conjugation net, collapse
 * identical branches), skips rows whose tokenized form is unchanged, and
 * recomputes the full text-derived set on the rows it does change
 * (text, canonicalText, splitTokenIndex, hasPronouns; updatedAt via $onUpdate).
 *
 * Run: pnpm --filter @workspace/api-server exec tsx scripts/retokenize-facts.ts
 */

import { installStdioGuard } from "../src/lib/stdioGuard";
installStdioGuard();

import OpenAI from "openai";
import { db } from "@workspace/db";
import { factsTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { renderCanonical } from "../src/lib/renderCanonical";
import { computeSplitTokenIndex } from "../src/lib/splitTokenIndex";
import { chatModelTuningParams } from "../src/lib/openaiChatParams";
import {
  TOKENIZE_SYSTEM_PROMPT,
  TOKENIZER_MODEL,
  TOKENIZER_REASONING_EFFORT,
  postProcessTokenizedTemplate,
} from "../src/lib/factTokenizer";

if (!process.env.OPENAI_API_KEY) {
  console.error("ERROR: OPENAI_API_KEY must be set.");
  process.exit(1);
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const HAS_PRONOUN_RE =
  /\{(SUBJ|OBJ|POSS|POSS_PRO|REFL|Subj|Obj|Poss|Poss_Pro|Refl|he|him|his|himself|He|Him|His|Himself|he's|He's|[^|{}]+\|[^|{}]+)\}/;

async function tokenize(text: string): Promise<string> {
  const completion = await openai.chat.completions.create({
    model: TOKENIZER_MODEL,
    // Reasoning-compatible call shape: a gpt-5* model rejects bare
    // temperature/max_tokens and needs max_completion_tokens + reasoning_effort.
    ...chatModelTuningParams({
      model: TOKENIZER_MODEL,
      maxTokens: 1024,
      temperature: 0,
      reasoningEffort: TOKENIZER_REASONING_EFFORT,
    }),
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: TOKENIZE_SYSTEM_PROMPT },
      { role: "user", content: `Convert this fact to a template:\n\n"${text}"` },
    ],
  });
  const raw = completion.choices[0]?.message?.content ?? "{}";
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const template = typeof parsed.template === "string" && parsed.template.length > 0 ? parsed.template : text;
  // Same deterministic guarantee the live route applies — the FULL post-process
  // (strip + name-collapse + conjugation net + identical-branch collapse), not
  // just the conjugation net, so the script can't reintroduce e.g. a
  // "{NAME} {gives|give}" pair the route would have collapsed.
  return postProcessTokenizedTemplate(template).template;
}

async function main() {
  const facts = await db.select({ id: factsTable.id, text: factsTable.text }).from(factsTable);
  console.log(`\nRetokenizing ${facts.length} facts...\n`);

  let changed = 0;
  let skipped = 0;
  let failed = 0;

  for (const fact of facts) {
    try {
      const template = await tokenize(fact.text);
      if (template === fact.text) {
        skipped++;
        console.log(`  #${fact.id} — unchanged, skipped`);
      } else {
        await db
          .update(factsTable)
          .set({
            text: template,
            canonicalText: renderCanonical(template),
            splitTokenIndex: computeSplitTokenIndex(template),
            hasPronouns: HAS_PRONOUN_RE.test(template),
          })
          .where(eq(factsTable.id, fact.id));
        changed++;
        console.log(`  #${fact.id} ✓`);
        console.log(`    was: ${fact.text.slice(0, 80)}${fact.text.length > 80 ? "…" : ""}`);
        console.log(`    now: ${template.slice(0, 80)}${template.length > 80 ? "…" : ""}`);
      }
    } catch (err) {
      failed++;
      console.error(`  [!] #${fact.id} FAILED: ${(err as Error).message}`);
    }

    // Small delay to be polite to the API.
    await new Promise((r) => setTimeout(r, 200));
  }

  console.log(`\nDone. Changed: ${changed}, Skipped: ${skipped}, Failed: ${failed}`);
  process.exit(0);
}

void main();

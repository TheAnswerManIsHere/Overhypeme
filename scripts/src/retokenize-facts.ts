/**
 * One-shot script to retokenize all facts using the new AI token system.
 * Converts plain-English legacy tokens into the full {NAME}/{SUBJ}/{OBJ}/{POSS}/verb-pair format.
 * Run with: pnpm --filter @workspace/api-server exec tsx ../../scripts/retokenize-facts.ts
 */
import OpenAI from "openai";
import { db } from "@workspace/db";
import { factsTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";

if (!process.env.AI_INTEGRATIONS_OPENAI_BASE_URL || !process.env.AI_INTEGRATIONS_OPENAI_API_KEY) {
  console.error("ERROR: AI_INTEGRATIONS_OPENAI_BASE_URL and AI_INTEGRATIONS_OPENAI_API_KEY must be set.");
  process.exit(1);
}

const openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
});

const SYSTEM_PROMPT = `You are a fact-template tokenizer for a personalized humor website called Overhype.me.
Users write facts in plain English about a person. You convert them into a template using a closed token set.

TOKEN RULES:
1. Replace the person's name (or legacy {Name}/{NAME} tokens) with {NAME}
2. Replace subject pronouns (he, she, or legacy {he}/{He} tokens) with {SUBJ}; capitalize to {Subj} when sentence-starting
3. Replace object pronouns (him, her, or legacy {him}/{Him} tokens) with {OBJ}; capitalize to {Obj} when needed
4. Replace possessive adjectives (his, her as adjective, or legacy {his}/{His} tokens) with {POSS}; capitalize to {Poss} when needed
5. Replace possessive pronouns (his, hers as standalone, or legacy {his}) with {POSS_PRO}; capitalize to {Poss_Pro} when needed
6. Replace reflexive pronouns (himself, herself, or legacy {himself}/{Himself} tokens) with {REFL}; capitalize to {Refl} when needed
7. For ANY verb or auxiliary that conjugates differently for "they" vs "he/she", use {singular_form|plural_form} syntax.
   Examples: {doesn't|don't}  {isn't|aren't}  {was|were}  {does|do}  {has|have}  {pushes|push}  {counts|count}
   The LEFT form is used for he/she; the RIGHT form is used for they.
8. Keep everything else exactly as written.

IMPORTANT:
- Capitalize tokens at the start of sentences: {Subj} not {SUBJ}, etc.
- Verb conjugation is the hardest part. Identify EVERY third-person singular verb that would change with "they". Don't miss any.
- "they" triggers plural: "he sleeps" → "{SUBJ} {sleeps|sleep}", "he doesn't" → "{SUBJ} {doesn't|don't}", "he was" → "{SUBJ} {was|were}"
- Input may already contain legacy tokens like {Name}, {he}, {him}, {his}, {himself}, {He}, {Him}, {His}, {Himself}, {he's}, {He's}. Upgrade them to the new token set.
- Return ONLY valid JSON: {"template": "...the tokenized template..."}
- Do NOT explain, do NOT add any other keys.`;

const HAS_PRONOUN_RE = /\{(SUBJ|OBJ|POSS|POSS_PRO|REFL|Subj|Obj|Poss|Poss_Pro|Refl|he|him|his|himself|He|Him|His|Himself|he's|He's|[^|{}]+\|[^|{}]+)\}/;

async function tokenize(text: string): Promise<string> {
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    max_tokens: 1024,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user",   content: `Convert this fact to a template:\n\n"${text}"` },
    ],
  });
  const raw = completion.choices[0]?.message?.content ?? "{}";
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (typeof parsed.template === "string" && parsed.template.length > 0) {
    return parsed.template;
  }
  return text;
}

const facts = await db.select({ id: factsTable.id, text: factsTable.text }).from(factsTable);
console.log(`\nRetokenizing ${facts.length} facts...\n`);

let processed = 0;
let failed = 0;

for (const fact of facts) {
  try {
    const template = await tokenize(fact.text);
    const hasPronouns = HAS_PRONOUN_RE.test(template);
    await db
      .update(factsTable)
      .set({ text: template, hasPronouns })
      .where(eq(factsTable.id, fact.id));
    processed++;
    console.log(`  [${processed}/${facts.length}] #${fact.id} ✓ has_pronouns=${hasPronouns}`);
    console.log(`    was: ${fact.text.slice(0, 80)}${fact.text.length > 80 ? "…" : ""}`);
    console.log(`    now: ${template.slice(0, 80)}${template.length > 80 ? "…" : ""}`);
  } catch (err) {
    failed++;
    console.error(`  [!] #${fact.id} FAILED: ${(err as Error).message}`);
  }

  // Small delay to be polite to the API
  await new Promise((r) => setTimeout(r, 200));
}

console.log(`\nDone. Processed: ${processed}, Failed: ${failed}`);
process.exit(0);

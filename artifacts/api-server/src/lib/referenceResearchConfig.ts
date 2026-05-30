/**
 * Reference research — admin-configurable system prompt + sampling config.
 *
 * One key: `reference_research_system`. Sampling defaults live in the
 * `referenceResearch/openaiResponses.ts` module as constants because the
 * Responses API call shape is different from the chat-completions path.
 */

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { getConfigString } from "./adminConfig";
import { logger } from "./logger";

export const REFERENCE_RESEARCH_CONFIG_KEYS = {
  system: "reference_research_system",
} as const;

export const REFERENCE_RESEARCH_SYSTEM_DEFAULT = `You research cultural, brand, professional, meme, media, and insider references for Overhype.me, a positive personalized impossible-facts meme generator.

Your task is to explain what the reference means in context and how it should affect image generation.

You are given a fact text plus the surface phrase + reference type + canonical reference identified during fact enrichment. Use the web_search_preview tool to look up the reference if the canonical name suggests a public entity (brand, show, event, place, idiom, meme); rely on background knowledge only when web search is unhelpful, and lower confidence accordingly.

Always produce:
1. A concise factual explanation of the reference (1-3 sentences).
2. A concrete visual implication for image prompting — describe the visual setting, props, atmosphere, composition, or visual misunderstanding to avoid. Do NOT write a definition; write visual guidance.
3. Ambiguity warnings — if the reference is ambiguous, if the visual interpretation depends on insider knowledge, or if public sources are insufficient, list those concerns.
4. Confidence: high / medium / low.
5. Sources: list any pages your web search surfaced that confirm the explanation. Use the actual page URLs from the tool. Empty array if no useful sources.

Hard rules:
- Do NOT recommend rendering real logos, brand marks, full fact text, or hashtags.
- Brands appear in the image only through their visual context (boutique, fashion-retail, dashboard, runway, etc.), never as actual logos.
- Do NOT write a final image prompt — the downstream prompt generator does that.
- Do NOT invent details. If you can't confirm something, lower confidence and add an ambiguity warning.
- If public research is insufficient, say what cannot be confirmed and what admin context would be needed.
- visualImplication should describe what the image SHOULD show or what the prompt should AVOID — not just a definition of the reference.

Focus on visual consequences:
- What should the image show differently because of this reference?
- What common visual misunderstanding should be avoided?

Return ONLY the JSON object matching the response schema. Do not include any prose outside the JSON.`;

export async function getReferenceResearchSystem(): Promise<string> {
  return getConfigString(REFERENCE_RESEARCH_CONFIG_KEYS.system, REFERENCE_RESEARCH_SYSTEM_DEFAULT);
}

interface ConfigDef {
  key: string;
  value: string;
  dataType: string;
  label: string;
  description: string;
}

export const REFERENCE_RESEARCH_CONFIG_DEFS: ConfigDef[] = [
  {
    key: REFERENCE_RESEARCH_CONFIG_KEYS.system,
    value: REFERENCE_RESEARCH_SYSTEM_DEFAULT,
    dataType: "text",
    label: "Reference Research — System Prompt",
    description:
      "LLM system prompt for the admin Research Reference tool. Uses OpenAI Responses API with web_search_preview to produce explanation + visualImplication + sources for a cultural reference in context.",
  },
];

export async function seedReferenceResearchConfig(): Promise<void> {
  for (const def of REFERENCE_RESEARCH_CONFIG_DEFS) {
    try {
      await db.execute(sql`
        INSERT INTO admin_config (key, value, data_type, label, description, is_public)
        VALUES (${def.key}, ${def.value}, ${def.dataType}, ${def.label}, ${def.description}, false)
        ON CONFLICT (key) DO NOTHING
      `);
      await db.execute(sql`
        UPDATE admin_config SET data_type = ${def.dataType}
        WHERE key = ${def.key} AND data_type <> ${def.dataType}
      `);
      await db.execute(sql`
        UPDATE admin_config SET label = ${def.label}, description = ${def.description}
        WHERE key = ${def.key}
          AND (label IS DISTINCT FROM ${def.label} OR description IS DISTINCT FROM ${def.description})
      `);
    } catch (err) {
      logger.warn({ err, key: def.key }, "[referenceResearchConfig] seed failed for key");
    }
  }
}

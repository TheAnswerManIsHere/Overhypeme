/**
 * @purpose The admin view of the six code-owned AI system prompts: each one's text, label and description, read from the code, for a read-only display.
 * @subsystem ai-config
 *
 * Launch Phase 3, plan amendment 1, B3. The admin config list shows these rows
 * from code, not from `admin_config`, so an older database's stale copy never
 * reaches the screen.
 */
import type { AdminConfig } from "@workspace/db/schema";

import { CODE_OWNED_PROMPT_KEYS } from "./codeOwnedPromptKeys";
import { FACT_ENRICHMENT_CONFIG_DEFS } from "./factEnrichmentConfig";
import { IMAGE_PROMPT_CONFIG_DEFS } from "./imagePromptConfig";
import { REFERENCE_RESEARCH_CONFIG_DEFS } from "./referenceResearchConfig";
import { SCENE_PROMPT_CONFIG_DEFS } from "./scenePromptConfig";
import { VISUAL_CONCEPTS_CONFIG_DEFS } from "./visualConceptsConfig";

export type AdminConfigView = AdminConfig & { codeOwned?: true };

/** The six prompts as admin config rows, from code. */
export function codeOwnedPromptRows(): AdminConfigView[] {
  const defs = [
    ...FACT_ENRICHMENT_CONFIG_DEFS,
    ...IMAGE_PROMPT_CONFIG_DEFS,
    ...REFERENCE_RESEARCH_CONFIG_DEFS,
    ...SCENE_PROMPT_CONFIG_DEFS,
    ...VISUAL_CONCEPTS_CONFIG_DEFS,
  ].filter((d) => CODE_OWNED_PROMPT_KEYS.has(d.key));
  return defs.map((d) => ({
    key: d.key,
    value: d.value,
    valueLabel: null,
    dataType: d.dataType,
    label: d.label,
    description: d.description,
    minValue: null,
    maxValue: null,
    isPublic: false,
    updatedAt: new Date(0),
    updatedById: null,
    codeOwned: true as const,
  }));
}

/** The admin config list with the six prompts replaced by their code rows. */
export function withCodeOwnedPrompts(rows: AdminConfig[]): AdminConfigView[] {
  return [...rows.filter((r) => !CODE_OWNED_PROMPT_KEYS.has(r.key)), ...codeOwnedPromptRows()];
}

/**
 * @purpose The six AI system prompts whose text lives in code alone: boot does not seed them, no admin write reaches them, every reader returns the code constant, and the admin config list shows them read-only from code.
 * @subsystem ai-config
 *
 * Launch Phase 3, plan amendment 1, Part B (docs/plans/PLAN_PHASE3_AMENDMENT_1.md,
 * approved by David 2026-10-29). Their `admin_config` rows, where an older
 * database still holds them, are ignored until a later migration retires them,
 * and never reach the admin screen.
 */
import type { AdminConfig } from "@workspace/db/schema";

import { FACT_ENRICHMENT_PROMPT_DEFS } from "./factEnrichmentConfig";
import { IMAGE_PROMPT_PROMPT_DEFS } from "./imagePromptConfig";
import { REFERENCE_RESEARCH_PROMPT_DEF } from "./referenceResearchConfig";
import { SCENE_PROMPT_DEF } from "./scenePromptConfig";
import { VISUAL_CONCEPTS_PROMPT_DEFS } from "./visualConceptsConfig";

const CODE_OWNED_PROMPT_DEFS = [
  ...FACT_ENRICHMENT_PROMPT_DEFS,
  ...IMAGE_PROMPT_PROMPT_DEFS,
  REFERENCE_RESEARCH_PROMPT_DEF,
  SCENE_PROMPT_DEF,
  ...VISUAL_CONCEPTS_PROMPT_DEFS,
];

const CODE_OWNED_PROMPT_KEYS: ReadonlySet<string> = new Set(CODE_OWNED_PROMPT_DEFS.map((d) => d.key));

export const CODE_OWNED_PROMPT_REFUSAL = "This prompt is set in code; change it through a reviewed pull request.";

export function isCodeOwnedPromptKey(key: string): boolean {
  return CODE_OWNED_PROMPT_KEYS.has(key);
}

export type AdminConfigView = AdminConfig & { codeOwned?: true };

/** The six prompts as admin config rows, from code. */
const CODE_OWNED_PROMPT_ROWS: readonly AdminConfigView[] = CODE_OWNED_PROMPT_DEFS.map((d) => ({
  key: d.key,
  value: d.value,
  valueLabel: null,
  dataType: "text",
  label: d.label,
  description: d.description,
  minValue: null,
  maxValue: null,
  isPublic: false,
  updatedAt: new Date(0),
  updatedById: null,
  codeOwned: true as const,
}));

/** The admin config list with the six prompts replaced by their code rows. */
export function withCodeOwnedPrompts(rows: AdminConfig[]): AdminConfigView[] {
  return [...rows.filter((r) => !isCodeOwnedPromptKey(r.key)), ...CODE_OWNED_PROMPT_ROWS];
}

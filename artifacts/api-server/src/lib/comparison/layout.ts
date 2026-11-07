/**
 * The engine comparison's layout (launch Phase 8, plan
 * `docs/plans/PLAN_PHASE8_ENGINE_EVALUATION.md`, *Proposed Design* C): a set's
 * panels are fact × scenario × style, and its cells are panel × the engine of
 * each family whose mode is the panel's. Pure, so the counts the plan names
 * (33 panels and 198 cells across rounds 1 and 2) are checkable without a
 * database.
 *
 * A family that cannot be rendered is refused at creation, never dropped: a
 * silently smaller comparison is what the plan forbids ("a candidate that
 * cannot be rendered at all is a scope question for David").
 */

import {
  RENDER_SCENARIO_DESCRIPTORS,
  type GenerationMode,
  type RenderScenarioKey,
} from "@workspace/api-zod";
import { generationModeForSubjectRenderMode } from "../factRenderScenarios";

/** The fields of an engine row the layout reads. */
export interface LayoutEngine {
  id: string;
  kind: string;
  family: string | null;
  imageMode: string | null;
  isActive: boolean;
  retired: boolean;
  deletedAt: Date | null;
  priceModel: unknown;
  sizeVocabulary: unknown;
}

export interface LayoutInput {
  factIds: number[];
  scenarioKeys: RenderScenarioKey[];
  lookStyleIds: string[];
  engineFamilies: string[];
}

export interface LayoutPanel {
  factId: number;
  scenarioKey: RenderScenarioKey;
  lookStyleId: string;
  imageMode: GenerationMode;
  engineIds: string[];
}

export class ComparisonLayoutError extends Error {
  constructor(readonly reasons: string[]) {
    super(`comparison set refused: ${reasons.join("; ")}`);
    this.name = "ComparisonLayoutError";
  }
}

function dedupe<T>(xs: T[]): T[] {
  return Array.from(new Set(xs));
}

/** Why `engine` cannot be a comparison cell, or null. */
export function comparisonEngineRefusal(engine: LayoutEngine): string | null {
  if (engine.kind !== "image") return "not an image engine";
  if (engine.retired) return "retired";
  if (engine.deletedAt) return "archived";
  if (!engine.isActive) return "inactive";
  if (!engine.priceModel) return "it has no price model, so no run can bound its cost";
  if (!engine.sizeVocabulary) return "it declares no size vocabulary";
  return null;
}

export function deriveComparisonLayout(input: LayoutInput, engines: LayoutEngine[]): LayoutPanel[] {
  const reasons: string[] = [];
  const families = dedupe(input.engineFamilies);
  const byFamilyMode = new Map<string, string>();
  for (const family of families) {
    for (const mode of ["t2i", "i2i"] as const) {
      const members = engines.filter((e) => e.family === family && e.imageMode === mode);
      if (members.length !== 1) {
        reasons.push(`family "${family}" has ${members.length} ${mode} engines, not one`);
        continue;
      }
      const refusal = comparisonEngineRefusal(members[0]!);
      if (refusal) reasons.push(`${members[0]!.id}: ${refusal}`);
      else byFamilyMode.set(`${family}|${mode}`, members[0]!.id);
    }
  }
  for (const key of input.scenarioKeys) {
    if (!(key in RENDER_SCENARIO_DESCRIPTORS)) reasons.push(`unknown scenario "${key}"`);
  }
  if (reasons.length) throw new ComparisonLayoutError(reasons);

  const panels: LayoutPanel[] = [];
  for (const factId of dedupe(input.factIds)) {
    for (const scenarioKey of dedupe(input.scenarioKeys)) {
      const imageMode = generationModeForSubjectRenderMode(RENDER_SCENARIO_DESCRIPTORS[scenarioKey].subjectRenderMode);
      for (const lookStyleId of dedupe(input.lookStyleIds)) {
        panels.push({
          factId,
          scenarioKey,
          lookStyleId,
          imageMode,
          engineIds: families.map((f) => byFamilyMode.get(`${f}|${imageMode}`)!),
        });
      }
    }
  }
  return panels;
}

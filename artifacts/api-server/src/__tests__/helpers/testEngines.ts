/**
 * A test engine: a catalogue engine cloned under a new id and family. Since
 * 2026-11-14 an engine's call settings come from its code definition, and an
 * engine with none cannot be dispatched (plan PLAN_AI_SETTINGS_IN_CODE.md), so
 * the clone's definition is registered beside the row it returns.
 */
import type { InsertEngine } from "@workspace/db/schema";
import type { EngineDefinition } from "../../lib/engines/types.js";
import { codeDefinitionToRow } from "../../lib/engines/toRow.js";
import { __registerEngineDefinitionForTest } from "../../lib/engineInterpreter.js";

export function testEngineRow(base: EngineDefinition, id: string, family: string): InsertEngine {
  const def: EngineDefinition = { ...base, id, family, isDefault: false };
  __registerEngineDefinitionForTest(def);
  return codeDefinitionToRow(def);
}

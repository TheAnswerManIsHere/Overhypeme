/**
 * A test engine: a catalogue engine cloned under a new id and family. Engines
 * live only in code (decisions.md 2026-11-14; there is no engines table), so
 * the clone is registered as a code definition and returned as the record the
 * server reads.
 */
import type { EngineDefinition } from "../../lib/engines/types.js";
import { toEngineRecord, type Engine } from "../../lib/engines/engineRecord.js";
import { __registerEngineDefinitionForTest } from "../../lib/engineInterpreter.js";

export function testEngineRow(base: EngineDefinition, id: string, family: string, overrides: Partial<EngineDefinition> = {}): Engine {
  const def: EngineDefinition = { ...base, ...overrides, id, family };
  __registerEngineDefinitionForTest(def);
  return toEngineRecord(def);
}

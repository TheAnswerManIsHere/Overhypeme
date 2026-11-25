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
  // A clone is active unless the test says otherwise: tests borrow a retired
  // engine's price and size rules (FLUX 3, GPT Image 2.5) as a stand-in, and
  // must not inherit its retirement.
  const def: EngineDefinition = { ...base, isActive: true, ...overrides, id, family };
  __registerEngineDefinitionForTest(def);
  return toEngineRecord(def);
}

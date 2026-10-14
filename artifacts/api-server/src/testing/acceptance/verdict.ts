/**
 * The acceptance run's completion rule (Launch Phase 2, increment 6, #631;
 * plan D2, D4, D6): every reason a variant is red, or none. Pure, so the rule
 * itself is unit-tested.
 */
import type { Row } from "./coverage";
import type { DetectorVerdict } from "./detector";
import type { JourneyOutcome } from "./driver";

export interface VerdictInput {
  journeys: JourneyOutcome[];
  coverage: Row[];
  uncovered: string[];
  detector?: Pick<DetectorVerdict, "problems"> & { violations: { sink: unknown[]; syscall: unknown[] } };
  setupError?: string;
  innerError?: string;
  /** Live mode over the fixture only: the Pexels-only meme read. */
  pexelsMeme?: { ok?: boolean } | null;
  requirePexelsMeme?: boolean;
}

export const EXPECTED_JOURNEYS = ["2", "3", "4", "5", "6", "7"] as const;

export function redReasons(v: VerdictInput): string[] {
  const red: string[] = [];
  if (v.setupError) red.push(`setup: ${v.setupError}`);
  if (v.innerError) red.push(`the inner program failed: ${v.innerError.split("\n")[0]}`);
  for (const j of EXPECTED_JOURNEYS) {
    const o = v.journeys.find((x) => x.journey === j);
    if (!o) red.push(`journey ${j} was never reported`);
    else if (o.status !== "passed") red.push(`journey ${j} ${o.status}${o.error ? `: ${o.error}` : ""}`);
  }
  for (const row of v.coverage) if (row.status === "missing") red.push(`operation ${row.key} (journey ${row.journey}): ${row.detail}`);
  for (const u of v.uncovered) red.push(`uncovered AI call: ${u}`);
  if (v.detector) {
    red.push(...v.detector.problems.map((p) => `detector: ${p}`));
    const n = v.detector.violations.sink.length + v.detector.violations.syscall.length;
    if (n > 0) red.push(`detector: ${n} outbound attempt(s) recorded after the self-test`);
  }
  if (v.requirePexelsMeme && !v.pexelsMeme?.ok) red.push(`the Pexels-only meme read: ${JSON.stringify(v.pexelsMeme ?? null)}`);
  return red;
}

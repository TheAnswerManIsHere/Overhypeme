/**
 * Did a negative control behave? (Launch Phase 2, increment 6, #631; plan D6.)
 *
 * A control injects one fault and must fail in exactly the way that fault
 * explains: its expected red reasons are present, and every other red reason
 * is absent. A run that went red for the injected reason AND for something
 * unrelated has not shown the run can catch that reason, so it did not behave.
 * Pure, so the rule itself is unit-tested.
 */
import type { Row } from "./coverage";
import type { JourneyOutcome } from "./driver";

export type ControlName = "forbidden-request" | "render-failure" | "corrupt-source" | "upload-failure";

export interface ControlInput {
  journeys: JourneyOutcome[];
  coverage: Row[];
  red: string[];
  /** The driver's own account of the render-failure control. */
  control?: { ok?: boolean; detail?: string };
  detector?: { violations: { sink: unknown[]; syscall: unknown[] } };
}

export interface ControlVerdict {
  behaved: boolean;
  why: string;
}

const OUTBOUND = /^detector: \d+ outbound attempt\(s\) recorded after the self-test$/;

/** The journeys an `operation …` red line names, e.g. "operation image-prompts (journey 3, 6): …" → [3, 6]. */
function operationJourneys(line: string): number[] | null {
  const m = /^operation \S+ \(journey ([\d, ]+)\)/.exec(line);
  return m ? m[1]!.split(",").map((n) => Number(n.trim())) : null;
}

function verdict(expectedHeld: boolean, held: string, others: string[]): ControlVerdict {
  if (expectedHeld && others.length === 0) return { behaved: true, why: held };
  const parts = [expectedHeld ? held : `the expected failure did not happen (${held})`];
  if (others.length) parts.push(`other red reasons: ${others.join(" | ")}`);
  return { behaved: false, why: parts.join("; ") };
}

export function controlVerdict(control: ControlName, r: ControlInput): ControlVerdict {
  switch (control) {
    case "forbidden-request": {
      const sink = (r.detector?.violations.sink ?? []) as Array<{ name?: string | null }>;
      const named = sink.some((e) => e.name === "api.openai.com");
      const sys = (r.detector?.violations.syscall.length ?? 0) > 0;
      const others = r.red.filter((x) => !OUTBOUND.test(x));
      return verdict(named && sys, named && sys ? "both observers recorded the caught request, the sink naming api.openai.com" : "the caught request was not recorded by both observers", others);
    }
    case "render-failure": {
      // The driver stops at journey 3 by design, so journeys 3–7 are not run and
      // the operations only those journeys exercise are missing. Journey 2 and
      // its operations are not affected, and must still hold.
      const two = r.journeys.find((j) => j.journey === "2")?.status === "passed";
      const expected = (x: string) => {
        if (/^journey [3-7] not-run\b/.test(x)) return true;
        const js = operationJourneys(x);
        return js !== null && js.every((n) => n >= 3);
      };
      const others = r.red.filter((x) => !expected(x));
      const held = r.control?.ok === true && two;
      return verdict(held, r.control?.detail ?? "journey 3 never reached its renders", [...(two ? [] : ["journey 2 did not pass"]), ...others]);
    }
    case "upload-failure": {
      const seven = r.journeys.find((j) => j.journey === "7")?.status === "passed";
      const missing = r.coverage.filter((c) => c.status === "missing").map((c) => c.key).sort();
      const held = seven && JSON.stringify(missing) === JSON.stringify(["photo-classifier", "photo-upload"]);
      const others = r.red.filter((x) => !x.startsWith("operation photo-upload") && !x.startsWith("operation photo-classifier"));
      return verdict(
        held,
        held ? "journey 7 completed on the fail-open path, and the evaluator marked the photo's upload and classification missing" : `journey 7 ${seven ? "passed" : "did not pass"}; missing rows ${missing.join(", ") || "none"}`,
        others,
      );
    }
    case "corrupt-source": {
      const four = r.journeys.find((j) => j.journey === "4");
      const held = four?.status === "failed" && /anyone reads the public meme image/.test(four.error ?? "");
      const others = r.red.filter((x) => !(x.startsWith("journey 4 failed:") && /anyone reads the public meme image/.test(x)));
      return verdict(held, held ? `journey 4 failed reading its composed image: ${four!.error}` : `journey 4 is ${four?.status} (${four?.error ?? "no error"})`, others);
    }
  }
}

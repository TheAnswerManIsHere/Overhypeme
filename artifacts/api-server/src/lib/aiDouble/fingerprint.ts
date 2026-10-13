/**
 * The identity of a recorded request (design D4, settled with Astra).
 *
 * The fingerprint covers the whole request the application sent — for chat:
 * model, every message in order (system, user and any corrective retry),
 * `response_format` including its schema, and the output-shaping options —
 * and nothing is left out unless a run has shown it varies between two runs
 * of the same baseline (see `normaliseRequest`). A field is never excluded on
 * a guess: an unexpected difference makes the replay fail visibly, which is
 * how the next one is found.
 */
import { createHash } from "node:crypto";

/**
 * The request in canonical form: keys sorted, undefined dropped.
 *
 * Nothing is normalised beyond that. The first record-versus-replay
 * comparison (2026-10-12) needed no transport field: the replay of every
 * baseline journey matched its recordings as captured. When a run first
 * shows a field that differs for transport reasons (an object path, a request
 * id), it is replaced here, by name, with the diff that showed it.
 */
export function normaliseRequest(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normaliseRequest);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = normaliseRequest(v);
    }
    return out;
  }
  return value;
}

export function fingerprint(kind: string, request: unknown): string {
  return createHash("sha256")
    .update(kind)
    .update("\0")
    .update(JSON.stringify(normaliseRequest(request)))
    .digest("hex");
}

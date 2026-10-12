/**
 * The identity of a recorded request (design D4, settled with Astra).
 *
 * The fingerprint covers the whole request the application sent — for chat:
 * model, every message in order (system, user and any corrective retry),
 * `response_format` including its schema, and the output-shaping options —
 * and nothing is left out unless it is named in `TRANSPORT_FIELDS` below with
 * the evidence that showed it varies between two runs of the same baseline.
 * A field is never added there on a guess: an unnamed difference makes the
 * replay fail visibly, which is how the next one is found.
 */
import { createHash } from "node:crypto";

/**
 * Fields that differ between two runs of the same baseline for reasons that
 * are not the request's meaning. Each entry is a dotted path matched anywhere
 * in the request (`*` matches one key) and the diff that showed it.
 *
 * Empty until the first record-versus-replay comparison names one.
 */
export const TRANSPORT_FIELDS: ReadonlyArray<{ path: string; evidence: string }> = [];

const PLACEHOLDER = "<transport>";

function matches(pattern: string[], at: string[]): boolean {
  if (pattern.length !== at.length) return false;
  return pattern.every((p, i) => p === "*" || p === at[i]);
}

function normalise(value: unknown, at: string[], patterns: string[][]): unknown {
  if (patterns.some((p) => matches(p, at))) return PLACEHOLDER;
  if (Array.isArray(value)) return value.map((v, i) => normalise(v, [...at, String(i)], patterns));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v === undefined) continue;
      out[key] = normalise(v, [...at, key], patterns);
    }
    return out;
  }
  return value;
}

/** The request as it is fingerprinted and stored: key order fixed, transport fields replaced. */
export function normaliseRequest(request: unknown): unknown {
  return normalise(request, [], TRANSPORT_FIELDS.map((f) => f.path.split(".")));
}

export function fingerprint(kind: string, request: unknown): string {
  return createHash("sha256")
    .update(kind)
    .update("\0")
    .update(JSON.stringify(normaliseRequest(request)))
    .digest("hex");
}

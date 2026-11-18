export const SENSITIVE_KEY_PATTERNS: RegExp[] = [
  /^sid$/i,
  /pass(word)?/i,
  /token/i,
  /secret/i,
  /api[_-]?key/i,
  /authoriz/i,
  /session/i,
  /cookie/i,
  /email/i,
  /otp/i,
  /code/i,
  /signature/i,
  // Personal text a page address can carry (launch Phase 14): a share link's
  // friend's name and pronouns, and a search's words. The Privacy page lists
  // "pages visited" for analytics, not what a person typed or was called.
  /^displayName$/i,
  /^pronouns$/i,
  /^q$/i,
];

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERNS.some((re) => re.test(key));
}

export function scrubObject(value: unknown, depth = 0): unknown {
  if (depth > 6 || value == null) return value;
  if (Array.isArray(value)) return value.map((v) => scrubObject(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSensitiveKey(k) ? "[Filtered]" : scrubObject(v, depth + 1);
    }
    return out;
  }
  return value;
}

export function scrubUrl(rawUrl: string, base = "http://internal.invalid"): string {
  try {
    const url = new URL(rawUrl, base);
    let mutated = false;
    for (const key of [...url.searchParams.keys()]) {
      if (isSensitiveKey(key)) {
        url.searchParams.set(key, "[Filtered]");
        mutated = true;
      }
    }
    if (!mutated) return rawUrl;
    if (rawUrl.startsWith("/")) return `${url.pathname}${url.search}${url.hash}`;
    return url.toString();
  } catch {
    return rawUrl;
  }
}

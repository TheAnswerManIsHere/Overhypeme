/**
 * Project Arachnid Shield client (Layer 1).
 *
 * Hash-based CSAM matching service operated by the Canadian Centre for
 * Child Protection. Endpoint: https://shield.projectarachnid.ca/v1/media/
 * Auth: HTTP Basic with the credentials issued at projectarachnid.ca.
 *
 * The official `arachnid-shield-sdk` package is not published to npm, so
 * we call the documented REST endpoint with `fetch` directly. Same payload,
 * same response shape, no upstream dependency surface.
 *
 * Configuration:
 *   - Env var ARACHNID_SHIELD_USERNAME, ARACHNID_SHIELD_PASSWORD — credentials.
 *   - admin_config `arachnid_shield_enabled` — false disables the call.
 *   - admin_config `arachnid_fail_open` — when true, network errors let
 *     uploads through; default false (fail closed).
 *
 * The wrapper is best-effort idempotent: it never persists anything by
 * itself. Callers are responsible for invoking
 * {@link quarantineImage} on a hit and stamping the upload metadata
 * columns on a clean scan.
 */

import { logger } from "../logger";
import { getConfigString } from "../adminConfig";

export const ARACHNID_BASE_URL = "https://shield.projectarachnid.ca/v1/media/";

/** Mirrors the `MediaClassification` enum from arachnid-shield-sdk-ts. */
export type ArachnidClassification = "csam" | "harmful-abusive-material" | "no-known-match" | string;

export interface ArachnidNearMatchDetail {
  sha1_base32?: string;
  sha256_hex?: string;
  classification?: ArachnidClassification | null;
  timestamp?: string | null;
}

export interface ArachnidScannedMedia {
  sha1_base32: string;
  sha256_hex: string;
  classification: ArachnidClassification | null;
  match_type: "exact" | "near" | null;
  is_match: boolean;
  size_bytes: number;
  near_match_details?: ArachnidNearMatchDetail[];
}

export interface ArachnidScanResultOk {
  status: "ok";
  data: ArachnidScannedMedia;
}

export interface ArachnidScanResultErr {
  status: "err";
  data: string;
}

export type ArachnidScanResult = ArachnidScanResultOk | ArachnidScanResultErr;

export class ArachnidConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArachnidConfigurationError";
  }
}

interface ArachnidCredentials {
  username: string;
  password: string;
}

function readCredentials(): ArachnidCredentials | null {
  const username = process.env["ARACHNID_SHIELD_USERNAME"]?.trim();
  const password = process.env["ARACHNID_SHIELD_PASSWORD"]?.trim();
  if (!username || !password) return null;
  return { username, password };
}

function basicAuthHeader(creds: ArachnidCredentials): string {
  return "Basic " + Buffer.from(`${creds.username}:${creds.password}`).toString("base64");
}

/**
 * Test seam: tests can swap in a fake `fetch`-shaped function or override
 * the credentials check. Production paths leave both at their defaults.
 */
export interface ArachnidScannerOverrides {
  fetchImpl?: typeof fetch;
  credentials?: ArachnidCredentials | null;
  baseUrl?: string;
}

export async function scanMediaFromBytes(
  bytes: Buffer,
  mimeType: string,
  overrides: ArachnidScannerOverrides = {},
): Promise<ArachnidScanResult> {
  const creds = overrides.credentials ?? readCredentials();
  if (!creds) {
    throw new ArachnidConfigurationError(
      "Arachnid Shield credentials are not configured (ARACHNID_SHIELD_USERNAME/PASSWORD).",
    );
  }
  const url = overrides.baseUrl ?? ARACHNID_BASE_URL;
  const fetchImpl = overrides.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: basicAuthHeader(creds),
        "Content-Type": mimeType,
        "Content-Length": String(bytes.length),
      },
      body: bytes,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { status: "err", data: `HTTP ${res.status}: ${text.slice(0, 500)}` };
    }
    const json = (await res.json()) as Partial<ArachnidScannedMedia>;
    const classification = (json.classification ?? null) as ArachnidClassification | null;
    const matchType = (json.match_type ?? null) as ArachnidScannedMedia["match_type"];
    const isMatch = classification !== null && classification !== "no-known-match";
    return {
      status: "ok",
      data: {
        sha1_base32: json.sha1_base32 ?? "",
        sha256_hex: json.sha256_hex ?? "",
        classification,
        match_type: matchType,
        is_match: isMatch,
        size_bytes: json.size_bytes ?? bytes.length,
        near_match_details: json.near_match_details ?? [],
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { status: "err", data: message };
  }
}

export interface ScanFaceSourceInput {
  bytes: Buffer;
  mimeType: string;
  /** Test override hook; production callers should not pass this. */
  scannerOverrides?: ArachnidScannerOverrides;
}

export interface ScanFaceSourceClean {
  outcome: "clean";
  evidence: ArachnidScannedMedia;
}
export interface ScanFaceSourceMatched {
  outcome: "match";
  evidence: ArachnidScannedMedia;
}
export interface ScanFaceSourceErrored {
  outcome: "error";
  message: string;
}
export interface ScanFaceSourceDisabled {
  outcome: "disabled";
}

export type ScanFaceSourceOutcome =
  | ScanFaceSourceClean
  | ScanFaceSourceMatched
  | ScanFaceSourceErrored
  | ScanFaceSourceDisabled;

/**
 * High-level wrapper for the upload route. Reads `arachnid_shield_enabled`
 * to short-circuit when disabled. Returns a discriminated outcome so the
 * caller can choose how to handle each branch (the route turns `match`
 * into a generic 422 with a quarantine row, `error` into 503 unless
 * `arachnid_fail_open=true`).
 */
export async function scanFaceSource(input: ScanFaceSourceInput): Promise<ScanFaceSourceOutcome> {
  const enabled = (await getConfigString("arachnid_shield_enabled", "true")).toLowerCase() === "true";
  if (!enabled) {
    logger.warn("[arachnid] scan skipped — arachnid_shield_enabled is false");
    return { outcome: "disabled" };
  }

  let result: ArachnidScanResult;
  try {
    result = await scanMediaFromBytes(input.bytes, input.mimeType, input.scannerOverrides ?? {});
  } catch (err) {
    if (err instanceof ArachnidConfigurationError) {
      if (process.env["NODE_ENV"] === "production") {
        // In production, missing credentials is a hard failure — fail closed.
        logger.error({ err }, "[arachnid] credentials missing — failing closed in production");
        return { outcome: "error", message: err.message };
      }
      // Dev/staging: bypass the scan with a warning (same pattern as verifyCaptcha dev bypass).
      logger.warn("[arachnid] credentials not configured — skipping scan in non-production environment");
      return { outcome: "disabled" };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { outcome: "error", message };
  }

  if (result.status === "err") {
    if (process.env["NODE_ENV"] !== "production") {
      // In dev/staging the Arachnid Shield endpoint is unreachable (network blocked).
      // Treat network errors the same as a disabled scan so uploads aren't blocked.
      logger.warn({ err: result.data }, "[arachnid] scan network error — skipping in non-production environment");
      return { outcome: "disabled" };
    }
    logger.warn({ err: result.data }, "[arachnid] scan failed");
    return { outcome: "error", message: result.data };
  }

  if (result.data.is_match) {
    logger.warn(
      {
        classification: result.data.classification,
        matchType: result.data.match_type,
        sha256: result.data.sha256_hex,
      },
      "[arachnid] MATCH — image will be quarantined",
    );
    return { outcome: "match", evidence: result.data };
  }

  return { outcome: "clean", evidence: result.data };
}

/** Returns true when the operator explicitly opted into fail-open semantics. */
export async function isArachnidFailOpen(): Promise<boolean> {
  return (await getConfigString("arachnid_fail_open", "false")).toLowerCase() === "true";
}

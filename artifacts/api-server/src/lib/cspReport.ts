/**
 * The CSP report collector (launch Phase 15, increment 3b; plan
 * PLAN_PHASE15_SECURITY_HARDENING.md, Block A, increment 3).
 *
 * Browsers POST a report here when a page breaks one of our Content Security
 * Policies (both the web app's, sent by artifacts/overhype-me/server/serve.mjs,
 * and the API's own, lib/securityHeaders.ts). A report can only be useful if
 * it arrives, and the web app's policy stays report-only until a measured
 * window of these reports is clean, so this endpoint is what makes that window
 * mean anything.
 *
 * It is unauthenticated by necessity (a browser sends the report itself, with
 * no CSRF header and from any page that carries our policy), so it is built to
 * be cheap and to leak nothing:
 *
 *  - **Only the two CSP report media types are read**: `application/csp-report`
 *    (the `report-uri` form both servers' policies use) and
 *    `application/reports+json` (the Reporting API's form, accepted so a
 *    browser that sends it is still heard; neither policy names `report-to`,
 *    lib/securityHeaders.ts says why). Anything else is 415.
 *  - **The body is capped** at {@link CSP_REPORT_MAX_BYTES}; a larger one is
 *    refused (413) without being parsed.
 *  - **Rate-limited per address** ({@link CSP_REPORT_MAX_PER_WINDOW} a minute),
 *    separately from the API-wide backstop, so a flood is shed cheaply.
 *  - **Logged as one structured line per violation, and nothing else kept.**
 *    No cookie is read (the route sits ahead of the cookie parser), no header
 *    is logged, every URL loses its query string and fragment, the script
 *    sample is dropped, and every field is length-capped. No table, no row.
 *  - **Never echoes input**: every answer is an empty body.
 *
 * Mounted in app.ts ahead of the cookie parser, the origin and CSRF checks
 * and the auth chain, because none of them apply to a browser's own report.
 *
 * @purpose Receives browsers' CSP violation reports for both servers' policies and logs each as one bounded, query-free structured line.
 * @subsystem security
 */
import express, { type Request, type Response, type NextFunction, type Router } from "express";
import { rateLimit, ipKeyGenerator } from "express-rate-limit";
import { ipFromRequest } from "./transientRenderLog";
import { BoundedMemoryStore, MAX_TRACKED_KEYS } from "./globalRateLimitStore";
import { logger } from "./logger";

/** The path prefix both servers' policies report to; the last segment names the policy that fired. */
export const CSP_REPORT_PATH = "/api/csp-report";

/** The policies that report here. A report to any other name is refused (404). */
export const CSP_REPORT_SOURCES = ["web", "api"] as const;
export type CspReportSource = (typeof CSP_REPORT_SOURCES)[number];

/** The largest report body accepted. A single violation is well under 4 KB even with a long policy. */
export const CSP_REPORT_MAX_BYTES = 16 * 1024;

/** Reports accepted per address per minute; the rest get 429. A busy page breaks a policy a few times per load. */
export const CSP_REPORT_MAX_PER_WINDOW = 60;
const CSP_REPORT_WINDOW_MS = 60_000;

/** A `reports+json` batch is read up to this many entries; the rest are counted, not logged. */
const MAX_REPORTS_PER_BODY = 20;

/** Every logged string is cut to this length. */
const MAX_FIELD_LENGTH = 300;

const REPORT_MEDIA_TYPES = ["application/csp-report", "application/reports+json"];

/** The logged form of one violation: fixed fields, all bounded. */
export interface CspViolationLine {
  source: CspReportSource;
  disposition: string | null;
  directive: string | null;
  blocked: string | null;
  document: string | null;
  sourceFile: string | null;
  line: number | null;
  column: number | null;
  statusCode: number | null;
}

function cap(value: string): string {
  return value.length > MAX_FIELD_LENGTH ? value.slice(0, MAX_FIELD_LENGTH) : value;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? cap(value) : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : null;
}

/**
 * A URL as it may be logged: scheme, host and path only — never a query
 * string or fragment, which is where tokens and personal data travel. A value
 * that is not a URL (a CSP keyword such as `inline`, `eval`, `data`) keeps its
 * first word only, so nothing after a separator survives either.
 */
export function stripUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    const url = new URL(value);
    if (url.protocol === "http:" || url.protocol === "https:" || url.protocol === "wss:" || url.protocol === "ws:") {
      return cap(`${url.protocol}//${url.host}${url.pathname}`);
    }
    // data:, blob:, chrome-extension: and the like: the scheme says enough.
    return cap(url.protocol.replace(/:$/, ""));
  } catch {
    const word = value.split(/[\s?#;:,]/)[0] ?? "";
    return word ? cap(word) : null;
  }
}

/** One violation from the `report-uri` form's `csp-report` object. */
function fromLegacy(source: CspReportSource, report: Record<string, unknown>): CspViolationLine {
  return {
    source,
    disposition: asString(report["disposition"]),
    directive: asString(report["effective-directive"]) ?? asString(report["violated-directive"]),
    blocked: stripUrl(report["blocked-uri"]),
    document: stripUrl(report["document-uri"]),
    sourceFile: stripUrl(report["source-file"]),
    line: asNumber(report["line-number"]),
    column: asNumber(report["column-number"]),
    statusCode: asNumber(report["status-code"]),
  };
}

/** One violation from a Reporting API entry's `body`. */
function fromReportingApi(source: CspReportSource, body: Record<string, unknown>): CspViolationLine {
  return {
    source,
    disposition: asString(body["disposition"]),
    directive: asString(body["effectiveDirective"]),
    blocked: stripUrl(body["blockedURL"]),
    document: stripUrl(body["documentURL"]),
    sourceFile: stripUrl(body["sourceFile"]),
    line: asNumber(body["lineNumber"]),
    column: asNumber(body["columnNumber"]),
    statusCode: asNumber(body["statusCode"]),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The violations a report body carries, in their logged form. Pure, so the
 * collector's whole reading of a body is testable without a server. Returns
 * `null` when the body is not a CSP report at all.
 */
export function parseCspReportBody(
  source: CspReportSource,
  mediaType: string,
  raw: string,
): { violations: CspViolationLine[]; dropped: number } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (mediaType === "application/csp-report") {
    if (!isRecord(parsed) || !isRecord(parsed["csp-report"])) return null;
    return { violations: [fromLegacy(source, parsed["csp-report"])], dropped: 0 };
  }
  if (!Array.isArray(parsed)) return null;
  const entries = parsed.filter(
    (entry): entry is Record<string, unknown> =>
      isRecord(entry) && entry["type"] === "csp-violation" && isRecord(entry["body"]),
  );
  const kept = entries.slice(0, MAX_REPORTS_PER_BODY);
  return {
    violations: kept.map((entry) => fromReportingApi(source, entry["body"] as Record<string, unknown>)),
    dropped: entries.length - kept.length,
  };
}

function mediaTypeOf(req: Request): string {
  return String(req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
}

function isSource(value: string): value is CspReportSource {
  return (CSP_REPORT_SOURCES as readonly string[]).includes(value);
}

/** An empty answer with no caching, the only shape this endpoint ever returns. */
function end(res: Response, status: number): void {
  res.set("Cache-Control", "no-store");
  res.status(status).end();
}

/**
 * The collector's router, mounted at the app root. A fresh limiter (and
 * store) per call, as the global limiter does, so each app built in a test
 * starts with an empty count.
 */
export function cspReportRouter(): Router {
  const router = express.Router();

  const limiter = rateLimit({
    windowMs: CSP_REPORT_WINDOW_MS,
    limit: CSP_REPORT_MAX_PER_WINDOW,
    store: new BoundedMemoryStore(MAX_TRACKED_KEYS),
    keyGenerator: (req) => ipKeyGenerator(ipFromRequest(req)),
    standardHeaders: false,
    legacyHeaders: false,
    handler: (_req, res) => end(res, 429),
  });

  const readBody = express.text({ type: REPORT_MEDIA_TYPES, limit: CSP_REPORT_MAX_BYTES });

  router.post(
    `${CSP_REPORT_PATH}/:source`,
    (req: Request, res: Response, next: NextFunction) => {
      if (!isSource(String(req.params["source"]))) return end(res, 404);
      if (!REPORT_MEDIA_TYPES.includes(mediaTypeOf(req))) return end(res, 415);
      const declared = Number(req.headers["content-length"]);
      if (Number.isFinite(declared) && declared > CSP_REPORT_MAX_BYTES) return end(res, 413);
      next();
    },
    limiter,
    readBody,
    (req: Request, res: Response) => {
      const source = String(req.params["source"]) as CspReportSource;
      const parsed = typeof req.body === "string" ? parseCspReportBody(source, mediaTypeOf(req), req.body) : null;
      // The app's request logger (app.ts, pino-http) logs `req.body` when the
      // response finishes; the raw report still holds query strings and the
      // script sample, so it is replaced before that line is written.
      req.body = undefined;
      if (!parsed) return end(res, 400);
      for (const violation of parsed.violations) {
        logger.warn({ event: "csp_report", ...violation }, "CSP violation reported");
      }
      if (parsed.dropped > 0) {
        logger.warn({ event: "csp_report_batch_truncated", source, dropped: parsed.dropped }, "CSP report batch truncated");
      }
      end(res, 204);
    },
  );

  // A body over the cap (sent chunked, so no Content-Length to refuse it by)
  // or one that will not decode ends here, still with an empty answer.
  router.use(CSP_REPORT_PATH, (err: unknown, _req: Request, res: Response, next: NextFunction) => {
    const status = (err as { status?: number } | null)?.status;
    if (status === 413) return end(res, 413);
    if (typeof status === "number" && status >= 400 && status < 500) return end(res, 400);
    next(err);
  });

  return router;
}

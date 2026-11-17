/**
 * @purpose The admin Operations page's API: the live state of each alert source, recent incidents read from Sentry, and a test alert.
 * @subsystem operations
 *
 *   GET  /admin/operations             — live state + recent incidents
 *   POST /admin/operations/test-alert  — sends a real alert through the whole route
 *
 * Launch Phase 16 (Issue #1029; plan design A, "the in-app half"). Sentry is
 * the only incident store, so the incident list is read from Sentry by the
 * server: an incident raised while the database was failing still appears.
 * When Sentry cannot be read the list says "unavailable", never "none".
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { requireAdmin } from "./admin";
import { laneHealth } from "../lib/queueHealth";
import { checkSharedRateLimit } from "../lib/sharedRateLimiter";
import { ALERT_SOURCES, alertTitle, reportOperationalAlert, type AlertSource } from "../lib/operationalAlerts";
import { logger } from "../lib/logger";

const router: IRouter = Router();

export type IncidentSource = AlertSource | "site_down" | "error";

export interface Incident {
  title: string;
  source: IncidentSource;
  lastSeen: string;
  count: number;
  link: string;
}

export type IncidentList =
  | { status: "ok"; incidents: Incident[] }
  | { status: "unavailable"; reason: "not_configured" | "unreachable" };

const SENTRY_ORG = process.env["SENTRY_ORG_SLUG"] ?? "overhypeme";
const SENTRY_API_BASE = process.env["SENTRY_API_BASE"] ?? "https://sentry.io";
const INCIDENT_LIMIT = 20;
const SENTRY_TIMEOUT_MS = 5_000;

interface SentryIssue {
  title?: string;
  lastSeen?: string;
  count?: string | number;
  permalink?: string;
  issueCategory?: string;
  issueType?: string;
}

/** Map one Sentry issue to the source shown on the page. */
export function classifyIssue(issue: SentryIssue): IncidentSource {
  for (const source of ALERT_SOURCES) {
    if (issue.title === alertTitle(source)) return source;
  }
  if (issue.issueCategory === "uptime" || (issue.issueType ?? "").startsWith("uptime")) return "site_down";
  return "error";
}

type Fetch = typeof fetch;
let fetchImpl: Fetch = (...args) => fetch(...args);
export function __setOperationsFetchForTest(fn: Fetch | null): void {
  fetchImpl = fn ?? ((...args) => fetch(...args));
}

/** Recent unresolved production incidents, newest first. Never throws. */
export async function readRecentIncidents(token = process.env["SENTRY_API_TOKEN"]): Promise<IncidentList> {
  if (!token) return { status: "unavailable", reason: "not_configured" };
  const params = new URLSearchParams({
    query: "is:unresolved",
    environment: "production",
    statsPeriod: "7d",
    sort: "date",
    limit: String(INCIDENT_LIMIT),
  });
  const url = `${SENTRY_API_BASE}/api/0/organizations/${encodeURIComponent(SENTRY_ORG)}/issues/?${params}`;
  try {
    const res = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(SENTRY_TIMEOUT_MS),
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, "[operations] Sentry issue list refused");
      return { status: "unavailable", reason: "unreachable" };
    }
    const body = (await res.json()) as unknown;
    if (!Array.isArray(body)) return { status: "unavailable", reason: "unreachable" };
    const incidents = (body as SentryIssue[]).slice(0, INCIDENT_LIMIT).map((issue) => ({
      title: String(issue.title ?? "(untitled)"),
      source: classifyIssue(issue),
      lastSeen: String(issue.lastSeen ?? ""),
      count: Number(issue.count ?? 0) || 0,
      link: String(issue.permalink ?? ""),
    }));
    return { status: "ok", incidents };
  } catch (err) {
    logger.warn({ err }, "[operations] Sentry issue list unreachable");
    return { status: "unavailable", reason: "unreachable" };
  }
}

router.get("/admin/operations", requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const rateLimit = await checkSharedRateLimit(
    { endpoint: "admin.operations.read", ip: req.ip ?? null, userId: req.user?.id ?? null },
    { limit: 60, windowMs: 60_000 },
  );
  if (!rateLimit.allowed) { res.status(429).json({ error: "Too many requests" }); return; }

  // Each half is read independently: one failing must not hide the other.
  const [lanesResult, incidents] = await Promise.all([
    laneHealth().then(
      (lanes) => ({ status: "ok" as const, lanes }),
      (err: unknown) => {
        logger.error({ err }, "[operations] lane health could not be read");
        return { status: "unavailable" as const };
      },
    ),
    readRecentIncidents(),
  ]);
  res.json({ checkedAt: new Date().toISOString(), lanes: lanesResult, incidents });
});

router.post("/admin/operations/test-alert", requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const rateLimit = await checkSharedRateLimit(
    { endpoint: "admin.operations.test-alert", ip: req.ip ?? null, userId: req.user?.id ?? null },
    { limit: 5, windowMs: 60_000 },
  );
  if (!rateLimit.allowed) { res.status(429).json({ error: "Too many requests" }); return; }
  reportOperationalAlert("test", { requestedAt: new Date().toISOString() });
  res.json({ sent: true, environment: process.env["NODE_ENV"] === "production" ? "production" : "development" });
});

export default router;

/**
 * @purpose The admin Operations page's API: the live state of each alert source, recent incidents read from Sentry, and a test alert.
 * @subsystem operations
 *
 *   GET  /admin/operations             — live state + recent incidents
 *   POST /admin/operations/test-alert  — sends a real alert through the whole route
 *   POST /admin/operations/drill       — starts the "job stopped or wedged" drill
 *   POST /admin/operations/crash-drill — ends this server process on purpose (Q30: 1)
 *
 * Launch Phase 16 (Issue #1029; plan design A, "the in-app half"). Sentry is
 * the only incident store, so the incident list is read from Sentry by the
 * server: an incident raised while the database was failing still appears.
 * When Sentry cannot be read the list says "unavailable", never "none".
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { requireAdmin } from "./admin";
import { laneHealth } from "../lib/queueHealth";
import { operationalHealthCached, type OperationalHealth } from "../lib/operationalHealth";
import { DRILL_ALERT_WHEN_HELD_MS, DRILL_HOLD_MS, startOperationsDrill } from "../lib/operationsDrill";
import { checkSharedRateLimit } from "../lib/sharedRateLimiter";
import { alertLabel, alertRouteConnected, alertSourceForTitle, reportOperationalAlert, type AlertSource } from "../lib/operationalAlerts";
import { isProductionEnv } from "../lib/env";
import { logger } from "../lib/logger";
import { readOnlyEnforcement, setReadOnly } from "../lib/readOnlyMode";

const router: IRouter = Router();

export type IncidentSource = AlertSource | "site_down" | "error";

export interface Incident {
  title: string;
  source: IncidentSource;
  /** What the page shows for the source; sent so the page holds no copy of the list. */
  label: string;
  /** Still open in Sentry; false once resolved (an outage resolves itself on recovery). */
  ongoing: boolean;
  lastSeen: string;
  count: number;
  link: string;
}

export type IncidentList =
  | { status: "ok"; incidents: Incident[] }
  | { status: "unavailable"; reason: "not_configured" | "refused" | "unreachable" };

const SENTRY_ORG = process.env["SENTRY_ORG_SLUG"] ?? "overhypeme";
const SENTRY_API_BASE = process.env["SENTRY_API_BASE"] ?? "https://sentry.io";
const INCIDENT_LIMIT = 20;
const SENTRY_TIMEOUT_MS = 5_000;

interface SentryIssue {
  title?: string;
  status?: string;
  lastSeen?: string;
  count?: string | number;
  permalink?: string;
  issueCategory?: string;
  issueType?: string;
}

/** Map one Sentry issue to the source shown on the page. */
export function classifyIssue(issue: SentryIssue): IncidentSource {
  // Sentry's issue list carries no tags, so an operational alert is recognised
  // by its fixed title, which lib/operationalAlerts.ts defines once.
  const source = alertSourceForTitle(issue.title);
  if (source) return source;
  // Sentry files uptime downtime under the "outage" category (read from a real
  // route-test incident, 2026-11-17); the type check covers the uptime_* types.
  if (issue.issueCategory === "outage" || issue.issueCategory === "uptime" || (issue.issueType ?? "").startsWith("uptime")) return "site_down";
  return "error";
}

type Fetch = typeof fetch;
let fetchImpl: Fetch = (...args) => fetch(...args);
export function __setOperationsFetchForTest(fn: Fetch | null): void {
  fetchImpl = fn ?? ((...args) => fetch(...args));
}

/**
 * The page polls every 15 s, possibly from several tabs; Sentry is asked at
 * most once a minute, and concurrent requests share one call. Only a good
 * answer is cached: "unavailable" is asked again on the next poll.
 */
const INCIDENT_CACHE_MS = 60_000;
let cached: { at: number; list: IncidentList } | null = null;
let inFlight: Promise<IncidentList> | null = null;

export function __resetIncidentCacheForTest(): void {
  cached = null;
  inFlight = null;
}

export async function readRecentIncidentsCached(): Promise<IncidentList> {
  if (cached && Date.now() - cached.at < INCIDENT_CACHE_MS) return cached.list;
  inFlight ??= readRecentIncidents().then((list) => {
    if (list.status === "ok") cached = { at: Date.now(), list };
    return list;
  }).finally(() => { inFlight = null; });
  return inFlight;
}

/** Recent unresolved production incidents, newest first. Never throws. */
export async function readRecentIncidents(token = process.env["SENTRY_API_TOKEN"]): Promise<IncidentList> {
  if (!token) return { status: "unavailable", reason: "not_configured" };
  const params = new URLSearchParams({
    // Empty, not omitted: Sentry applies `is:unresolved` when `query` is
    // absent, and a resolved incident (every recovered outage) still belongs
    // in the recent history.
    query: "",
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
      // 401/403: Sentry answered and rejected the key (revoked, expired, or
      // missing the event:read scope). Saying "could not be reached" then sent
      // the diagnosis the wrong way (#1055); the fix is a new key, not a retry.
      const refused = res.status === 401 || res.status === 403;
      return { status: "unavailable", reason: refused ? "refused" : "unreachable" };
    }
    const body = (await res.json()) as unknown;
    if (!Array.isArray(body)) return { status: "unavailable", reason: "unreachable" };
    const incidents = (body as SentryIssue[]).slice(0, INCIDENT_LIMIT).map((issue): Incident => {
      const source = classifyIssue(issue);
      return {
        title: String(issue.title ?? "(untitled)"),
        source,
        label: source === "site_down" ? "Site down" : source === "error" ? "Error" : alertLabel(source),
        ongoing: issue.status !== "resolved",
        lastSeen: String(issue.lastSeen ?? ""),
        count: Number(issue.count ?? 0) || 0,
        link: String(issue.permalink ?? ""),
      };
    });
    return { status: "ok", incidents };
  } catch (err) {
    logger.warn({ err }, "[operations] Sentry issue list unreachable");
    return { status: "unavailable", reason: "unreachable" };
  }
}

/**
 * The shared limiter writes a counter row. These are the screens David opens
 * when the product is failing, so a database that reads but cannot save must
 * not take them down: a failure of the counter's storage is logged and the
 * request carries on. The limit is unchanged whenever the counter works, and
 * checkSharedRateLimit itself is untouched (sign-in and submission throttles
 * rely on it failing closed).
 */
let limiter: typeof checkSharedRateLimit = checkSharedRateLimit;
export function __setOperationsLimiterForTest(fn: typeof checkSharedRateLimit | null): void {
  limiter = fn ?? checkSharedRateLimit;
}

async function withinLimit(req: Request, endpoint: string, limit: number): Promise<boolean> {
  try {
    const result = await limiter(
      { endpoint, ip: req.ip ?? null, userId: req.user?.id ?? null },
      { limit, windowMs: 60_000 },
    );
    return result.allowed;
  } catch (err) {
    logger.warn({ err, endpoint }, "[operations] rate-limit storage failed; serving the request");
    return true;
  }
}

router.get("/admin/operations", requireAdmin, async (req: Request, res: Response): Promise<void> => {
  if (!(await withinLimit(req, "admin.operations.read", 60))) { res.status(429).json({ error: "Too many requests" }); return; }

  // Each part is read independently: one failing must not hide another.
  const [lanesResult, incidents, alerts] = await Promise.all([
    laneHealth().then(
      (lanes) => ({ status: "ok" as const, lanes }),
      (err: unknown) => {
        logger.error({ err }, "[operations] lane health could not be read");
        return { status: "unavailable" as const };
      },
    ),
    readRecentIncidentsCached(),
    // The same verdict the combined alert address gives the uptime check,
    // with the detail it withholds. Never throws: each part says when it
    // could not be judged.
    operationalHealthCached().then(
      (h): { status: "ok"; health: OperationalHealth } => ({ status: "ok", health: h }),
      (err: unknown) => {
        logger.error({ err }, "[operations] the alert verdict could not be read");
        return { status: "unavailable" as const };
      },
    ),
  ]);
  // The state the server answering this request is enforcing (plan D: each
  // server keeps its own copy, refreshed about every half minute).
  const readOnly = await readOnlyEnforcement();
  res.json({ checkedAt: new Date().toISOString(), lanes: lanesResult, incidents, alerts, readOnly });
});

/**
 * Turn read-only mode on or off (plan design D, an incident lever). The
 * answering server enforces the new value at once; every other server picks
 * it up within its refresh interval.
 */
router.put("/admin/operations/read-only", requireAdmin, async (req: Request, res: Response): Promise<void> => {
  if (!(await withinLimit(req, "admin.operations.read-only", 20))) { res.status(429).json({ error: "Too many requests" }); return; }
  const on = (req.body as { on?: unknown } | undefined)?.on;
  if (typeof on !== "boolean") { res.status(400).json({ error: "on must be true or false" }); return; }
  try {
    await setReadOnly(on, req.user?.id ?? null);
  } catch (err) {
    logger.error({ err, on }, "[operations] the read-only switch could not be saved");
    res.status(503).json({ error: "The switch could not be saved. Nothing changed; try again." });
    return;
  }
  logger.warn({ on, adminId: req.user?.id ?? null }, `[operations] read-only mode turned ${on ? "on" : "off"}`);
  res.json({ readOnly: await readOnlyEnforcement() });
});

router.post("/admin/operations/test-alert", requireAdmin, async (req: Request, res: Response): Promise<void> => {
  if (!(await withinLimit(req, "admin.operations.test-alert", 5))) { res.status(429).json({ error: "Too many requests" }); return; }
  if (!alertRouteConnected()) {
    res.json({ sent: false, reason: "not_connected" });
    return;
  }
  reportOperationalAlert("test", { requestedAt: new Date().toISOString() });
  res.json({ sent: true, rings: isProductionEnv() });
});

/**
 * Start the drill (plan design G): a job that holds one background slot for
 * ten minutes and spends nothing. The combined alert address reads it as
 * wedged after two, so the uptime check fails and the phone rings.
 */
router.post("/admin/operations/drill", requireAdmin, async (req: Request, res: Response): Promise<void> => {
  if (!(await withinLimit(req, "admin.operations.drill", 5))) { res.status(429).json({ error: "Too many requests" }); return; }
  try {
    const { jobId, alreadyRunning } = await startOperationsDrill();
    res.json({ started: !alreadyRunning, alreadyRunning, jobId, holdMinutes: DRILL_HOLD_MS / 60_000, alertAfterMinutes: DRILL_ALERT_WHEN_HELD_MS / 60_000 });
  } catch (err) {
    logger.error({ err }, "[operations] the drill could not be started");
    res.status(503).json({ error: "The drill could not be started" });
  }
});

/**
 * The crash drill (increment 7, David's Q30: 1, 2026-11-20): end this server
 * process on purpose, through the same path a real crash takes, so the
 * fault-injection afternoon can show a crash reaching David's phone. The
 * one real crash on record (2026-10-31, Issue #826) never reached Sentry.
 *
 * The answer goes out first; half a second later an error is thrown outside
 * any request, so the process's uncaughtException handler (`fatalExit` in
 * index.ts) reports it to Sentry, waits for the report to leave, and exits.
 * The platform starts the process again. Only the instance that answered is
 * ended. The body must carry { confirm: "crash" }, so nothing sends it by
 * accident.
 */
export const CRASH_DRILL_DELAY_MS = 500;
export const CRASH_DRILL_MESSAGE = "Crash drill: an admin ended this server process on purpose (launch Phase 16, increment 7)";
const throwOutsideRequest = (err: Error): void => {
  setTimeout(() => { throw err; }, CRASH_DRILL_DELAY_MS);
};
let scheduleCrash: (err: Error) => void = throwOutsideRequest;
/** Tests replace the crash with a recorder; `null` restores the real one. */
export function __setCrashSchedulerForTest(fn: ((err: Error) => void) | null): void { scheduleCrash = fn ?? throwOutsideRequest; }

router.post("/admin/operations/crash-drill", requireAdmin, async (req: Request, res: Response): Promise<void> => {
  if (!(await withinLimit(req, "admin.operations.crash-drill", 3))) { res.status(429).json({ error: "Too many requests" }); return; }
  if ((req.body as { confirm?: unknown } | undefined)?.confirm !== "crash") {
    res.status(400).json({ error: "Send { confirm: \"crash\" } to end this server process." });
    return;
  }
  logger.warn({ adminId: req.user?.id ?? null, delayMs: CRASH_DRILL_DELAY_MS }, "[operations] crash drill requested: this process will exit");
  res.json({ crashing: true, delayMs: CRASH_DRILL_DELAY_MS, rings: isProductionEnv() });
  scheduleCrash(new Error(CRASH_DRILL_MESSAGE));
});

export default router;

/**
 * @purpose The admin Operations page: whether each alert source is healthy now, the recent incidents Sentry holds, and a test alert to David's phone.
 * @subsystem operations
 *
 * Launch Phase 16 (Issue #1029; plan design A, "the in-app half"). Every read
 * that can fail says so: a first load that fails never shows a healthy page,
 * a later failure keeps the last data marked stale, and incidents Sentry
 * cannot supply read "unavailable", never "none".
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { AdminLayout } from "@/components/admin/AdminLayout";
import { Button } from "@/components/ui/Button";
import { AlertTriangle, BellRing, CheckCircle2, ExternalLink, Loader2, RefreshCw, Timer, XCircle } from "lucide-react";

const POLL_INTERVAL_MS = 15_000;

interface Lane {
  lane: string;
  liveInstanceCount: number;
  lastScheduledAt: string | null;
  inFlightCount: number;
  stalled: boolean;
}

interface Incident {
  title: string;
  source: string;
  /** The server's label for the source. */
  label: string;
  /** Still open in Sentry; false once resolved. */
  ongoing: boolean;
  lastSeen: string;
  count: number;
  link: string;
}

type Part<T> = { status: "ok"; healthy: boolean; detail: T } | { status: "unjudgeable"; reason?: string };

interface TaskRow {
  id: string;
  label: string;
  cadenceMs: number;
  lastCompletedAt: string | null;
  dueBy: string;
  overdue: boolean;
}

interface AlertVerdict {
  checkedAt: string;
  healthy: boolean;
  tasks: Part<TaskRow[]>;
  jobs: Part<{ unclaimedQueues: string[]; held: Array<{ id: number; queue: string; heldForMs: number }> }>;
  payments: Part<{ expected: number; unprocessed: number; oldestUnprocessedAt: string | null }>;
}

interface OperationsPayload {
  checkedAt: string;
  lanes: { status: "ok"; lanes: Lane[] } | { status: "unavailable" };
  /** The verdict the uptime check reads, with its detail. */
  alerts?: { status: "ok"; health: AlertVerdict } | { status: "unavailable" };
  incidents:
    | { status: "ok"; incidents: Incident[] }
    | { status: "unavailable"; reason: "not_configured" | "unreachable" };
  /** Read-only mode as the server that answered is enforcing it. */
  readOnly?: ReadOnlyState;
}

interface ReadOnlyState {
  instanceId: string;
  enforcing: "on" | "off";
  status: "ok" | "stale" | "unavailable";
  confirmedAt: string | null;
  savedAt: string | null;
  refreshSeconds: number;
}

/**
 * The read-only switch (launch Phase 16, increment 4, plan design D). Each
 * server keeps its own copy and picks a change up within its refresh
 * interval, so the panel shows what the server that answered is enforcing.
 */
function ReadOnlyPanel({ state, onChanged }: { state: ReadOnlyState | undefined; onChanged: (s: ReadOnlyState) => void }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!state) {
    return <p className="text-sm text-destructive" data-testid="read-only-unavailable">The read-only switch could not be read.</p>;
  }
  const on = state.enforcing === "on";
  const save = async (next: boolean): Promise<void> => {
    if (next && !window.confirm("Turn read-only mode on? Visitors and members will not be able to change anything until you turn it off.")) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/operations/read-only", {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ on: next }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { readOnly: ReadOnlyState };
      onChanged(body.readOnly);
    } catch (err) {
      setError(`The switch could not be saved (${err instanceof Error ? err.message : String(err)}). Nothing changed.`);
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="space-y-2 text-sm" data-testid="read-only-panel">
      <div className="flex flex-wrap items-center gap-3">
        <span className={on ? "font-semibold text-destructive" : "font-semibold text-green-700"} data-testid="read-only-state">
          {on ? "On: visitors and members cannot change anything" : "Off: the site is open for changes"}
        </span>
        <Button size="sm" variant={on ? "primary" : "danger"} disabled={saving} onClick={() => void save(!on)} data-testid="read-only-toggle">
          {saving ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
          {on ? "Turn read-only mode off" : "Turn read-only mode on"}
        </Button>
      </div>
      {state.status === "stale" && (
        <p className="text-amber-600" data-testid="read-only-stale">
          Stale: this server could not re-read the switch; it is holding the last value it confirmed ({formatTime(state.confirmedAt)}).
        </p>
      )}
      {state.status === "unavailable" && (
        <p className="text-destructive" data-testid="read-only-server-unavailable">
          Unavailable: this server has never been able to read the switch, so it is refusing changes.
        </p>
      )}
      {error && <p className="text-destructive">{error}</p>}
      <p className="text-xs text-muted-foreground">
        While on, browsing, personalising, saving a name and pronouns, signing in, admin work, background jobs and payment
        webhooks carry on. Each server picks up a change within about {state.refreshSeconds} seconds. This reading is from
        server {state.instanceId.slice(0, 8)}, confirmed {formatTime(state.confirmedAt)}
        {state.savedAt ? `; last saved ${formatTime(state.savedAt)}` : ""}.
      </p>
    </div>
  );
}

function minutes(ms: number): string {
  const m = Math.round(ms / 60_000);
  return m < 1 ? "under a minute" : m < 120 ? `${m} min` : `${Math.round(m / 60)} h`;
}

const UNJUDGEABLE = "Could not be judged right now, so the uptime check is failing on it. This is not a healthy reading.";

function PartState({ healthy, testId }: { healthy: boolean | null; testId: string }) {
  if (healthy === null) return <XCircle className="h-4 w-4 text-destructive" data-testid={`${testId}-icon-unjudgeable`} />;
  return healthy ? <CheckCircle2 className="h-4 w-4 text-green-600" data-testid={`${testId}-icon-ok`} /> : <XCircle className="h-4 w-4 text-destructive" data-testid={`${testId}-icon-failing`} />;
}

function AlertParts({ verdict }: { verdict: AlertVerdict }) {
  const { tasks, jobs, payments } = verdict;
  return (
    <div className="space-y-4 text-sm">
      <p data-testid="operations-alert-verdict" className={verdict.healthy ? "text-green-600" : "font-medium text-destructive"}>
        {verdict.healthy
          ? "Healthy: the uptime check reads 200."
          : "Unhealthy: the uptime check reads 503, and after three failed checks your phone rings."}
      </p>

      <div>
        <h3 className="mb-1 flex items-center gap-2 font-semibold">
          <PartState healthy={tasks.status === "ok" ? tasks.healthy : null} testId="operations-tasks" /> Recurring tasks
        </h3>
        {tasks.status !== "ok" ? (
          <p className="text-destructive">{UNJUDGEABLE}</p>
        ) : (
          <ul className="space-y-0.5" data-testid="operations-tasks">
            {tasks.detail.map((t) => (
              <li key={t.id} className={t.overdue ? "text-destructive" : undefined}>
                <span className="font-medium">{t.label}</span>
                <span className="text-muted-foreground">
                  {" "}· every {minutes(t.cadenceMs)} · last completed {formatTime(t.lastCompletedAt)}
                  {t.overdue ? ` · overdue since ${formatTime(t.dueBy)}` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <h3 className="mb-1 flex items-center gap-2 font-semibold">
          <PartState healthy={jobs.status === "ok" ? jobs.healthy : null} testId="operations-jobs" /> Stuck jobs
        </h3>
        {jobs.status !== "ok" ? (
          <p className="text-destructive">{UNJUDGEABLE}</p>
        ) : jobs.healthy ? (
          <p className="text-muted-foreground">None: every due job is being picked up, and no job is held too long.</p>
        ) : (
          <ul className="space-y-0.5 text-destructive" data-testid="operations-jobs">
            {jobs.detail.unclaimedQueues.map((q) => (
              <li key={`u-${q}`}>{q}: due jobs waiting over 30 min with nothing picked up</li>
            ))}
            {jobs.detail.held.map((h) => (
              <li key={`h-${h.id}`}>
                {h.queue} job {h.id}: held for {minutes(h.heldForMs)}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <h3 className="mb-1 flex items-center gap-2 font-semibold">
          <PartState healthy={payments.status === "ok" ? payments.healthy : null} testId="operations-payments" /> Payment webhooks
        </h3>
        {payments.status !== "ok" ? (
          <p className="text-destructive" data-testid="operations-payments-unjudgeable">
            {payments.reason === "incomplete"
              ? "Stripe holds more recent events than one check reads, so the comparison is incomplete. This is not a healthy reading."
              : UNJUDGEABLE}
          </p>
        ) : (
          <p className={payments.healthy ? "text-muted-foreground" : "text-destructive"} data-testid="operations-payments">
            {payments.detail.unprocessed === 0
              ? `Every event Stripe sent over the last week has been processed (${payments.detail.expected} checked).`
              : `${payments.detail.unprocessed} of ${payments.detail.expected} Stripe events from the last week have not been processed; the oldest is from ${formatTime(payments.detail.oldestUnprocessedAt)}.`}
          </p>
        )}
      </div>
    </div>
  );
}

function formatTime(iso: string | null): string {
  if (!iso) return "never";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "unknown" : d.toLocaleString();
}

export default function AdminOperations() {
  const [data, setData] = useState<OperationsPayload | null>(null);
  const [initialError, setInitialError] = useState<string | null>(null);
  const [staleSince, setStaleSince] = useState<string | null>(null);
  const [test, setTest] = useState<
    { status: "idle" | "sending" | "failed" | "not_connected" } | { status: "sent"; rings: boolean }
  >({ status: "idle" });
  const [drill, setDrill] = useState<
    { status: "idle" | "starting" | "failed" } | { status: "started"; alreadyRunning: boolean; holdMinutes: number; alertAfterMinutes: number }
  >({ status: "idle" });
  const hasData = useRef(false);
  const seq = useRef(0);
  const appliedSeq = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    const mine = ++seq.current;
    try {
      const res = await fetch("/api/admin/operations", { credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const payload = (await res.json()) as OperationsPayload;
      if (mine < appliedSeq.current) return;
      appliedSeq.current = mine;
      setData(payload);
      hasData.current = true;
      setInitialError(null);
      setStaleSince(null);
    } catch (err) {
      if (mine < appliedSeq.current) return;
      appliedSeq.current = mine;
      const msg = err instanceof Error ? err.message : String(err);
      if (hasData.current) setStaleSince((prev) => prev ?? new Date().toISOString());
      else setInitialError(msg);
    }
  }, []);

  // No polling while the tab is hidden; a fresh read when it comes back.
  useEffect(() => {
    void load();
    const id = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, POLL_INTERVAL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  const sendTest = async (): Promise<void> => {
    setTest({ status: "sending" });
    try {
      const res = await fetch("/api/admin/operations/test-alert", { method: "POST", credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { sent?: boolean; rings?: boolean };
      setTest(body.sent === true ? { status: "sent", rings: body.rings === true } : { status: "not_connected" });
    } catch {
      setTest({ status: "failed" });
    }
  };

  const startDrill = async (): Promise<void> => {
    setDrill({ status: "starting" });
    try {
      const res = await fetch("/api/admin/operations/drill", { method: "POST", credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { alreadyRunning: boolean; holdMinutes: number; alertAfterMinutes: number };
      setDrill({ status: "started", ...body });
    } catch {
      setDrill({ status: "failed" });
    }
  };

  return (
    <AdminLayout title="Operations">
      <div className="space-y-6">
        <p className="text-sm text-muted-foreground">
          Whether each part of the site that can fail quietly is healthy right now, and the recent incidents that rang
          your phone. Alerts go out from Sentry, so they arrive even when this page cannot load.
        </p>

        {initialError && (
          <div className="flex items-center gap-2 rounded-md border border-destructive p-3 text-sm" data-testid="operations-load-error">
            <XCircle className="h-4 w-4 text-destructive" />
            Could not read the current state ({initialError}). This is not a healthy reading.
            <Button size="sm" variant="outline" onClick={() => void load()}>
              <RefreshCw className="mr-1 h-3 w-3" /> Retry
            </Button>
          </div>
        )}
        {staleSince && (
          <div className="flex items-center gap-2 rounded-md border border-amber-500 p-3 text-sm" data-testid="operations-stale">
            <AlertTriangle className="h-4 w-4 text-amber-500" />
            Showing the last reading; refreshing has failed since {formatTime(staleSince)}.
          </div>
        )}
        {!data && !initialError && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Reading the current state…
          </div>
        )}

        {data && (
          <>
            <section>
              <h2 className="mb-2 text-lg font-semibold">Read-only mode</h2>
              <ReadOnlyPanel state={data.readOnly} onChanged={(readOnly) => setData((d) => (d ? { ...d, readOnly } : d))} />
            </section>

            <section>
              <h2 className="mb-2 text-lg font-semibold">Background work</h2>
              {data.lanes.status === "unavailable" ? (
                <p className="text-sm text-destructive" data-testid="operations-lanes-unavailable">
                  The background-work state could not be read. This is not a healthy reading.
                </p>
              ) : (
                <ul className="space-y-1 text-sm" data-testid="operations-lanes">
                  {data.lanes.lanes.map((l) => (
                    <li key={l.lane} className="flex items-center gap-2">
                      {l.stalled ? <XCircle className="h-4 w-4 text-destructive" /> : <CheckCircle2 className="h-4 w-4 text-green-600" />}
                      <span className="font-medium">{l.lane}</span>
                      <span className="text-muted-foreground">
                        {l.stalled ? "stopped" : "running"} · {l.liveInstanceCount} server(s) · {l.inFlightCount} in progress · last
                        scheduled {formatTime(l.lastScheduledAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-1 text-xs text-muted-foreground">Checked {formatTime(data.checkedAt)}.</p>
            </section>

            <section>
              <h2 className="mb-2 text-lg font-semibold">What the uptime check reads</h2>
              {!data.alerts || data.alerts.status !== "ok" ? (
                <p className="text-sm text-destructive" data-testid="operations-alerts-unavailable">
                  The alert verdict could not be read. This is not a healthy reading.
                </p>
              ) : (
                <AlertParts verdict={data.alerts.health} />
              )}
            </section>

            <section>
              <h2 className="mb-2 text-lg font-semibold">Recent incidents (last 7 days, live site, open and resolved)</h2>
              {data.incidents.status === "unavailable" ? (
                <p className="text-sm text-amber-600" data-testid="operations-incidents-unavailable">
                  {data.incidents.reason === "not_configured"
                    ? "Unavailable: the server has no Sentry token, so it cannot list incidents. Alerts are sent by Sentry, not by this page."
                    : "Unavailable: Sentry could not be reached just now. Alerts are sent by Sentry, not by this page."}
                </p>
              ) : data.incidents.incidents.length === 0 ? (
                <p className="text-sm text-muted-foreground" data-testid="operations-incidents-none">
                  None in the last 7 days.
                </p>
              ) : (
                <ul className="space-y-1 text-sm" data-testid="operations-incidents">
                  {data.incidents.incidents.map((i) => (
                    <li key={i.link || i.title} className="flex flex-wrap items-center gap-2">
                      <span className="rounded bg-muted px-1.5 py-0.5 text-xs">{i.label}</span>
                      <span className={i.ongoing ? "text-xs font-medium text-destructive" : "text-xs text-muted-foreground"}>
                        {i.ongoing ? "ongoing" : "resolved"}
                      </span>
                      <span>{i.title}</span>
                      <span className="text-muted-foreground">
                        · {i.count}× · last {formatTime(i.lastSeen)}
                      </span>
                      {i.link && (
                        <a href={i.link} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary underline">
                          Open in Sentry <ExternalLink className="h-3 w-3" />
                        </a>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}

        <section>
          <h2 className="mb-2 text-lg font-semibold">Test the alert route</h2>
          <p className="mb-2 text-sm text-muted-foreground">
            Sends a real alert through Sentry and Pushover. On the live site your phone should ring within a minute; at
            most one test alert rings every five minutes.
          </p>
          <Button onClick={() => void sendTest()} disabled={test.status === "sending"} data-testid="operations-test-alert">
            {test.status === "sending" ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <BellRing className="mr-1 h-4 w-4" />}
            Send test alert
          </Button>
          {test.status === "sent" && (
            <p className="mt-2 text-sm" data-testid="operations-test-sent">
              Sent to Sentry.
              {test.rings ? " Your phone should ring shortly." : " This is not the live site, so it is recorded in Sentry but does not ring your phone."}
            </p>
          )}
          {test.status === "not_connected" && (
            <p className="mt-2 text-sm text-destructive" data-testid="operations-test-not-connected">
              Not sent: this server is not connected to Sentry, so no alert from it can reach your phone. Its Sentry
              connection setting is missing.
            </p>
          )}
          {test.status === "failed" && (
            <p className="mt-2 text-sm text-destructive">The test alert could not be sent. Try again in a minute.</p>
          )}
        </section>

        <section>
          <h2 className="mb-2 text-lg font-semibold">Drill: a background job that stops</h2>
          <p className="mb-2 text-sm text-muted-foreground">
            Starts a job that holds one background slot for ten minutes and does nothing else: it spends nothing and
            changes nothing. After two minutes the check above reads it as stuck; on the live site your phone rings a few
            minutes later. It ends by itself.
          </p>
          <Button variant="outline" onClick={() => void startDrill()} disabled={drill.status === "starting"} data-testid="operations-drill">
            {drill.status === "starting" ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Timer className="mr-1 h-4 w-4" />}
            Start the drill
          </Button>
          {drill.status === "started" && (
            <p className="mt-2 text-sm" data-testid="operations-drill-started">
              {drill.alreadyRunning
                ? "A drill is already running; no second one was started."
                : `Started. It reads as stuck after ${drill.alertAfterMinutes} minutes and ends after ${drill.holdMinutes}.`}
            </p>
          )}
          {drill.status === "failed" && (
            <p className="mt-2 text-sm text-destructive">The drill could not be started. Try again in a minute.</p>
          )}
        </section>
      </div>
    </AdminLayout>
  );
}

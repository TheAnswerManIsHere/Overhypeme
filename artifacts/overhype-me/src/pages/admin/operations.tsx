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
import { AlertTriangle, BellRing, CheckCircle2, ExternalLink, Loader2, RefreshCw, XCircle } from "lucide-react";

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
  lastSeen: string;
  count: number;
  link: string;
}

interface OperationsPayload {
  checkedAt: string;
  lanes: { status: "ok"; lanes: Lane[] } | { status: "unavailable" };
  incidents:
    | { status: "ok"; incidents: Incident[] }
    | { status: "unavailable"; reason: "not_configured" | "unreachable" };
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
  const [test, setTest] = useState<{ status: "idle" | "sending" | "failed" } | { status: "sent"; rings: boolean }>({ status: "idle" });
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
      const body = (await res.json()) as { rings?: boolean };
      setTest({ status: "sent", rings: body.rings === true });
    } catch {
      setTest({ status: "failed" });
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
              <h2 className="mb-2 text-lg font-semibold">Recent incidents (last 7 days, live site)</h2>
              {data.incidents.status === "unavailable" ? (
                <p className="text-sm text-amber-600" data-testid="operations-incidents-unavailable">
                  {data.incidents.reason === "not_configured"
                    ? "Unavailable: the server has no Sentry token, so it cannot list incidents. Alerts still reach your phone."
                    : "Unavailable: Sentry could not be reached just now. Alerts still reach your phone."}
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
          {test.status === "failed" && (
            <p className="mt-2 text-sm text-destructive">The test alert could not be sent. Try again in a minute.</p>
          )}
        </section>
      </div>
    </AdminLayout>
  );
}

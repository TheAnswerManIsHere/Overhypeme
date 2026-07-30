import { useCallback, useEffect, useRef, useState } from "react";
import { AdminLayout } from "@/components/admin/AdminLayout";
import { Button } from "@/components/ui/Button";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Loader2,
  MinusCircle,
  RefreshCw,
  SkipForward,
  XCircle,
} from "lucide-react";

/** Steady cadence. Never a timeout: a legitimately long job may run for an hour. */
const POLL_INTERVAL_MS = 5_000;

type DisplayStatus = "pending" | "processing" | "done" | "failed" | "skipped" | "abandoned_no_retry";

interface QueueRow {
  queue: string;
  lane: string | null;
  pending: number;
  processing: number;
  done: number;
  failed: number;
  skipped: number;
  abandonedNoRetry: number;
  done24h: number;
  failed24h: number;
  oldestPendingAgeSeconds: number | null;
}

interface LaneRow {
  lane: string;
  intervalMs: number;
  staleThresholdMs: number;
  liveInstanceCount: number;
  lastScheduledAt: string | null;
  lastScheduledAgeSeconds: number | null;
  lastTickCompletedAt: string | null;
  inFlightCount: number;
  stalled: boolean;
}

interface HealthPayload {
  ts: string;
  queues: QueueRow[];
  lanes: LaneRow[];
}

interface JobRow {
  id: number;
  queue: string;
  status: string;
  displayStatus: DisplayStatus;
  skipReason: string | null;
  attempts: number;
  effectiveMaxAttempts: number;
  lastError: string | null;
  nextAttemptAt: string;
  createdAt: string;
  updatedAt: string;
}

function formatAge(seconds: number | null): string {
  if (seconds == null) return "—";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

/**
 * Every state gets a word, not only a colour.
 *
 * "Skipped" and "still running" are first-class terminal states in this
 * codebase's async-status contract, never collapsed into a checkmark or an
 * error — so each renders its own icon *and* its own label.
 */
function DisplayStatusBadge({ status, skipReason }: { status: DisplayStatus; skipReason: string | null }) {
  const map: Record<DisplayStatus, { icon: typeof CheckCircle2; label: string; className: string }> = {
    pending: { icon: Clock, label: "Queued", className: "text-muted-foreground" },
    processing: { icon: Loader2, label: "Working", className: "text-blue-500" },
    done: { icon: CheckCircle2, label: "Done", className: "text-green-600" },
    failed: { icon: XCircle, label: "Failed", className: "text-destructive" },
    skipped: { icon: SkipForward, label: "Skipped", className: "text-amber-600" },
    // Covers two operator stories: a queue that never retries at all, and a
    // handler that gave up deterministically before reaching its own retry
    // ceiling — "never" would misdescribe the second, since some attempts did
    // happen.
    abandoned_no_retry: { icon: MinusCircle, label: "Failed — no more retries", className: "text-destructive" },
  };
  const { icon: Icon, label, className } = map[status];
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-medium ${className}`}>
      <Icon className={`w-3.5 h-3.5 shrink-0 ${status === "processing" ? "animate-spin" : ""}`} />
      {label}
      {skipReason ? <span className="text-muted-foreground">({skipReason})</span> : null}
    </span>
  );
}

export default function AdminQueueHealth() {
  const [data, setData] = useState<HealthPayload | null>(null);
  /** Set only when the FIRST load fails. Distinct from a poll failure. */
  const [initialError, setInitialError] = useState<string | null>(null);
  /** Set when a poll fails after data was already on screen. */
  const [staleSince, setStaleSince] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [jobs, setJobs] = useState<Record<string, JobRow[]>>({});
  /** Per-queue, not a single shared flag — a slow response from a queue the
   * admin has since collapsed must not land as an error under whatever queue
   * happens to be open when it arrives. */
  const [jobsLoading, setJobsLoading] = useState<Record<string, boolean>>({});
  const [jobsErrors, setJobsErrors] = useState<Record<string, string | null>>({});
  const hasData = useRef(false);
  const expandedRef = useRef<string | null>(null);
  useEffect(() => {
    expandedRef.current = expanded;
  }, [expanded]);

  // Sequence numbers track which request STARTED most recently; the applied*
  // refs track which response has actually been shown. A response is
  // discarded only if a MORE RECENT response has already been applied — never
  // merely because a newer request has since started but not yet resolved.
  // Comparing against "started" instead would starve every response once
  // requests routinely run longer than the 5s poll interval: the next tick's
  // request increments the counter before even a successful slow response
  // arrives, so every response — including the only one available — reads as
  // "superseded" and gets discarded forever.
  const loadSeq = useRef(0);
  const loadAppliedSeq = useRef(0);
  const jobsSeq = useRef<Record<string, number>>({});
  const jobsAppliedSeq = useRef<Record<string, number>>({});

  const load = useCallback(async (): Promise<void> => {
    const seq = ++loadSeq.current;
    try {
      const res = await fetch("/api/admin/queue-health", { credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const payload = (await res.json()) as HealthPayload;
      if (seq < loadAppliedSeq.current) return; // a newer response already applied
      loadAppliedSeq.current = seq;
      setData(payload);
      hasData.current = true;
      setInitialError(null);
      setStaleSince(null);
    } catch (err) {
      if (seq < loadAppliedSeq.current) return; // a newer response already applied
      loadAppliedSeq.current = seq;
      const msg = err instanceof Error ? err.message : String(err);
      // The distinction that matters. On a FIRST-load failure we must never fall
      // through to the empty/healthy view — "all queues healthy" and "we could
      // not ask" look identical to an operator, on the one page whose entire job
      // is to reveal that something is wrong. On a LATER failure we keep the
      // last-known data but mark it stale, because stale data is useful and
      // stale data presented as current is not.
      if (hasData.current) {
        setStaleSince((prev) => prev ?? new Date().toISOString());
      } else {
        setInitialError(msg);
      }
    }
  }, []);

  const loadJobs = useCallback(async (queue: string): Promise<void> => {
    const seq = (jobsSeq.current[queue] ?? 0) + 1;
    jobsSeq.current[queue] = seq;
    setJobsLoading((prev) => ({ ...prev, [queue]: true }));
    try {
      const res = await fetch(
        `/api/admin/queue-health/jobs?queue=${encodeURIComponent(queue)}&limit=25`,
        { credentials: "include" },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const payload = (await res.json()) as { rows: JobRow[] };
      if (seq < (jobsAppliedSeq.current[queue] ?? 0)) return; // a newer response already applied
      jobsAppliedSeq.current[queue] = seq;
      setJobs((prev) => ({ ...prev, [queue]: payload.rows }));
      setJobsErrors((prev) => ({ ...prev, [queue]: null }));
      setJobsLoading((prev) => ({ ...prev, [queue]: false }));
    } catch (err) {
      if (seq < (jobsAppliedSeq.current[queue] ?? 0)) return;
      jobsAppliedSeq.current[queue] = seq;
      setJobsErrors((prev) => ({ ...prev, [queue]: err instanceof Error ? err.message : String(err) }));
      setJobsLoading((prev) => ({ ...prev, [queue]: false }));
    }
  }, []);

  useEffect(() => {
    void load();
    // Polling never stops on failure — it keeps retrying, because the backend's
    // retry/maxAttempts is what fails a job, not the UI giving up. It also
    // refreshes whichever queue is currently expanded, via a ref rather than an
    // effect dependency — restarting the 5s timer every time the admin
    // expands/collapses a row would desync the two altitudes' cadences.
    const handle = setInterval(() => {
      void load();
      if (expandedRef.current) void loadJobs(expandedRef.current);
    }, POLL_INTERVAL_MS);
    return () => clearInterval(handle);
  }, [load, loadJobs]);

  const toggle = useCallback((queue: string): void => {
    setExpanded((prev) => {
      const next = prev === queue ? null : queue;
      if (next) void loadJobs(next);
      return next;
    });
  }, [loadJobs]);

  // ── Initial-load failure: an explicit error state with a retry ────────────
  if (initialError !== null) {
    return (
      <AdminLayout title="Queue Health">
        <div className="p-6 rounded-lg bg-destructive/10 border border-destructive/30 flex flex-col gap-3">
          <div className="flex items-center gap-2 text-destructive">
            <AlertTriangle className="w-5 h-5 shrink-0" />
            <span className="font-semibold text-sm">Could not load queue health</span>
          </div>
          <p className="text-xs text-muted-foreground">
            This is <strong>not</strong> the same as the queues being healthy — we were unable to ask.
            ({initialError})
          </p>
          <Button onClick={() => void load()} variant="outline" size="sm" className="self-start">
            <RefreshCw className="w-4 h-4 mr-2" /> Retry
          </Button>
        </div>
      </AdminLayout>
    );
  }

  // ── First load in flight: a skeleton, not a spinner over the whole page ───
  if (data === null) {
    return (
      <AdminLayout title="Queue Health">
        <div className="flex flex-col gap-2" aria-busy="true">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="h-14 rounded-lg bg-muted animate-pulse" />
          ))}
        </div>
      </AdminLayout>
    );
  }

  const stalledLanes = data.lanes.filter((l) => l.stalled);
  const busyQueues = data.queues.filter(
    (q) => q.pending > 0 || q.processing > 0 || q.failed > 0 || q.abandonedNoRetry > 0,
  );

  return (
    <AdminLayout title="Queue Health">
      <div className="flex flex-col gap-4">
        {staleSince !== null && (
          <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/30 text-xs flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0 text-amber-600" />
            <span>
              <strong>Showing data from {new Date(data.ts).toLocaleTimeString()}</strong> — the last refresh
              failed and we are still retrying. These numbers are not current.
            </span>
          </div>
        )}

        {/* Lane liveness. A stale lane is called out IN WORDS, not by colour alone. */}
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold flex items-center gap-2">
            <Activity className="w-4 h-4" /> Worker lanes
          </h2>
          {stalledLanes.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              All five lanes are being scheduled. Last checked {new Date(data.ts).toLocaleTimeString()}.
            </p>
          ) : (
            <div className="p-3 rounded-lg bg-destructive/10 border border-destructive/30 text-xs">
              <strong className="text-destructive">
                {stalledLanes.length} lane{stalledLanes.length === 1 ? "" : "s"} not being scheduled by any live
                worker:
              </strong>{" "}
              {stalledLanes.map((l) => l.lane).join(", ")}. Queued work in {stalledLanes.length === 1 ? "it" : "them"}{" "}
              is not moving.
            </div>
          )}
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {data.lanes.map((l) => (
              <div key={l.lane} className="p-3 rounded-lg border bg-card flex flex-col gap-1">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-xs">{l.lane}</span>
                  {l.stalled ? (
                    <span className="text-xs font-medium text-destructive">Not scheduling</span>
                  ) : (
                    <span className="text-xs font-medium text-green-600">Scheduling</span>
                  )}
                </div>
                <div className="text-xs text-muted-foreground">
                  {l.liveInstanceCount} live instance{l.liveInstanceCount === 1 ? "" : "s"} · last fire{" "}
                  {formatAge(l.lastScheduledAgeSeconds)} ago · {l.inFlightCount} in flight
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Aggregate altitude, one row per queue, with per-item detail on expand. */}
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold">Queues</h2>
          {busyQueues.length === 0 && (
            <p className="text-xs text-muted-foreground">
              No queue has pending, working or failed items. Last checked{" "}
              {new Date(data.ts).toLocaleTimeString()}.
            </p>
          )}
          <div className="flex flex-col gap-1">
            {data.queues.map((q) => {
              const isOpen = expanded === q.queue;
              return (
                <div key={q.queue} className="rounded-lg border bg-card">
                  <button
                    type="button"
                    onClick={() => toggle(q.queue)}
                    className="w-full px-3 py-2 flex items-center gap-2 text-left hover:bg-muted/50 rounded-lg"
                    aria-expanded={isOpen}
                  >
                    {isOpen ? (
                      <ChevronDown className="w-4 h-4 shrink-0" />
                    ) : (
                      <ChevronRight className="w-4 h-4 shrink-0" />
                    )}
                    <span className="font-mono text-xs shrink-0">{q.queue}</span>
                    <span className="text-xs text-muted-foreground truncate">
                      {q.pending} queued · {q.processing} working · {q.done} done · {q.failed} failed
                      {q.skipped > 0 ? ` · ${q.skipped} skipped` : ""}
                      {q.abandonedNoRetry > 0 ? ` · ${q.abandonedNoRetry} never retried` : ""}
                      {q.oldestPendingAgeSeconds != null
                        ? ` · oldest ${formatAge(q.oldestPendingAgeSeconds)}`
                        : ""}
                      {" · 24h: "}
                      {q.done24h} done / {q.failed24h} failed
                    </span>
                  </button>
                  {isOpen && (
                    <div className="px-3 pb-3 border-t pt-2 flex flex-col gap-1">
                      {jobsLoading[q.queue] && !(q.queue in jobs) && (
                        <p className="text-xs text-muted-foreground">Loading…</p>
                      )}
                      {jobsErrors[q.queue] != null && (
                        <p className="text-xs text-destructive">Could not load items: {jobsErrors[q.queue]}</p>
                      )}
                      {/* Empty only once THIS queue has actually completed a load — `q.queue in
                          jobs` is the "loaded at least once" signal, distinct from an in-flight
                          request that hasn't resolved yet. */}
                      {q.queue in jobs && !jobsLoading[q.queue] && jobsErrors[q.queue] == null
                        && (jobs[q.queue] ?? []).length === 0 && (
                        <p className="text-xs text-muted-foreground">No items in this queue.</p>
                      )}
                      {(jobs[q.queue] ?? []).map((j) => (
                        <div key={j.id} className="flex items-start gap-3 py-1 text-xs">
                          <span className="font-mono text-muted-foreground shrink-0">#{j.id}</span>
                          <DisplayStatusBadge status={j.displayStatus} skipReason={j.skipReason} />
                          <span className="text-muted-foreground shrink-0">
                            {j.attempts}/{j.effectiveMaxAttempts}
                          </span>
                          {j.lastError ? (
                            <span className="text-destructive/80 truncate">{j.lastError}</span>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      </div>
    </AdminLayout>
  );
}

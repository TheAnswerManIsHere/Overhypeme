/**
 * @purpose The admin Billing page's "Missed Stripe events" panel (Issue #1244): lists the events the payment alert counts as unprocessed, and replays one, behind a confirm, with the same effect as its original delivery.
 * @subsystem payments
 *
 * The list is the alert's own comparison, read uncached by the server, so it
 * shows exactly what the alert counts. A comparison that could not run is shown
 * as such, never as an empty list. Replay is a synchronous request; its row
 * shows it running and then its result, and the list re-reads.
 */
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle, History, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/Button";

export interface MissedStripeEvent {
  id: string;
  type: string;
  created: string;
}

type ListResponse =
  | { status: "ok"; unprocessed: number; events: MissedStripeEvent[] }
  | { status: "unjudgeable"; reason: string };

type ReplayResponse = { outcome: "processed" | "already_processed" | "refused" | "failed"; reason?: string };

const UNJUDGEABLE: Record<string, string> = {
  stripe_unavailable: "Stripe could not be reached, so the missed events cannot be listed right now.",
  incomplete: "Stripe returned more events than one check reads, so the list would be incomplete.",
  read_failed: "The record of processed events could not be read.",
};

const REFUSAL: Record<string, string> = {
  malformed_id: "That is not a Stripe event id.",
  audit_unavailable: "The replay could not be recorded in the admin log, so nothing was done.",
  not_found: "Stripe has no such event for this account and mode (events are kept 30 days).",
  wrong_mode: "That event belongs to the other Stripe mode.",
  mode_changed: "The Stripe mode changed while replaying; nothing was done. Try again.",
  unsupported_type: "The site does not process this kind of event.",
};

function age(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

function resultText(r: ReplayResponse): { text: string; ok: boolean } {
  if (r.outcome === "processed") return { text: "Replayed: processed as its delivery would have been.", ok: true };
  if (r.outcome === "already_processed") return { text: "Already processed — nothing was changed.", ok: true };
  if (r.outcome === "refused") return { text: REFUSAL[r.reason ?? ""] ?? `Refused: ${r.reason}`, ok: false };
  return { text: `Processing failed; the event can be replayed again. ${r.reason ?? ""}`.trim(), ok: false };
}

export function MissedStripeEventsPanel() {
  const [list, setList] = useState<ListResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [result, setResult] = useState<{ id: string; text: string; ok: boolean } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch("/api/admin/stripe/missed-events", { credentials: "include", cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setList((await res.json()) as ListResponse);
    } catch (err) {
      setLoadError(`The missed Stripe events could not be loaded (${err instanceof Error ? err.message : String(err)}).`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function replay(id: string) {
    setConfirming(null);
    setRunning(id);
    setResult(null);
    try {
      const res = await fetch(`/api/admin/stripe/missed-events/${encodeURIComponent(id)}/replay`, { method: "POST", credentials: "include" });
      const body = (await res.json().catch(() => ({ outcome: "failed", reason: `HTTP ${res.status}` }))) as ReplayResponse;
      setResult({ id, ...resultText(body) });
      await load();
    } finally {
      setRunning(null);
    }
  }

  const events = list?.status === "ok" ? list.events : [];
  const shownResultOffList = result && !events.some((e) => e.id === result.id);

  return (
    <div className="bg-card border border-border rounded-lg overflow-hidden">
      <div className="px-5 py-4 border-b border-border flex items-center gap-3 flex-wrap">
        <History className="w-4 h-4 text-primary shrink-0" />
        <h2 className="font-display font-bold uppercase tracking-wide text-sm text-foreground">Missed Stripe events</h2>
        <span className="text-xs text-muted-foreground">
          {list?.status === "ok" ? (events.length === 0 ? "— none" : `— ${events.length} unprocessed`) : ""}
        </span>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh
        </button>
      </div>

      <p className="px-5 pt-3 text-xs text-muted-foreground">
        Events Stripe sent in the last seven days that the site never processed — what the payment alert counts.
        Replay reads the event from Stripe and processes it exactly as its delivery would have.
      </p>

      {loadError && <p className="px-5 py-3 text-sm text-destructive" role="alert">{loadError}</p>}
      {list === null && !loadError && (
        <div className="px-5 py-6 flex justify-center"><Loader2 className="w-4 h-4 animate-spin text-muted-foreground" aria-label="Loading missed Stripe events" /></div>
      )}
      {list?.status === "unjudgeable" && (
        <p className="px-5 py-3 text-sm text-amber-500 flex items-center gap-2" role="status">
          <AlertTriangle className="w-4 h-4 shrink-0" /> {UNJUDGEABLE[list.reason] ?? `The check could not run (${list.reason}).`}
        </p>
      )}
      {list?.status === "ok" && events.length === 0 && (
        <p className="px-5 py-3 text-sm text-muted-foreground flex items-center gap-2">
          <CheckCircle className="w-4 h-4 text-emerald-500 shrink-0" /> Every event Stripe sent has been processed.
        </p>
      )}

      {events.length > 0 && (
        <div className="divide-y divide-border mt-2">
          {events.map((e) => (
            <div key={e.id} className="px-5 py-3 space-y-2">
              <div className="flex items-center gap-4 flex-wrap">
                <div className="flex-1 min-w-[14rem]">
                  <p className="text-sm font-medium text-foreground font-mono">{e.type}</p>
                  <p className="text-xs text-muted-foreground font-mono truncate">{e.id}</p>
                  <p className="text-xs text-muted-foreground">{new Date(e.created).toLocaleString()} · {age(e.created)}</p>
                </div>
                {confirming !== e.id && (
                  <Button variant="outline" size="sm" onClick={() => setConfirming(e.id)} disabled={running !== null}>
                    {running === e.id ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Replaying…</> : "Replay"}
                  </Button>
                )}
              </div>
              {confirming === e.id && (
                <div className="flex items-center gap-2 flex-wrap border border-amber-500/40 rounded-sm px-3 py-2">
                  <p className="text-xs text-foreground flex-1 min-w-[12rem]">
                    Replay this <span className="font-mono">{e.type}</span> event, {age(e.created)}? It has the same effect as its
                    original delivery — memberships, records, and any email to the member (in live mode), sent now.
                  </p>
                  <Button variant="primary" size="sm" onClick={() => void replay(e.id)}>Replay event</Button>
                  <Button variant="outline" size="sm" onClick={() => setConfirming(null)}>Cancel</Button>
                </div>
              )}
              {result?.id === e.id && <ResultLine result={result} />}
            </div>
          ))}
        </div>
      )}
      {shownResultOffList && <ResultLine result={result} className="px-5 py-3" />}
    </div>
  );
}

function ResultLine({ result, className = "" }: { result: { id: string; text: string; ok: boolean }; className?: string }) {
  return (
    <p className={`text-xs ${result.ok ? "text-emerald-500" : "text-destructive"} ${className}`} role="status">
      <span className="font-mono">{result.id}</span>: {result.text}
    </p>
  );
}

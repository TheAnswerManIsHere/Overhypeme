/**
 * @purpose A gag's render history on the Renders view: every render ever drawn for it, newest first and 50 at a time, each a one-line summary that opens to the full record of how it was made, with deleting an old render after a confirmation; and the fact's removed gags, each keeping its own history.
 * @subsystem visual-pipeline
 *
 * Plan docs/plans/PLAN_RENDER_HISTORY.md D3, D4, D5 and D6 (Issue #1304). The
 * server reads every field from what the render stored and makes no fal call
 * (lib/gags/renderHistory.ts); this file only says it in words. Approving
 * stays on the working render, never in history.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, Loader2, Trash2 } from "lucide-react";
import {
  KIND_LABEL,
  type RemovedGagHistory,
  type RenderApproval,
  type RenderCost,
  type RenderHistoryEntry,
  type RenderRole,
} from "@workspace/api-zod";
import { renderHistoryApi } from "./gagApi";

/** A render still queued or drawing: it shows a spinner, offers no draw, and can't be deleted. */
export const IN_FLIGHT = new Set(["queued", "rendering"]);

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A render's billed cost in words (D5): the known amount is never shown as the whole when part is outstanding. */
export function costWords(cost: RenderCost): string {
  switch (cost.state) {
    case "billed": {
      const parts = [`$${cost.usd.toFixed(4)}`];
      if (cost.unbilledRequests > 0) parts.push(`${plural(cost.unbilledRequests, "request")} not billed yet`);
      if (cost.unknownRequests > 0) parts.push(`${plural(cost.unknownRequests, "request")} whose charge is not on record`);
      return parts.length === 1 ? parts[0]! : `${parts[0]} so far; ${parts.slice(1).join("; ")}`;
    }
    case "not_checked": return "Cost not checked yet";
    case "no_bill_found": return "No bill found at fal yet";
    case "billing_key_not_set": return "Cost unknown: the billing key is not set";
    case "not_recorded": return "Cost not recorded";
    case "never_sent": return "Never reached fal; nothing charged";
  }
}

/** Whether a render was ever approved (D4; David, Q51). */
export function approvalWords(a: RenderApproval): string {
  return a === "approved" ? "Approved" : a === "not_approved" ? "Not approved" : "Approval history not recorded";
}

/** A role's name (D1). An unpublished fact has nothing live, so its pick is "Approved for publishing". */
export function roleWords(role: RenderRole, factLive: boolean): string {
  if (role === "live") return "Live example";
  if (role === "approved_next") return factLive ? "Approved for next publish" : "Approved for publishing";
  return "Working render";
}

function statusWords(e: RenderHistoryEntry): string {
  switch (e.status) {
    case "done": return e.imageUrl ? "Drawn" : "Drawn; the picture is not available";
    case "failed": return `Failed: ${e.error ?? "the render did not finish"}`;
    case "blocked": return `Blocked: ${e.error ?? "the render was refused"}`;
    case "queued": return "Queued";
    case "rendering": return "Drawing";
    default: return e.status;
  }
}

const pictureOf = (e: RenderHistoryEntry) => (e.kind ? KIND_LABEL[e.kind] : "Custom");
const when = (iso: string) => new Date(iso).toLocaleString();
/** Official renders and running ones can't be deleted; the server checks again and says why. */
const deletable = (e: RenderHistoryEntry) => !e.roles.includes("live") && !e.roles.includes("approved_next") && !IN_FLIGHT.has(e.status);

export interface GagHistoryProps {
  factId: number;
  gagId: number;
  reviewId: number | null;
  readOnly: boolean;
  /** Whether the fact is live: names the draft pick's role. */
  factLive: boolean;
  /** Changes when the gag's renders change (a draw, an approval): an open history reloads. */
  refreshKey?: string;
  /** Called after a render is deleted, so the panel reloads its view. */
  onDeleted?: () => void;
  /** The heading; "History" for a gag on the page, the gag's id for a removed one. */
  title?: string;
  testId?: string;
}

/** A gag's history, collapsed until opened (D3). */
export function GagHistory({ factId, gagId, reviewId, readOnly, factLive, refreshKey = "", onDeleted, title = "History", testId = "gag-history" }: GagHistoryProps) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<RenderHistoryEntry[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // A reload's answer wins over an older page still on its way.
  const generation = useRef(0);

  /** Read a page: the newest (replacing the list) or the next older one (appended). */
  const fetchPage = useCallback(async (before: string | null) => {
    const g = before == null ? ++generation.current : generation.current;
    setLoading(true); setError(null);
    const r = await renderHistoryApi.page(factId, gagId, before);
    if (g !== generation.current) return;
    setLoading(false);
    if (!r.ok) { setError(r.error); return; }
    setEntries((prev) => before == null ? r.data.entries : [...prev, ...r.data.entries.filter((e) => !prev.some((p) => p.attemptId === e.attemptId))]);
    setNextBefore(r.data.nextBefore);
  }, [factId, gagId]);
  const reload = useCallback(() => fetchPage(null), [fetchPage]);

  useEffect(() => { if (open) void reload(); }, [open, refreshKey, reload]);

  const remove = async (e: RenderHistoryEntry) => {
    if (!window.confirm(`Delete the ${pictureOf(e).toLowerCase()} render drawn ${when(e.createdAt)} for good? Its picture file is deleted too. This can't be undone.`)) return;
    setNotice(null); setError(null);
    const r = await renderHistoryApi.remove(factId, gagId, e.attemptId, reviewId);
    if (!r.ok) { setError(r.error); return; }
    setNotice(r.data.fileStillBeingRemoved ? "Deleted; its picture file is still being removed." : "Deleted.");
    onDeleted?.();
    await reload();
  };

  return (
    <div className="border-t border-border pt-2" data-testid={testId} data-gag-id={gagId}>
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} data-testid="gag-history-toggle"
        className="inline-flex items-center gap-1 text-xs font-semibold text-foreground hover:text-primary">
        {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />} {title}
      </button>
      {open && (
        <div className="mt-2 space-y-1.5">
          {notice && <p className="text-[11px] text-green-700 dark:text-green-400" data-testid="gag-history-notice">{notice}</p>}
          {error && (
            <p className="text-[11px] text-destructive flex items-start gap-1.5" data-testid="gag-history-error">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" /><span className="min-w-0">{error}</span>
            </p>
          )}
          {!loading && !error && entries.length === 0 && (
            <p className="text-[11px] text-muted-foreground" data-testid="gag-history-empty">No renders drawn yet.</p>
          )}
          <ul className="space-y-1">
            {entries.map((e) => (
              <HistoryEntry key={e.attemptId} entry={e} factLive={factLive} canDelete={!readOnly && deletable(e)} onDelete={() => void remove(e)} />
            ))}
          </ul>
          {loading && <p className="text-[11px] text-muted-foreground flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> Loading history…</p>}
          {!loading && nextBefore && (
            <button type="button" onClick={() => void fetchPage(nextBefore)} data-testid="gag-history-older"
              className="px-2 py-0.5 text-[11px] border border-border rounded-sm hover:bg-muted text-foreground">Load older</button>
          )}
        </div>
      )}
    </div>
  );
}

/** One render: a line (picture, when, by whom, status, cost, roles) that opens to its full record (D4). */
function HistoryEntry({ entry: e, factLive, canDelete, onDelete }: { entry: RenderHistoryEntry; factLive: boolean; canDelete: boolean; onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="rounded-sm border border-border bg-background" data-testid="gag-history-entry" data-attempt-id={e.attemptId}>
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} data-testid="gag-history-entry-toggle"
        className="w-full text-left px-2 py-1 text-[11px] flex items-center gap-1.5 flex-wrap hover:bg-muted/50">
        {open ? <ChevronDown className="w-3 h-3 shrink-0" /> : <ChevronRight className="w-3 h-3 shrink-0" />}
        <span className="font-semibold text-foreground">{pictureOf(e)}</span>
        <span className="text-muted-foreground">{when(e.createdAt)}</span>
        <span className="text-muted-foreground">· {e.drawnBy.name ?? "No admin on record"}</span>
        <span className={e.status === "failed" || e.status === "blocked" ? "text-destructive" : "text-foreground"} data-testid="gag-history-status">· {statusWords(e)}</span>
        <span className="text-muted-foreground" data-testid="gag-history-cost">· {costWords(e.cost)}</span>
        {e.roles.map((r) => (
          <span key={r} data-testid="gag-history-role" data-role={r}
            className={`text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-sm ${r === "working" ? "bg-muted text-foreground" : "bg-green-600/15 text-green-700 dark:text-green-400"}`}>
            {roleWords(r, factLive)}
          </span>
        ))}
      </button>
      {open && <EntryRecord entry={e} canDelete={canDelete} onDelete={onDelete} />}
    </li>
  );
}

function Json({ value }: { value: unknown }) {
  return <pre className="text-[10px] bg-muted rounded-sm p-1.5 overflow-x-auto whitespace-pre-wrap break-all max-h-64">{JSON.stringify(value, null, 2)}</pre>;
}

function EntryRecord({ entry: e, canDelete, onDelete }: { entry: RenderHistoryEntry; canDelete: boolean; onDelete: () => void }) {
  const fb = e.engine.fallback;
  return (
    <div className="px-2 pb-2 pt-1 space-y-2 text-[11px]" data-testid="gag-history-record">
      {e.imageUrl && (
        <a href={e.imageUrl} target="_blank" rel="noopener noreferrer" title="Open full size">
          <img src={e.imageUrl} alt={`${pictureOf(e)} render, ${when(e.createdAt)}`} className="w-40 rounded-sm border border-border" />
        </a>
      )}
      <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1">
        <dt className="text-muted-foreground">Drawn</dt>
        <dd className="text-foreground">{when(e.createdAt)} by {e.drawnBy.name ?? "no admin on record"} · render #{e.attemptId}</dd>
        <dt className="text-muted-foreground">Outcome</dt>
        <dd className="text-foreground">{statusWords(e)}</dd>
        <dt className="text-muted-foreground">Approval</dt>
        <dd className="text-foreground" data-testid="gag-history-approval">{approvalWords(e.approval)}</dd>
        <dt className="text-muted-foreground">Cost</dt>
        <dd className="text-foreground">{costWords(e.cost)}</dd>
        <dt className="text-muted-foreground">Picture</dt>
        <dd className="text-foreground">
          {pictureOf(e)}; reference photo {e.reference.identityType ?? "none on record"}{e.reference.assetVersion ? `, version ${e.reference.assetVersion}` : ""}
        </dd>
        <dt className="text-muted-foreground">Engine</dt>
        <dd className="text-foreground" data-testid="gag-history-engine">
          {e.engine.engineId ?? "not on record"}
          {fb && ` (${fb.refusedEngineId} refused it: ${fb.reason}; ${fb.drawnByEngineId} drew it)`}
        </dd>
      </dl>
      <div className="space-y-1">
        <p className="font-semibold text-foreground">The gag as drawn</p>
        {e.gag ? (
          <div className="space-y-0.5" data-testid="gag-history-gag">
            <p className="text-foreground">{e.gag.coreSceneOverride || "No scene on record."}</p>
            {e.gag.bubbles.filter((b) => b.text.trim()).map((b, i) => (
              <p key={i} className="text-muted-foreground">Bubble {i + 1} ({b.entity || "no speaker"}): “{b.text}”</p>
            ))}
          </div>
        ) : <p className="text-muted-foreground">Not on record.</p>}
      </div>
      <details>
        <summary className="cursor-pointer font-semibold text-foreground">The prompt</summary>
        <Json value={e.prompt.compiled} />
      </details>
      <details data-testid="gag-history-requests">
        <summary className="cursor-pointer font-semibold text-foreground">{plural(e.prompt.requests.length, "request")} sent to the engine, exactly as sent</summary>
        {e.prompt.requests.map((q) => (
          <div key={q.id} className="space-y-0.5 mt-1">
            <p className="text-muted-foreground">
              {when(q.createdAt)} · {q.engineId ?? q.endpointId} · {q.billedUsd != null ? `billed $${q.billedUsd.toFixed(4)}` : "no bill on record"}
            </p>
            <Json value={q.request} />
          </div>
        ))}
      </details>
      {canDelete && (
        <button type="button" onClick={onDelete} data-testid="gag-history-delete"
          className="inline-flex items-center gap-1 px-2 py-0.5 border border-destructive/50 text-destructive rounded-sm hover:bg-destructive/10">
          <Trash2 className="w-3 h-3" /> Delete this render
        </button>
      )}
    </div>
  );
}

/** The fact's removed gags that still have renders (D3), each with its own history, grouped by the gag's id, never its slot. */
/** A removed gag's renders change only by a delete here, so its list and histories are read on opening and after a delete, never on the live gags' draws. */
export function RemovedGagsHistory({ factId, reviewId, readOnly, factLive }: Pick<GagHistoryProps, "factId" | "reviewId" | "readOnly" | "factLive">) {
  const [open, setOpen] = useState(false);
  const [gags, setGags] = useState<RemovedGagHistory[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    const r = await renderHistoryApi.removedGags(factId);
    if (r.ok) { setGags(r.data); setError(null); } else setError(r.error);
  }, [factId]);
  useEffect(() => { void load(); }, [load]);
  if (!error && (gags == null || gags.length === 0)) return null;
  return (
    <div className="rounded-sm border border-dashed border-border bg-card p-3" data-testid="removed-gags-history">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} data-testid="removed-gags-toggle"
        className="inline-flex items-center gap-1 text-xs font-semibold text-foreground hover:text-primary">
        {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />} Removed gags{gags ? ` (${gags.length})` : ""}
      </button>
      {error && <p className="text-[11px] text-destructive mt-1">{error}</p>}
      {open && gags && (
        <div className="mt-2 space-y-2">
          {gags.map((g) => (
            <GagHistory key={g.gagId} factId={factId} gagId={g.gagId} reviewId={reviewId} readOnly={readOnly} factLive={factLive}
              onDeleted={() => void load()} testId="removed-gag-history"
              title={`Removed gag #${g.gagId}: ${plural(g.renders, "render")}, the last ${when(g.lastRenderAt)}`} />
          ))}
        </div>
      )}
    </div>
  );
}

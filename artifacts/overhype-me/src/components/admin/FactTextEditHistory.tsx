import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, History, Loader2, AlertCircle } from "lucide-react";

interface TextEditEntry {
  id: number;
  oldText: string;
  newText: string;
  reason: string;
  createdAt: string;
  actor: { id: string; name: string | null; email: string | null } | null;
}

/**
 * Read-only "Approved text edit history" for a fact — the audit trail of the
 * rare, dire-warning-gated text edits. Collapsible; lazy-loads on first open.
 * Never editable/deletable from here.
 */
export function FactTextEditHistory({ factId }: { factId: number }) {
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [entries, setEntries] = useState<TextEditEntry[] | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/facts/${factId}/text-edit-history`, { credentials: "include" });
      const data = (await res.json().catch(() => ({}))) as { entries?: TextEditEntry[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? `Failed to load history (${res.status})`);
      setEntries(data.entries ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load history");
    } finally {
      setLoading(false);
    }
  }, [factId]);

  // Lazy-load the first time the section is opened.
  useEffect(() => {
    if (expanded && entries === null && !loading && !error) void load();
  }, [expanded, entries, loading, error, load]);

  return (
    <div className="rounded-sm border border-border bg-muted/20">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between gap-2 p-3 text-left"
        data-testid="fact-text-edit-history-toggle"
      >
        <span className="text-xs font-bold text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
          <History className="w-3.5 h-3.5" /> Approved text edit history
        </span>
        {expanded ? <ChevronDown className="w-4 h-4 text-muted-foreground" /> : <ChevronRight className="w-4 h-4 text-muted-foreground" />}
      </button>

      {expanded && (
        <div className="px-3 pb-3">
          {loading && (
            <p className="text-xs text-muted-foreground flex items-center gap-1.5"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…</p>
          )}
          {error && (
            <p className="text-xs text-destructive flex items-start gap-1.5"><AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" /> {error}</p>
          )}
          {!loading && !error && entries?.length === 0 && (
            <p className="text-xs text-muted-foreground italic">No approved-text edits recorded for this fact.</p>
          )}
          {!loading && !error && entries && entries.length > 0 && (
            <ul className="space-y-3">
              {entries.map((e) => (
                <li key={e.id} className="text-xs border-l-2 border-destructive/30 pl-3">
                  <div className="flex flex-wrap items-center gap-x-2 text-muted-foreground">
                    <span className="font-medium text-foreground">{e.actor ? e.actor.name ?? e.actor.email ?? e.actor.id : "deleted admin"}</span>
                    <span>·</span>
                    <span>{new Date(e.createdAt).toLocaleString()}</span>
                  </div>
                  <p className="mt-1 whitespace-pre-wrap"><span className="text-muted-foreground line-through decoration-destructive/40">{e.oldText}</span></p>
                  <p className="whitespace-pre-wrap text-foreground">→ {e.newText}</p>
                  <p className="mt-1 text-muted-foreground italic">Reason: {e.reason}</p>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

import { useState } from "react";
import { Rocket, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/Button";

/**
 * Confirm modal for "Mark major update" — bumps the manual engine-revision
 * marker by one. This is a CORPUS-WIDE staleness invalidation: every fact whose
 * stored ProcessingSignature carries the old revision immediately reads
 * "stale for reprocess" in Taxonomy Health. Use it after a real engine/LLM
 * swap, not for routine tweaks.
 *
 * Self-contained: owns the POST + its own submitting/error state. On success it
 * hands the new/previous revision back to the page so the header + summary can
 * refresh.
 */
export function MarkMajorUpdateModal({
  currentRevision,
  onCancel,
  onDone,
}: {
  currentRevision: number | null;
  onCancel: () => void;
  onDone: (result: { engineRevision: number; previousRevision: number }) => void;
}) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/taxonomy-health/actions/mark-major-update", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: note.trim() ? note.trim() : undefined }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        success?: boolean; engineRevision?: number; previousRevision?: number; error?: string;
      };
      if (res.ok && data.success && data.engineRevision != null && data.previousRevision != null) {
        onDone({ engineRevision: data.engineRevision, previousRevision: data.previousRevision });
      } else {
        setError(data.error ?? `Mark major update failed (${res.status})`);
      }
    } catch {
      setError("Network error — could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  const nextRevision = currentRevision != null ? currentRevision + 1 : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" data-testid="mark-major-update-modal">
      <div className="bg-card border border-border rounded-lg w-full max-w-md p-6 flex flex-col gap-5 shadow-xl">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-amber-500/10 flex items-center justify-center shrink-0">
            <Rocket className="w-5 h-5 text-amber-500" />
          </div>
          <div>
            <h2 className="font-display font-bold text-foreground uppercase tracking-wide">Mark Major Update</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Engine revision {currentRevision ?? "—"}
              {nextRevision != null && <> → <span className="font-mono text-foreground">{nextRevision}</span></>}
            </p>
          </div>
        </div>

        <div className="rounded-sm border border-amber-500/40 bg-amber-500/10 p-3 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
          <p className="text-xs text-foreground">
            This bumps the engine revision for the <strong>entire corpus</strong>. Every fact processed under the old
            revision will read <strong>stale for reprocess</strong> until it's sent back through the refresh pipeline.
            Use this after a real engine/model swap — not routine tweaks. It can't be un-bumped (you'd bump again).
          </p>
        </div>

        <label className="text-sm text-foreground flex flex-col gap-1">
          <span>
            Note <span className="text-xs text-muted-foreground">(optional — what changed, for the audit log)</span>
          </span>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={2000}
            rows={3}
            placeholder="e.g. switched the enricher to the gpt-5.5 pipeline"
            className="w-full px-2 py-1.5 text-sm bg-background border border-border rounded-sm resize-y"
            data-testid="mark-major-update-note"
          />
        </label>

        {error && (
          <p className="text-xs text-destructive" data-testid="mark-major-update-error">{error}</p>
        )}

        <div className="flex gap-3">
          <Button onClick={() => void submit()} isLoading={busy} className="flex-1 gap-2" data-testid="mark-major-update-confirm">
            <Rocket className="w-4 h-4" /> Bump engine revision
          </Button>
          <Button variant="outline" onClick={onCancel} className="flex-1" disabled={busy}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}

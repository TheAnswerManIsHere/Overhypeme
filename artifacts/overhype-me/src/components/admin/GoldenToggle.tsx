/**
 * GoldenToggle (Slice 2B) — mark/unmark a fact as part of the eval golden set.
 * Optimistic; reflects saved state. Only ACTIVE facts can be ADDED (the server
 * enforces this too); a fact that went inactive can still be removed.
 */
import { useState } from "react";
import { FlaskConical, Loader2 } from "lucide-react";

export function GoldenToggle({
  factId,
  isActive,
  initialGolden,
  onChange,
}: {
  factId: number;
  isActive: boolean;
  initialGolden: boolean;
  /** Notify the parent of the new saved state (e.g. to update the list row). */
  onChange?: (golden: boolean) => void;
}) {
  const [golden, setGolden] = useState(initialGolden);
  const [busy, setBusy] = useState(false);
  const canAdd = isActive || golden; // adding needs active; removing always allowed

  async function toggle() {
    if (busy) return;
    const next = !golden;
    if (next && !isActive) return; // guarded by disabled, defensive
    setBusy(true);
    setGolden(next); // optimistic
    const r = await fetch(`/api/admin/facts/${factId}/eval-golden`, {
      method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ golden: next }),
    }).catch(() => null);
    setBusy(false);
    if (!r || !r.ok) { setGolden(!next); return; } // revert on failure
    onChange?.(next);
  }

  return (
    <button
      type="button"
      data-testid="golden-toggle"
      aria-pressed={golden}
      disabled={busy || !canAdd}
      onClick={() => void toggle()}
      title={!canAdd ? "Only active facts can be added to the golden set" : golden ? "In the eval golden set — click to remove" : "Add to the eval golden set"}
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-bold rounded-sm border ${
        golden
          ? "bg-primary/15 text-primary border-primary/40"
          : "bg-background text-muted-foreground border-border hover:bg-muted"
      } disabled:opacity-50`}
    >
      {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FlaskConical className="w-3.5 h-3.5" />}
      {golden ? "Golden" : "Mark golden"}
    </button>
  );
}

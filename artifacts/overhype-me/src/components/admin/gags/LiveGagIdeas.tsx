/**
 * Draft more gags on a live fact (plan docs/plans/PLAN_THREE_GAGS.md,
 * increment 2): the gag writer run from the Facts editor, outside any review.
 * Its ideas offer the same actions as the review's Gags step, and using one
 * saves it as a gag's change, hidden from users until a test render of it is
 * approved as the gag's example. Not shown while a review is open: that
 * review's own ideas are drafted there, and the server refuses a live draft.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { FactGagsView, VisualConceptsResponse } from "@workspace/api-zod";
import { VisualConceptCandidates } from "../VisualConceptCandidates";
import { useGagIdeaActions } from "./useGagIdeaActions";

const POLL_MS = 2000;

async function readIdeas(factId: number, method: "GET" | "POST"): Promise<{ ok: true; ideas: VisualConceptsResponse } | { ok: false; error: string }> {
  try {
    const r = await fetch(`/api/admin/facts/${factId}/gags/ideas`, { method, credentials: "include" });
    const data = (await r.json().catch(() => null)) as (VisualConceptsResponse & { error?: string }) | null;
    if (!r.ok || !data) return { ok: false, error: data?.error ?? `Request failed (${r.status}).` };
    return { ok: true, ideas: data };
  } catch {
    return { ok: false, error: "Network error: could not reach the server." };
  }
}

export function LiveGagIdeas({
  factId,
  gagsView,
  onApplied,
  unsavedGagEdits,
  onSavingChange,
  disabled = false,
}: {
  factId: number;
  /** The gags as the Gags panel last loaded them. */
  gagsView: FactGagsView | null;
  /** An idea was used on a gag: reload the panel with the server's view. */
  onApplied: (view: FactGagsView) => void;
  /** A gag card holds unsaved edits: using an idea would replace them, so it waits. */
  unsavedGagEdits: boolean;
  /** An idea is being saved onto a gag: the panel's drafts would be replaced, so editing waits. */
  onSavingChange?: (saving: boolean) => void;
  disabled?: boolean;
}) {
  const [ideas, setIdeas] = useState<VisualConceptsResponse | undefined>(undefined);
  const [error, setError] = useState("");
  const live = gagsView != null && gagsView.isActive && gagsView.review == null;
  const { actions, saving } = useGagIdeaActions({ factId, reviewId: null, gagsView, onApplied, onError: setError });
  useEffect(() => { onSavingChange?.(saving); }, [saving, onSavingChange]);

  // Only the latest request's answer is kept: a read that started before
  // Draft was pressed must not overwrite the "working" the press returned.
  const latest = useRef(0);
  const request = useCallback(async (method: "GET" | "POST") => {
    const n = ++latest.current;
    const r = await readIdeas(factId, method);
    if (n !== latest.current) return;
    if (r.ok) setIdeas(r.ideas);
    else setError(r.error);
  }, [factId]);
  const load = useCallback(() => request("GET"), [request]);

  useEffect(() => { if (live) void load(); }, [live, load]);

  // A drafting run works in the background: poll until it lands or fails.
  // The gags changing (an idea used, a gag saved) re-reads too, since the
  // ideas are current only against the gags they were drafted for.
  const pending = ideas?.status === "pending";
  useEffect(() => {
    if (!live || !pending) return;
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
  }, [live, pending, load]);
  useEffect(() => { if (live && ideas) void load(); }, [gagsView]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!live) return null;

  const generate = async () => {
    setError("");
    await request("POST");
  };

  return (
    <div className="space-y-2" data-testid="live-gag-ideas">
      <p className="text-xs text-muted-foreground">
        <span className="font-bold text-foreground">Draft more gags.</span> The gag writer drafts three ideas that
        avoid this fact's existing gags. Using one saves it as a gag's change; users keep the current gags until a
        test render of it is approved as its example.
      </p>
      <VisualConceptCandidates
        visualConcepts={ideas}
        disabled={disabled || saving}
        pickBlockedReason={unsavedGagEdits ? "Save or undo your gag edits first: using an idea replaces that gag's saved version." : null}
        actions={actions}
        onGenerate={generate}
      />
      {error && <p className="text-xs text-destructive break-words" data-testid="live-gag-ideas-error">{error}</p>}
    </div>
  );
}

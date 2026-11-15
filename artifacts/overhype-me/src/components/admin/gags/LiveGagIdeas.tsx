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
import { gagApi } from "./gagApi";
import { useGagIdeaActions } from "./useGagIdeaActions";

const POLL_MS = 2000;


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

  // A read that started before Draft was pressed must not overwrite the
  // "working" the press returned, so a read is dropped only when a press
  // began after it. Reads never cancel each other: while one is in flight the
  // next poll tick skips, so a slow connection still gets its answers through
  // (Codex, PR #958 round 2).
  const presses = useRef(0);
  const reading = useRef(false);
  const request = useCallback(async (method: "GET" | "POST") => {
    let r;
    if (method === "POST") {
      const press = ++presses.current;
      r = await gagApi.draftIdeas(factId);
      if (press !== presses.current) return;
    } else {
      if (reading.current) return;
      reading.current = true;
      const press = presses.current;
      try {
        r = await gagApi.ideas(factId);
      } finally {
        reading.current = false;
      }
      if (press !== presses.current) return;
    }
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
  // Keyed on the gags' content, not the view object: the panel hands over a
  // new view on every poll while a render draws.
  const gagsKey = gagsView ? JSON.stringify(gagsView.gags.map((g) => [g.id, g.approvedContent, g.pendingContent, g.pendingRemove])) : "";
  const seenGags = useRef(gagsKey);
  useEffect(() => {
    if (seenGags.current === gagsKey) return;
    seenGags.current = gagsKey;
    if (live && ideas) void load();
  }, [gagsKey]); // eslint-disable-line react-hooks/exhaustive-deps

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

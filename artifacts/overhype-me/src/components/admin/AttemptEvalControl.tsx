/**
 * AttemptEvalControl (Slice 2B) — a compact per-attempt eval control: a 1–5
 * rating, a failure-tag selector (concept / compiler / image_model / none), and
 * an optional note. Every field is INDEPENDENT and CLEARABLE (click an active
 * rating/tag again to clear it). Endpoint-agnostic: the parent supplies `onSave`
 * so the same control drives the review-scoped route (moderation tile) and the
 * eval-run route (dashboard).
 *
 * Writes are optimistic — local state updates immediately and reverts on error.
 */
import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import { FAILURE_TAG_VALUES, type FailureTag } from "@workspace/api-zod";

export interface EvalWriteBody {
  rating?: number | null;
  failureTag?: FailureTag | null;
  notes?: string | null;
}

/** The four attribution buckets + their moderator-facing tooltips. */
export const FAILURE_TAG_LABELS: Record<FailureTag, { label: string; hint: string }> = {
  concept: { label: "Concept", hint: "Concept — the idea / staging was wrong" },
  compiler: { label: "Compiler", hint: "Compiler — concept was good but the compiled prompt lost it" },
  image_model: { label: "Image model", hint: "Image model — prompt was good but execution failed" },
  none: { label: "None", hint: "None — rated, no single dominant failure" },
};

export function AttemptEvalControl({
  rating: initialRating,
  failureTag: initialFailureTag,
  notes: initialNotes,
  onSave,
  compact,
}: {
  rating?: number | null;
  failureTag?: string | null;
  notes?: string | null;
  /** POST the (partial) eval write; resolve ok/error so the control can revert. */
  onSave: (body: EvalWriteBody) => Promise<{ ok: boolean; error?: string }>;
  compact?: boolean;
}) {
  const [rating, setRating] = useState<number | null>(initialRating ?? null);
  const [failureTag, setFailureTag] = useState<FailureTag | null>((initialFailureTag as FailureTag | null) ?? null);
  const [notes, setNotes] = useState(initialNotes ?? "");
  const [savedNotes, setSavedNotes] = useState(initialNotes ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(body: EvalWriteBody, revert: () => void) {
    setBusy(true);
    setError(null);
    const res = await onSave(body).catch(() => ({ ok: false, error: "network" }));
    setBusy(false);
    if (!res.ok) {
      revert();
      setError(res.error ?? "Save failed");
    }
  }

  function pickRating(v: number) {
    const prev = rating;
    const next = rating === v ? null : v; // click active → clear
    setRating(next);
    void save({ rating: next }, () => setRating(prev));
  }

  function pickTag(t: FailureTag) {
    const prev = failureTag;
    const next = failureTag === t ? null : t;
    setFailureTag(next);
    void save({ failureTag: next }, () => setFailureTag(prev));
  }

  function commitNotes() {
    const trimmed = notes.trim();
    if (trimmed === savedNotes.trim()) return;
    const prevSaved = savedNotes;
    setSavedNotes(notes);
    void save({ notes: notes }, () => { setSavedNotes(prevSaved); setNotes(prevSaved); });
  }

  return (
    <div className="space-y-1.5" data-testid="attempt-eval-control">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Rate</span>
        <div className="flex items-center gap-0.5">
          {[1, 2, 3, 4, 5].map((v) => (
            <button
              key={v}
              type="button"
              data-testid={`eval-rating-${v}`}
              aria-pressed={rating === v}
              disabled={busy}
              onClick={() => pickRating(v)}
              className={`w-5 h-5 text-[11px] font-bold rounded-sm border ${
                rating != null && v <= rating
                  ? "bg-primary/20 border-primary/50 text-primary"
                  : "border-border text-muted-foreground hover:bg-muted"
              } disabled:opacity-50`}
              title={`${v} / 5`}
            >
              {v}
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-1 flex-wrap">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mr-1">Failure</span>
        {FAILURE_TAG_VALUES.map((t) => (
          <button
            key={t}
            type="button"
            data-testid={`eval-tag-${t}`}
            aria-pressed={failureTag === t}
            disabled={busy}
            title={FAILURE_TAG_LABELS[t].hint}
            onClick={() => pickTag(t)}
            className={`px-1.5 py-0.5 text-[10px] font-semibold rounded-sm border ${
              failureTag === t
                ? "bg-primary/20 border-primary/50 text-primary"
                : "border-border text-muted-foreground hover:bg-muted"
            } disabled:opacity-50`}
          >
            {FAILURE_TAG_LABELS[t].label}
          </button>
        ))}
      </div>

      {!compact && (
        <textarea
          data-testid="eval-notes"
          rows={2}
          value={notes}
          disabled={busy}
          placeholder="Optional note…"
          onChange={(e) => setNotes(e.target.value)}
          onBlur={commitNotes}
          className="w-full rounded-sm border border-border bg-background px-2 py-1 text-[11px] text-foreground focus:outline-none focus:ring-1 focus:ring-primary resize-none disabled:opacity-60"
        />
      )}

      {error && (
        <p className="text-[10px] text-destructive flex items-center gap-1" data-testid="eval-error">
          <AlertTriangle className="w-3 h-3 shrink-0" /> {error}
        </p>
      )}
    </div>
  );
}

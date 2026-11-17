/**
 * @purpose A submission's duplicate verdict at triage: a verdict line, the matched or closest item, and the on-open check for a review with no usable verdict.
 * @subsystem moderation
 *
 * Plan docs/plans/PLAN_DUPLICATE_VERDICT.md (Issue #1003). The verdict is the
 * server's check of the saved wording, never a similarity percentage:
 *   - Duplicate of #N / Duplicate of pending review #N — the match is shown;
 *   - Not a duplicate — "Show closest fact" reveals the nearest fact;
 *   - Couldn't check — the closest fact is shown straight away, with Try again;
 *   - Not checked yet — triage checks it on opening (David, Q1: on first open).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Copy, ExternalLink, HelpCircle, Loader2, RotateCcw } from "lucide-react";

export type DuplicateState = "duplicate" | "distinct" | "unavailable" | "not_checked";

export interface DuplicateView {
  state: DuplicateState;
  /** The matched fact on "duplicate"; the nearest fact otherwise, when it still exists. */
  fact: { id: number; text: string } | null;
  /** The matched pending review on "duplicate". */
  review: { id: number; text: string } | null;
}

export const NOT_CHECKED: DuplicateView = { state: "not_checked", fact: null, review: null };

/** The one-line verdict, as the queue row and the modal word it. */
export function verdictLabel(view: DuplicateView): string {
  switch (view.state) {
    case "duplicate":
      return view.review ? `Duplicate of pending review #${view.review.id}` : view.fact ? `Duplicate of #${view.fact.id}` : "Duplicate";
    case "distinct": return "Not a duplicate";
    case "unavailable": return "Couldn't check";
    default: return "Not checked yet";
  }
}

/**
 * The on-open check (David, Q1) and the request identity around it. The verdict
 * belongs to `submittedText`: a check whose answer is for other wording, or that
 * a wording save or a newer request superseded, is dropped. `seq()` is bumped by
 * anything that replaces the verdict (a wording save), so a late answer can
 * never restore an older one.
 */
export function useDuplicateCheck({
  reviewId,
  submittedText,
  view,
  canCheck,
  onView,
  onChecked,
}: {
  reviewId: number;
  submittedText: string;
  view: DuplicateView;
  /** At triage, first-time submission: a verdict can still be computed. */
  canCheck: boolean;
  onView: (view: DuplicateView) => void;
  /** A check completed: refresh the queue so its row shows the verdict. */
  onChecked: () => void;
}) {
  const [checking, setChecking] = useState(false);
  const [failed, setFailed] = useState(false);
  const seqRef = useRef(0);
  const textRef = useRef(submittedText);
  textRef.current = submittedText;
  const autoTriedRef = useRef(false);

  const check = useCallback(async () => {
    const seq = ++seqRef.current;
    const forText = textRef.current;
    let applied = false;
    setChecking(true); setFailed(false);
    try {
      const r = await fetch(`/api/admin/reviews/${reviewId}/duplicate-check`, { method: "POST", credentials: "include" });
      if (seq !== seqRef.current) return;
      if (!r.ok) { setFailed(true); return; }
      const data = (await r.json()) as { submittedText: string; duplicate: DuplicateView };
      if (seq !== seqRef.current || data.submittedText !== textRef.current || forText !== textRef.current) return;
      // Applied: bump the counter so an older detail load cannot overwrite it.
      applied = true;
      seqRef.current++;
      onView(data.duplicate);
      onChecked();
    } catch {
      if (seq === seqRef.current) setFailed(true);
    } finally {
      if (applied || seq === seqRef.current) setChecking(false);
    }
  }, [reviewId, onView, onChecked]);

  // Check once on opening when there is no usable verdict; Try again re-runs it.
  const needs = canCheck && (view.state === "not_checked" || view.state === "unavailable");
  useEffect(() => {
    if (!needs || autoTriedRef.current) return;
    autoTriedRef.current = true;
    void check();
  }, [needs, check]);

  /** Something else replaced the verdict (a wording save): drop any check in flight. */
  const supersede = useCallback(() => { seqRef.current++; setChecking(false); setFailed(false); }, []);
  /** A snapshot of the request counter, for a caller's own late-answer guard. */
  const seq = useCallback(() => seqRef.current, []);

  return { checking, failed, check, supersede, seq };
}

function MatchCard({ title, text, href }: { title: string; text: string; href?: string }) {
  return (
    <div className="bg-background border-2 border-primary/40 rounded-sm p-4" data-testid="duplicate-match">
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs font-bold text-primary uppercase tracking-wide">{title}</p>
        {href && (
          <a href={href} target="_blank" rel="noreferrer" className="text-xs text-primary hover:underline flex items-center gap-1">
            View <ExternalLink className="w-3 h-3" />
          </a>
        )}
      </div>
      <p className="text-base italic text-foreground leading-relaxed">"{text}"</p>
    </div>
  );
}

/** The verdict line, for the submitter-context row. */
export function DuplicateVerdictLine({
  view, checking, failed, canCheck, onRetry, showClosest, onShowClosest,
}: {
  view: DuplicateView;
  checking: boolean;
  failed: boolean;
  canCheck: boolean;
  onRetry: () => void;
  showClosest: boolean;
  onShowClosest: () => void;
}) {
  // A check request that failed outright reads like a failed check.
  const shown: DuplicateView = failed && view.state === "not_checked" ? { ...view, state: "unavailable" } : view;
  const Icon = checking ? Loader2 : shown.state === "duplicate" ? Copy : shown.state === "distinct" ? CheckCircle2 : shown.state === "unavailable" ? AlertTriangle : HelpCircle;
  const tone = shown.state === "duplicate" ? "text-primary" : shown.state === "unavailable" ? "text-amber-500" : "text-foreground";
  return (
    <span className="flex items-center gap-2" data-testid="duplicate-verdict" data-state={checking ? "checking" : shown.state}>
      Duplicate check:{" "}
      <strong className={`flex items-center gap-1 ${tone}`}>
        <Icon className={`w-3.5 h-3.5 ${checking ? "animate-spin" : ""}`} />
        {checking ? "Checking for duplicates…" : verdictLabel(shown)}
      </strong>
      {!checking && canCheck && shown.state === "unavailable" && (
        <button onClick={onRetry} className="text-xs text-primary underline hover:opacity-80 font-normal flex items-center gap-1">
          <RotateCcw className="w-3 h-3" /> Try again
        </button>
      )}
      {!checking && shown.state === "distinct" && shown.fact && !showClosest && (
        <button onClick={onShowClosest} className="text-xs text-primary underline hover:opacity-80 font-normal">
          Show closest fact
        </button>
      )}
    </span>
  );
}

/** Whether the match panel shows anything: the one statement of that rule. */
export function duplicateMatchShown(view: DuplicateView, showClosest: boolean): boolean {
  if (view.state === "duplicate") return view.review !== null || view.fact !== null;
  if (view.state === "unavailable") return view.fact !== null;   // Couldn't check: straight away
  return view.state === "distinct" && view.fact !== null && showClosest;
}

/** The match panel beside the wording, or null when nothing is shown. */
export function DuplicateMatchPanel({ view, showClosest }: { view: DuplicateView; showClosest: boolean }) {
  if (!duplicateMatchShown(view, showClosest)) return null;
  if (view.state === "duplicate") {
    if (view.review) return <MatchCard title={`Matches pending review #${view.review.id}`} text={view.review.text} />;
    return <MatchCard title={`Matches fact #${view.fact!.id}`} text={view.fact!.text} href={`/facts/${view.fact!.id}`} />;
  }
  // Couldn't check (straight away) or Not a duplicate (on request): the closest fact.
  return <MatchCard title={`Closest fact #${view.fact!.id}`} text={view.fact!.text} href={`/facts/${view.fact!.id}`} />;
}

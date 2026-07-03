/**
 * VisualConceptCandidates (Slice 2A) — the candidate-concept picker that sits
 * directly under the "Visual concept" field. During prep the frontier planner
 * drafts THREE distinct "describe the picture" ideas; here the moderator scans
 * them and (optionally) drops one into the Visual concept field as a starting
 * point — picking is draft-only, the moderator still Saves.
 *
 * States (driven entirely by the server-computed `visualConcepts` block; the FE
 * never recomputes hashes):
 *   null      → not started (pre-feature row / missed enqueue) → manual Generate.
 *   pending   → working (parent polls until terminal).
 *   failed    → non-blocking; offer Try again.
 *   ok+stale  → the fact/enrichment changed since these were drafted → hide the
 *               candidates, show why, offer Regenerate.
 *   ok+current→ the three cards, each with an expandable scene + "Use as draft".
 *
 * Optional by design: the Visual concept field works perfectly well empty, so a
 * failed/absent concept job never blocks anything.
 */
import { useState } from "react";
import { Lightbulb, Loader2, AlertTriangle, Sparkles, ChevronDown, ChevronRight } from "lucide-react";
import type {
  VisualConceptsResponse,
  StoredCandidateConcept,
  VisualConceptStaleReason,
} from "@workspace/api-zod";

const STALE_COPY: Record<VisualConceptStaleReason, string> = {
  review_mismatch: "These ideas were drafted for a different review.",
  candidate_version_mismatch: "These ideas were drafted for a different candidate version.",
  input_hash_mismatch: "The fact or its enrichment changed since these ideas were drafted.",
};

function ConceptCard({
  concept,
  index,
  disabled,
  onPick,
}: {
  concept: StoredCandidateConcept;
  index: number;
  disabled?: boolean;
  onPick: (sceneDescription: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const pickable = concept.tokenValid && !disabled;
  return (
    <div className="rounded-sm border border-border bg-background p-3 space-y-2" data-testid="visual-concept-candidate">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-foreground truncate" data-testid="candidate-title">
            {concept.title || `Idea ${index + 1}`}
          </p>
          {concept.whyItWorks && (
            <p className="text-xs text-muted-foreground mt-0.5">{concept.whyItWorks}</p>
          )}
        </div>
        <button
          type="button"
          data-testid="candidate-use"
          disabled={!pickable}
          title={concept.tokenValid ? undefined : concept.tokenError ?? "This idea uses an invalid personalization token."}
          onClick={() => onPick(concept.sceneDescription)}
          className="shrink-0 text-xs font-bold px-2 py-1 rounded-sm border border-primary/50 text-primary hover:bg-primary/10 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Use as draft
        </button>
      </div>

      <button
        type="button"
        data-testid="candidate-toggle-scene"
        onClick={() => setExpanded((v) => !v)}
        className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
      >
        {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        {expanded ? "Hide scene" : "Show scene"}
      </button>
      {expanded && (
        <p className="text-xs text-foreground/90 leading-relaxed whitespace-pre-wrap" data-testid="candidate-scene">
          {concept.sceneDescription}
        </p>
      )}
      {!concept.tokenValid && (
        <p className="text-[11px] text-amber-700 dark:text-amber-400 flex items-start gap-1">
          <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
          Can't pick — invalid token{concept.tokenError ? `: ${concept.tokenError}` : ""}.
        </p>
      )}
    </div>
  );
}

export function VisualConceptCandidates({
  visualConcepts,
  disabled,
  onPick,
  onGenerate,
}: {
  visualConcepts: VisualConceptsResponse | undefined;
  /** Disable picking / generating (e.g. while the enrichment draft is committing). */
  disabled?: boolean;
  /** Drop a candidate's scene into the Visual concept draft (draft-only). */
  onPick: (sceneDescription: string) => void;
  /** POST regenerate — the server uses the current unsaved draft as context. */
  onGenerate: () => Promise<void>;
}) {
  const [submitting, setSubmitting] = useState(false);
  const status = visualConcepts?.status ?? null;
  const current = visualConcepts?.current ?? false;
  const candidates = visualConcepts?.candidates ?? [];
  const staleReason = visualConcepts?.staleReason;

  const busy = submitting || status === "pending";
  const runGenerate = async () => {
    if (busy || disabled) return;
    setSubmitting(true);
    try {
      await onGenerate();
    } finally {
      setSubmitting(false);
    }
  };

  const GenerateButton = ({ label }: { label: string }) => (
    <button
      type="button"
      data-testid="visual-concepts-generate"
      disabled={busy || disabled}
      onClick={() => void runGenerate()}
      className="inline-flex items-center gap-1.5 text-xs font-bold px-2.5 py-1 rounded-sm border border-primary/50 text-primary hover:bg-primary/10 disabled:opacity-40"
    >
      <Sparkles className="w-3.5 h-3.5" />
      {label}
    </button>
  );

  const showCards = status === "ok" && current && candidates.length > 0;

  return (
    <div className="bg-background border-2 border-border rounded-sm p-4 space-y-3" data-testid="visual-concepts">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <Lightbulb className="w-4 h-4 text-muted-foreground" />
          <p className="text-xs font-bold text-muted-foreground uppercase tracking-wide">Visual ideas</p>
          <span className="text-[10px] font-mono text-muted-foreground">optional</span>
        </div>
        {(status === "ok" || status === "failed") && <GenerateButton label="Regenerate" />}
      </div>

      {status == null && (
        <div className="space-y-2" data-testid="visual-concepts-idle">
          <p className="text-xs text-muted-foreground">
            The planner can draft three distinct concepts to start from — pick one, edit it, or ignore them and
            write your own above.
          </p>
          <GenerateButton label="Generate visual ideas" />
        </div>
      )}

      {status === "pending" && (
        <p className="text-xs text-blue-600 dark:text-blue-400 flex items-center gap-1.5" data-testid="visual-concepts-pending">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Drafting three ideas… this view updates live.
        </p>
      )}

      {status === "failed" && (
        <p className="text-xs text-muted-foreground flex items-center gap-1.5" data-testid="visual-concepts-failed">
          <AlertTriangle className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400 shrink-0" />
          Couldn't draft ideas this time — no problem, write the Visual concept above yourself or Regenerate.
        </p>
      )}

      {status === "ok" && !current && (
        <p className="text-xs text-muted-foreground flex items-start gap-1.5" data-testid="visual-concepts-stale">
          <AlertTriangle className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
          {staleReason ? STALE_COPY[staleReason] : "These ideas are out of date."} Regenerate for fresh ideas.
        </p>
      )}

      {showCards && (
        <div className="space-y-2" data-testid="visual-concepts-cards">
          {candidates.map((c, i) => (
            <ConceptCard key={i} concept={c} index={i} disabled={disabled} onPick={onPick} />
          ))}
          <p className="text-[11px] text-muted-foreground">
            "Use as draft" fills the Visual concept field above — you still Save to apply it.
          </p>
        </div>
      )}
    </div>
  );
}

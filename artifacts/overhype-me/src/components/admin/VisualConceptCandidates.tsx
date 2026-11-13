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
import { Lightbulb, Loader2, AlertTriangle, Sparkles, ChevronDown, ChevronRight, MessageCircle, Cloud, Check, Pencil, Laugh } from "lucide-react";
import { isCandidateConceptPickable } from "@workspace/api-zod";
import type {
  VisualConceptsResponse,
  StoredCandidateConcept,
  VisualConceptStaleReason,
} from "@workspace/api-zod";

const STALE_COPY: Record<VisualConceptStaleReason, string> = {
  review_mismatch: "These ideas were drafted for a different review.",
  candidate_version_mismatch: "These ideas were drafted for a different candidate version.",
  input_hash_mismatch: "The fact, its enrichment or the gag writer changed since these ideas were drafted.",
  humor_note_changed: "These ideas were drafted for a different reading of the joke than the humor note now says.",
};

/**
 * The joke read and the fact's approved humor note (plan
 * docs/plans/PLAN_GAG_GENERATOR.md, E). The latest generation's read is always
 * shown, labelled as the AI's. With no saved note it can be confirmed with one
 * press or corrected; a saved note shows who approved it and when, and can be
 * edited. A correction being typed survives polling, because this card keeps
 * its own edit state while the panel re-renders with new server data.
 */
function HumorNoteCard({
  jokeRead,
  humorNote,
  disabled,
  onSave,
}: {
  jokeRead?: string;
  humorNote: NonNullable<VisualConceptsResponse["humorNote"]> | null;
  disabled?: boolean;
  onSave: (text: string) => Promise<string | null>;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const save = async (text: string) => {
    setSaving(true);
    setError("");
    const failure = await onSave(text);
    setSaving(false);
    if (failure) setError(failure);
    else setEditing(null);
  };
  if (!jokeRead && !humorNote && editing == null) {
    return (
      <div className="text-xs" data-testid="humor-note-empty">
        <button type="button" disabled={disabled} onClick={() => setEditing("")} className="inline-flex items-center gap-1 text-primary hover:underline disabled:opacity-40" data-testid="humor-note-write">
          <Pencil className="w-3 h-3" /> Write a humor note
        </button>
      </div>
    );
  }
  return (
    <div className="rounded-sm border border-border bg-muted/30 p-3 space-y-2" data-testid="humor-note-card">
      {humorNote && editing == null && (
        <div className="space-y-1" data-testid="humor-note-approved">
          <p className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground flex items-center gap-1"><Laugh className="w-3.5 h-3.5" /> Humor note (approved)</p>
          <p className="text-sm text-foreground whitespace-pre-wrap" data-testid="humor-note-text">{humorNote.text}</p>
          <p className="text-[11px] text-muted-foreground">
            Approved {new Date(humorNote.approvedAt).toLocaleString()}. The gag writer uses it on every regeneration.{" "}
            <button type="button" disabled={disabled} onClick={() => setEditing(humorNote.text)} className="text-primary hover:underline disabled:opacity-40" data-testid="humor-note-edit">Edit</button>
          </p>
        </div>
      )}
      {jokeRead && editing == null && (humorNote?.text ?? "") !== jokeRead && (
        <div className="space-y-1" data-testid="joke-read">
          <p className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">The AI's read of the joke</p>
          <p className="text-sm text-foreground/90 whitespace-pre-wrap" data-testid="joke-read-text">{jokeRead}</p>
          {!humorNote && (
            <div className="flex gap-2">
              <button type="button" disabled={disabled || saving} onClick={() => void save(jokeRead)} data-testid="joke-read-confirm" className="inline-flex items-center gap-1 text-xs font-bold px-2 py-1 rounded-sm border border-primary/50 text-primary hover:bg-primary/10 disabled:opacity-40">
                {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />} That's right
              </button>
              <button type="button" disabled={disabled || saving} onClick={() => setEditing(jokeRead)} data-testid="joke-read-edit" className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-sm border border-border hover:bg-muted disabled:opacity-40">
                <Pencil className="w-3 h-3" /> Edit
              </button>
            </div>
          )}
        </div>
      )}
      {editing != null && (
        <div className="space-y-1.5" data-testid="humor-note-editor">
          <p className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">Humor note: why this is funny, and what a picture must keep</p>
          <textarea value={editing} onChange={(e) => setEditing(e.target.value)} maxLength={1500} rows={3} data-testid="humor-note-input" className="w-full rounded-sm border border-border bg-background px-2 py-1 text-sm" />
          <div className="flex gap-2">
            <button type="button" disabled={disabled || saving || !editing.trim()} onClick={() => void save(editing)} data-testid="humor-note-save" className="inline-flex items-center gap-1 text-xs font-bold px-2 py-1 rounded-sm bg-primary text-white hover:opacity-90 disabled:opacity-40">
              {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />} {saving ? "Saving…" : "Save note"}
            </button>
            <button type="button" disabled={saving} onClick={() => { setEditing(null); setError(""); }} data-testid="humor-note-cancel" className="text-xs px-2 py-1 rounded-sm border border-border hover:bg-muted">Cancel</button>
          </div>
        </div>
      )}
      {error && <p className="text-xs text-destructive" data-testid="humor-note-error">{error}</p>}
    </div>
  );
}

function ConceptCard({
  concept,
  index,
  disabled,
  pickBlockedReason,
  onPick,
}: {
  concept: StoredCandidateConcept;
  index: number;
  disabled?: boolean;
  /** Non-null: picking is temporarily blocked for a draft-state reason (shown
   *  as the button title); the card itself may still be valid. */
  pickBlockedReason?: string | null;
  onPick: (concept: StoredCandidateConcept) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  // ATOMIC pickability: the scene AND every proposed bubble must be valid —
  // "Use as draft" applies the complete displayed concept or nothing.
  const conceptValid = isCandidateConceptPickable(concept);
  const pickable = conceptValid && !disabled && !pickBlockedReason;
  const bubbles = concept.bubbles ?? [];
  const invalidBubbles = bubbles.filter((b) => !b.tokenValid);
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
          title={
            !conceptValid
              ? concept.tokenError ?? invalidBubbles[0]?.tokenError ?? "This idea uses an invalid personalization token."
              : pickBlockedReason ?? undefined
          }
          onClick={() => onPick(concept)}
          className="shrink-0 text-xs font-bold px-2 py-1 rounded-sm border border-primary/50 text-primary hover:bg-primary/10 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Use as draft
        </button>
      </div>

      {/* Proposed bubbles — the NORMALIZED stored values, i.e. exactly what a
          pick applies to the draft. */}
      {bubbles.length > 0 && (
        <div className="space-y-1" data-testid="candidate-bubbles">
          {bubbles.map((b, i) => (
            <p key={i} className="text-xs text-foreground/90 flex items-start gap-1.5" data-testid="candidate-bubble">
              {b.type === "speech" ? (
                <MessageCircle className="w-3.5 h-3.5 mt-0.5 shrink-0 text-muted-foreground" />
              ) : (
                <Cloud className="w-3.5 h-3.5 mt-0.5 shrink-0 text-muted-foreground" />
              )}
              <span className="min-w-0">
                <span className="text-muted-foreground">{b.type === "speech" ? "Speech" : "Thought"} — {b.entity}: </span>
                <span className="font-medium">“{b.text}”</span>
                {!b.tokenValid && (
                  <span className="text-amber-700 dark:text-amber-400"> — invalid{b.tokenError ? `: ${b.tokenError}` : ""}</span>
                )}
              </span>
            </p>
          ))}
        </div>
      )}

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
      {!conceptValid && (
        <p className="text-[11px] text-amber-700 dark:text-amber-400 flex items-start gap-1" data-testid="candidate-unpickable">
          <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
          {concept.tokenValid
            ? `Can't pick — bubble ${bubbles.findIndex((b) => !b.tokenValid) + 1} is invalid${invalidBubbles[0]?.tokenError ? `: ${invalidBubbles[0].tokenError}` : ""}. The whole idea is applied together, so fix requires Regenerate.`
            : `Can't pick — invalid token${concept.tokenError ? `: ${concept.tokenError}` : ""}.`}
        </p>
      )}
    </div>
  );
}

export function VisualConceptCandidates({
  visualConcepts,
  disabled,
  pickBlockedReason,
  onPick,
  onGenerate,
  onSaveNote,
}: {
  visualConcepts: VisualConceptsResponse | undefined;
  /** Disable picking / generating (e.g. while the enrichment draft is committing). */
  disabled?: boolean;
  /** Non-null: picking is blocked because of unsaved unrelated Visual
   *  Strategy edits — cards render normally but "Use as draft" disables with
   *  this reason. Generating stays available. */
  pickBlockedReason?: string | null;
  /** Apply the complete candidate (scene + bubbles) to the draft (draft-only). */
  onPick: (concept: StoredCandidateConcept) => void;
  /** POST regenerate — the server uses the current unsaved draft as context. */
  onGenerate: () => Promise<void>;
  /** PUT the fact's humor note; resolves to an error message, or null on success. */
  onSaveNote?: (text: string) => Promise<string | null>;
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
          {visualConcepts?.failureReason
            ?? "Couldn't draft ideas this time. Press Regenerate to try again; the gag can't be approved until ideas are drafted."}
        </p>
      )}

      {/* Mounted whenever a note can be saved, whatever the generation status,
          so a correction being typed survives Regenerate (pending → ok/failed)
          and a note can be written before any generation has succeeded. */}
      {onSaveNote && (
        <HumorNoteCard
          jokeRead={status === "ok" ? visualConcepts?.jokeRead : undefined}
          humorNote={visualConcepts?.humorNote ?? null}
          disabled={disabled}
          onSave={onSaveNote}
        />
      )}

      {status === "ok" && !current && (
        <p className="text-xs text-muted-foreground flex items-start gap-1.5" data-testid="visual-concepts-stale">
          <AlertTriangle className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
          {staleReason ? STALE_COPY[staleReason] : "These ideas are out of date."} Regenerate for fresh ideas.
        </p>
      )}

      {showCards && (
        <div className="space-y-2" data-testid="visual-concepts-cards">
          {pickBlockedReason && (
            <p className="text-[11px] text-amber-700 dark:text-amber-400 flex items-start gap-1" data-testid="pick-blocked-note">
              <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" /> {pickBlockedReason}
            </p>
          )}
          {candidates.map((c, i) => (
            <ConceptCard key={i} concept={c} index={i} disabled={disabled} pickBlockedReason={pickBlockedReason} onPick={onPick} />
          ))}
          <p className="text-[11px] text-muted-foreground">
            "Use as draft" fills the Visual concept and bubbles above — you still Save to apply it.
          </p>
        </div>
      )}
    </div>
  );
}

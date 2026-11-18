/**
 * The Reading step of moderation (plan docs/plans/PLAN_FACT_LIFECYCLE_REBUILD.md,
 * 1B; Issue #1018, increment 1.2c-ii): how the fact was read. The reading's
 * draft humor note, editable, which the moderator approves to open Gags; and
 * beneath it, read-only, the reference research it was written from.
 *
 * States (async-ui-status.md: the step that waits for background work shows it):
 *   no run    → a review the stage cutover moved here: "Write the reading".
 *   pending   → "Reading the fact…", live (the parent polls).
 *   failed    → why, and "Try again".
 *   ok        → the note editor, Approve, and the research.
 */
import { useEffect, useState } from "react";
import { AlertTriangle, BookOpen, CheckCircle2, ExternalLink, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { HUMOR_NOTE_MAX_CHARS, type FactReadingView, type ReviewReadingView } from "@workspace/api-zod";

export function ReadingResearch({ reading }: { reading: FactReadingView }) {
  const refs = reading.research?.references ?? [];
  return (
    <div className="space-y-3" data-testid="reading-research">
      <p className="text-xs font-bold text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
        <BookOpen className="w-3.5 h-3.5" /> Reference research
      </p>
      {refs.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="reading-no-references">
          No references found: the fact stands on its own words.
        </p>
      ) : (
        <ul className="space-y-3">
          {refs.map((r, i) => (
            <li key={i} className="rounded-sm border border-border bg-background p-3 space-y-1.5">
              <p className="text-sm font-semibold text-foreground">"{r.phrase}"</p>
              <p className="text-sm text-foreground">{r.meaning}</p>
              {r.pictureImplication && (
                <p className="text-sm text-muted-foreground"><span className="font-semibold">In a picture:</span> {r.pictureImplication}</p>
              )}
              {r.sources.length > 0 && (
                <ul className="flex flex-wrap gap-x-3 gap-y-1">
                  {r.sources.map((s, j) => (
                    <li key={j}>
                      <a href={s.url} target="_blank" rel="noreferrer noopener" className="text-xs text-primary underline inline-flex items-center gap-1">
                        {s.title || s.url} <ExternalLink className="w-3 h-3" />
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ReadingStep({
  reading,
  disabled,
  onApprove,
  onRetry,
}: {
  reading: ReviewReadingView | null | undefined;
  disabled?: boolean;
  /** Approve the note as shown; resolves to an error message, or null when it moved on. */
  onApprove: (text: string, readingId: number) => Promise<string | null>;
  onRetry: () => Promise<void>;
}) {
  const latest = reading?.latest ?? null;
  const [text, setText] = useState(latest?.draftNote ?? "");
  const [seededFrom, setSeededFrom] = useState<number | null>(latest?.status === "ok" ? latest.id : null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Seed the editor from each newly finished run, once: polling never
  // overwrites what the moderator is typing.
  useEffect(() => {
    if (latest?.status === "ok" && latest.id !== seededFrom) {
      setText(latest.draftNote ?? "");
      setSeededFrom(latest.id);
    }
  }, [latest?.status, latest?.id, latest?.draftNote, seededFrom]);

  const retry = async () => {
    setBusy(true); setError("");
    try { await onRetry(); } finally { setBusy(false); }
  };

  if (!latest) {
    return (
      <div className="rounded-sm border border-amber-500/40 bg-amber-500/10 p-4 space-y-3" data-testid="reading-none">
        <p className="text-sm text-amber-700 dark:text-amber-300 flex items-center gap-1.5">
          <AlertTriangle className="w-4 h-4 shrink-0" /> This fact hasn't been read yet.
        </p>
        <Button onClick={() => void retry()} isLoading={busy} disabled={disabled || busy} className="gap-2" data-testid="reading-start">
          <RefreshCw className="w-4 h-4" /> Write the reading
        </Button>
      </div>
    );
  }
  if (latest.status === "pending") {
    return (
      <div className="rounded-sm border border-blue-500/30 bg-blue-500/10 p-4" data-testid="reading-pending">
        <p className="text-sm text-blue-700 dark:text-blue-300 flex items-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin shrink-0" />
          Reading the fact: researching its references, then drafting the humor note. This updates live; you don't need to refresh.
        </p>
      </div>
    );
  }
  if (latest.status === "failed") {
    return (
      <div className="rounded-sm border border-destructive/50 bg-destructive/10 p-4 space-y-3" data-testid="reading-failed">
        <p className="text-sm text-destructive flex items-start gap-1.5">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{latest.error ?? "The reading could not be written."}</span>
        </p>
        <Button onClick={() => void retry()} isLoading={busy} disabled={disabled || busy} className="gap-2" data-testid="reading-retry">
          <RefreshCw className="w-4 h-4" /> Try again
        </Button>
      </div>
    );
  }

  const trimmed = text.trim();
  const approve = async () => {
    setBusy(true); setError("");
    try {
      const err = await onApprove(trimmed, latest.id);
      if (err) setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-4" data-testid="reading-ok">
      <div className="rounded-sm border-2 border-border bg-card p-4 space-y-2">
        <label htmlFor="reading-note" className="block text-xs font-bold text-muted-foreground uppercase tracking-wide">
          Humor note
        </label>
        <p className="text-xs text-muted-foreground">
          The AI's reading of the joke, written from the research below. Correct it if it's wrong: the gag ideas are written from the note you approve.
        </p>
        <textarea
          id="reading-note"
          value={text}
          onChange={(e) => { setText(e.target.value); setError(""); }}
          rows={4}
          maxLength={HUMOR_NOTE_MAX_CHARS}
          disabled={disabled || busy}
          className="w-full px-3 py-2 bg-background border border-border rounded-sm text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
          data-testid="reading-note"
        />
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => void approve()} isLoading={busy} disabled={disabled || busy || trimmed.length === 0}
            className="bg-green-600 hover:bg-green-700 text-white gap-2" data-testid="approve-reading">
            <CheckCircle2 className="w-4 h-4" /> Approve the humor note
          </Button>
          {trimmed.length === 0 && <span className="text-xs text-amber-600 dark:text-amber-400">The note can't be empty.</span>}
        </div>
        {error && <p className="text-sm text-destructive" data-testid="reading-approve-error">{error}</p>}
      </div>
      <ReadingResearch reading={latest} />
    </div>
  );
}

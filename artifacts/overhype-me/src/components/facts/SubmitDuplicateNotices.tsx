/**
 * @purpose The submit page's two duplicate notices: the warning when the server judges the fact a duplicate (the submitter may back out or submit anyway), and the refusal when the wording is identical to an existing fact.
 * @subsystem facts
 *
 * Plan docs/plans/PLAN_FACT_LIFECYCLE_REBUILD.md, item 2 and 1G (Issue #1018,
 * increment 1.4): the message is funny and on-brand and shows the matching
 * fact; identical wording is refused by the server, everything else may be
 * submitted anyway and arrives at Triage flagged. The verdict itself is
 * Issue #1003's.
 */
import { ChevronLeft, Copy, GitBranch } from "lucide-react";

export interface DuplicateMatch {
  matchingFactId?: number;
  matchingReviewId?: number;
  /** The match's wording, rendered for a reader. */
  text: string;
}

/** A server answer naming a match (the duplicate preview, or the identical-text refusal), as a notice shows it. */
export function toDuplicateMatch(src: { matchingFactId?: number; matchingReviewId?: number; matchingCanonicalText?: string; matchingFactText?: string }): DuplicateMatch {
  return { matchingFactId: src.matchingFactId, matchingReviewId: src.matchingReviewId, text: src.matchingCanonicalText ?? src.matchingFactText ?? "" };
}

function MatchedFact({ match }: { match: DuplicateMatch }) {
  return (
    <div className="bg-background rounded-lg border border-border px-5 py-4 mb-4">
      <p className="text-xl font-bold text-foreground leading-snug" data-testid="duplicate-match-text">"{match.text}"</p>
      {match.matchingFactId != null && (
        <a
          href={`/facts/${match.matchingFactId}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm text-primary underline mt-3 block hover:opacity-80"
        >
          See the original legend →
        </a>
      )}
    </div>
  );
}

/** The server's "duplicate" verdict: a warning, with the way back and the way on. */
export function DuplicateWarning({ match, onBackOut }: { match: DuplicateMatch; onBackOut: () => void }) {
  return (
    <div className="rounded-xl border-2 border-amber-500/40 bg-amber-500/5 p-6" data-testid="duplicate-warning">
      <p className="text-lg font-semibold text-amber-600 dark:text-amber-400 mb-1 flex items-center gap-2">
        <GitBranch className="w-5 h-5 shrink-0" /> Great legends think alike.
      </p>
      <p className="text-muted-foreground mb-4">
        {match.matchingReviewId != null
          ? "Someone already sent in a feat a lot like this one, and it's waiting in line for review:"
          : "This feat looks a lot like one that's already been immortalized:"}
      </p>
      <MatchedFact match={match} />
      <p className="text-muted-foreground mb-4">
        Think yours is different enough? Submit it anyway and a moderator will decide which legend lives on.
        Or go back and make it even more impossible.
      </p>
      <button
        type="button"
        onClick={onBackOut}
        data-testid="duplicate-back-out"
        className="inline-flex items-center gap-1 text-foreground font-semibold underline underline-offset-2 hover:text-primary"
      >
        <ChevronLeft className="w-4 h-4" /> Make it more impossible
      </button>
    </div>
  );
}

/** The server refused identical wording: nothing to submit, only the way back. */
export function IdenticalRefusal({ match, onBackOut }: { match: DuplicateMatch; onBackOut: () => void }) {
  return (
    <div className="rounded-xl border-2 border-destructive/40 bg-destructive/5 p-6" data-testid="identical-refusal">
      <p className="text-lg font-semibold text-destructive mb-1 flex items-center gap-2">
        <Copy className="w-5 h-5 shrink-0" /> Even legends can't happen twice.
      </p>
      <p className="text-muted-foreground mb-4">
        {match.matchingReviewId != null
          ? "This exact fact is already waiting in line for review, word for word:"
          : "This exact fact is already on Overhype.me, word for word:"}
      </p>
      <MatchedFact match={match} />
      <p className="text-muted-foreground mb-4">Change it up and try again.</p>
      <button
        type="button"
        onClick={onBackOut}
        data-testid="identical-back-out"
        className="inline-flex items-center gap-1 text-foreground font-semibold underline underline-offset-2 hover:text-primary"
      >
        <ChevronLeft className="w-4 h-4" /> Write a new one
      </button>
    </div>
  );
}

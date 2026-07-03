import { RefreshCw } from "lucide-react";

/**
 * Marks a REFRESH review (versioned enrichment refresh of a LIVE fact) apart
 * from a first-time submission: approving promotes the new enrichment for
 * future renders; rejecting keeps the live fact exactly as it is today.
 * Rendered in the moderation list rows and the review modal header whenever
 * `review.candidateVersionId != null`.
 */
export function RefreshReviewBadge() {
  return (
    <span
      data-testid="refresh-review-badge"
      title="Versioned enrichment refresh of a live fact. Approving promotes the new enrichment for future renders; rejecting keeps the live fact exactly as it is. Existing memes and images are never changed."
      className="inline-flex items-center gap-1 rounded-sm border border-blue-500/50 bg-blue-500/10 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-blue-600 dark:text-blue-400"
    >
      <RefreshCw className="w-3 h-3" /> Refresh review
    </span>
  );
}

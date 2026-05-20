/**
 * Terminal screen rendered inside the God Mode loading takeover when a
 * video-job POST (or its async budget gate) returns BUDGET_EXCEEDED.
 *
 * Locked copy per spec — no retry button. The only action is to go back to
 * Step 2 so the user can pick a different artifact type, or close out.
 */

import { Button } from "@/components/ui/Button";

interface Props {
  /** ISO date string (e.g. "2026-06-01"). */
  resetDate: string;
  onGoBack: () => void;
}

export function VideoBudgetExceededScreen({ resetDate, onGoBack }: Props) {
  return (
    <div
      className="flex h-full w-full flex-col items-center justify-center px-6 text-center"
      data-testid="video-budget-exceeded"
    >
      <div className="max-w-sm space-y-4">
        <h2 className="font-display text-3xl uppercase tracking-wide text-white">
          You've out-legended your monthly budget.
        </h2>
        <p className="text-white/70">
          Your reset is {formatResetDate(resetDate)}. Come back wilder.
        </p>
        <Button
          type="button"
          variant="secondary"
          onClick={onGoBack}
          data-testid="video-budget-exceeded-back"
        >
          Go back
        </Button>
      </div>
    </div>
  );
}

function formatResetDate(iso: string): string {
  // Tolerant of bad input — display the raw string in that case.
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

/**
 * Budget-exhausted overlay for the Step 1 video card.
 *
 * Shown to Legendary users who have spent their full monthly video budget.
 * Card is non-tappable in this state; the message tells them when the
 * budget resets.
 *
 * Defined in MBFO-2 but not yet rendered — the client-side video-budget
 * endpoint that triggers this state lands in MBFO-4. Until then, the
 * resolver never returns `budget-reached`.
 */

interface Props {
  resetDate: string;
}

export function CardBudgetReached({ resetDate }: Props) {
  return (
    <>
      <div className="absolute inset-0 z-10 bg-black/70" aria-hidden="true" />
      <div
        className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 px-6 text-center text-white"
        data-testid="card-budget-reached"
      >
        <span className="font-mono text-xs uppercase tracking-widest text-[#ffb347]">
          Budget reached
        </span>
        <span className="font-display text-lg uppercase">
          Resets {resetDate || "next month"}
        </span>
      </div>
    </>
  );
}

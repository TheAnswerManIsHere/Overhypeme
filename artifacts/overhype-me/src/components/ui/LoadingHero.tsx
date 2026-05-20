import { ActivityRing } from "./ActivityRing";

/**
 * Shared centered-hero layout for the wizard's loading takeovers.
 *
 * Used by both the image flow's PulidLoadingTakeover and the video flow's
 * GodModeLoadingTakeover (working phases only — checkpoint, no-face review,
 * and failed states have their own full-bleed layouts since they require
 * user decision UI).
 *
 * Renders the ActivityRing as the dominant motion cue, with the bar
 * underneath as a secondary, quantitative signal. The wrapper expects to
 * sit inside an already-full-screen container (the takeover's bg overlay).
 */
interface Props {
  heading: string;
  subhead?: string;
  /** 0..1; rendered as a bigger, centered bar than the legacy thin top one. */
  progress: number;
  /** Hide the activity ring (e.g. for the terminal "Done." flash). */
  hideRing?: boolean;
  /** Hide the progress bar (e.g. when there's no meaningful progress to show). */
  hideProgress?: boolean;
}

export function LoadingHero({
  heading,
  subhead,
  progress,
  hideRing = false,
  hideProgress = false,
}: Props) {
  const pct = Math.round(Math.min(1, Math.max(0, progress)) * 100);
  return (
    <div
      className="flex h-full w-full flex-col items-center justify-center px-6 text-center"
      data-testid="loading-hero"
    >
      {!hideRing && <ActivityRing size={72} className="mb-6" />}
      <h2 className="font-display text-3xl uppercase tracking-wide text-white">
        {heading}
      </h2>
      {subhead && (
        <p className="mt-3 max-w-sm text-sm text-white/70">{subhead}</p>
      )}
      {!hideProgress && (
        <div className="mt-8 w-full max-w-sm" aria-hidden>
          <div className="h-2 w-full overflow-hidden rounded-full bg-white/10">
            <div
              className="h-full bg-[#ff6b35] transition-[width] duration-150 ease-out"
              style={{ width: `${pct}%` }}
              data-testid="loading-hero-progress-fill"
            />
          </div>
        </div>
      )}
    </div>
  );
}

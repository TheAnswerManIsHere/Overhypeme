import { Globe, Lock } from "lucide-react";
import type { Tier } from "../types";
import { VISIBILITY_COPY } from "../copy";

interface Props {
  /** Current choice. `true` = public (the server-side default). */
  isPublic: boolean;
  onChange: (next: boolean) => void;
  tier: Tier;
  /** Called instead of `onChange` when a non-Legendary viewer taps "Private". */
  onRequestUpgrade: () => void;
  className?: string;
}

/**
 * Public / Private choice for a meme, shown next to the save action in both
 * builder surfaces (the MBFO wizard's Step 2 and the single-screen builder).
 *
 * Privacy is a Legendary-level entitlement: `createMemeRecord` rejects an
 * explicit `isPublic: false` from anyone below it with a 403 rather than
 * downgrading the meme to public. So for a non-Legendary viewer the "Private"
 * pill is **locked, never selectable** — tapping it opens the upgrade modal and
 * `onChange(false)` is unreachable. That keeps the control from ever offering a
 * choice the save would then refuse. `tier` here already collapses admin into
 * `legendary` (`roleToTier`), which matches the server's role-based gate.
 * Locked affordances follow
 * the wizard's established language (dimmed pill + typeset LEGEND badge, no
 * emoji) rather than being hidden, so the entitlement is discoverable.
 *
 * The helper line renders only for the private choice: it keeps the control a
 * single compact row in the default (public) case, where it sits directly above
 * a fixed-position CTA and every pixel is viewport the user loses.
 */
export function VisibilityToggle({
  isPublic,
  onChange,
  tier,
  onRequestUpgrade,
  className,
}: Props) {
  const privateLocked = tier !== "legendary";
  const privateSelected = !isPublic && !privateLocked;

  const pill = (selected: boolean) =>
    [
      "flex flex-1 items-center justify-center gap-1.5 rounded-sm px-3 py-1.5",
      "font-display text-xs font-bold uppercase tracking-wider transition-colors",
      selected
        ? "bg-primary text-primary-foreground"
        : "text-muted-foreground hover:text-foreground",
    ].join(" ");

  return (
    <div className={className} data-testid="meme-visibility">
      <div
        role="group"
        aria-label={VISIBILITY_COPY.groupLabel}
        className="flex items-center gap-2 rounded-sm border border-border bg-secondary p-1"
      >
        <button
          type="button"
          aria-pressed={isPublic}
          onClick={() => onChange(true)}
          data-testid="meme-visibility-public"
          className={pill(isPublic)}
        >
          <Globe className="h-3.5 w-3.5" aria-hidden />
          {VISIBILITY_COPY.public}
        </button>
        <button
          type="button"
          aria-pressed={privateSelected}
          aria-disabled={privateLocked}
          onClick={() => (privateLocked ? onRequestUpgrade() : onChange(false))}
          data-testid="meme-visibility-private"
          className={`${pill(privateSelected)} ${privateLocked ? "opacity-60" : ""}`}
        >
          <Lock className="h-3.5 w-3.5" aria-hidden />
          {VISIBILITY_COPY.private}
          {privateLocked && (
            <span
              aria-hidden
              className="rounded-sm border border-primary/70 px-1 py-0.5 font-mono text-[9px] tracking-wider text-primary"
            >
              {VISIBILITY_COPY.lockBadge}
            </span>
          )}
        </button>
      </div>
      {privateSelected && (
        <p className="mt-1.5 text-[11px] leading-snug text-muted-foreground">
          {VISIBILITY_COPY.privateHelper}
        </p>
      )}
    </div>
  );
}

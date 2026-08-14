import { Globe, Lock } from "lucide-react";
import { VISIBILITY_COPY } from "../copy";

interface Props {
  /** Current choice. `true` = public (the server-side default). */
  isPublic: boolean;
  onChange: (next: boolean) => void;
  /**
   * The SERVER's answer for `meme_private_visibility`, passed straight
   * through. Never a tier the client derived.
   */
  canSetPrivate: boolean;
  /** Called instead of `onChange` when a non-Legendary viewer taps "Private". */
  onRequestUpgrade: () => void;
  className?: string;
}

/**
 * Public / Private choice for a meme, shown next to the save action in both
 * builder surfaces (the MBFO wizard's Step 2 and the single-screen builder).
 *
 * This is the control PR #402 broke. The builder derived a tier client-side
 * (`roleToTier`, which collapsed admin into legendary) and offered the Private
 * pill; `createMemeRecord` resolved `meme_private_visibility` from the tier
 * column, found `registered`, and coerced the meme public. A privacy choice was
 * silently discarded and the meme was world-readable at its permalink.
 *
 * The fix is that the lock and the server's gate are now the SAME expression,
 * evaluated once: `canSetPrivate` is the resolved entitlement, handed down from
 * the server. Granting `meme_private_visibility` to another tier from
 * Admin → Features now genuinely unlocks this pill, which the old tier-only
 * lock could never do.
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
  canSetPrivate,
  onRequestUpgrade,
  className,
}: Props) {
  const privateLocked = !canSetPrivate;
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

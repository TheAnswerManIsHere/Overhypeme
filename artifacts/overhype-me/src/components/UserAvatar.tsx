import { forwardRef } from "react";
import { Crown, User as UserIcon } from "lucide-react";

export type UserAvatarSize = "xs" | "sm" | "md" | "lg";

interface UserAvatarProps {
  avatarUrl: string | null;
  fallbackInitial?: string;
  /** When true, renders the Legendary status decoration (gold ring + crown medallion). */
  isLegendary?: boolean;
  size?: UserAvatarSize;
  /** Render as a button (clickable trigger) or a plain div (display only). */
  as?: "button" | "div";
  ariaLabel?: string;
  className?: string;
}

const sizeClasses: Record<UserAvatarSize, string> = {
  xs: "w-6 h-6",
  sm: "w-7 h-7",
  md: "w-8 h-8",
  lg: "w-12 h-12",
};

const crownSizeClasses: Record<UserAvatarSize, string> = {
  xs: "w-2.5 h-2.5",
  sm: "w-3 h-3",
  md: "w-3.5 h-3.5",
  lg: "w-4 h-4",
};

const initialTextClasses: Record<UserAvatarSize, string> = {
  xs: "text-[10px]",
  sm: "text-xs",
  md: "text-sm",
  lg: "text-lg",
};

export const UserAvatar = forwardRef<HTMLElement, UserAvatarProps>(function UserAvatar(
  { avatarUrl, fallbackInitial, isLegendary = false, size = "md", as = "div", ariaLabel, className = "" },
  ref,
) {
  const sizeClass = sizeClasses[size];
  const initialClass = initialTextClasses[size];

  // The crown medallion is decorative chrome and reads as cluttered at xs/sm,
  // so we suppress it on tiny avatars (e.g. comment threads) and let the gold
  // ring carry the affordance on its own.
  const showCrown = isLegendary && (size === "md" || size === "lg");

  const ringClass = isLegendary
    ? "ring-2 ring-offset-2 ring-offset-background ring-amber-400 shadow-[0_0_12px_rgba(251,191,36,0.45)]"
    : "ring-1 ring-border";

  const innerContent = avatarUrl ? (
    <img src={avatarUrl} alt="" className="w-full h-full object-cover" />
  ) : fallbackInitial ? (
    <span className={`${initialClass} font-bold font-display text-foreground`}>{fallbackInitial}</span>
  ) : (
    <UserIcon className="w-1/2 h-1/2 text-muted-foreground" />
  );

  const sharedClass = `relative inline-flex flex-shrink-0 ${className}`;
  const circleClass = `${sizeClass} rounded-full overflow-hidden inline-flex items-center justify-center bg-secondary ${ringClass}`;

  // Wrap in an outer relative span so the crown medallion can be absolutely
  // positioned without being clipped by the avatar's overflow-hidden circle.
  const inner = (
    <>
      <span className={circleClass}>{innerContent}</span>
      {showCrown && (
        <span
          aria-hidden
          className="absolute -bottom-0.5 -right-0.5 inline-flex items-center justify-center rounded-full bg-gradient-to-br from-amber-300 via-yellow-400 to-amber-500 p-0.5 shadow-[0_0_6px_rgba(251,191,36,0.55)] ring-1 ring-background"
        >
          <Crown className={`${crownSizeClasses[size]} text-amber-900`} fill="currentColor" />
        </span>
      )}
    </>
  );

  if (as === "button") {
    return (
      <button
        ref={ref as React.Ref<HTMLButtonElement>}
        type="button"
        aria-label={ariaLabel ?? "Open account menu"}
        className={sharedClass}
      >
        {inner}
      </button>
    );
  }

  return (
    <span ref={ref as React.Ref<HTMLSpanElement>} className={sharedClass} aria-label={ariaLabel}>
      {inner}
    </span>
  );
});

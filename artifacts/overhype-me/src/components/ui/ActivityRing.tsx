import { cn } from "@/lib/utils";

/**
 * Large, brand-orange activity indicator for full-screen loading takeovers.
 *
 * Pairs with the small top-of-screen progress bar — the bar communicates
 * "how far along we are," this ring communicates "the system is actively
 * working." Two concentric layers move on different schedules so the
 * indicator never appears frozen even if the bar is mid-asymptote.
 *
 * Renders nothing when `active` is false (e.g. terminal phases) so callers
 * can mount it unconditionally and toggle via prop.
 */
interface Props {
  /** Whether the ring should render and animate. Defaults to true. */
  active?: boolean;
  /** Diameter in pixels. Defaults to 64. */
  size?: number;
  /** Override classes on the outer wrapper. */
  className?: string;
}

const BRAND_ORANGE = "#ff6b35";

export function ActivityRing({ active = true, size = 64, className }: Props) {
  if (!active) return null;

  const ringThickness = Math.max(3, Math.round(size / 12));
  const innerSize = size - ringThickness * 4;

  return (
    <div
      role="status"
      aria-label="Working"
      className={cn("relative inline-flex items-center justify-center", className)}
      style={{ width: size, height: size }}
      data-testid="activity-ring"
    >
      {/* Outer spinning ring — fire-orange arc on a faint track. */}
      <span
        className="absolute inset-0 rounded-full animate-spin"
        style={{
          borderWidth: ringThickness,
          borderStyle: "solid",
          borderColor: "rgba(255, 255, 255, 0.08)",
          borderTopColor: BRAND_ORANGE,
          borderRightColor: BRAND_ORANGE,
        }}
      />
      {/* Inner pulsing dot — reinforces "live" when the outer ring's spin
          happens to align with the page refresh cadence. */}
      <span
        className="rounded-full animate-pulse"
        style={{
          width: innerSize,
          height: innerSize,
          background: `radial-gradient(circle, ${BRAND_ORANGE}55 0%, ${BRAND_ORANGE}00 70%)`,
        }}
      />
    </div>
  );
}

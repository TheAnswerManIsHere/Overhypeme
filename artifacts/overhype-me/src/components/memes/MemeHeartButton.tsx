import { useEffect, useState } from "react";
import { Heart } from "lucide-react";
import { useHeartMeme } from "@workspace/api-client-react";
import { useAuth } from "@workspace/replit-auth-web";
import { useLocation } from "wouter";

interface MemeHeartButtonProps {
  memeId: number;
  initialHeartCount: number;
  initialViewerHasHearted: boolean;
  /** Stop click propagation so the button can sit inside an <a>/Link card. */
  stopPropagation?: boolean;
  /** Optional size preset. */
  size?: "sm" | "md";
  /** Optional extra classes for the wrapper button. */
  className?: string;
}

/**
 * Heart toggle for a meme. Optimistic flip + rollback on failure. Sized to
 * sit alongside meme metadata or as a corner overlay; the parent decides the
 * positioning. Anonymous taps route to /login.
 */
export function MemeHeartButton({
  memeId,
  initialHeartCount,
  initialViewerHasHearted,
  stopPropagation,
  size = "md",
  className,
}: MemeHeartButtonProps) {
  const { isAuthenticated } = useAuth();
  const [, setLocation] = useLocation();
  const [count, setCount] = useState(initialHeartCount);
  const [active, setActive] = useState(initialViewerHasHearted);
  const heartMutation = useHeartMeme();

  // Reset internal state when the underlying meme changes (e.g. navigating
  // between memes inside the same gallery).
  useEffect(() => {
    setCount(initialHeartCount);
    setActive(initialViewerHasHearted);
  }, [memeId, initialHeartCount, initialViewerHasHearted]);

  const onClick = (e: React.MouseEvent) => {
    e.preventDefault();
    if (stopPropagation) e.stopPropagation();
    if (!isAuthenticated) {
      setLocation(`/login?from=${encodeURIComponent(window.location.pathname)}`);
      return;
    }
    const next = !active;
    setActive(next);
    setCount((c) => Math.max(0, c + (next ? 1 : -1)));
    heartMutation.mutate(
      { id: memeId },
      {
        onSuccess: (res) => {
          setActive(res.viewerHasHearted);
          setCount(res.heartCount);
        },
        onError: () => {
          setActive(!next);
          setCount((c) => Math.max(0, c + (next ? -1 : 1)));
        },
      },
    );
  };

  const iconClass = size === "sm" ? "w-4 h-4" : "w-5 h-5";
  const textClass = size === "sm" ? "text-xs" : "text-sm";

  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={active ? "Remove heart" : "Heart this meme"}
      className={`inline-flex items-center gap-1.5 font-semibold transition-colors ${textClass} ${
        active ? "text-primary" : "text-muted-foreground hover:text-primary"
      } ${className ?? ""}`}
    >
      <Heart className={`${iconClass} ${active ? "fill-current" : ""}`} />
      <span>{count}</span>
    </button>
  );
}

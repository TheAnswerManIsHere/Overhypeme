import { useState } from "react";
import { Heart } from "lucide-react";
import { useHeartComment } from "@workspace/api-client-react";
import { useAuth } from "@workspace/replit-auth-web";
import { useLocation } from "wouter";

interface CommentHeartButtonProps {
  commentId: number;
  initialHeartCount: number;
  initialViewerHasHearted: boolean;
}

/**
 * Heart toggle for a comment. Optimistically flips state on tap and reconciles
 * against the server response. Unauthenticated taps route to /login.
 */
export function CommentHeartButton({ commentId, initialHeartCount, initialViewerHasHearted }: CommentHeartButtonProps) {
  const { isAuthenticated } = useAuth();
  const [, setLocation] = useLocation();
  const [count, setCount] = useState(initialHeartCount);
  const [active, setActive] = useState(initialViewerHasHearted);
  const heartMutation = useHeartComment();

  const onClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!isAuthenticated) {
      setLocation(`/login?from=${encodeURIComponent(window.location.pathname)}`);
      return;
    }
    const next = !active;
    setActive(next);
    setCount((c) => Math.max(0, c + (next ? 1 : -1)));
    heartMutation.mutate(
      { id: commentId },
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

  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={active ? "Remove heart" : "Heart this comment"}
      className={`inline-flex items-center gap-1 text-xs font-medium transition-colors ${
        active ? "text-primary" : "text-muted-foreground hover:text-primary"
      }`}
    >
      <Heart className={`w-4 h-4 ${active ? "fill-current" : ""}`} />
      <span>{count}</span>
    </button>
  );
}

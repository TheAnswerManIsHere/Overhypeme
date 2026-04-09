import { Lock, ShieldAlert } from "lucide-react";
import { Link, useLocation } from "wouter";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/utils";

export interface AccessGateProps {
  reason: "login" | "legendary";
  /**
   * "page"  — full-page blocker; wrap this in <Layout> at the call site.
   * "panel" — inline amber dashed-border box embedded inside content areas.
   */
  variant?: "page" | "panel";
  /**
   * Panel size (ignored when variant="page"):
   * "lg" — centered with flex-1 grow, max-w-sm inner box, w-8 icon.
   * "sm" — inline box in-place, no centering wrapper, w-6 icon.
   */
  size?: "sm" | "lg";
  /** Override the default description text. */
  description?: string;
  /**
   * Path to redirect back to after login (page & panel variants).
   * Defaults to window.location.pathname when not provided.
   */
  returnTo?: string;
  className?: string;
}

function loginHref(returnTo?: string) {
  const path =
    returnTo ??
    (typeof window !== "undefined" ? window.location.pathname : "/");
  return `/login?from=${encodeURIComponent(path)}`;
}

/**
 * AccessGate — single source of truth for every "not allowed" state in the app.
 *
 * Usage (page-level, must be wrapped in <Layout> by the caller):
 *   <Layout><AccessGate variant="page" reason="login" /></Layout>
 *
 * Usage (inline panel):
 *   <AccessGate reason="legendary" size="sm" description="Upload photos with Legendary." />
 */
export function AccessGate({
  reason,
  variant = "panel",
  size = "lg",
  description,
  returnTo,
  className,
}: AccessGateProps) {
  const [, setLocation] = useLocation();

  // ── Page variant ─────────────────────────────────────────────────────────────
  if (variant === "page") {
    const title =
      reason === "login" ? "Restricted Area" : "Legendary Required";
    const defaultDesc =
      reason === "login"
        ? "You must be logged in to access this page."
        : "This page requires a Legendary membership.";
    const actionLabel =
      reason === "login" ? "Login to Continue" : "Go Legendary";
    const actionHref =
      reason === "login" ? loginHref(returnTo) : "/pricing";

    return (
      <div className={cn("max-w-2xl mx-auto px-4 py-24 text-center", className)}>
        <ShieldAlert className="w-20 h-20 text-primary mx-auto mb-6 opacity-80" />
        <h1 className="text-4xl font-display uppercase mb-4 text-foreground">
          {title}
        </h1>
        <p className="text-muted-foreground text-xl mb-8">
          {description ?? defaultDesc}
        </p>
        <div className="flex gap-4 justify-center">
          <Link href={actionHref}>
            <Button size="lg">{actionLabel}</Button>
          </Link>
          <Button
            size="lg"
            variant="outline"
            onClick={() =>
              typeof window !== "undefined" && window.history.length > 1
                ? window.history.back()
                : setLocation("/")
            }
          >
            Go Back
          </Button>
        </div>
      </div>
    );
  }

  // ── Panel variant ─────────────────────────────────────────────────────────────
  const isLg = size === "lg";
  const iconSize = isLg ? "w-8 h-8" : "w-6 h-6";
  const padding = isLg ? "p-8 space-y-3" : "p-5 space-y-2";

  const title = reason === "login" ? "Login Required" : "Legendary Feature";
  const defaultDesc =
    reason === "login"
      ? "Log in to access this feature."
      : "This feature is exclusive to Legendary members.";
  const actionLabel = reason === "login" ? "Login" : "Go Legendary";
  const actionHref = reason === "login" ? loginHref(returnTo) : "/pricing";

  const innerBox = (
    <div
      className={cn(
        "border-2 border-dashed border-amber-400/30 bg-amber-400/5 text-center",
        padding,
        isLg && "max-w-sm w-full",
        !isLg && className
      )}
    >
      <Lock className={cn(iconSize, "text-amber-400 mx-auto")} />
      <p className="text-sm font-bold text-amber-400 uppercase tracking-wider">
        {title}
      </p>
      <p className="text-xs text-muted-foreground">{description ?? defaultDesc}</p>
      <Link href={actionHref}>
        <Button size="sm" className="mt-1">
          {actionLabel}
        </Button>
      </Link>
    </div>
  );

  if (isLg) {
    return (
      <div className={cn("flex-1 flex items-center justify-center p-8", className)}>
        {innerBox}
      </div>
    );
  }

  return innerBox;
}

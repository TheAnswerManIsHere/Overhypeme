/**
 * @purpose The one treatment for a control that would save something while the site is read-only (#1109, plan D1): grayed out, does nothing when clicked or tapped (including inside a clickable card, and a link does not navigate), and explains why on hover, on keyboard focus and on tap, in the banner's words. While the site is not paused it renders the control untouched.
 * @subsystem operations
 */
import { cloneElement, isValidElement, useEffect, useId, useState, type ReactElement, type ReactNode } from "react";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { isReadOnlyNow, onReadOnlyChange, READ_ONLY_EXPLANATION } from "@/lib/readOnlyNotice";
import { cn } from "@/lib/utils";

/** Whether this page knows the site is paused; re-renders when that changes. */
export function useReadOnly(): boolean {
  const [on, setOn] = useState(isReadOnlyNow());
  useEffect(() => {
    setOn(isReadOnlyNow());
    return onReadOnlyChange(setOn);
  }, []);
  return on;
}

/** How long a tap's explanation stays up on a touch screen. */
const TAP_EXPLANATION_MS = 5000;

interface Props {
  /** The control: a button, a link, or a group of them (everything inside is made inert). */
  children: ReactNode;
  /** Layout classes for the wrapper while paused, e.g. "w-full" for a full-width button. */
  className?: string;
  /** Pause regardless of the site's state (tests and stories only). */
  forcePaused?: boolean;
}

export function PausedWhenReadOnly({ children, className, forcePaused }: Props) {
  const siteReadOnly = useReadOnly();
  const paused = forcePaused ?? siteReadOnly;
  const [open, setOpen] = useState(false);
  const explanationId = useId();

  useEffect(() => {
    if (!paused) setOpen(false);
  }, [paused]);
  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => setOpen(false), TAP_EXPLANATION_MS);
    return () => window.clearTimeout(t);
  }, [open]);

  if (!paused) return <>{children}</>;

  const control = isValidElement(children)
    ? cloneElement(children as ReactElement<Record<string, unknown>>, {
        disabled: true,
        "aria-disabled": true,
        tabIndex: -1,
      })
    : children;

  const block = (e: { preventDefault: () => void; stopPropagation: () => void }) => {
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <span
          data-testid="read-only-paused"
          role="button"
          tabIndex={0}
          aria-disabled="true"
          aria-describedby={explanationId}
          className={cn("relative inline-flex cursor-not-allowed rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary", className)}
          onClick={(e) => {
            block(e);
            setOpen(true);
          }}
          onPointerDown={(e) => e.stopPropagation()}
          onPointerEnter={(e) => {
            if (e.pointerType === "mouse") setOpen(true);
          }}
          onPointerLeave={(e) => {
            if (e.pointerType === "mouse") setOpen(false);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              block(e);
              setOpen(true);
            }
          }}
        >
          <span inert className="pointer-events-none inline-flex w-full grayscale opacity-50">{control}</span>
          <span id={explanationId} className="sr-only">
            {READ_ONLY_EXPLANATION}
          </span>
        </span>
      </PopoverAnchor>
      <PopoverContent
        side="top"
        role="tooltip"
        data-testid="read-only-explanation"
        className="w-auto max-w-xs p-3 text-sm leading-snug"
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        {READ_ONLY_EXPLANATION}
      </PopoverContent>
    </Popover>
  );
}

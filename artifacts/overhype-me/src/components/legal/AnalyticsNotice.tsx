/**
 * @purpose Tells every visitor, once per browser, what analytics and error monitoring run and links to the Privacy page (launch Phase 14, increment 2, oracle item 5); a notice, not a consent manager, while the EEA and UK are not served. Phase 16's analytics work adopts this surface.
 * @subsystem public-site
 */
import { useState } from "react";
import { Link } from "wouter";

/** Bump the suffix when the notice's wording changes in substance, so every browser sees it again. */
export const ANALYTICS_NOTICE_KEY = "overhype.analyticsNotice.v1";

function alreadySeen(): boolean {
  try {
    return window.localStorage.getItem(ANALYTICS_NOTICE_KEY) === "seen";
  } catch {
    return false;
  }
}

export function AnalyticsNotice() {
  const [open, setOpen] = useState(() => !alreadySeen());
  if (!open) return null;
  const dismiss = () => {
    try {
      window.localStorage.setItem(ANALYTICS_NOTICE_KEY, "seen");
    } catch {
      // Storage refused (private mode): the notice closes for this visit only.
    }
    setOpen(false);
  };
  return (
    <div
      role="region"
      aria-label="How this site measures visits"
      data-testid="analytics-notice"
      className="fixed z-30 left-3 right-3 bottom-20 md:bottom-4 md:left-auto md:right-4 md:max-w-sm bg-card border border-border shadow-lg p-4 text-sm text-muted-foreground"
    >
      <p>
        We count visits with Google Analytics, and our error-monitoring service records some visits with
        everything you type and all text on the page hidden, so we can fix problems. Read our{" "}
        <Link href="/privacy" className="underline text-foreground hover:text-primary">Privacy Policy</Link>.
      </p>
      <button
        type="button"
        onClick={dismiss}
        className="mt-3 px-4 py-2 bg-primary text-primary-foreground font-semibold uppercase tracking-wide text-xs"
      >
        Got it
      </button>
    </div>
  );
}

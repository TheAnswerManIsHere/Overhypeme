/**
 * @purpose The site-wide notice while read-only mode is on (launch Phase 16, increment 4): learned from the public config, re-read every minute and when the tab returns, and from any refused request; a refused action also shows the short message as a toast, and the form that sent it keeps what was typed.
 * @subsystem operations
 */
import { useEffect, useState } from "react";
import { toast } from "@/hooks/use-toast";
import {
  isReadOnlyNow,
  onReadOnlyChange,
  onReadOnlyRefusal,
  READ_ONLY_REFUSED_MESSAGE,
  setReadOnlyNow,
} from "@/lib/readOnlyNotice";

const POLL_MS = 60_000;

async function readSwitch(): Promise<void> {
  try {
    const res = await fetch("/api/config", { credentials: "include" });
    if (!res.ok) return;
    const body = (await res.json()) as { readOnlyMode?: unknown };
    if (typeof body.readOnlyMode === "boolean") setReadOnlyNow(body.readOnlyMode);
  } catch {
    /* keep what is known */
  }
}

export function ReadOnlyNotice() {
  const [on, setOn] = useState(isReadOnlyNow());

  useEffect(() => {
    const offChange = onReadOnlyChange(setOn);
    const offRefusal = onReadOnlyRefusal(() => {
      toast({ title: "Paused for a moment", description: READ_ONLY_REFUSED_MESSAGE });
    });
    void readSwitch();
    const timer = window.setInterval(() => void readSwitch(), POLL_MS);
    const onVisible = () => { if (document.visibilityState === "visible") void readSwitch(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      offChange();
      offRefusal();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  if (!on) return null;
  return (
    <div
      role="status"
      data-testid="read-only-notice"
      className="relative z-[60] w-full bg-primary text-primary-foreground text-center text-sm font-medium px-4 py-1.5 shadow"
    >
      Overhype.me is undergoing maintenance. Real men get pedicures. Keep browsing but the site is read-only until we're done waiting for our toes to dry.
    </div>
  );
}

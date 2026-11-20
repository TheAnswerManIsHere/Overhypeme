/**
 * @purpose The site-wide notice while read-only mode is on (launch Phase 16, increment 4): learned from the public config, re-read every minute and when the tab returns, and from any refused request; a refused action also shows the short message as a toast, and the form that sent it keeps what was typed.
 * @subsystem operations
 */
import { useEffect, useRef } from "react";
import { useLocation } from "wouter";
import { toast } from "@/hooks/use-toast";
import {
  READ_ONLY_ADMIN_WARNING,
  READ_ONLY_EXPLANATION,
  onReadOnlyRefusal,
  READ_ONLY_REFUSED_MESSAGE,
  READ_ONLY_REFUSED_TITLE,
  fetchReadOnlyFlag,
  setReadOnlyNow,
} from "@/lib/readOnlyNotice";
import { useReadOnly } from "@/hooks/use-read-only";

const POLL_MS = 60_000;

/**
 * The notice's height, as a CSS variable on the root element (0px while it is
 * hidden). Shells pinned to the viewport's top (the admin layout, the meme
 * builder) start below it with `top-[var(--read-only-notice-h,0px)]`, so the
 * notice pushes them down instead of covering them; in-flow pages are pushed
 * down by the notice itself.
 */
export const NOTICE_HEIGHT_VAR = "--read-only-notice-h";

async function readSwitch(): Promise<void> {
  const flag = await fetchReadOnlyFlag();
  if (flag !== null) setReadOnlyNow(flag); // a failed read keeps what is known
}

export function ReadOnlyNotice() {
  const on = useReadOnly();

  useEffect(() => {
    const offRefusal = onReadOnlyRefusal(() => {
      toast({ title: READ_ONLY_REFUSED_TITLE, description: READ_ONLY_REFUSED_MESSAGE });
    });
    void readSwitch();
    const timer = window.setInterval(() => void readSwitch(), POLL_MS);
    const onVisible = () => { if (document.visibilityState === "visible") void readSwitch(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      offRefusal();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = document.documentElement;
    const el = ref.current;
    if (!on || !el) {
      root.style.setProperty(NOTICE_HEIGHT_VAR, "0px");
      return;
    }
    const write = () => root.style.setProperty(NOTICE_HEIGHT_VAR, `${el.offsetHeight}px`);
    write();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(write);
    observer?.observe(el);
    window.addEventListener("resize", write);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", write);
      root.style.setProperty(NOTICE_HEIGHT_VAR, "0px");
    };
  }, [on]);

  // Admin screens say what still works for an admin, and when not to (#1109 D6).
  const [path] = useLocation();
  const base = import.meta.env.BASE_URL.replace(/\/$/, "");
  const admin = /^\/admin(\/|$)/.test(path.startsWith(base) ? path.slice(base.length) || "/" : path);

  if (!on) return null;
  return (
    <div
      ref={ref}
      role="status"
      data-testid="read-only-notice"
      data-audience={admin ? "admin" : "public"}
      className="relative z-[60] w-full bg-primary text-primary-foreground text-center text-sm font-medium px-4 py-1.5 shadow"
    >
      {admin ? READ_ONLY_ADMIN_WARNING : READ_ONLY_EXPLANATION}
    </div>
  );
}

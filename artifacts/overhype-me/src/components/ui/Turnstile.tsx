/**
 * @purpose The Cloudflare Turnstile widget (launch Phase 5, increment 1, #795): loads Cloudflare's script once per page, renders one widget explicitly, reports its token to the caller and clears it on expiry or error, and exposes reset() so a form can ask for a fresh single-use token after a failed submit.
 * @subsystem security
 */
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";

/** The public site key. Unset falls back to Cloudflare's documented always-pass
 *  test key, whose tokens a real secret rejects — so a deploy that forgot the
 *  key fails closed at the server, never open. */
export const TURNSTILE_SITE_KEY: string =
  import.meta.env.VITE_TURNSTILE_SITE_KEY || "1x00000000000000000000AA";

const SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

interface TurnstileApi {
  render(container: HTMLElement, options: Record<string, unknown>): string;
  reset(widgetId?: string): void;
  remove(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let scriptPromise: Promise<TurnstileApi> | null = null;

/** Loads Cloudflare's script once; later callers share the same promise. */
export function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SCRIPT_URL;
    script.async = true;
    script.onload = () => {
      if (window.turnstile) resolve(window.turnstile);
      else reject(new Error("Turnstile script loaded without window.turnstile"));
    };
    script.onerror = () => {
      scriptPromise = null; // a later mount may retry
      reject(new Error("Turnstile script failed to load"));
    };
    document.head.appendChild(script);
  });
  return scriptPromise;
}

/** Test seam: forget the cached load so each test starts clean. */
export function __resetTurnstileLoaderForTests(): void {
  scriptPromise = null;
}

export interface TurnstileHandle {
  reset(): void;
}

export interface TurnstileProps {
  onVerify: (token: string) => void;
  /** Called when the token lapses (five minutes) or the widget errors; the caller clears its stored token. */
  onExpire?: () => void;
  theme?: "light" | "dark" | "auto";
  size?: "normal" | "compact" | "flexible";
  className?: string;
}

export const Turnstile = forwardRef<TurnstileHandle, TurnstileProps>(function Turnstile(
  { onVerify, onExpire, theme = "dark", size = "normal", className },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);
  const apiRef = useRef<TurnstileApi | null>(null);
  // Latest callbacks without re-rendering the widget when a parent re-renders.
  const onVerifyRef = useRef(onVerify);
  const onExpireRef = useRef(onExpire);
  onVerifyRef.current = onVerify;
  onExpireRef.current = onExpire;

  useImperativeHandle(ref, () => ({
    reset() {
      if (apiRef.current && widgetIdRef.current) apiRef.current.reset(widgetIdRef.current);
    },
  }), []);

  useEffect(() => {
    let cancelled = false;
    loadTurnstile()
      .then((api) => {
        if (cancelled || !containerRef.current) return;
        apiRef.current = api;
        widgetIdRef.current = api.render(containerRef.current, {
          sitekey: TURNSTILE_SITE_KEY,
          theme,
          size,
          callback: (token: string) => onVerifyRef.current(token),
          "expired-callback": () => onExpireRef.current?.(),
          "error-callback": () => onExpireRef.current?.(),
        });
      })
      .catch(() => {
        // The form stays disabled without a token; nothing else to do here.
      });
    return () => {
      cancelled = true;
      if (apiRef.current && widgetIdRef.current) apiRef.current.remove(widgetIdRef.current);
      widgetIdRef.current = null;
    };
  }, [theme, size]);

  return <div ref={containerRef} className={className} data-testid="turnstile-widget" />;
});

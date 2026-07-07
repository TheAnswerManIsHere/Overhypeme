import { lazy } from "react";

/**
 * Like React.lazy(), but automatically retries a failed dynamic import once
 * after a short delay. If the retry also fails, the page is force-reloaded —
 * but at most once every RELOAD_COOLDOWN_MS milliseconds. A sessionStorage
 * timestamp prevents rapid reload loops when the Vite dev server is unstable
 * or a deploy left truly missing chunks, while still allowing recovery after
 * the server has stabilised (e.g. after an HMR reconnect a few seconds later).
 *
 * This handles two real-world failure modes:
 *  1. Dev server restart — the Vite dev server restarted mid-navigation and
 *     old chunk URLs are no longer valid. A fresh fetch after ~400 ms picks up
 *     the new URLs.
 *  2. Post-deploy stale chunks — after a production deploy the old browser
 *     page tries to load chunk URLs that no longer exist. A page reload fetches
 *     the current HTML and resolves everything.
 */

const RELOAD_FLAG = "lazy-retry:reloaded-at";
const RELOAD_COOLDOWN_MS = 10_000;

export function lazyWithRetry<T extends React.ComponentType<object>>(
  factory: () => Promise<{ default: T }>,
): React.LazyExoticComponent<T> {
  return lazy(() =>
    factory().catch(
      () =>
        new Promise<{ default: T }>((resolve, reject) => {
          setTimeout(() => {
            factory()
              .then(resolve)
              .catch((err) => {
                const storedAt = sessionStorage.getItem(RELOAD_FLAG);
                const lastReloadAge = storedAt
                  ? Date.now() - Number(storedAt)
                  : Infinity;

                if (lastReloadAge < RELOAD_COOLDOWN_MS) {
                  // Reloaded very recently and still failing — propagate so
                  // the Sentry ErrorBoundary shows the fallback instead of
                  // looping. The server likely needs more time; the user can
                  // manually retry via the "Reload Page" button.
                  reject(err);
                  return;
                }

                sessionStorage.setItem(RELOAD_FLAG, String(Date.now()));
                window.location.reload();
                // Leave the promise unsettled — the page is being replaced.
              });
          }, 400);
        }),
    ),
  );
}

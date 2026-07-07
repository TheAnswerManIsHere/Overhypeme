import { lazy } from "react";

/**
 * Like React.lazy(), but automatically retries a failed dynamic import once
 * after a short delay. If the retry also fails, the page is force-reloaded —
 * but only once per page load. A sessionStorage flag prevents the reload from
 * looping when the Vite dev server is still restarting or a deploy left truly
 * missing chunks.
 *
 * This handles two real-world failure modes:
 *  1. Dev server restart — the Vite dev server restarted mid-navigation and
 *     old chunk URLs are no longer valid. A fresh fetch after ~400 ms picks up
 *     the new URLs.
 *  2. Post-deploy stale chunks — after a production deploy the old browser
 *     page tries to load chunk URLs that no longer exist. A page reload fetches
 *     the current HTML and resolves everything.
 */

const RELOAD_FLAG = "lazy-retry:reloaded";

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
                // Only reload once per page load. If we already reloaded and
                // chunks are still missing, propagate the error so the Sentry
                // ErrorBoundary can show the fallback UI instead of looping.
                if (sessionStorage.getItem(RELOAD_FLAG)) {
                  reject(err);
                  return;
                }
                sessionStorage.setItem(RELOAD_FLAG, "1");
                window.location.reload();
                // Leave the promise unsettled — the page is being replaced.
              });
          }, 400);
        }),
    ),
  );
}

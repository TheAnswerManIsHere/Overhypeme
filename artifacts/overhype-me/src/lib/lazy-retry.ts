import { lazy } from "react";

/**
 * Like React.lazy(), but automatically retries a failed dynamic import once
 * after a short delay. If the retry also fails, the page is force-reloaded.
 *
 * This handles two real-world failure modes:
 *  1. Dev server restart — the Vite dev server restarted mid-navigation and
 *     old chunk URLs are no longer valid. A fresh fetch after ~400 ms picks up
 *     the new URLs.
 *  2. Post-deploy stale chunks — after a production deploy the old browser
 *     page tries to load chunk URLs that no longer exist. A page reload fetches
 *     the current HTML and resolves everything.
 */
export function lazyWithRetry<T extends React.ComponentType<object>>(
  factory: () => Promise<{ default: T }>,
): React.LazyExoticComponent<T> {
  return lazy(() =>
    factory().catch(
      () =>
        new Promise<{ default: T }>((resolve) => {
          setTimeout(() => {
            factory()
              .then(resolve)
              .catch(() => {
                // Trigger a full reload to fetch fresh chunk URLs. We
                // intentionally never settle this promise — the page is being
                // replaced, so propagating a rejection would only surface as
                // noise in Sentry via the Suspense error boundary.
                window.location.reload();
              });
          }, 400);
        }),
    ),
  );
}

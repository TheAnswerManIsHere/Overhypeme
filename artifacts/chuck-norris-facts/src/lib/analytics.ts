declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void;
    dataLayer?: unknown[];
  }
}

export function trackPageView(path: string, title?: string) {
  const gaId = import.meta.env.VITE_GA_MEASUREMENT_ID as string | undefined;
  if (!gaId || !window.gtag) return;
  window.gtag("config", gaId, {
    page_path: path,
    page_title: title,
  });
}

export function trackEvent(
  eventName: string,
  params?: Record<string, string | number | boolean>,
) {
  if (!window.gtag) return;
  window.gtag("event", eventName, params ?? {});
}

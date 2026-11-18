/**
 * @purpose admitAndStart: asks the API once whether this visit is admitted (GET /api/admission) and only on a 200 starts error monitoring, Google Analytics and ads, recording the first page view; on 451 (a place the site does not serve) sends the visitor to the explanation page; on anything else starts nothing.
 * @subsystem public-site
 *
 * Launch Phase 14, increment 3 (plan S-e2, the floor): "the app starts no
 * analytics and no error monitoring until the API — which is behind S-e — has
 * answered that this request is admitted, so a visitor who goes around
 * Cloudflare, or one in a blocked region, gets the app's code and the
 * explanation and nothing is collected about them".
 */
import { startMonitoring } from "./sentry";
import { trackPageView } from "./analytics";

declare global {
  interface Window {
    __ohStartAnalytics?: () => void;
    __ohStartAds?: () => void;
  }
}

export type Admission = "admitted" | "blocked" | "refused";

export const EXPLANATION_PATH = "/unavailable";

export async function admitAndStart(
  fetchImpl: typeof fetch = fetch,
  location: Pick<Location, "replace" | "pathname"> = window.location,
): Promise<Admission> {
  let status: number;
  try {
    status = (await fetchImpl("/api/admission", { credentials: "include", cache: "no-store" })).status;
  } catch {
    return "refused";
  }
  if (status === 451) {
    location.replace(EXPLANATION_PATH);
    return "blocked";
  }
  if (status !== 200) return "refused";
  startMonitoring();
  window.__ohStartAnalytics?.();
  window.__ohStartAds?.();
  // The router's first page view fired before analytics existed.
  trackPageView(location.pathname, document.title);
  return "admitted";
}

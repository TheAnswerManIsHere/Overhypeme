/**
 * @purpose admitAndStart: asks the API once whether this visit is admitted (GET /api/admission) and starts everything sent to third parties (lib/telemetry.ts) only on the API's explicit yes — not redirected, 200, JSON `admitted: true` (page views and funnel events made while it was pending are held by lib/analytics and sent then); a 451, or a redirect that lands on the explanation page (Cloudflare's geography rule), sends the visitor to /unavailable; anything else starts nothing.
 * @subsystem public-site
 *
 * Launch Phase 14, increment 3 (plan S-e2, the floor): "the app starts no
 * analytics and no error monitoring until the API — which is behind S-e — has
 * answered that this request is admitted, so a visitor who goes around
 * Cloudflare, or one in a blocked region, gets the app's code and the
 * explanation and nothing is collected about them".
 *
 * Redirects are followed, never `redirect: "manual"`: a manual redirect is
 * opaque, so the geography rule could not be told from any other (PR #1063
 * round 1). The body is always read, which also lets the request finish.
 */
import { startTelemetry } from "./telemetry";

export type Admission = "admitted" | "blocked" | "refused";

export const EXPLANATION_PATH = "/unavailable";

function landedOnExplanation(res: Response): boolean {
  try {
    return new URL(res.url, "http://local").pathname === EXPLANATION_PATH;
  } catch {
    return false;
  }
}

async function saysAdmitted(res: Response): Promise<boolean> {
  if (res.redirected || res.status !== 200) return false;
  try {
    const body: unknown = await res.json();
    return typeof body === "object" && body !== null && (body as { admitted?: unknown }).admitted === true;
  } catch {
    return false;
  }
}

export async function admitAndStart(
  fetchImpl: typeof fetch = fetch,
  location: Pick<Location, "replace" | "pathname"> = window.location,
): Promise<Admission> {
  let res: Response;
  try {
    res = await fetchImpl("/api/admission", { credentials: "include", cache: "no-store" });
  } catch {
    return "refused";
  }
  if (res.status === 451 || (res.redirected && landedOnExplanation(res))) {
    void res.body?.cancel().catch(() => {});
    location.replace(EXPLANATION_PATH);
    return "blocked";
  }
  if (!(await saysAdmitted(res))) {
    void res.body?.cancel().catch(() => {});
    return "refused";
  }
  // Page views and funnel events made while this check was pending are held
  // by lib/analytics and sent, in order, as it starts.
  startTelemetry();
  return "admitted";
}

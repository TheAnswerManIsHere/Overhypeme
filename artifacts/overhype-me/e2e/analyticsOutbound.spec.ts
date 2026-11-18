/**
 * Launch Phase 16, increment 3 (plan PLAN_PHASE16_ANALYTICS_OPERATIONS.md,
 * Acceptance, Analytics): what actually leaves the browser for GA4 and
 * PostHog, read from the wire, on a fresh browser that has not dismissed the
 * notice.
 *
 * Runs on the production-mode stack (`e2e:auth`, port 5174), whose web server
 * is built with a test GA4 ID and a test PostHog key (build.yml). Requests to
 * PostHog and to GA4's collection address are answered here and never reach
 * either vendor. Google's real script loads, so its hits are read from the
 * wire; the command queue the module feeds (`window.dataLayer`) is read too,
 * so the page-view count does not depend on Google's script loading.
 *
 * Proves: one page view per page shown, back and forward included; a
 * personalised landing link, a search and a sign-up carry none of the name,
 * the search words or the email to either vendor; a sign-up is counted; the
 * member is known by internal id; sign-out forgets them.
 */
import { gunzipSync } from "node:zlib";
import { randomUUID } from "node:crypto";
import { expect, test, type Page, type Request } from "@playwright/test";

// A fresh browser, and an ordinary browser's identity: PostHog drops events
// from a browser that looks automated, as headless Chromium does (see the
// init script below for the rest of that disguise).
test.use({
  storageState: { cookies: [], origins: [] },
  userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
});

const NAME = "Zebulonia";
const SEARCH_WORD = "Quixotic";

type PhEvent = { event: string; properties?: Record<string, unknown>; [k: string]: unknown };

function decodePosthog(req: Request): PhEvent[] {
  const url = new URL(req.url());
  const buf = req.postDataBuffer();
  if (!buf) return [];
  let text: string;
  // PostHog gzips a batch when the browser can; the body then starts with gzip's magic bytes.
  if (buf[0] === 0x1f && buf[1] === 0x8b) text = gunzipSync(buf).toString("utf8");
  else text = buf.toString("utf8");
  void url;
  if (text.startsWith("data=")) text = Buffer.from(decodeURIComponent(text.slice(5)), "base64").toString("utf8");
  const parsed = JSON.parse(text) as PhEvent | PhEvent[] | { batch: PhEvent[] };
  if (Array.isArray(parsed)) return parsed;
  if ("batch" in parsed && Array.isArray(parsed.batch)) return parsed.batch;
  return [parsed as PhEvent];
}

async function spa(page: Page, path: string): Promise<void> {
  await page.evaluate((p) => window.history.pushState({}, "", p), path);
  await page.waitForURL((u) => u.pathname === path.split("?")[0]);
}

test("analytics send route patterns and funnel events, never a name, a search or an email", async ({ page }) => {
  test.setTimeout(120_000);
  const phEvents: PhEvent[] = [];
  const phRaw: string[] = [];
  const gaCommands: unknown[][] = [];
  const gaHits: string[] = [];

  await page.route(/https:\/\/[a-z0-9.-]*google-analytics\.com\/.*collect.*/, async (route) => {
    const req = route.request();
    gaHits.push(decodeURIComponent(`${req.url()}\n${req.postData() ?? ""}`));
    await route.fulfill({ status: 204, body: "" });
  });
  await page.route("https://us.i.posthog.com/**", async (route) => {
    const req = route.request();
    if (req.method() === "POST") {
      phRaw.push(req.url());
      phEvents.push(...decodePosthog(req));
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: "{\"status\":1}" });
  });
  await page.exposeBinding("__recordGa", (_src, json: string) => { gaCommands.push(JSON.parse(json) as unknown[]); });
  // PostHog also reads the automation flag and the browser's brand list
  // ("HeadlessChrome") to spot bots; this browser presents as an ordinary one.
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "webdriver", { get: () => false });
    Object.defineProperty(Navigator.prototype, "userAgentData", { get: () => undefined });
  });
  await page.addInitScript(() => {
    const queue: unknown[] = [];
    const push = queue.push.bind(queue);
    (queue as { push: (...a: unknown[]) => number }).push = (...items: unknown[]) => {
      for (const item of items) {
        try {
          (window as unknown as { __recordGa: (s: string) => void }).__recordGa(JSON.stringify(Array.from(item as ArrayLike<unknown>)));
        } catch { /* a non-serialisable command is not ours */ }
      }
      return push(...items);
    };
    (window as unknown as { dataLayer: unknown[] }).dataLayer = queue;
  });

  // A personalised landing link, a search, then in-app navigation with back and forward.
  // PostHog sends in batches; each full page load waits for the previous
  // page's view to arrive, so the count measures the app, not the batching.
  const pageViews = () => phEvents.filter((e) => e.event === "$pageview").length;
  await page.goto(`/facts/1?displayName=${NAME}&pronouns=she%2Fher`);
  await expect(page.getByTestId("analytics-notice"), "a fresh browser sees the notice").toBeVisible();
  await expect.poll(pageViews, { timeout: 15_000 }).toBe(1);
  await page.goto(`/search?q=${SEARCH_WORD}`);
  await spa(page, "/pricing");
  await page.goBack();
  await page.waitForURL((u) => u.pathname === "/search");
  await page.goForward();
  await page.waitForURL((u) => u.pathname === "/pricing");
  await expect.poll(pageViews, { timeout: 15_000 }).toBeGreaterThanOrEqual(5);

  const views = phEvents.filter((e) => e.event === "$pageview").map((e) => e.properties?.["$pathname"]);
  expect(views.slice(0, 5), "one page view per page shown, as its pattern").toEqual(["/facts/:id", "/search", "/pricing", "/search", "/pricing"]);
  const gaViews = gaCommands.filter((c) => c[0] === "event" && c[1] === "page_view");
  expect(gaViews.map((c) => (c[2] as { page_title?: string }).page_title).slice(0, 5)).toEqual(["/facts/:id", "/search", "/pricing", "/search", "/pricing"]);

  // Sign up through the real form, then sign out.
  const email = `analytics-${randomUUID()}@test.local`;
  await page.goto("/login");
  await page.getByRole("button", { name: "Sign up" }).click();
  await page.getByPlaceholder("your@email.com").fill(email);
  await page.getByPlaceholder(/How facts will address you/).fill(NAME);
  await page.getByPlaceholder("First").fill(NAME);
  await page.getByPlaceholder("Last").fill("Tester");
  await page.getByPlaceholder("Min 8 characters").fill(`Pw-${randomUUID()}`);
  await page.getByRole("button", { name: /create account/i }).click();
  await expect(page.getByRole("heading", { name: "CHECK YOUR EMAIL" })).toBeVisible();
  const me = (await page.evaluate(async () => (await (await fetch("/api/auth/user", { credentials: "include" })).json()) as { user?: { id?: string } })).user;
  expect(me?.id).toBeTruthy();

  await expect.poll(() => phEvents.some((e) => e.event === "sign_up"), { timeout: 15_000 }).toBe(true);
  expect(phEvents.find((e) => e.event === "sign_up")?.properties?.["method"]).toBe("password");
  expect(gaCommands).toContainEqual(["event", "sign_up", { method: "password" }]);

  // The member is known once the app has read the new session, on the next
  // page it loads: by internal id, never by email.
  await page.goto("/check-email");
  await expect.poll(() => phEvents.some((e) => e.event === "$identify"), { timeout: 15_000 }).toBe(true);
  const identifyEvent = phEvents.find((e) => e.event === "$identify")!;
  expect(identifyEvent.properties?.["distinct_id"] ?? identifyEvent["distinct_id"], "known by internal id").toBe(me!.id);
  expect(gaCommands).toContainEqual(["set", { user_id: me!.id }]);

  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForURL((u) => u.pathname === "/");
  await expect.poll(() => gaCommands.some((c) => c[0] === "set" && (c[1] as { user_id?: unknown }).user_id === null), { timeout: 15_000 }).toBe(true);

  // Nothing personal on the wire, to either vendor.
  const wire = JSON.stringify({ phEvents, phRaw, gaCommands, gaHits });
  for (const secret of [NAME, SEARCH_WORD, email, "Tester"]) {
    expect(wire.includes(secret), `"${secret}" was sent to an analytics vendor`).toBe(false);
  }
  expect(phEvents.some((e) => String(e.event).startsWith("$snapshot")), "no session recording").toBe(false);
  expect(phEvents.some((e) => e.event === "$autocapture"), "no autocapture").toBe(false);
});

test("no session replay request is made to Sentry", async ({ page }) => {
  const replay: string[] = [];
  page.on("request", (req) => {
    if (/sentry/.test(req.url()) && /replay/i.test(req.postData() ?? "")) replay.push(req.url());
  });
  await page.goto("/search");
  await page.waitForLoadState("networkidle");
  expect(replay).toEqual([]);
});

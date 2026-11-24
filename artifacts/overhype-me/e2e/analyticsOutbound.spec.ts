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
 * the search words or the email to either vendor; GA4's hits are seen on the
 * wire, the first carrying the pattern; a personalised link counts once, on
 * landing; a funnel event after an in-app navigation (the meme builder,
 * reached from its fact page) is filed under its own page; a sign-up is
 * counted; the member is
 * known by internal id; a lapsed session's next visit is not sent under that
 * id; sign-out forgets them.
 */
import { gunzipSync } from "node:zlib";
import { randomUUID } from "node:crypto";
import { expect, test, type Page, type Request } from "@playwright/test";
import { factDetail, stubPublicFacts } from "./helpers/apiStubs";
import { PAID_ACCOUNT, TEST_ACCOUNT_PASSWORD, currentUser, signInThroughForm, submitLoginForm } from "./helpers/testAccounts";

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
  const buf = req.postDataBuffer();
  if (!buf) return [];
  let text: string;
  // PostHog gzips a batch when the browser can; the body then starts with gzip's magic bytes.
  if (buf[0] === 0x1f && buf[1] === 0x8b) text = gunzipSync(buf).toString("utf8");
  else text = buf.toString("utf8");
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

/** What left for the two vendors, as the page sent it; `googleScript()` says whether Google's own script loaded. */
interface AnalyticsCapture {
  phEvents: PhEvent[];
  phRaw: string[];
  gaCommands: unknown[][];
  gaHits: string[];
  /** Google's hits as sent, one per event (a request may batch several, one per body line). */
  gaWire: URLSearchParams[];
  googleScript: () => "loaded" | "failed" | "pending";
}

/** Answer both vendors' collection addresses here, record what was sent, and disguise the browser as an ordinary one. */
async function captureAnalytics(page: Page): Promise<AnalyticsCapture> {
  const phEvents: PhEvent[] = [];
  const phRaw: string[] = [];
  const gaCommands: unknown[][] = [];
  const gaHits: string[] = [];
  const gaWire: URLSearchParams[] = [];

  await page.route(/https:\/\/[a-z0-9.-]*google-analytics\.com\/.*collect.*/, async (route) => {
    const req = route.request();
    gaHits.push(decodeURIComponent(`${req.url()}\n${req.postData() ?? ""}`));
    const shared = new URL(req.url()).searchParams;
    const lines = (req.postData() ?? "").split("\n").filter(Boolean);
    for (const line of lines.length ? lines : [""]) {
      const hit = new URLSearchParams(shared);
      for (const [k, v] of new URLSearchParams(line)) hit.set(k, v);
      gaWire.push(hit);
    }
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
  // Whether Google's own script loaded. It comes from Google, not this stack,
  // so a CI runner that cannot reach Google skips the checks that read
  // Google's hits off the wire, with a message, rather than failing every PR.
  let gtagScript: "loaded" | "failed" | "pending" = "pending";
  page.on("response", (r) => { if (r.url().includes("googletagmanager.com/gtag/js")) gtagScript = r.ok() ? "loaded" : "failed"; });
  page.on("requestfailed", (r) => { if (r.url().includes("googletagmanager.com/gtag/js")) gtagScript = "failed"; });
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
  return { phEvents, phRaw, gaCommands, gaHits, gaWire, googleScript: () => gtagScript };
}

test("analytics send route patterns and funnel events, never a name, a search or an email", async ({ page }) => {
  test.setTimeout(120_000);
  const { phEvents, phRaw, gaCommands, gaHits, gaWire, googleScript } = await captureAnalytics(page);

  // A personalised landing link, a search, then in-app navigation with back and forward.
  // PostHog sends in batches; each full page load waits for the previous
  // page's view to arrive, so the count measures the app, not the batching.
  const pageViews = () => phEvents.filter((e) => e.event === "$pageview").length;
  // The landing link also carries campaign tags: two clean ones that GA4 must
  // receive, and one holding the name, which neither vendor may.
  await page.goto(`/facts/1?displayName=${NAME}&pronouns=she%2Fher&utm_source=newsletter&utm_campaign=launch-week&utm_term=${NAME}%20Tester`);
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

  // The wire check can see Google's hits at all (Google's real script loads
  // here), so the absence checks below are not passing on an empty capture.
  await expect.poll(googleScript, { timeout: 20_000 }).not.toBe("pending");
  const googleOnWire = googleScript() === "loaded";
  if (!googleOnWire) {
    const message = "Google's script (googletagmanager.com) could not load on this runner, so the checks that read Google's own hits off the wire were skipped. The command queue the app feeds Google was still checked.";
    test.info().annotations.push({ type: "skipped: Google's hits on the wire", description: message });
    console.warn(`[analyticsOutbound] ${message}`);
  }
  if (googleOnWire) {
    await expect.poll(() => gaWire.filter((h) => h.get("en") === "page_view").length, { timeout: 20_000 }).toBeGreaterThanOrEqual(1);
    const firstHit = gaWire.find((h) => h.get("en") === "page_view")!;
    expect(firstHit.get("dl"), "the first hit on a personalised landing link carries the pattern and the clean campaign tags only")
      .toMatch(/\/facts\/:id\?utm_source=newsletter&utm_campaign=launch-week$/);
    expect(firstHit.get("dt")).toBe("/facts/:id");
  } else {
    // The same facts, read from the command queue instead of the wire.
    const firstSet = gaCommands.find((c) => c[0] === "set" && typeof (c[1] as { page_location?: unknown }).page_location === "string");
    expect((firstSet?.[1] as { page_location: string }).page_location).toMatch(/\/facts\/:id\?utm_source=newsletter&utm_campaign=launch-week$/);
  }

  // A friend arriving by a personalised link has personalised (David's Q16: 1):
  // counted once, on landing, filed under the landing page's pattern. Saving a
  // name later through the name tag on /pricing (reached in-app) counts nothing.
  if (googleOnWire) {
    await expect.poll(() => gaWire.some((h) => h.get("en") === "personalise"), { timeout: 20_000 }).toBe(true);
    const personaliseHit = gaWire.find((h) => h.get("en") === "personalise")!;
    expect(personaliseHit.get("dt"), "GA4 files the link's personalise under the landing page").toBe("/facts/:id");
    expect(personaliseHit.get("dl")).toMatch(/\/facts\/:id(\?utm_source=newsletter&utm_campaign=launch-week)?$/);
  } else {
    await expect.poll(() => gaCommands.some((c) => c[0] === "event" && c[1] === "personalise"), { timeout: 20_000 }).toBe(true);
  }
  await expect.poll(() => phEvents.some((e) => e.event === "personalise"), { timeout: 15_000 }).toBe(true);
  expect(phEvents.find((e) => e.event === "personalise")?.properties?.["$pathname"]).toBe("/facts/:id");
  await page.getByRole("button", { name: new RegExp(`^As: ${NAME}`) }).filter({ visible: true }).first().click();
  await page.getByPlaceholder("Your name").filter({ visible: true }).first().fill(NAME);
  await page.getByRole("button", { name: "Apply" }).filter({ visible: true }).first().click();
  await page.waitForTimeout(1500);
  expect(phEvents.filter((e) => e.event === "personalise"), "the name-tag save after the link counts nothing more").toHaveLength(1);
  expect(gaCommands.filter((c) => c[0] === "event" && c[1] === "personalise")).toHaveLength(1);

  // Sign up through the real form, then sign out.
  const email = `analytics-${randomUUID()}@test.local`;
  const password = `Pw-${randomUUID()}`;
  await page.goto("/login");
  await page.getByRole("button", { name: "Sign up" }).click();
  await page.getByPlaceholder("your@email.com").fill(email);
  await page.getByPlaceholder(/How facts will address you/).fill(NAME);
  await page.getByPlaceholder("First").fill(NAME);
  await page.getByPlaceholder("Last").fill("Tester");
  await page.getByPlaceholder("Min 8 characters").fill(password);
  await page.getByRole("button", { name: /create account/i }).click();
  await expect(page.getByRole("heading", { name: "CHECK YOUR EMAIL" })).toBeVisible();
  const userId = (await currentUser(page))?.["id"] as string | undefined;
  expect(userId).toBeTruthy();

  await expect.poll(() => phEvents.some((e) => e.event === "sign_up"), { timeout: 15_000 }).toBe(true);
  expect(phEvents.find((e) => e.event === "sign_up")?.properties?.["method"]).toBe("password");
  expect(gaCommands).toContainEqual(["event", "sign_up", { method: "password" }]);

  // The member is known once the app has read the new session, on the next
  // page it loads: by internal id, never by email.
  await page.goto("/check-email");
  await expect.poll(() => phEvents.some((e) => e.event === "$identify"), { timeout: 15_000 }).toBe(true);
  const identifyEvent = phEvents.find((e) => e.event === "$identify")!;
  expect(identifyEvent.properties?.["distinct_id"] ?? identifyEvent["distinct_id"], "known by internal id").toBe(userId);
  expect(gaCommands).toContainEqual(["set", { user_id: userId }]);

  // A session that lapses without a sign-out click (PostHog keeps its stored
  // identity): the next signed-out visit is never sent under the member's id,
  // its first page view included, and that page is counted once.
  const distinctId = (e: PhEvent) => e.properties?.["distinct_id"] ?? e["distinct_id"];
  // PostHog sends in batches: wait until the signed-in page's own view has
  // arrived, so what follows the mark was made after the lapse.
  await expect.poll(() => phEvents.some((e) => e.event === "$pageview" && e.properties?.["$pathname"] === "/check-email"), { timeout: 15_000 }).toBe(true);
  const beforeLapse = phEvents.length;
  await page.context().clearCookies();
  await page.goto("/top-facts");
  await expect.poll(() => phEvents.slice(beforeLapse).filter((e) => e.event === "$pageview").length, { timeout: 15_000 }).toBe(1);
  await page.waitForTimeout(4000);
  const afterLapse = phEvents.slice(beforeLapse);
  expect(afterLapse.filter((e) => distinctId(e) === userId), "nothing after the lapse is sent under the member's id").toEqual([]);
  expect(afterLapse.filter((e) => e.event === "$pageview").map((e) => e.properties?.["$pathname"])).toEqual(["/top-facts"]);

  // Sign back in, then sign out by the button: both vendors forget the member.
  await submitLoginForm(page, email, password);
  await page.waitForURL((u) => u.pathname !== "/login");
  await page.goto("/check-email");
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

test("a submitted fact, a made meme and an upgrade each reach both vendors, filed under the page they happened on", async ({ page }) => {
  test.setTimeout(150_000);
  const { phEvents, gaCommands, gaHits, gaWire, googleScript } = await captureAnalytics(page);
  const FACT_TEXT = "{NAME} out-ran the weekend and {SUBJ} never looked back";
  const TYPED = "Quentin Zyxwv once out-ran the weekend and never looked back";
  const CHECKOUT_SESSION = "cs_test_e2e_wire_proof";
  await stubPublicFacts(page, { facts: [factDetail({ id: 1, text: FACT_TEXT })], images: ["/api/storage/objects/uploads/e2e-photo.jpg"] });

  // The submit journey's writes and the meme save, the checkout confirmation
  // and the member's uploads are answered here: this database holds no facts
  // and no payment. The pages' own code runs up to the line that counts.
  const stubbed: string[] = [];
  const json = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  await page.route("**/api/ai/tokenize-fact", (route) => { stubbed.push("tokenize"); return route.fulfill(json({ template: "{NAME} out-ran the weekend and {SUBJ} never looked back" })); });
  await page.route("**/api/ai/suggest-hashtags", (route) => route.fulfill(json({ hashtags: ["legend"] })));
  await page.route("**/api/facts/submit-review", (route) => { stubbed.push("submit-review"); return route.fulfill(json({ ok: true })); });
  await page.route("**/api/users/me/uploads*", (route) => route.fulfill(json({
    uploads: [{ objectPath: "/objects/uploads/e2e-photo.jpg", width: 1200, height: 1200, isLowRes: false, fileSizeBytes: 1000, createdAt: "2026-10-01T12:00:00.000Z", transform: null, sourceObjectPath: null, factId: null, transformParamsHash: null, isProfile: false }],
    uploadCount: 1, maxUploads: 20, displayLimit: 20,
  })));
  await page.route("**/api/memes", (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    stubbed.push("memes");
    return route.fulfill(json({ memeId: 7, permalinkSlug: "e2e-wire", permalinkUrl: "/m/e2e-wire" }));
  });
  await page.route("**/api/stripe/checkout/confirm", (route) => { stubbed.push("confirm"); return route.fulfill(json({ tier: "legendary" })); });

  await signInThroughForm(page, PAID_ACCOUNT.email, TEST_ACCOUNT_PASSWORD);

  // Google's own script may not load on every runner: then its side is read
  // from the command queue the app feeds it, as the first test does.
  const googleChecked = async (): Promise<boolean> => {
    await expect.poll(googleScript, { timeout: 20_000 }).not.toBe("pending");
    return googleScript() === "loaded";
  };
  let googleOnWire = false;
  const expectBothVendors = async (gaName: string, phName: string, pattern: string): Promise<PhEvent> => {
    await expect.poll(() => phEvents.some((e) => e.event === phName), { timeout: 20_000 }).toBe(true);
    const ph = phEvents.find((e) => e.event === phName)!;
    expect(ph.properties?.["$pathname"], `PostHog files ${phName} under the page it happened on`).toBe(pattern);
    if (googleOnWire) {
      await expect.poll(() => gaWire.some((h) => h.get("en") === gaName), { timeout: 20_000 }).toBe(true);
      const hit = gaWire.find((h) => h.get("en") === gaName)!;
      expect(hit.get("dt"), `GA4 files ${gaName} under the page it happened on`).toBe(pattern);
    } else {
      await expect.poll(() => gaCommands.some((c) => c[0] === "event" && c[1] === gaName), { timeout: 20_000 }).toBe(true);
    }
    return ph;
  };

  // 1. submit: write a fact, preview it, send it for review.
  await page.goto("/submit");
  googleOnWire = await googleChecked();
  if (!googleOnWire) {
    const message = "Google's script (googletagmanager.com) could not load on this runner, so the checks that read Google's own hits off the wire were skipped. The command queue the app feeds Google was still checked.";
    test.info().annotations.push({ type: "skipped: Google's hits on the wire", description: message });
    console.warn(`[analyticsOutbound] ${message}`);
  }
  await page.getByPlaceholder(/When David does pushups/).fill(TYPED);
  await page.getByRole("button", { name: /Preview/ }).click();
  await expect(page.getByRole("heading", { name: "Does this look right?" })).toBeVisible();
  await page.getByRole("button", { name: /submit/i }).filter({ visible: true }).last().click();
  await expect.poll(() => stubbed.includes("submit-review"), { timeout: 15_000 }).toBe(true);
  await expectBothVendors("submit", "submit", "/submit");

  // 2. meme_made: the real builder, its photo from the member's uploads, saved.
  // Reached in-app from the fact page, with no full load: GA4 must file the
  // event under the builder's pattern, not the page the visit landed on
  // (increment 3's first review round; the guard PR #1073 replaced).
  await page.goto("/facts/1");
  await expect.poll(() => phEvents.some((e) => e.event === "$pageview" && e.properties?.["$pathname"] === "/facts/:id"), { timeout: 15_000 }).toBe(true);
  await spa(page, "/facts/1/meme");
  await page.getByRole("button", { name: "Make my meme" }).click();
  await expect.poll(() => stubbed.includes("memes"), { timeout: 15_000 }).toBe(true);
  await expectBothVendors("meme_made", "meme_made", "/facts/:id/:sub");

  // 3. upgrade: back from Stripe's checkout, the confirmation answers legendary.
  await page.goto(`/profile?checkout=success&session_id=${CHECKOUT_SESSION}`);
  await expect.poll(() => stubbed.includes("confirm"), { timeout: 15_000 }).toBe(true);
  const upgrade = await expectBothVendors("purchase", "upgrade", "/profile");
  expect(upgrade.properties?.["plan"], "the plan is a code").toBe("legendary");
  expect(phEvents.some((e) => e.event === "purchase"), "PostHog keeps our name for the upgrade").toBe(false);
  expect(gaCommands.some((c) => c[0] === "event" && c[1] === "upgrade"), "GA4 gets its own name for the upgrade").toBe(false);

  // Nothing typed, no member name and no email went to either vendor.
  const wire = JSON.stringify({ phEvents, gaCommands, gaHits });
  for (const secret of ["Quentin", "Zyxwv", TYPED, PAID_ACCOUNT.email, PAID_ACCOUNT.displayName, PAID_ACCOUNT.firstName, PAID_ACCOUNT.lastName, CHECKOUT_SESSION]) {
    expect(wire.includes(secret), `"${secret}" was sent to an analytics vendor`).toBe(false);
  }
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

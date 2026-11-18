#!/usr/bin/env node
/**
 * @purpose The post-merge live check for launch Phase 16, increment 3: loads a deployed build with its real GA4 stream and PostHog project, follows a personalised link, a search and in-app back/forward, and reports what actually left the browser — that no hit carries the test name or search word, that GA4 sends one page view per page shown and no event of its own (enhanced measurement: scroll, click, site search, form, file download, video), and that PostHog sends no autocapture or recording. Read-only against the product; it does send a handful of real analytics hits.
 * @subsystem public-site
 *
 * Usage: node artifacts/overhype-me/scripts/analytics-live-probe.mjs <base-url>
 * Exit 0 on a pass, 1 on a failure (each failure printed), 2 on a usage error.
 */
import { chromium } from "@playwright/test";
import { gunzipSync } from "node:zlib";

const base = process.argv[2];
if (!base || !/^https?:\/\//.test(base)) {
  console.error("usage: analytics-live-probe.mjs <base-url>");
  process.exit(2);
}

const NAME = "Zebulonia";
const WORD = "Quixotic";
// Our funnel events, plus `user_engagement`: GA4's base engagement-time ping,
// sent with the same scrubbed page fields, not an enhanced-measurement event.
const OUR_GA_EVENTS = new Set(["page_view", "user_engagement", "personalise", "sign_up", "verify", "submit", "meme_made", "share", "purchase"]);

const gaHits = [];
const phBodies = [];

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const context = await browser.newContext({
  userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
});
await context.addInitScript(() => {
  Object.defineProperty(Navigator.prototype, "webdriver", { get: () => false });
  Object.defineProperty(Navigator.prototype, "userAgentData", { get: () => undefined });
});
const page = await context.newPage();
page.on("request", (req) => {
  const url = req.url();
  if (/google-analytics\.com\/.*collect/.test(url)) {
    // A GA4 request may batch several hits, one per line of the body.
    const lines = (req.postData() ?? "").split("\n").filter(Boolean);
    const shared = new URL(url).searchParams;
    for (const line of lines.length ? lines : [""]) {
      const params = new URLSearchParams(shared);
      for (const [k, v] of new URLSearchParams(line)) params.set(k, v);
      gaHits.push(params);
    }
  } else if (/posthog\.com\//.test(url) && req.method() === "POST") {
    const buf = req.postDataBuffer();
    if (buf) phBodies.push(buf[0] === 0x1f && buf[1] === 0x8b ? gunzipSync(buf).toString("utf8") : buf.toString("utf8"));
  }
});

const settle = () => page.waitForTimeout(4000);
await page.goto(new URL(`/facts/1?displayName=${NAME}&pronouns=she%2Fher`, base).href);
await settle();
await page.goto(new URL(`/search?q=${WORD}`, base).href);
await settle();
await page.evaluate(() => window.history.pushState({}, "", "/pricing"));
await settle();
await page.goBack();
await settle();
await page.goForward();
await page.waitForTimeout(8000);
await browser.close();

const failures = [];
const wire = JSON.stringify({ ga: gaHits.map((p) => p.toString()), ph: phBodies });
for (const secret of [NAME, WORD]) if (wire.includes(secret)) failures.push(`"${secret}" was sent to an analytics vendor`);
const gaEvents = gaHits.map((p) => p.get("en"));
const foreign = gaEvents.filter((e) => e && !OUR_GA_EVENTS.has(e));
if (foreign.length) failures.push(`GA4 sent events of its own (enhanced measurement is on in the stream): ${[...new Set(foreign)].join(", ")}`);
const views = gaHits.filter((p) => p.get("en") === "page_view").map((p) => p.get("dt"));
if (gaHits.length && views.length !== 5) failures.push(`GA4 page views: expected 5 (one per page shown), got ${views.length}: ${views.join(", ")}`);
if (!gaHits.length) failures.push("no GA4 hit was seen: is VITE_GA_MEASUREMENT_ID set in this build?");
if (!phBodies.length) failures.push("no PostHog request was seen: is VITE_POSTHOG_KEY set in this build?");
if (/\$autocapture|\$snapshot/.test(phBodies.join(""))) failures.push("PostHog sent autocapture or recording events");

console.log(`GA4 hits: ${gaHits.length} (events: ${gaEvents.join(", ")}); page titles sent: ${views.join(", ")}`);
console.log(`PostHog requests: ${phBodies.length}`);
if (failures.length) {
  for (const f of failures) console.log(`FAIL: ${f}`);
  process.exit(1);
}
console.log("PASS: no name or search word left the browser; GA4 sent only our events, one page view per page shown; no autocapture or recording");

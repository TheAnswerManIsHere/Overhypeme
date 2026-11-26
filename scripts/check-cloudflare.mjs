#!/usr/bin/env node
/**
 * Does Cloudflare still hold what `docs/cloudflare-configuration.md` records?
 * (launch Phase 15, increment 1).
 * ────────────────────────────────────────────────────────────────────────────
 * Two halves, both read-only by default:
 *
 *   1. OUTSIDE — what anyone on the internet sees: every serving hostname
 *      answers through Cloudflare, www and plain http redirect at the edge, a
 *      crawler gets the OG shell and a browser the app, HSTS is counted, no
 *      Cloudflare-injected script is in the page, and Replit's own address
 *      still behaves as recorded (the origin exposure Phase 20 seals).
 *   2. SETTINGS — the zone's settings, rules, worker and Web Analytics site,
 *      read through Cloudflare's API. Runs only when CLOUDFLARE_API_TOKEN is
 *      set. In a Claude cloud session the network proxy injects the real
 *      token, so the variable only has to be non-empty there, and Node's
 *      fetch must be told to use that proxy:
 *        NODE_USE_ENV_PROXY=1 CLOUDFLARE_API_TOKEN=proxy-injected \
 *          node scripts/check-cloudflare.mjs
 *
 * `--burst` adds the one check that is not read-only in effect: it sends a
 * burst of GETs at a render path and expects Cloudflare's own 429 (body
 * `error code: 1015`). The caller's address is then refused those paths for
 * 10 seconds. GET reaches no render handler, so production records nothing.
 *
 * What it cannot check from here, and the record quotes instead: the country
 * rule seen from a blocked country, a Turnstile challenge completing in a real
 * browser, and CF-IPCountry reaching the app on a signed-in request.
 *
 * Exit 1 when anything differs from the record. A difference means either
 * Cloudflare drifted or the record is stale; fix whichever is wrong.
 */
import { pathToFileURL } from "node:url";

export const ZONE_ID = "759edc0f6744c981b16d648f1a9ffa12";
export const ACCOUNT_ID = "975a348dc75f2f3849507caefab3862e";
const API = "https://api.cloudflare.com/client/v4";
const CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** Zone settings the record says the product depends on, with their values. */
export const EXPECTED_SETTINGS = {
  ssl: "strict",
  min_tls_version: "1.2",
  always_use_https: "on",
  tls_1_3: "on",
  email_obfuscation: "off",
  ip_geolocation: "on",
  rocket_loader: "off",
  development_mode: "off",
};

/**
 * HSTS header counts on overhype.me. The web path carries only Replit's
 * two-year header (Cloudflare's HSTS setting is off). The API path also
 * carries the app's own until increment 3e removes it; 3e changes 2 to 1.
 */
export const EXPECTED_HSTS = { web: 1, api: 2 };

/**
 * Lower-cased, with and without the trailing slash: the API's router is
 * case-insensitive and not strict, so every one of those spellings reaches
 * the same handler (`/API/…` in capitals does not: Replit routes `/api` to
 * the API by a case-sensitive prefix, and capitals land on the web app).
 */
export const RATE_LIMIT_EXPRESSION =
  '(lower(http.request.uri.path) in {"/api/render-preview" "/api/render-preview/" "/api/render-download" "/api/render-download/"})';
export const WORKER_ROUTES = ["overhype.me/api/memes/*", "overhype.me/api/og/*", "overhype.me/m/*"];
export const WORKER_CRON = "23 9 * * *";
export const MAINTENANCE_URL = "https://overhypeme.replit.app/api/jobs/maintenance";
/**
 * The dynamic-redirect phase, in order, exactly as recorded: the www→apex
 * redirect, then the country rule (Phase 14, increment 3). The country
 * expression is what `cloudflareRedirectExpression()` in
 * `artifacts/api-server/src/lib/geography.ts` produces; the unit test holds
 * the two equal. Compared whole, never by fragment: a rule narrowed, negated
 * or widened still contains every fragment.
 */
export const GEO_EXPRESSION =
  '(ip.src.country in {"AT" "BE" "BG" "HR" "CY" "CZ" "DK" "EE" "FI" "FR" "DE" "GR" "HU" "IE" "IT" "LV" "LT" "LU" "MT" "NL" "PL" "PT" "RO" "SK" "SI" "ES" "SE" "AX" "GF" "GP" "MF" "MQ" "RE" "YT" "IS" "LI" "NO" "GB" "CU" "IR" "KP"} or (ip.src.country eq "UA" and ip.src.region_code in {"43" "40" "14" "09"})) and not starts_with(http.request.uri.path, "/unavailable")';
export const REDIRECT_RULES = [
  { expression: '(http.request.full_uri wildcard r"https://www.*")', status: 301 },
  { expression: GEO_EXPRESSION, status: 302, target: "https://overhype.me/unavailable" },
];

/**
 * Cloudflare's own rate-limit answer. The app's limiter also sends 429 and
 * Retry-After, so only the body tells them apart. Cloudflare answers a
 * curl-like client with this plain text and Node's fetch with an HTML page
 * linking its error-1015 documentation; both are its, and neither is the
 * app's JSON.
 */
export const EDGE_RATE_LIMIT_BODY = "error code: 1015";
const EDGE_RATE_LIMIT_PAGE = /cloudflare-1xxx-errors\/error-1015\//;
/** Every spelling the API routes to a render handler, and the rule must cover. */
export const RENDER_SPELLINGS = ["/api/render-preview", "/api/render-preview/", "/api/render-download", "/api/render-download/", "/api/Render-Download"];

// ── Pure checks (unit-tested) ────────────────────────────────────────────────

/** Settings whose live value differs from EXPECTED_SETTINGS, or HSTS turned on. */
export function settingsFailures(settings) {
  const byId = new Map(settings.map((s) => [s.id, s.value]));
  const failures = [];
  for (const [id, want] of Object.entries(EXPECTED_SETTINGS)) {
    const got = byId.get(id);
    if (got !== want) failures.push(`zone setting ${id} is ${JSON.stringify(got)}, the record says ${JSON.stringify(want)}`);
  }
  const hsts = byId.get("security_header")?.strict_transport_security;
  if (hsts?.enabled) failures.push("Cloudflare's HSTS setting is on; the record has it off (Replit already sends one, so on means two until increment 3e settles which one stays)");
  return failures;
}

/** The burst rule on the two render paths, exactly as recorded. */
export function rateLimitFailures(rules) {
  const rule = (rules ?? []).find((r) => r.expression === RATE_LIMIT_EXPRESSION);
  if (!rule) return ["no rate-limit rule on the two render paths"];
  const failures = [];
  const rl = rule.ratelimit ?? {};
  if (rule.enabled === false) failures.push("the render rate-limit rule is disabled");
  if (rule.action !== "block") failures.push(`the render rate-limit rule's action is ${rule.action}, not block`);
  if (rl.requests_per_period !== 10 || rl.period !== 10 || rl.mitigation_timeout !== 10) {
    failures.push(`the render rate-limit rule is ${rl.requests_per_period}/${rl.period}s blocking ${rl.mitigation_timeout}s, the record says 10/10s blocking 10s`);
  }
  return failures;
}

/**
 * The redirect phase's enabled rules, in order, compared whole. Cloudflare
 * stores an expression as typed, trailing newline included, so only the ends
 * are trimmed; any other difference means the rule was edited and this record
 * must be re-read.
 */
export function redirectFailures(rules) {
  const live = (rules ?? []).filter((r) => r.enabled !== false);
  const failures = [];
  if (live.length !== REDIRECT_RULES.length) {
    failures.push(`the redirect phase has ${live.length} enabled rule(s), the record says ${REDIRECT_RULES.length} (www→apex, then the country rule)`);
  }
  REDIRECT_RULES.forEach((want, i) => {
    const got = live[i];
    const name = i === 0 ? "the www→apex rule" : "the country rule";
    if (!got || (got.expression ?? "").trim() !== want.expression) {
      failures.push(`${name} (position ${i + 1}) is not the recorded expression`);
      return;
    }
    const from = got.action_parameters?.from_value ?? {};
    if (from.status_code !== want.status) failures.push(`${name} answers ${from.status_code}, the record says ${want.status}`);
    if (want.target && from.target_url?.value !== want.target) failures.push(`${name} sends to ${from.target_url?.value}, not ${want.target}`);
  });
  return failures;
}

/** True only for Cloudflare's rate-limit answer, never the app's own 429. */
export function isEdgeRateLimit({ status, body }) {
  const text = (body ?? "").trim();
  return status === 429 && (text === EDGE_RATE_LIMIT_BODY || EDGE_RATE_LIMIT_PAGE.test(text));
}

/** The og-router worker's routes, schedule and maintenance address. */
export function workerFailures({ routes, schedules, bindings }) {
  const failures = [];
  const live = (routes ?? []).filter((r) => r.script === "overhype-og-router").map((r) => r.pattern).sort();
  if (JSON.stringify(live) !== JSON.stringify([...WORKER_ROUTES].sort())) {
    failures.push(`og-router routes are ${JSON.stringify(live)}, the record says ${JSON.stringify(WORKER_ROUTES)}`);
  }
  const crons = (schedules ?? []).map((s) => s.cron);
  if (JSON.stringify(crons) !== JSON.stringify([WORKER_CRON])) failures.push(`og-router schedule is ${JSON.stringify(crons)}, the record says ["${WORKER_CRON}"]`);
  const url = (bindings ?? []).find((b) => b.name === "MAINTENANCE_URL")?.text;
  if (url !== MAINTENANCE_URL) failures.push(`og-router MAINTENANCE_URL is ${url}, the record says ${MAINTENANCE_URL}`);
  if (!(bindings ?? []).some((b) => b.name === "CRON_SECRET" && b.type === "secret_text")) failures.push("og-router has no CRON_SECRET secret");
  return failures;
}

/** Web Analytics must not inject its beacon (the web CSP does not allow it). */
export function webAnalyticsFailures(sites) {
  return (sites ?? [])
    .filter((s) => s.ruleset?.zone_name === "overhype.me" && (s.auto_install || s.ruleset?.enabled))
    .map(() => "Cloudflare Web Analytics is injecting its beacon into overhype.me again");
}

/** Number of HSTS headers in a fetch response (fetch joins repeats with ", "). */
export function hstsCount(headerValue) {
  return headerValue ? (headerValue.match(/max-age=/gi) ?? []).length : 0;
}

// ── Live checks ──────────────────────────────────────────────────────────────

async function head(url, init = {}) {
  return fetch(url, { redirect: "manual", ...init });
}

async function outsideFailures() {
  const failures = [];
  for (const url of ["https://overhype.me/", "https://overhype.me/api/healthz", "https://www.overhype.me/"]) {
    const r = await head(url);
    if (r.headers.get("server") !== "cloudflare" || !r.headers.get("cf-ray")) failures.push(`${url} did not answer through Cloudflare`);
  }
  const www = await head("https://www.overhype.me/api/healthz");
  if (www.status !== 301 || www.headers.get("location") !== "https://overhype.me/api/healthz") failures.push(`www is ${www.status} → ${www.headers.get("location")}, not 301 to the apex`);
  const http = await head("http://overhype.me/");
  if (http.status !== 301 || http.headers.get("location") !== "https://overhype.me/") failures.push(`plain http is ${http.status} → ${http.headers.get("location")}, not 301 to https://overhype.me/`);

  const web = await head("https://overhype.me/");
  const api = await head("https://overhype.me/api/healthz");
  const counts = { web: hstsCount(web.headers.get("strict-transport-security")), api: hstsCount(api.headers.get("strict-transport-security")) };
  for (const k of ["web", "api"]) {
    if (counts[k] !== EXPECTED_HSTS[k]) failures.push(`HSTS on the ${k} path: ${counts[k]} header(s), the record says ${EXPECTED_HSTS[k]}`);
  }

  const bot = await fetch("https://overhype.me/m/zz-check-cloudflare", { headers: { "user-agent": "Twitterbot/1.0" } });
  if (!(await bot.text()).includes('property="og:site_name"')) failures.push("a crawler on /m/:slug did not get the OG shell");
  const human = await fetch("https://overhype.me/m/zz-check-cloudflare", { headers: { "user-agent": CHROME_UA } });
  const page = await human.text();
  if (human.status !== 200 || page.includes('property="og:site_name"')) failures.push("a browser on /m/:slug did not get the app");
  if (page.includes("cloudflareinsights") || page.includes("email-decode")) failures.push("Cloudflare is injecting a script into the page");

  const originPage = await head("https://overhypeme.replit.app/");
  if (originPage.status !== 308 || originPage.headers.get("location") !== "https://overhype.me/") failures.push(`Replit's address answers pages ${originPage.status}; the record says 308 to overhype.me — update the record`);
  const originApi = await head("https://overhypeme.replit.app/api/healthz");
  if (originApi.status !== 200) failures.push(`Replit's address answers the API ${originApi.status}; the record says 200 (the daily maintenance call relies on it) — update the record`);
  return failures;
}

async function cf(path) {
  const r = await fetch(`${API}/${path}`, { headers: { authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` } });
  const body = await r.json();
  if (!body.success) throw new Error(`${path}: ${JSON.stringify(body.errors)}`);
  return body.result;
}

async function settingsCheckFailures() {
  const ruleset = async (phase) => (await cf(`zones/${ZONE_ID}/rulesets/phases/${phase}/entrypoint`).catch(() => ({ rules: [] }))).rules;
  return [
    ...settingsFailures(await cf(`zones/${ZONE_ID}/settings`)),
    ...rateLimitFailures(await ruleset("http_ratelimit")),
    ...redirectFailures(await ruleset("http_request_dynamic_redirect")),
    ...workerFailures({
      routes: await cf(`zones/${ZONE_ID}/workers/routes`),
      schedules: (await cf(`accounts/${ACCOUNT_ID}/workers/scripts/overhype-og-router/schedules`)).schedules,
      bindings: (await cf(`accounts/${ACCOUNT_ID}/workers/scripts/overhype-og-router/settings`)).bindings,
    }),
    ...webAnalyticsFailures(await cf(`accounts/${ACCOUNT_ID}/rum/site_info/list`)),
  ];
}

/**
 * GET, not POST: the edge rule matches the path whatever the method, and a GET
 * reaches no render handler, so nothing past the edge writes to production
 * (a rejected POST is logged as a render attempt). Paced, not parallel:
 * Cloudflare's counter catches up within a few seconds, so a burst finished in
 * under two seconds is never refused. Once refused, a request per spelling,
 * inside the 10-second block, proves the rule covers each. Each spelling gets
 * up to three tries, because an egress proxy that rotates its address sends
 * some requests from an address the block does not cover.
 */
async function burstFailures() {
  const send = (path) =>
    fetch(`https://overhype.me${path}`).then(async (r) => ({ path, status: r.status, body: await r.text() }));
  let tripped = false;
  for (let i = 0; i < 40 && !tripped; i++) {
    tripped = isEdgeRateLimit(await send("/api/render-download"));
    if (!tripped) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!tripped) return ["40 paced requests to /api/render-download drew no Cloudflare 1015"];
  const failures = [];
  for (const path of RENDER_SPELLINGS) {
    let last;
    for (let i = 0; i < 3; i++) {
      last = await send(path);
      if (isEdgeRateLimit(last)) break;
    }
    if (!isEdgeRateLimit(last)) failures.push(`${path} was not refused by the edge during the block (status ${last.status})`);
  }
  return failures;
}

async function main() {
  const failures = [...(await outsideFailures())];
  if (process.env.CLOUDFLARE_API_TOKEN) failures.push(...(await settingsCheckFailures()));
  else console.log("check:cloudflare: CLOUDFLARE_API_TOKEN not set; settings not read (outside checks only).");
  if (process.argv.includes("--burst")) failures.push(...(await burstFailures()));
  if (failures.length) {
    console.error("check:cloudflare FAILED — Cloudflare differs from docs/cloudflare-configuration.md:");
    for (const f of failures) console.error(`  ${f}`);
    process.exit(1);
  }
  console.log("check:cloudflare: Cloudflare matches docs/cloudflare-configuration.md.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(`check:cloudflare could not finish: ${e.message}`);
    process.exit(1);
  });
}

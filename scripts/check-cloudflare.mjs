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
 * burst at the render endpoints and expects the edge's rate limit to answer
 * 429. The caller's address is then refused those two paths for 10 seconds.
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

export const RATE_LIMIT_EXPRESSION = '(http.request.uri.path in {"/api/render-preview" "/api/render-download"})';
export const WORKER_ROUTES = ["overhype.me/api/memes/*", "overhype.me/api/og/*", "overhype.me/m/*"];
export const WORKER_CRON = "23 9 * * *";
export const MAINTENANCE_URL = "https://overhypeme.replit.app/api/jobs/maintenance";
/** Places the country rule sends to /unavailable (Phase 14, increment 3). */
export const BLOCKED_COUNTRIES = [
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV", "LT",
  "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE", "AX", "GF", "GP", "MF", "MQ", "RE", "YT",
  "IS", "LI", "NO", "GB", "CU", "IR", "KP",
];

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

/** The www→apex redirect and the country rule, both live in the dynamic-redirect phase. */
export function redirectFailures(rules) {
  const failures = [];
  const list = rules ?? [];
  const www = list.find((r) => r.enabled !== false && /https:\/\/www\.\*/.test(r.expression ?? ""));
  if (!www) failures.push("no www→apex redirect rule");
  const geo = list.find((r) => r.enabled !== false && (r.expression ?? "").includes("ip.src.country"));
  if (!geo) return [...failures, "no country rule"];
  const target = geo.action_parameters?.from_value?.target_url?.value;
  if (target !== "https://overhype.me/unavailable") failures.push(`the country rule sends to ${target}, not https://overhype.me/unavailable`);
  const missing = BLOCKED_COUNTRIES.filter((c) => !geo.expression.includes(`"${c}"`));
  if (missing.length) failures.push(`the country rule no longer names ${missing.join(", ")}`);
  if (!/ip\.src\.country eq "UA" and ip\.src\.region_code in \{"43" "40" "14" "09"\}/.test(geo.expression)) {
    failures.push("the country rule's Crimea, Sevastopol, Donetsk and Luhansk clause changed");
  }
  if (!geo.expression.includes('not starts_with(http.request.uri.path, "/unavailable")')) {
    failures.push("the country rule no longer exempts /unavailable (it would redirect forever)");
  }
  return failures;
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

async function burstFailures() {
  const send = () => fetch("https://overhype.me/api/render-download", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).then((r) => r.status);
  const statuses = await Promise.all(Array.from({ length: 40 }, send));
  statuses.push(await send());
  return statuses.includes(429) ? [] : [`40 parallel render requests drew no 429 (statuses: ${[...new Set(statuses)].join(", ")})`];
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

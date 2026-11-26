import test from "node:test";
import assert from "node:assert/strict";
import {
  BLOCKED_COUNTRIES, EXPECTED_SETTINGS, MAINTENANCE_URL, RATE_LIMIT_EXPRESSION, WORKER_CRON, WORKER_ROUTES,
  hstsCount, rateLimitFailures, redirectFailures, settingsFailures, webAnalyticsFailures, workerFailures,
} from "../check-cloudflare.mjs";

const settings = (over = {}) => [
  ...Object.entries({ ...EXPECTED_SETTINGS, ...over }).map(([id, value]) => ({ id, value })),
  { id: "security_header", value: { strict_transport_security: { enabled: false } } },
];

test("settings as recorded pass; a drifted one is named", () => {
  assert.deepEqual(settingsFailures(settings()), []);
  const [f] = settingsFailures(settings({ min_tls_version: "1.0" }));
  assert.match(f, /min_tls_version is "1\.0"/);
});

test("Cloudflare's own HSTS switched on fails (the edge would send two)", () => {
  const s = settings().map((x) => (x.id === "security_header" ? { ...x, value: { strict_transport_security: { enabled: true } } } : x));
  assert.equal(settingsFailures(s).length, 1);
});

const rlRule = (over = {}) => ({ expression: RATE_LIMIT_EXPRESSION, action: "block", enabled: true, ratelimit: { requests_per_period: 10, period: 10, mitigation_timeout: 10 }, ...over });

test("the render burst rule: present passes, missing or loosened fails", () => {
  assert.deepEqual(rateLimitFailures([rlRule()]), []);
  assert.match(rateLimitFailures([])[0], /no rate-limit rule/);
  assert.equal(rateLimitFailures([rlRule({ ratelimit: { requests_per_period: 100, period: 10, mitigation_timeout: 10 } })]).length, 1);
  assert.equal(rateLimitFailures([rlRule({ action: "log" })]).length, 1);
});

const geoExpr = `(ip.src.country in {${BLOCKED_COUNTRIES.map((c) => `"${c}"`).join(" ")}} or (ip.src.country eq "UA" and ip.src.region_code in {"43" "40" "14" "09"})) and not starts_with(http.request.uri.path, "/unavailable")`;
const redirects = (geo = geoExpr) => [
  { expression: '(http.request.full_uri wildcard r"https://www.*")', enabled: true },
  { expression: geo, enabled: true, action_parameters: { from_value: { target_url: { value: "https://overhype.me/unavailable" } } } },
];

test("the country rule as recorded passes; a dropped country or the lost exemption fails", () => {
  assert.deepEqual(redirectFailures(redirects()), []);
  assert.match(redirectFailures(redirects(geoExpr.replace('"GB" ', "")))[0], /no longer names GB/);
  assert.match(redirectFailures(redirects(geoExpr.replace(/ and not starts_with.*$/, "")))[0], /exempts \/unavailable/);
  assert.match(redirectFailures([redirects()[1]])[0], /www/);
});

const worker = (over = {}) => ({
  routes: WORKER_ROUTES.map((pattern) => ({ pattern, script: "overhype-og-router" })),
  schedules: [{ cron: WORKER_CRON }],
  bindings: [{ name: "MAINTENANCE_URL", type: "plain_text", text: MAINTENANCE_URL }, { name: "CRON_SECRET", type: "secret_text" }],
  ...over,
});

test("the og-router worker as recorded passes; a lost route, cron or secret fails", () => {
  assert.deepEqual(workerFailures(worker()), []);
  assert.equal(workerFailures(worker({ routes: [] })).length, 1);
  assert.equal(workerFailures(worker({ schedules: [] })).length, 1);
  assert.equal(workerFailures(worker({ bindings: [worker().bindings[0]] })).length, 1);
});

test("Web Analytics injecting again fails; off passes", () => {
  const site = (auto_install, enabled) => [{ auto_install, ruleset: { zone_name: "overhype.me", enabled } }];
  assert.deepEqual(webAnalyticsFailures(site(false, false)), []);
  assert.equal(webAnalyticsFailures(site(true, true)).length, 1);
  assert.equal(webAnalyticsFailures(site(false, true)).length, 1);
});

test("HSTS headers are counted when fetch joins repeats", () => {
  assert.equal(hstsCount(null), 0);
  assert.equal(hstsCount("max-age=63072000; includeSubDomains"), 1);
  assert.equal(hstsCount("max-age=63072000; includeSubDomains, max-age=15552000"), 2);
});

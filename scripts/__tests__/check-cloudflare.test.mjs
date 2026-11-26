import test from "node:test";
import assert from "node:assert/strict";
import {
  EDGE_RATE_LIMIT_BODY, EXPECTED_SETTINGS, RENDER_SPELLINGS, GEO_EXPRESSION, MAINTENANCE_URL, RATE_LIMIT_EXPRESSION, REDIRECT_RULES,
  WORKER_CRON, WORKER_ROUTES, hstsCount, isEdgeRateLimit, rateLimitFailures, redirectFailures, settingsFailures,
  webAnalyticsFailures, workerFailures,
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

// Live rules as Cloudflare returns them: the country rule's text ends in a newline.
const liveRule = ({ expression, status, target }, over = {}) => ({
  enabled: true,
  expression,
  action_parameters: { from_value: { status_code: status, target_url: target ? { value: target } : { expression: "…" } } },
  ...over,
});
const redirects = (geoOver = {}) => [liveRule(REDIRECT_RULES[0]), liveRule(REDIRECT_RULES[1], { expression: `${GEO_EXPRESSION}\n`, ...geoOver })];

test("the redirect phase as recorded passes, trailing newline and all", () => {
  assert.deepEqual(redirectFailures(redirects()), []);
});

test("a country rule narrowed, negated or widened fails, though every fragment is still there", () => {
  const narrowed = `${GEO_EXPRESSION} and http.request.uri.path eq "/old-page"`;
  const negated = GEO_EXPRESSION.replace("(ip.src.country in", "(not ip.src.country in");
  const widened = GEO_EXPRESSION.replace('"KP"}', '"KP" "US"}');
  const regrouped = GEO_EXPRESSION.replace(/^\(/, "").replace(")) and not", ") and not");
  for (const expression of [narrowed, negated, widened, regrouped]) {
    assert.match(redirectFailures(redirects({ expression }))[0], /country rule .* not the recorded expression/);
  }
});

test("a rule placed ahead of the country rule fails (it could exempt blocked visitors)", () => {
  const ahead = { enabled: true, expression: '(http.request.uri.path eq "/x")', action_parameters: { from_value: { status_code: 302 } } };
  const [first, second] = redirects();
  assert.ok(redirectFailures([first, ahead, second]).length > 0);
});

test("a country rule sending elsewhere, or with another status, fails", () => {
  const [www, geo] = redirects();
  assert.equal(redirectFailures([www, { ...geo, action_parameters: { from_value: { status_code: 302, target_url: { value: "https://overhype.me/" } } } }]).length, 1);
  assert.equal(redirectFailures([www, { ...geo, action_parameters: { from_value: { status_code: 301, target_url: { value: "https://overhype.me/unavailable" } } } }]).length, 1);
});

test("the recorded country expression is the one the app's geography module produces", async (t) => {
  if (!process.features?.typescript) return t.skip("this Node cannot import TypeScript; the check runs where it can");
  const { cloudflareRedirectExpression } = await import("../../artifacts/api-server/src/lib/geography.ts");
  assert.equal(GEO_EXPRESSION, cloudflareRedirectExpression());
});

test("only Cloudflare's 1015 counts as the edge rate limit, never the app's JSON 429", () => {
  assert.equal(isEdgeRateLimit({ status: 429, body: EDGE_RATE_LIMIT_BODY }), true);
  assert.equal(isEdgeRateLimit({ status: 429, body: '{"error":"Too many requests. Please slow down."}' }), false);
  assert.equal(isEdgeRateLimit({ status: 404, body: EDGE_RATE_LIMIT_BODY }), false);
  const page = '<!doctype html>… <a href="https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1015/">';
  assert.equal(isEdgeRateLimit({ status: 429, body: page }), true);
});

test("the render rule covers every spelling the API routes to the handler", () => {
  for (const p of RENDER_SPELLINGS) {
    assert.ok(RATE_LIMIT_EXPRESSION.includes(`"${p.toLowerCase()}"`), p);
  }
  assert.match(RATE_LIMIT_EXPRESSION, /^\(lower\(http\.request\.uri\.path\) in /);
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

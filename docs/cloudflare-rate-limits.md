# Cloudflare rate-limit rules — the edge limit on the render endpoints

The edge's rate limit on the two render endpoints, and how to recreate it. The
rest of the Cloudflare configuration, and the evidence for this rule, is
[`cloudflare-configuration.md`](cloudflare-configuration.md). Cloudflare's
dashboard is the source of truth; `scripts/check-cloudflare.mjs` compares it
with these values.

**History.** This file used to specify two hourly rules, `RL-PREVIEW` (30 per
hour) and `RL-DOWNLOAD` (10 per hour), with a custom JSON 429 body. **They were
never created**: on 2026-11-26 the zone's `http_ratelimit` phase had no rules
(launch Phase 15, increment 1; Issue #1306). The zone is on Cloudflare's
**Free plan**, which cannot hold them: one rule, path-only expressions, a
10-second counting period and a 10-second block, with no custom response.

## The rule — `RL-RENDER burst`

Created 2026-11-26 through the API (rule `d322a6ccefd341eca0f048444fafe352`).

| Field | Value |
| --- | --- |
| Phase | `http_ratelimit` (WAF → Rate limiting rules) |
| Expression | `(lower(http.request.uri.path) in {"/api/render-preview" "/api/render-preview/" "/api/render-download" "/api/render-download/"})` |
| Counting | IP (Cloudflare adds the data centre: `ip.src`, `cf.colo.id`) |
| Threshold | 10 requests per 10 seconds |
| Action | Block for 10 seconds |
| Response | Cloudflare's default 429, `retry-after: 10`; body `error code: 1015` (or its HTML error-1015 page, depending on the client) |

**Why these numbers.** Each render burns seconds of `node-canvas` time, so no
person makes ten in ten seconds; the rule refuses a script hammering the
endpoint without touching a real session. Both endpoints are signed-in only
(`artifacts/api-server/src/routes/render.ts`), so the edge limit is a backstop,
not the main control. **Next:** a per-account limit in the app (Issue #1306).

**Recreate it** with `PUT /zones/{zone_id}/rulesets/phases/http_ratelimit/entrypoint`
and the body
`{"rules":[{"description":"RL-RENDER burst","expression":"(lower(http.request.uri.path) in {\"/api/render-preview\" \"/api/render-preview/\" \"/api/render-download\" \"/api/render-download/\"})","action":"block","ratelimit":{"characteristics":["ip.src","cf.colo.id"],"period":10,"requests_per_period":10,"mitigation_timeout":10},"enabled":true}]}`.

**Why every spelling.** The API's router is case-insensitive and ignores a
trailing slash, so each spelling in the expression reaches the same handler;
lower-casing the path covers the mixed-case ones. The Free plan accepts
`lower()` here (measured 2026-11-26).

**Verify it** with `node scripts/check-cloudflare.mjs --burst`. It sends GETs
to `/api/render-download` every 250 ms until Cloudflare refuses, then one
request per spelling inside the 10-second block, each of which must be refused.
GET, because the rule matches the path whatever the method and a GET reaches no
render handler, so production records nothing (a rejected POST is written to the
render abuse log). Paced, because Cloudflare's counter catches up within a few
seconds: a parallel burst finished in under two seconds is never refused.

## Storage divergence note

The project principle says "Cloudflare R2" but the current artifact persists
meme images in **Google Cloud Storage** via the Replit sidecar (see
`artifacts/api-server/src/lib/objectStorage.ts`). Cloudflare here refers only
to the CDN / WAF / DNS layer in front of the origin — the rate-limit rule is
unaffected. Consolidating the storage layer to R2 is a separate workstream.

## Application-layer divergence note

The edge rule covers the two render endpoints. The authenticated save
endpoint `POST /api/memes` is rate-limited at the application layer instead:
a rolling 24 h cap counted against the `memes` table (see
`memes.free_tier_daily_save_cap` / `memes.legendary_tier_daily_save_cap` in
`admin_config`). Edge limits cannot read the user's tier and would also fail
to respect soft-deleted rows.

## IP source — why `CF-Connecting-IP`

Cloudflare's rate limiting counts by the connecting IP automatically,
but the application also reads the same value (via `CF-Connecting-IP`) in
`lib/transientRenderLog.ts` for hashed audit logging. **Do not** consult the
`X-Forwarded-For` header at the origin: that chain can be appended to by a
client bypassing Cloudflare, which would corrupt the abuse-detection signal.
The app falls back to `req.ip` when running outside Cloudflare (dev/test).


# Cloudflare WAF rate-limit rules — recoverability spec

This document records the WAF Rate Limiting Rules that protect the two
anonymous-accessible Phase-4 render endpoints. Cloudflare's dashboard is the
source of truth in production, but the rules below are the authoritative
recipe so the configuration can be recreated if it is ever lost or migrated.

The current Cloudflare product is **WAF → Tools → Rate limiting rules** (the
older "Rate Limiting" product is deprecated and will not be used here). Docs:
<https://developers.cloudflare.com/waf/rate-limiting-rules/>.

## Storage divergence note

The project principle says "Cloudflare R2" but the current artifact persists
meme images in **Google Cloud Storage** via the Replit sidecar (see
`artifacts/api-server/src/lib/objectStorage.ts`). Cloudflare here refers only
to the CDN / WAF / DNS layer in front of the origin — the rate-limit rules are
unaffected. Consolidating the storage layer to R2 is a separate workstream.

## Application-layer divergence note

These edge rules cover the two anonymous endpoints. The authenticated save
endpoint `POST /api/memes` is rate-limited at the application layer instead:
a rolling 24 h cap counted against the `memes` table (see
`memes.free_tier_daily_save_cap` / `memes.legendary_tier_daily_save_cap` in
`admin_config`). Edge limits cannot read the user's tier and would also fail
to respect soft-deleted rows.

## Rule 1 — `RL-PREVIEW`

| Field             | Value |
| ----------------- | ----- |
| Description       | Phase-4 anonymous render-preview rate limit |
| Match expression  | `(http.request.uri.path eq "/api/render-preview" and http.request.method eq "POST")` |
| Counting characteristics | IP — Cloudflare uses the connecting IP (the same value surfaced as `CF-Connecting-IP` at the origin) |
| Period            | 1 hour (3600 seconds) |
| Requests          | 30 |
| Action            | Block |
| Custom response   | Status `429`, content type `application/json`, body below |
| Custom response body | `{"error":"rate_limited","endpoint":"render-preview","retryAfterSeconds":3600}` |
| Response headers added | `Retry-After: 3600` |

### Justification

- A user scrubbing the stock picker triggers ~10–15 previews in a normal
  builder session. 30/hour leaves roughly 2× headroom for power users.
- Each preview burns server CPU on `node-canvas`; the limit needs to bite
  long before that becomes the bottleneck.
- The 1-hour window is short enough that a user who legitimately tripped the
  limit gets unblocked within a single session.

## Rule 2 — `RL-DOWNLOAD`

| Field             | Value |
| ----------------- | ----- |
| Description       | Phase-4 anonymous render-download rate limit |
| Match expression  | `(http.request.uri.path eq "/api/render-download" and http.request.method eq "POST")` |
| Counting characteristics | IP |
| Period            | 1 hour (3600 seconds) |
| Requests          | 10 |
| Action            | Block |
| Custom response   | Status `429`, content type `application/json`, body below |
| Custom response body | `{"error":"rate_limited","endpoint":"render-download","retryAfterSeconds":3600}` |
| Response headers added | `Retry-After: 3600` |

### Justification

- Downloads are end-of-funnel: a real user finalising a meme typically saves
  one variant per session. 10/hour is generous compared to the expected ~2
  per session.
- Lower than the preview limit because abusive scraping signals are stronger
  here — bulk-downloading the rendered output of every fact is a more direct
  abuse vector than scrubbing previews.

## Rule IDs (production)

Populate these after the rules are created in the dashboard. Both fields
(`id` and `lastModified`) come from the API surface
`GET /zones/{zone_id}/rulesets/phases/http_ratelimit/entrypoint`.

| Rule          | Rule ID | Last modified |
| ------------- | ------- | ------------- |
| `RL-PREVIEW`  | _TBD_   | _TBD_         |
| `RL-DOWNLOAD` | _TBD_   | _TBD_         |

## IP source — why `CF-Connecting-IP`

Cloudflare's Rate Limiting Rules counts by the connecting IP automatically,
but the application also reads the same value (via `CF-Connecting-IP`) in
`lib/transientRenderLog.ts` for hashed audit logging. **Do not** consult the
`X-Forwarded-For` header at the origin: that chain can be appended to by a
client bypassing Cloudflare, which would corrupt the abuse-detection signal.
The app falls back to `req.ip` when running outside Cloudflare (dev/test).

## Plan-tier note

WAF Rate Limiting Rules availability varies with Cloudflare plan tier. The
configuration above uses only the features available on Pro+ plans (custom
response body, status code override, `Retry-After` injection). If the project
is on the Free plan and the dashboard refuses these options, fall back to:

1. Increase the daily-save cap on the application layer.
2. Add a coarser application-layer per-IP limiter in front of the two
   render endpoints (the existing `lib/sharedRateLimiter.ts` primitive can
   be reused with `endpoint: "render-preview"` and `ip: ipFromRequest(req)`).

## Verification

After deploying, verify with curl from a single IP:

```sh
# Should succeed for the first 30 calls in an hour, then 429 with JSON body.
for i in $(seq 1 35); do
  curl -s -o /dev/null -w "%{http_code}\n" \
    -X POST https://overhype.me/api/render-preview \
    -H "Content-Type: application/json" \
    -d '{"factId":1,"name":"Test","pronouns":"they/them","imageSource":{"type":"stock","pexelsPhotoId":1}}'
done | sort | uniq -c
```

Expected output: `30 200`, `5 429` (or close — Cloudflare batches counters
at 10 s granularity, so the cutover may slide by a couple of requests).

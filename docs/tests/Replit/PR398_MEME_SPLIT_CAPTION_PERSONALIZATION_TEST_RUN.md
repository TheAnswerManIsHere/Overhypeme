# PR398 — Meme split-caption personalization · TEST_RUN

Checklist for Replit (the technical safety net), run post-merge against the
live workspace. Replit owns the DB connection — no `DATABASE_URL` / test-DB
env is set here.

Pre-merge gates (install, typecheck, codegen drift) are assumed green;
spot-check only if something below fails.

No test suites here — this PR's suites (`memeCaptionPersonalization`,
`renderCanonical`, `resolvedIdentityForms`, and the full blast-radius sweep
listed in the PR body) ran and passed in CI on this exact code. Everything
below is what CI cannot see: the live Cloudflare edge cache and a deploy step
that needs a production credential.

## Repo-health gates (post-merge state — run always)
- `pnpm --filter @workspace/db validate-snapshots` — expected: passes
- `pnpm --filter @workspace/db check-snapshots` — expected: passes. New
  `SNAPSHOT_EXEMPT_TAGS` entries this PR added: none
- `node scripts/check-docs-accuracy.mjs` — expected: clean
- Other allow-list entries this PR added: none

## Deploy step (⚠️ MUTATING — this is a production deploy, not a read-only check)

This is the one part of this PR that only Replit can do: `CLOUDFLARE_API_TOKEN`
is a production credential David doesn't hold directly, and the fix's edge-cache
half doesn't take effect until this Worker is redeployed.

**What it deploys:** `cloudflare/og-router`, the Cloudflare Worker in front of
`overhype.me/api/memes/*/image`. Round 2 of this PR's review added a
cache-busting query param (`MEME_IMAGE_EDGE_CACHE_VERSION`) so a previously
edge-cached (stale, tokenized) meme image can't keep being served after this
fix's origin half deploys. That query-param bump only does anything once this
Worker is redeployed — merging the PR alone does not push it live.

**Ordering matters — do NOT deploy the Worker before confirming the origin is
live.** If the Worker deploys first, the first request at each edge PoP after
its deploy uses the new cache key but can still hit an origin still running
the old code — the edge then caches those OLD bytes under the NEW key for a
full 24h (`s-maxage=86400`), silently defeating the whole point of this step.

1. **Confirm the main app (this PR's origin half) is actually live first.**
   Use a unique query param so this check is guaranteed a fresh cache key and
   an actual origin round-trip — the bare URL can be edge-cached and lie:
   ```bash
   curl -sI "https://overhype.me/api/memes/<any-live-slug>/image?verify=$(date +%s)" | grep -i etag
   ```
   Expected: the ETag reads `meme-v4-...`. If it still reads `meme-v3-...` (or
   anything lower), the app deploy hasn't finished yet — wait and re-check
   before continuing. Do not deploy the Worker while this still reads v3.

2. **Deploy the Worker** (only once step 1 confirms `meme-v4-...`):
   ```bash
   export CLOUDFLARE_API_TOKEN=…  # token with "Edit Cloudflare Workers" scope
   pnpm worker:deploy
   ```
   Expected: `wrangler deploy` completes without error. Full context and the
   same commands live in `cloudflare/og-router/README.md`'s Deploy section —
   this section is that same procedure, reproduced here because it's the one
   step that has to run in this environment rather than being told to David.

3. **Post-deploy spot-check.** Fetch the same slug used in step 1 again (no
   need for the `?verify=` param this time — you're checking the public,
   real-world path now):
   ```bash
   curl -sI "https://overhype.me/api/memes/<any-live-slug>/image" | grep -i etag
   ```
   Expected: `meme-v4-...`, confirming the edge is now serving through the
   redeployed Worker rather than a stale cached entry.

## What's deliberately NOT shipped
- No CI-enforced guard against the Worker's `MEME_IMAGE_EDGE_CACHE_VERSION`
  drifting out of sync with the origin's `MEME_RENDER_VERSION` — tracked in
  #403, deliberately out of scope for this PR.

## Delete me
Transient — delete once this checklist has been run. The `_UAT.md` sibling is
the durable half.

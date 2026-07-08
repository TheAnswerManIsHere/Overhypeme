# PR213 — Private-Meme Access (C3) — TEST_RUN

Engineering checklist for Replit. Transient — delete once run. The UAT sibling
(`PR213_PRIVATE_MEME_ACCESS_UAT.md`) is the durable half.

## Scope

Enforce `isPublic=false` = owner-only across every meme-by-slug surface, and
keep private responses out of the public/edge cache.

- New `src/lib/memeVisibility.ts` → `canViewMeme(meme, req)` (public OR owner OR
  admin; null-creator private = admin-only).
- Gated: `GET /memes/:slug`, `GET /memes/:slug/image`, `GET /og/m/:slug`,
  `POST /memes/:slug/zazzle-export`, `GET /memes/:slug/zazzle-redirect`,
  `GET /share-copy/:memeId/:platform`, `POST /share-intents`.
- `cloudflare/og-router/src/index.ts`: only a public `200` gets the forced
  public Cache-Control; private/`no-store`/non-200 pass through.

No schema/migration change.

## Commands (`artifacts/api-server`)

```bash
npx tsc -b
node --import tsx/esm --test \
  src/__tests__/memes.privacy-cache.test.ts \
  src/__tests__/routes.memes.test.ts \
  src/__tests__/phase5.og.routes.test.ts \
  src/__tests__/routes.shareCopy.test.ts \
  src/__tests__/routes.shareIntents.test.ts
# full suite sanity
pnpm --filter @workspace/api-server test
```

## Expected results

- `memes.privacy-cache.test.ts` — `canViewMeme` unit (6) + `GET /memes/:slug`
  (owner 200 + `no-store`; different user 404; unauth 404; admin 200; public
  200). All pass.
- OG + shareCopy + shareIntents + routes.memes suites unchanged — all pass
  (60 total across the listed files).

## Behavioral checks (running server)

With a **legendary** user A who owns a **private** meme at slug `S`:
- `GET /api/memes/S` as A → 200, `Cache-Control: no-store`. As user B or
  anonymous → **404**. As admin → 200.
- `GET /api/memes/S/image` as B/anon → **404**; as A → image with `no-store`
  (not `public, s-maxage=...`).
- `GET /api/og/m/S` (unauthenticated crawler) → generic "Not found" card,
  `Cache-Control: no-store` — no fact text / creator / image leaked.
- `GET /api/share-copy/S/twitter` as B → not-found; as A → copy.
- `POST /api/memes/S/zazzle-export` as B → 404; as A → export.
- Public memes: all of the above behave exactly as before (public cache intact).

## Gotchas / notes

- The image-route test is not end-to-end (rendering needs GCS/templates); the
  route gate is the same `canViewMeme` call the unit test covers, plus the
  behavioral check above.
- **Cloudflare worker** change deploys separately (Wrangler) — verify after the
  next worker deploy that a private meme's `/api/memes/S/image` is **not**
  edge-cached (response `no-store` survives the worker). The origin-side markers
  are already correct regardless.
- Edge case: a private meme whose creator's account was deleted (`createdById`
  null) is **admin-only** by design (fail closed).

## Deliberately NOT shipped

- Listing/gallery endpoints — already exclude others' private memes (verified),
  no change.
- `GET /videos/single/:videoId` fact-text join is gated by the video's own
  `isPrivate`; not part of this meme-privacy PR.

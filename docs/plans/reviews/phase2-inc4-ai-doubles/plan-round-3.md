# PLAN — Phase 2 increment 4: the AI doubles · technical design · draft v3 (after Astra rounds 1–2)

Parent: `docs/plans/PLAN_PHASE2_VERIFICATION.md` v4 (sha256 `db036f0f…`,
approved by David 2026-10-08 / 2026-10-11), *Settled Decisions*, increment 4,
which reserves exactly this: "The exact adapter shape is the AI increment's
technical decision, settled there with Astra and recorded with its reason."
Nothing here changes scope; anything that would is marked **for David**.

## What increment 4 must deliver (from the parent, quoted)

- "Deterministic stand-ins at the existing provider boundaries — the shared
  fal client (extended, not replaced), the shared OpenAI client and the
  embeddings client — so the journeys run without a vendor."
- **Coverage rule:** "for each baseline journey the selected double is
  available without credentials (including the configured-key checks in front
  of the clients), supplies the responses and local media the journey needs
  (including the image a render downloads), and supports one representative
  provider failure; unconfigured operations fail visibly; authentication,
  authorisation, orchestration, persistence and serving stay real. The pricing
  warm-up does not reach out."
- **Shapes come from reality:** "each double's responses are built from
  responses recorded from the real vendor, never written from memory, and the
  recording says when and against which client version it was taken."
- One selection rule (`lib/doubleSelection.ts`): explicit value, unrecognised
  refuses everywhere, production boot refuses; the increment adds a row and a
  test that a production boot naming it exits before listening.
- Journey 6 (moved here, David 2026-10-10); the journey 7 command rewrite in
  `TESTING.md`; the storage selector refusing `STORAGE_DOUBLE_DIR=/`.

## The surface, measured (2026-10-12, read from source at `d0a5444`)

fal — every production caller uses the `@fal-ai/client` singleton; all but
`moderation/nsfwClassifier.ts:20` import it through `lib/falClient.ts`.
Methods used: `fal.subscribe` (image: `fal-ai/nano-banana-2`,
`fal-ai/nano-banana-2/edit`, `fal-ai/flux-pro/v1.1`, `fal-ai/flux-pulid`;
classifier: `fal-ai/imageutils/nsfw`; detector: `fal-ai/yolo-world`; video
and subtitle endpoints), `fal.storage.upload` (returns a URL string),
`fal.queue.submit/status/result` (admin engine tests only), `fal.config`.
Image callers then `fetch()` the returned `images[0].url` and read `.ok`,
`content-type` and the bytes (`imagePromptJobs.ts:624`,
`aiMemePipeline.ts:406,740`). Pricing is a plain `fetch` to `api.fal.ai`
(`falPricing.ts:43`), skipped only when `getFalApiKey()` is null; the warm-up
runs at every boot (`index.ts:402`).

Key checks: `getFalApiKey()` (`FAL_AI_API_KEY ?? FAL_KEY`) gates the NSFW
classifier on upload and meme save (skipped with a warning when null:
`userImageUpload.ts:225`, `createMemeRecord.ts:336`), video (503), and pricing;
`ensureFalConfigured()` throws without a key at 13 call sites.

OpenAI — `getOpenAIClient()` (memoised; throws without `OPENAI_API_KEY`) is
used by `callUtilityLLM` (`chat.completions.create`, ~11 callers) and by
`referenceResearch/openaiResponses.ts` (`responses.create`, admin-only, off
every journey). `embeddings.ts` builds its own `new OpenAI` per call (throws
without the key) for `embeddings.create` (`text-embedding-3-small`, 384 dims);
`backfillEmbeddings` runs at every boot (`index.ts:386`). Chat callers read
`choices[0].message.content` and mostly `JSON.parse` it; four use
`zodResponseFormat` with a schema name (`fact_enrichment`, `visual_concepts`,
`image_prompt_plan`, `source_image_classification`), the rest `json_object`
or plain text. The image-prompt planner's output is validated against its
input (render mode, identity, enrichment) and a mismatch after one retry is
terminal (`validation_exhausted`).

## Design

### D1. One selector, `AI_BACKEND`

Real value `vendors`; double `recorded-double`; and `recorder` (D6), which
wraps the real clients to capture pairs. One row in `SELECTORS` covers fal,
the shared OpenAI client and the embeddings client. Not every journey uses
all three (photo upload uses only fal), but a half-doubled boot (fal doubled,
OpenAI real) is the configuration that leaks an outbound call, and one switch
makes it unrepresentable. Both non-real values are refused in a production
boot by the existing rule; `recorder` also `requires` the vendor keys, so a
recorder boot without them refuses before listening.

### D2. Where each double plugs in — application-owned adapters, resolved per call

- **OpenAI: an API-owned adapter.** `artifacts/api-server/src/lib/aiClients.ts`
  exports `getOpenAIClient()` and `getEmbeddingsClient()`. Each calls
  `selectedBackend("AI_BACKEND")` **before any credential check**: the double
  when `recorded-double`, a recording wrapper around the real client when
  `recorder`, otherwise the existing integration-package getter
  (`@workspace/integrations-openai-ai-server`, unchanged) or, for embeddings,
  the existing `new OpenAI` construction. `utilityLLM.ts`,
  `referenceResearch/openaiResponses.ts` and `embeddings.ts` import the
  adapter. The integration package does not import application modules (it is
  a composite project with `rootDir: "src"`).
- **fal: a forwarding facade in `falClient.ts`.** The exported `fal` is an
  object whose supported methods (`subscribe`, `storage.upload`,
  `queue.submit/status/result`, `config`) resolve the backend on each
  invocation and forward to the real SDK singleton, the recording wrapper or
  the double — so selection is call-time, not module-load-time. The module
  keeps its API ("extended, not replaced"). Under `recorded-double`,
  `getFalApiKey()` returns a non-secret sentinel so the upload and meme-save
  gates run classification rather than silently skipping it, and
  `ensureFalConfigured()` succeeds without `fal.config`. `nsfwClassifier.ts`
  imports `fal` from `falClient.ts` instead of the SDK; its injected-client
  seam (`overrides.falImpl`) is unchanged.
- **Pricing:** `falPricing.fetchPricingFromApi` resolves the backend first:
  under `recorded-double` it returns the recorded pricing for a recorded
  endpoint, and a visible "no recording" null-with-warning for any other,
  never calling `fetch`.

### D3. Media the journeys download — local, no network (unchanged; Astra concurs)

The image double returns `images[0].url` as a `data:image/png;base64,…` URL
holding a small real PNG derived from the recorded generation (downscaled).
Node 22's `fetch` resolves it locally with `content-type: image/png` (probed
2026-10-12: `true image/png`; Astra's probe returned identical bytes), so
`imagePromptJobs.ts:623` and `aiMemePipeline.ts:403` run their real
download, probe and storage path. `storage.upload` returns a deterministic
`https://` placeholder: the inspected consumers pass it to the vendor and never
download it.

### D4. Responses: replay of captured request/response pairs (option A, settled with Astra)

Replay a bounded set of captured pairs for fixed baseline inputs. The reason
is that the real validators stay the only statement of their rules: a
synthesiser (option B) would have to manufacture input-dependent enrichment
and render plans that satisfy them, a second copy of those rules that drifts.
(Astra's correction, accepted: adapting an exemplar is not in itself
"written from memory"; the maintenance obligation is the real objection.)

- **Fingerprint** = model + the complete `response_format` (including the
  schema) + the ordered messages (system, user, and any corrective retry
  message), plus the request options that change output (`temperature`,
  `max_tokens`, reasoning effort). For fal: endpoint + `input`. For
  embeddings: model + `input` + `dimensions`.
- **Normalisation covers only identified transport differences**, found by
  evidence, not guessed: the recorded run's requests are compared with a
  fresh replay run's requests (D7), and each field that differs between two
  runs of the same baseline (an object path, a request id, a timestamp) is
  named in the normaliser with the diff that showed it. Anything not named
  stays in the fingerprint.
- **Vision is out of the baseline.** The source-image vision fallback
  (`tier3AiVisionFallback.ts`) runs only on escalation from `analyze-source`,
  which no baseline journey calls; it stays explicitly unrecorded.
- **Unmatched requests fail visibly**, never fall through to a vendor. That
  includes boot-time work outside the baseline: the pricing warm-up walks the
  whole engine catalogue and the embedding backfill walks active facts; their
  unrecorded calls log "no recording for …" and fail. No success is invented
  to make startup quiet.
- **The baseline the recordings cover:** journey 3's chain for one baseline
  fact submitted by the free test account (tokenise, duplicate check,
  hashtags, enrichment, Pexels keywords, visual concepts, tokenise-enrichment,
  one image-prompt plan and one Nano Banana render per required scenario —
  `generic_t2i`, `i2i_male_default`, `i2i_female_default` — and the embedding
  on approve); journey 6's no-reference generation by the paid test account
  (plan + `fal-ai/nano-banana-2`) and its save (upload + NSFW); journeys 4
  and 7's upload + NSFW classification. The recording file records the
  fixture identity: the fact text, the test accounts' personalisation
  (name, pronouns), the engine rows and model configuration, and the render
  scenarios.

### D5. The representative failure

`AI_DOUBLE_FAIL=<operation>` (for example `fal:fal-ai/nano-banana-2`), read
at call time under `recorded-double` only: that operation throws the
**recorded** vendor error (fal's `ApiError` with `status` and `body.detail`;
the OpenAI SDK's `APIError`), captured by sending the real endpoint one
invalid input during the recording run. A test control, not a selector: it
does nothing unless the double is selected.

### D6. Recordings — taken by the real app, bounded in cost

- **How:** the server boots on the Repl in development mode against the
  marked test database with `AI_BACKEND=recorder`. The recorder wraps the real
  clients and appends each request/response pair, with `recordedAt` and the
  `@fal-ai/client` and `openai` versions, to the recordings directory. A
  baseline driver (`scripts/drive-ai-baseline.ts`) makes the same API calls
  the frontend makes for journeys 3, 6, 4 and 7 against that server, as the
  seeded test accounts and the bootstrap admin. Because the recordings come
  from the application's own requests, the replay fingerprints match by
  construction rather than by a script imitating them. The driver is reused
  locally against `recorded-double` (D7) and by increment 6.
- **Isolated launch (Astra C6).** The recorder server is launched as a
  separate process by `scripts/record-ai-baseline.ts` with an **explicitly
  constructed environment**: the runtime settings the server needs, the fal
  and OpenAI keys, and nothing else inherited — no Stripe, Resend, Arachnid,
  NCMEC, Pexels or hCaptcha credentials. Before importing the application it
  requires the test-database marker (the check-before-import pattern of
  `testing/productionModeLauncher.ts`). It selects `STORAGE_BACKEND=local-double`
  with a dedicated temporary directory, listens on its own local port, and
  is terminated on success or failure. It is invoked explicitly and never in
  CI; replay uses the same baseline with no credentials. Implementation
  demonstrates the marker refusal before startup and the storage writes
  landing in the temporary directory.
- **Spending limit, enforced before dispatch (Astra C5).** The baseline's
  model settings and image parameters are frozen and priced in a small
  recorder-local price table (fal prices from the app's pricing cache;
  OpenAI from the published list, with the date read). Before each vendor
  call the recorder **reserves that call's conservative maximum** — input
  tokens as sent, output at the configured maximum including reasoning
  headroom, one image per generation — against the remaining allowance,
  counting calls still outstanding. A call with an unknown price, or whose
  reservation exceeds the remainder, is refused. Startup calls and the
  application's own retries draw on the same allowance; the recorder sets
  the SDK's automatic retries to zero so one admitted call is one vendor
  attempt. On completion a call's reservation is settled to its actual
  usage. A refusal leaves the recording incomplete and reports the missing
  coverage; it never restarts with a fresh allowance. If the complete
  baseline cannot fit, that result goes to David rather than a larger
  allowance or a weaker baseline. **The allowance is David's (below).**
- **Scrub before commit:** vendor URLs, request ids and account identifiers
  are replaced; generated images are kept only as the downscaled PNGs D3
  serves.
- **Repl hygiene:** the run uses the branch's code without moving the Repl's
  checkout (a worktree of `origin/claude/phase2-ai-doubles` outside the app
  directory), and the worktree is removed afterwards.

### D7. Tests and evidence

- `doubleSelection.test.ts`: the `AI_BACKEND` row — selected when named,
  refused when unrecognised, both non-real values refused in a production
  boot (spawned server never listens), `recorder` refused without keys.
- Per client: a call under `recorded-double` reaches the double (its call
  record), an unrecorded request fails visibly, the failure control throws
  the recorded error shape, and selection precedes the credential check.
- **Through the consumers (Astra A3):** the baseline driver run locally
  against `recorded-double` and the test database proves the recorded
  tokeniser, enrichment, concept and planner responses pass the real
  validators and each downstream request finds its recording; the committed
  PNG survives decoding, storage and serving; and one recorded provider error
  travels through a real consumer (the Nano Banana job) to its expected job
  state. This is also the second run that names the normaliser's fields (D4).
- Journey 6 (`e2e/aiImageMeme.spec.ts`), acceptance-only like journey 7; its
  spend clause is a Deferred line naming #651 (David, 2026-10-12: "next").
- The storage selector's `requires` refuses `STORAGE_DOUBLE_DIR=/`.

## Not in this increment

Journey 3's full moderation run is increment 6's acceptance run; this
increment supplies the recordings and doubles it needs and proves them per
call. The allowlisted boot environment is increment 6's (#637 gap).
`responses.create` (reference research) stays unrecorded and fails visibly.
Video endpoints stay unrecorded (video is cut from launch).

## Decided by David (2026-10-12)

- Journey 6's spend clause: **next** — deferred to #651 and the spend-controls
  phase. Astra's round-1 view, recorded as dissent: keep the assertion and make
  production spend support a prerequisite.
- The recording spend: **approved** on the "under $1" estimate. That
  estimate assumed actual usage; D6's conservative reservations need a larger
  allowance to admit the baseline at all — **for David** (2026-10-12).

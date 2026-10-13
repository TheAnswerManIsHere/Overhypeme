# PLAN — Phase 2 increment 4: the AI doubles · technical design · draft v1

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

Real value `vendors`; double `recorded-double`. One row in `SELECTORS`
covering fal, the shared OpenAI client and the embeddings client together.
Every journey that touches AI needs all three, and a half-doubled boot (fal
doubled, OpenAI real) is exactly the configuration that leaks an outbound
call; one switch makes it unrepresentable. `requires`: none (the double needs
no settings). Production boot refusal and the boot test come from the
existing rule.

### D2. Where each double plugs in — at the client, not the call site

- **fal:** `falClient.ts` exports `fal` as the real singleton or, when
  `AI_BACKEND=recorded-double`, a double implementing the subset above
  (`subscribe`, `storage.upload`, `queue.*`, `config` as a no-op). "Extended,
  not replaced": the module keeps its API; `getFalApiKey()` returns a
  non-secret sentinel under the double so the key gates pass, and
  `ensureFalConfigured()` succeeds without calling `fal.config`.
  `nsfwClassifier.ts` changes its import to `falClient.ts` so it gets the same
  object (its injected-client seam is untouched).
- **Pricing:** `falPricing.fetchPricingFromApi` returns the recorded pricing
  response under the double and never calls `fetch`. This is the only place
  the double reaches into a non-client module, because pricing is not an SDK
  call.
- **OpenAI:** `getOpenAIClient()` returns a double exposing
  `chat.completions.create` (and `responses.create` that throws "no
  recording", since no journey uses it). `embeddings.ts`'s `getClient()`
  returns a double exposing `embeddings.create`.
- **Selection is read at call time** through `selectedBackend("AI_BACKEND")`,
  so the boot refusal is re-applied at the point of use, as storage does.

### D3. Media the journeys download — local, no network

The image double returns `images[0].url` as a `data:image/png;base64,…` URL
holding a small real PNG committed with the recordings. Node's `fetch`
resolves `data:` URLs locally with the right `content-type`, so
`imagePromptJobs` and `aiMemePipeline` run their real download, probe and
storage path unchanged with no outbound request. `storage.upload` returns a
deterministic `https://` string that nothing in our code fetches (only fal
would). Recorded vendor URLs are replaced, never served.

### D4. Responses: recorded envelope, and content chosen by purpose — **the fork for Astra**

The envelope of every response (ids, `object`, `model`, `usage`,
`finish_reason`, fal's `{data, requestId}` wrapper, image `width`/`height`/
`content_type`, `has_nsfw_concepts`) is the recorded one. The open question is
the *content* of chat responses whose correctness depends on the input:

- **Option A — replay by recorded input.** Recordings are taken for one
  recorded fact through the whole moderation chain (tokenise → enrichment →
  concepts → image-prompt plan per render scenario) and for journey 6's
  generation. The double keys each chat response by `(model, schema name or
  response kind, a normalised hash of the user message)`. Journeys submit the
  recorded fact's text, so every downstream call matches. A request with no
  matching recording fails visibly ("no recording for …"), which is the
  coverage rule's "unconfigured operations fail visibly". Cost: journeys are
  bound to the recorded fact; any prompt-template change in the code changes
  the hash and needs a re-recording (which the live check in increment 6 is
  already the trigger for).
- **Option B — content synthesised per purpose from a recorded exemplar.**
  The double keys by purpose only and adapts the recorded content to the
  input (for example, echo the input fact into the tokenizer's `template`,
  rewrite the planner's identity fields to the requested render mode).
  Journeys can use any fact. Cost: the synthesiser re-implements just enough
  of each validator's expectations to pass it — content partly written from
  code rather than recorded, which is the thing "never written from memory"
  rules out, and a second copy of validation rules that can drift.

My recommendation: **A, with the hash taken over the stable parts of the
request** (model, response-format name, user-message text after
whitespace normalisation; never ids, timestamps or the system prompt's
dynamic lines). A satisfies "shapes come from reality" for content as well as
envelope, keeps the validators as the only statement of their rules, and its
cost (re-record when prompts change) is the same trigger the live check
already owns. Embeddings use A too (keyed by input text; the duplicate-check
neighbour score is then real cosine distance between recorded vectors).

### D5. The representative failure

`AI_DOUBLE_FAIL=<operation>` (for example `fal:fal-ai/nano-banana-2`),
read at call time under the double only: that operation throws the
**recorded** vendor error (fal's `ApiError` shape with `status` and
`body.detail`, recorded by sending the real endpoint an invalid input; for
OpenAI the SDK's `APIError` shape). It is a test control, not a selector: it
does nothing unless the double is selected, and the selector's production
refusal already covers it.

### D6. Recordings — how they are taken

A recorder script (`scripts/record-ai-shapes.ts`) calls each operation the
journeys use once, through the same client code, and writes
`artifacts/api-server/src/lib/aiDouble/recordings/*.json`, each with
`recordedAt`, the client library versions (`@fal-ai/client`, `openai`) and
the endpoint/model. Vendor URLs, request ids and account identifiers are
replaced before commit. It runs on the Repl (the only place with keys,
never CI), once now; increment 6's live check reuses it. **For David:** the
first run spends real vendor money (estimate under $1, unverified).

### D7. Tests

- `doubleSelection.test.ts` gains the row: selected when named, refused when
  unrecognised, refused in a production boot (spawned server never listens).
- Per double: a call reaches the double (asserted by the double's own call
  record, per the parent's Testing Plan); an unrecorded request fails visibly;
  the failure control throws the recorded error shape.
- Recording integrity: each recording file declares `recordedAt` and client
  versions; the test fails if a double serves a response with no recording
  behind it.
- Journey 6 (`e2e/aiImageMeme.spec.ts`), acceptance-only like journey 7.
- The storage selector's `requires` refuses `STORAGE_DOUBLE_DIR=/`.

## Not in this increment

Journey 3's full moderation run is increment 6's acceptance run; this
increment supplies the recordings and doubles it needs and proves them per
call. The allowlisted boot environment is increment 6's (#637 gap).
`responses.create` (reference research) stays unrecorded and fails visibly.
Video endpoints stay unrecorded (video is cut from launch).

## Open for David

- Journey 6's "spend recorded against that user": the live Nano Banana path
  calls neither `checkBudget` nor `recordCost`; asked 2026-10-12.
- The recording spend (D6).

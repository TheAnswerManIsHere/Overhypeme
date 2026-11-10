# Plan — Image tracing: every image that leaves Overhype.me leads back to how it was made

Workstream: #905 · Mode: feature, production phase · Tier: sensitive (visual
pipeline, moderation, deletion rules; a migration)

```plan-oracle
# Oracle — Image tracing (Issue #905), scope agreed by David 2026-11-10

Source: the pre-plan conversation on Issue #905, its comments of 2026-11-10
("Pre-plan conversation", "Spike result", "Two decisions from David"), and
David's "Go. I couldn't see any artifacts in the watermark." (2026-11-10).

## Direction
Any image that left Overhype.me, found anywhere, leads back to a complete
record of how it came to exist. David: "if, God forbid, there's some issue
with content, with copyright, with CSAM, any of those things, I need to be
able to trace it back to how it came into being."

## Product intent
An admin pastes a link, an id, or uploads a picture into a "trace this image"
screen and gets: who made it, when, from what background (the member's own
photo or an AI render), by which engine and settings, prompt and fact, and
which release and meme-generator version — and which lookup matched.

## Must not change
- The engine comparison under Issue #887 (Phase 8): its rounds, judging and
  adoption. Nothing here builds until #887 round 1 is judged.
- What a meme looks like to the eye. (David saw no difference in the
  watermarked sample.)
- What visitors and members can see or do. Tracing is admin-only.

## Settled
- The database is the durable record. A file and its pixels carry only an
  opaque id (and, in file metadata, the engine name) — never settings or
  prompts.
- A provenance record outlives deletion of the meme, the image or the account.
  Kept indefinitely (David, 2026-11-10), built as one retention setting that
  defaults to "never expire", so Phase 14's legal read can change it.
- Every image leaving the system is in scope, memes built on a member's own
  photo included.
- No visual-fingerprint fallback and no backfill of existing memes or images
  (David: "All images will be new from the time we launch.").
- The legacy FLUX backfill path is left to its retirement under #887
  increment 4; the trace screen labels its images "legacy path, settings not
  recorded".
- Invisible watermark: measured with Adobe TrustMark (MIT, model Q) on 24 real
  memes through 12 simulated share paths: exact id recovered in 10 of 12
  (fails: caption cropped off, phone screenshot with bars left on); no false
  reads on unmarked memes; mean PSNR 42 dB; ~0.5 s to mark on CPU.

## Now (this plan)
- The chain: every meme and every AI render records its source, maker, time,
  release and generator version.
- At creation each finished meme gets an exact hash, an invisible watermark
  carrying its id, and the id in the file's metadata.
- AI renders and comparison pictures get the same record and the metadata
  stamp, and are saved under their true file format.
- The admin trace screen: tries id, then metadata, exact hash, then watermark,
  and says which matched.

## Next (not this plan)
- AI backgrounds inside memes (Phase 7), built on this chain.

## Never
- Settings or prompts inside a file.
- A promise that every image is always traceable.

## Ceremony
Production-phase product code, standard loop. Touches the visual pipeline,
moderation and the deletion rules, and needs a migration: migration review and
sensitive-subsystem review apply.

## Facts found while inventorying (Claude, 2026-11-10, at 83deac7)
- Images leave the server by: the baked meme file (`memeBake.ts` →
  `/memes/:slug/image`), the live render of an unbaked recipe meme
  (`routes/memes.ts`), `/render-preview` and `/render-download`
  (`routes/render.ts`) — which return a composed meme with NO meme row; each
  call writes a `transient_renders` row that `transientRenderPurger` deletes
  after 30 days — the AI render files (`imagePromptJobs.ts`, comparison
  `runs.ts`, legacy `aiMemePipeline.ts`), and the member's own-image route
  `/memes/ai-user/image`.
- A meme's background can only be `upload` or `identity` (the member's own
  photo) today (`validators/memeBuilder.ts`).
```

## Problem

David cannot answer "where did this image come from?" for a picture found
outside the product. Today:

- A meme's file says nothing about itself, and a preview or download of a meme
  that was never saved has no lasting record at all: `/render-preview` and
  `/render-download` (`routes/render.ts`) send composed bytes and then write a
  best-effort `transient_renders` row without the recipe, which
  `transientRenderPurger` deletes after 30 days.
- An AI render's attempt row holds the engine id and `request_settings`, but
  not the full request the engine received: `buildEngineInput`
  (`engineInterpreter.ts:437`) adds defaults and static parameters after
  `request_settings` is written.
- Account deletion removes the person's memes, uploads and generations and
  then the user row (`accountDeletion.ts:584-621`); nothing records who made a
  picture once that happens. `account_deletions` itself cascades with the user.
- Engine output is saved and served as PNG whatever its real format
  (`imagePromptJobs.ts:392-396`, `comparison/runs.ts:317`,
  `routes/memes.ts:434`).

The symptom David named: he sees a bad image, or receives a copyright, abuse or
CSAM report about one, and cannot trace it back.

## Direction

The `plan-oracle` block above. This plan is the whole of it except the Phase 7
link from an AI background into a meme, which needs Phase 7's AI-background
source to exist first.

## Product Intent

The oracle's product intent, made concrete: an admin opens **Trace an image**,
gives it a meme link, an image link, an id, or the picture itself, and sees one
page: what the picture is (a meme, a preview, a download, an AI render, a
comparison picture, an upload), who made it, when, under which release; for a
meme, its fact, the caption as drawn, the name and pronouns used, its options,
and its background — the member's photo, with that photo's own record; for an
AI render, the engine, the full request it received, the prompt, the fact and
the vendor's request id; which lookup found it; and whether the meme, the
picture and the account still exist. When nothing matches, it says so and says
what it tried.

## Must Not Change

The oracle's three, plus what they imply here:

- **The engine comparison (#887).** Comparison pictures keep their pixels
  exactly; the blind judging route serves no engine name, in headers or in
  bytes. Nothing here builds until #887 round 1 is judged, and the comparison
  writer's change lands only between rounds.
- **What a meme looks like.** The watermark is the measured TrustMark Q
  configuration (PSNR 42 dB; David saw no difference). The meme generator's
  drawing is untouched.
- **What visitors and members see or do.** No route, page, response shape or
  permission visible to a non-admin changes, beyond the bytes of an image now
  carrying the watermark and an id in its metadata.
- **The deletion rules of 2026-11-02**, except as Settled Decision 2 below
  extends them: pictures, memes, uploads and generations are still destroyed.

## Settled Decisions

1. **The oracle's settled list**, all David's, 2026-11-10.
2. **A provenance record is not content.** It is a snapshot of how a picture
   was made — never the picture. Account deletion, by the member or by an
   admin, and meme or upload deletion leave it in place. This extends the
   2026-11-02 deletion decision; it goes into `decisions.md` with this plan.
3. **Coverage is by image produced, not by meme row** (Astra, scope S1;
   Claude agrees). Every server-composed meme image that leaves — the baked
   file, the live render of an unbaked meme, every preview and every download
   — gets its own record and watermark. Every new AI output (product renders,
   moderation and review renders, comparison pictures) gets its record and
   the metadata stamp. Every new member upload gets an import record with its
   exact hash.
4. **Uploads are recorded, not watermarked.** A member's photo is theirs; we
   did not generate it. The record says "uploaded by", never "authored by".
   Its picture is traced by exact hash or by link; once inside a meme, by the
   meme's watermark and chain.
5. **Snapshot, not reconstruction** (Astra, scope S2). A record holds what was
   true when the picture was made — the request actually sent, the caption
   actually drawn, the maker, the release — and the trace never rebuilds any of
   it from today's configuration or rows.
6. **The source commit identifies every code version** (revised after Astra,
   round 1, R1-3). "Which version of the meme generator and of our engine
   code" is answered by the full source commit, embedded into the server at
   build and snapshotted into each record; the deployment id is kept beside it
   when the runtime offers one. A hand-bumped version number would be a second
   source of truth for the same fact. Each stage records the commit it ran
   under, since a comparison can be prepared, submitted and stored under three
   releases. A production record without a known commit is a defect; a
   development or test run records that it is unversioned, explicitly. The
   engine's vendor version is the fal endpoint plus fal's own request id, which
   fal can trace further. (`instrument.ts:28-30` is a Sentry label, falling back
   to a short SHA and then `dev`; it is not this mechanism.)
7. **Comparison pictures carry the opaque id only, never the engine name**
   (Astra, scope S4): so the blind route has nothing to strip, and the
   comparison's pixels are untouched.
8. **The marker runs in the API process** (scope S3, investigated
   2026-11-10): TrustMark's encoder exported to ONNX and run with
   onnxruntime-node and sharp marked 24 memes whose final JPEGs the reference
   decoder read 24/24, with the same survival through the share paths as the
   Python run. No Python runtime in production.
9. **The watermark payload is the record's id**: random, not sequential, so a
   found id reveals nothing about volume or order, and sized to the payload
   the measured configuration carries with its error correction.
10. **Affected-surface inventory**, two oracles run at `83deac7`, tests
    excluded, because an image can leave as our bytes or as a vendor URL
    (Astra, round 1, R1-1):
    - Our bytes: `git grep -n "uploadObjectBuffer(\|composeMeme(\|generateMemeBuffer(\|renderMemeRecipe(" -- artifacts/api-server/src`.
      Producers: the product render worker (`imagePromptJobs.ts:393`), the
      comparison (`comparison/runs.ts:317`), the legacy FLUX path
      (`aiMemePipeline.ts:252`, out of scope per the oracle), the meme bake
      (`memeBake.ts:49` via `renderMemeRecipe`), the live render of an unbaked
      meme (`routes/memes.ts`, via `renderStoredMeme`), preview and download
      (`routes/render.ts`, via `composeMeme`), and member uploads
      (`userImageUpload.ts:379`). `objectStorage.ts:226` is the restricted
      wrapper (quarantine), which stores existing bytes, not new pictures;
      `testing/legacyFixture/load.ts` is test data.
    - Vendor submissions: `git grep -n "fal\.subscribe(\|fal\.queue\.submit\|fal\.queue\.result" -- artifacts/api-server/src`.
      Adds the **engine workbench** (`routes/adminEngines.ts:1104` submit,
      `:1231` result), whose poll route returns vendor image URLs to the
      admin's browser without any of our storage, and the comparison's
      transport (`comparison/transport.ts:49`, already behind `runs.ts`).
      `sourceImageAnalysis/tier1FalDetector.ts:61` is a classifier that
      returns no image; workbench dry runs and classifier-only responses
      likewise produce none.
    The plan's scope is the union. A producer added later joins it by
    construction (Data Model, "one finishing step"); the build adds a check
    over both oracles' entry points.

## Repo Context Inspected

`CLAUDE.md`; `decisions.md` (2026-11-06 engine routing, 2026-11-02 deletion);
`visual-pipeline.md`; `imagePromptJobs.ts`; `engineInterpreter.ts`
(`buildEngineInput`); `comparison/runs.ts`; `routes/adminComparison.ts:148`;
`aiMemePipeline.ts`, `aiMemeBackfillJobs.ts`; `memeGenerator.ts`,
`memeComposite.ts`, `memeBake.ts`; `routes/memes.ts`, `routes/render.ts`,
`routes/storage.ts`, `routes/og.ts`; `userImageUpload.ts`;
`validators/memeBuilder.ts`; `accountDeletion.ts`; schemas `memes.ts`,
`imagePromptAttempts.ts`, `comparisons.ts`, `transientRenders.ts`,
`accountDeletion.ts`, `moderation.ts`; `instrument.ts` (release id);
`.replit`. The spike and its numbers: #905 comments of 2026-11-10.

## Current Behavior

Covered under Problem. In addition: a meme's background is only ever the
member's own photo, `upload` or `identity` (`validators/memeBuilder.ts`), so no
meme uses an AI background today; the meme generator encodes JPEG at quality
90; the release is available to Sentry as `REPLIT_DEPLOYMENT_ID` or
`REPLIT_GIT_COMMIT_SHA` (`instrument.ts:29-30`).

## Source-of-Truth Analysis

- **The provenance record is the one source of truth for "how was this
  picture made"**. It does not replace the operational rows: an attempt row
  still drives the render worker, a meme row still drives serving. The record
  is written from the same values those producers already hold, at the moment
  they produce bytes, and is never edited afterwards.
- **What a record may not do is be derived later.** A trace reads the record;
  it never joins to today's engine registry, config, fact text or user row to
  fill a gap. Where a record lacks something, the trace shows it as not
  recorded.
- **The file never becomes a source of truth.** Its metadata and watermark
  are pointers to a record and nothing else.

## Proposed Design

**Two moments, one record per picture** (revised after Astra, round 1,
R1-2). History is captured when the producing stage knows it, because a later
stage may not: a storage-only comparison retry (`comparison/runs.ts:426`)
receives only the cell and the vendor URL, and rebuilding the request then
would break Source-of-Truth rule 2.

- **Execution context, before the vendor is called.** For every AI
  generation — product render, moderation and eval render, comparison cell,
  engine workbench test — the exact endpoint and the built request are
  persisted before submission, with the commit and the initiating actor, and
  the vendor's request id is added when it returns. Existing operation rows
  (the attempt, the comparison cell) carry it where they can; the workbench
  gains a server-side record of its own, since today its details live only in
  the admin's browser. Recovery and storage-only retries read this frozen
  context and never rebuild it.
- **The image record, at finishing**, written by **one finishing step** that
  every producer calls with the bytes it is about to store or send.
The step: gives the picture a new random id; for a meme image, embeds the
watermark carrying that id; writes the id (and, for an AI render, the engine
name) into the file's metadata; settles the true format from the bytes;
hashes the final bytes; and commits the record. Only then are the bytes
stored or sent.

- **The chain.** A meme's record points to its background's record — the
  member upload's import record — and holds the meme's id where one exists. An
  AI render's record holds its attempt or comparison cell. Phase 7 will point a
  meme at an AI render's record the same way.
- **Who made it, from named sources.** For a member's meme, preview,
  download or upload: the signed-in account, snapshotted per Question 1; an
  anonymous preview or download records that it was anonymous. For an admin's
  generation: the admin who started it, **captured at the action that starts
  the work, before any queue hand-off can drop it** (revised after Astra,
  round 2). Today a visual-concept approval enqueues render preparation with
  only the review id (`reviewRenderScenarios.ts:675`), and the default batch
  is written as `adminUserId: "system"` (`:419`), so the approving admin is
  lost; that hand-off carries the admin through to each attempt. Manual
  reruns, eval runs (`eval/evalRunJobs.ts:150`), comparison runs and
  workbench requests already know theirs. A system origin is recorded only
  for genuinely unattended work, never in place of a human who started it.
  These attempts deliberately carry no `userId`; a null owner is never
  recorded as anonymous. The name drawn in a caption is recorded as caption
  text, never as the maker.
- **Lookup keys outlive their rows** (R1-4). A record keeps the keys a link
  would carry — the meme's slug, the stored object's path — so an old link
  traces after the meme row and the file are gone. A meme's bake happens
  before its row exists (`createMemeRecord.ts:310`), so the slug, not the row
  id, is what the bake's record holds.
- **A match can be several records.** An upload is stored as supplied
  (`userImageUpload.ts:372`), so two accounts can upload identical bytes, and
  one meme link can have several live renders. The trace returns every
  matching record and never picks one silently.
- **When and under what release.** Creation time, and the source commit each
  stage ran under (Settled 6); a development or test run records that it is
  unversioned, explicitly, and a production record without a commit is a
  defect.
- **Lookup order**, in the trace screen: an id typed or pasted; a link resolved
  to its stored object or meme; then, for a picture given to it, the id in its
  metadata, its exact hash, and its watermark, read after trimming uniform
  screenshot bars. It reports which method matched. A watermark or metadata
  match identifies a record; it does not prove the picture is unaltered — the
  screen says whether the exact hash also matched.
- **Legacy FLUX images** (stored by `aiMemePipeline.ts`) are recognised by
  their storage location and answered as "legacy path, settings not recorded",
  until #887 increment 4 retires that path.

## Data Model and Migration Impact

- **A new provenance table**, expand-only migration. Nothing in it references
  another table with a cascading or nulling delete: references to memes,
  attempts, comparison cells, uploads, facts and users are stored as plain
  values, so no deletion elsewhere can reach a record. Its id is the random
  watermark payload, unique.
- **Retention**: one admin config setting, unset meaning "never expire"; a
  purge of records older than it runs only when it is set. No record is purged
  by anything else.
- **No change to existing tables' rows**, no backfill (oracle). Existing
  columns that already say what drew a render stay as they are.
- **Volume**: one row per preview, download, bake, live render, render, cell
  and upload. Rows only, never pictures. Measured against today's preview rate
  in the build and reported; David has judged rows cheap (2026-11-10).
- Migration ceremony applies: `overhype-migration-review`; the row-state
  matrix is trivial for a new empty table; the contract step, if any, follows
  `migrations-and-backfills.md`.

## Runtime Behavior

- **Ordering invariant**: no picture is stored or sent before its record is
  committed with the hash of exactly those bytes. A record may exist for a
  picture whose send or store then failed; the trace shows the record and
  whether a stored object exists.
- **Retries and recovery** keep one record per stored picture: a retried
  render that stores new bytes gets a new record; a re-serve of stored bytes
  (a baked meme's file, a stored render) does not create one. A recovery
  writes its image record from the frozen execution context, never from
  today's configuration.
- **The engine workbench** exposes a generated image only after it has been
  through the finishing step and our storage, so what the admin opens is our
  stamped copy, not the vendor URL.
- **The marker**: loaded once per process; marks a full-size meme in roughly
  0.6 s on the measured CPU with a naive implementation. Preview latency is
  the exposed cost; it is measured in the build at the sizes previews render,
  and reported in the PR.
- **Failure**: if marking or recording fails, the picture is not sent and the
  request fails as an ordinary render error. An image never leaves untraced to
  save a request.
- **The blind comparison route** serves pixels with no engine name anywhere
  (Settled 7). **The member AI-image route** serves the recorded true format.

## Admin/User UX Impact

- **Admin**: one new screen, **Trace an image**, in the admin area, on the
  design system (`overhype-design`). Inputs: a link, an id, or a picture file.
  Output: the record and its chain as described under Product Intent, with the
  matching method and, where nothing matched, what was tried. Each code
  version is shown as its commit with that commit's date and pull-request
  title (Question 2). Its status while
  reading a picture is shown, per `async-ui-status.md`.
- **Members and visitors**: no visible change. A downloaded meme's file carries
  an id in its metadata and the invisible watermark.

## Security, Permissions, and Validation

- **The trace screen and its endpoints are admin-only**, behind the existing
  admin guard. A record contains prompts, request parameters and account
  identity; none of it is reachable by a non-admin.
- **A file never carries settings or prompts** (oracle, Never). The metadata
  stamp holds the opaque id and, for AI renders except comparison pictures,
  the engine name; nothing else.
- **A picture submitted for tracing is never stored.** It is read in memory,
  bounded in size and type like an upload, and discarded.
- **The record's id is random**, so ids cannot be enumerated from one another.
- **No IP address** is added to any record.

## Testing Plan

Properties to hold, not assertions:

- Every producer in the inventory, and only through the finishing step, yields
  a record whose hash matches the bytes stored or sent; a producer that skips
  the step is caught by a test over the inventory's entry points.
- The production path end to end — the JavaScript payload encoder, the
  marker, the final stamped JPEG, the Node decoder the trace screen uses —
  reads the id back as emitted and through the spike's share paths, with no
  false read on an unmarked picture; the bars-on screenshot is read after
  trimming. (The spike used payload bits from Python and the Python decoder,
  so it proves feasibility, not this path.)
- Recovery keeps history: submit with one set of settings, interrupt before
  storage, change the configuration and the commit, recover; the trace shows
  the original request and commit, and no second paid generation runs.
- The workbench's submit, poll and retrieve flow yields a traceable stamped
  image.
- A moderation render from a visual-concept approval's default batch, and one
  from a manual rerun, each trace to the admin who started it.
- An old meme link traces after the meme, its file and the account are gone;
  identical uploads by two accounts both come back from an exact-hash lookup.
- A record survives account deletion (member and admin), meme deletion and
  upload deletion, and the trace still answers fully.
- The blind comparison image contains no engine name; comparison pixels are
  byte-identical to the vendor's.
- True format end to end for a JPEG and a WebP engine output.
- No non-admin can reach a trace endpoint.
- The watermark's visibility: the per-image PSNR distribution compared with
  the spike's (whose mean was 42 dB; that is not a per-image floor); David's
  eye is the judge.
- UAT: David sends a marked meme through WhatsApp and Instagram, saves what
  comes back, and traces it; and traces a meme whose account was deleted.

## Implementation Steps

Two increments, each with a screen David can use. Neither starts before #887
round 1 is judged.

1. **Increment 1 — the record, AI renders, and the trace screen by id and
   link.** The provenance table and retention setting; the finishing step;
   AI renders and comparison pictures recorded and metadata-stamped, true
   format end to end, blind route clean; execution context captured before
   every vendor call, the engine workbench included; the source commit
   embedded at build; new uploads recorded; the trace screen answering an id
   or a link, legacy FLUX labelled.
2. **Increment 2 — memes and the watermark.** The marker in the API process;
   every composed meme image (bake, live render, preview, download) recorded,
   watermarked and stamped, its chain to its upload; the trace screen accepting
   a picture and trying metadata, exact hash and watermark.

## Risks and Mitigations

- **Preview latency.** Marking adds work to every preview. Measured in
  increment 2 and reported; if it is felt, the implementation is optimised
  before merge rather than previews being exempted, since exempting them breaks
  the oracle.
- **Runtime size and memory.** The ONNX runtime package is large for linux-x64
  (318 MB, mostly GPU providers we do not use) and the spike's process grew to
  732 MB over a 24-meme batch, not isolated to the marker. Measured in
  increment 2 against the deployment's limits; reported in the PR.
- **Model and payload drift.** The measured survival belongs to TrustMark Q
  with its error-correction scheme; the build pins both and records the scheme
  on every record, so a later change is visible per picture.
- **Two share paths fail**: a crop that removes the caption, and a screenshot
  whose bars cannot be trimmed cleanly. Accepted (oracle, Never).
- **Retaining identity after deletion** is a privacy exposure in some
  jurisdictions. Built as one setting; Phase 14's legal read revisits it
  (David, 2026-11-10).

## Questions for David

1. **What identifies the maker once their account is deleted?** **Answered by
   David, 2026-11-10: (a)** — the record keeps the account id and the email
   address the account had when the picture was made. Claude and Astra both
   recommended it. The trace screen words it as the account's contact address
   at the time, not proof of a person's identity or authorship. It sits under
   the retention setting and Phase 14's legal read. The options not taken:
   (b) the account id and a one-way fingerprint of the email; (c) the account
   id only.
2. **A readable version on the trace screen.** **Approved by David,
   2026-11-10:** beside each commit the screen shows its date and the title of
   the pull request that produced it (the squash commit's subject), captured
   when the server is built, so the trace depends on nothing outside the
   record. Overhype.me keeps no hand-numbered product or generator version:
   the commit is the version (Settled 6).

## Definition of Done

- An admin can trace a representative new picture from every producer in the
  inventory — by id, by link and, for a meme, by the picture itself after the
  spike's share paths — and sees its chain, its release and the matching
  method.
- The same trace answers after the meme, the upload and the account are
  deleted.
- The blind comparison and every member- and visitor-facing surface are
  unchanged.
- `decisions.md` records Settled Decision 2 and David's answers.

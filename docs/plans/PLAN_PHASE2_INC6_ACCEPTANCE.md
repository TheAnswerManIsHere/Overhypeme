# PLAN — Phase 2 increment 6: the acceptance workflow, the outbound-request check and the live check · technical design · v4 (rounds 1–3 with Astra incorporated) · APPROVED by David 2026-10-14

Parent: `docs/plans/PLAN_PHASE2_VERIFICATION.md` v4 (sha256 `db036f0f…`, approved by David 2026-10-08 / 2026-10-11), *Settled Decisions*, increment 6. Nothing here changes scope; anything that would is marked **for David**.

```plan-oracle
# Oracle — Phase 2 increment 6: the acceptance workflow, the outbound-request check and the live check

Status: the scope below is the approved parent plan's increment 6
(`docs/plans/PLAN_PHASE2_VERIFICATION.md` v4, sha256
db036f0fbe7b86812a8b83dbe85f694f144c1f5dc5786c522cd188d4b0461ae1, approved by
David 2026-10-08 / 2026-10-11), quoted, plus the gaps earlier increments
recorded for it on #631 (David, 2026-10-10 and 2026-10-13), plus David's three
answers of 2026-10-14 ("Go with your recommendations"). Nothing here is new
scope. Increments 1 to 5 are merged; `main` is `076e7b5`.

## Direction (parent, quoted)

"`launch-definition.md`, *Verification is a prerequisite*: every later phase
ships with its mechanical checks scripted, and David's share of a UAT is the
human residue. Phase 2 delivers reusable verification infrastructure and
proves it through a named baseline of journeys that exist today."

## Product intent for this increment (parent, quoted)

Product Intent 2: "A Playwright or API test can create an ordinary **free**
and an ordinary **paid** user, sign in through the real entry points, and run
the **baseline journeys** below — in CI and in this container, with no
external credential and no outbound request."

Product Intent 3: "An on-demand acceptance run, separate from the per-PR
gate, runs the baseline and reports green only when every baseline journey
ran and passed; a skipped or missing journey makes the run incomplete, never
green."

Product Intent 6: "The lane model, the acceptance workflow and the readiness
table live in the handbook, so a second app inherits them."

## What increment 6 must deliver

The parent's increment 6, quoted: "**Acceptance workflow.** An on-demand
GitHub workflow and a local command that run baseline journeys 2–7 against
the doubles (and the fixture), with evidence uploaded; never a required
check. **Any unexpected outbound request fails the run**, even when
application code catches the error — detected outside the app, not by the
doubles' own records. **A live check** (David, 2026-10-08) runs the same
journeys against the real vendors with test credentials, on the Repl and
never in CI, on demand: before each launch stage and whenever a vendor
client library is upgraded. It is the only evidence that the real vendor
still accepts our requests in the recorded shape."

The parent's Definition of Done, the second-consumer check (David,
2026-10-11), quoted: "increment 6 writes the acceptance-workflow and
live-check contracts product-neutral, and Phase 2 is done only when the
handbook-shaped parts (lane tags, the acceptance workflow shape, the
readiness table, the double-selection rule, the test-database marker, the
launcher pattern) are read against DojoOS's planning docs and either serve it
unchanged or name, in #631, the DojoOS-specific piece they leave to its own
harness increment (the two-process async harness, media probes and generated
fixtures, voice and transcription doubles)."

Recorded for this increment on #631:

- David, 2026-10-10 (from #637): "**Increment 6 owns an allowlisted boot
  environment for every journey launcher**, meaning the server gets only the
  settings the command passes." Today journey 1's CI launch blanks three
  Resend variables (`.github/workflows/build.yml:624`), journey 7's documented
  command blanks fal and Arachnid keys, and only the recorder's launch is
  constructed (`scripts/record-ai-baseline.ts:268-280`, with
  `aiRecorderGuard.ts` refusing variables outside its allowlist).
- #654's recorded gap: "The driver's image-content check. Owner: increment
  6." The driver reads back the bytes of the images journeys 4, 6 and 7
  serve and checks only the status and a byte count
  (`scripts/drive-ai-baseline.ts:289`).
- Increment 5's plan D8: "the acceptance run over the fixture, and any
  re-recording it needs, are increment 6's". The fixture's identity: manifest
  sha256 `864bfcf551fedd009feb84c951e2e5ba0a9aaa962336cb8dde85ea3c40f3b882`,
  source commit `efe0732`, 102 migrations. Load order: schema push,
  migrations, `load-legacy-fixture.ts`, the account seed, then boot; the
  loader enforces it.

## The baseline journeys this increment runs (parent, quoted)

"2. **Free user submits a fact.** Onboarding, submission, and the submission
appearing in the moderation queue.
3. **Moderation with AI doubles.** An admin takes that submission through
triage, preparation and test renders to an active fact, with tokenising,
enrichment and rendering served by the doubles and the renders stored and
readable.
4. **Free user makes and saves a photo meme.** An ordinary free account
uploads a synthetic image and uses the existing photo-meme builder to save a
public meme; its permalink and rendered image are readable. The baseline uses
the normal free-account permissions.
5. **Free user is refused paid generation** by the gate that applies to them,
with the refusal the product shows.
6. **Paid user generates and saves an AI image meme.** An ordinary paid
account reaches a completed, stored, readable generation, with spend recorded
against that user. It saves a private meme; the owner can read its permalink
and image, and another ordinary user is refused.
7. **Photo upload.** An ordinary user uploads a photo; it is stored, readable
by its owner, and not readable by another user."

"Each names its observable outcome; a recorded call to a double is never the
outcome." "Journeys 2–7 form the acceptance run." Journey 6's spend clause
stays a Deferred line naming #651 (David, 2026-10-12), never a pass.

## Must not change (parent, the items this increment can touch)

- "**Production behaviour.** No double is reachable from the deployment
  entrypoint in production." Deploy-selectable doubles "refuse to start in a
  production boot"; test-harness substitution "is installed only by a test
  launcher that imports the app itself".
- "**No credential in CI**, in any form, for any vendor (#566)."
- "**No real external effect from a test**: no email delivered, no image
  generated at a vendor, no object written to the real bucket, no Stripe
  call." The live check is the one named exception, on the Repl with test
  credentials, never in CI.
- "**The child-safety boundary.** No quarantined evidence, NCMEC report or
  safety-ledger row enters a fixture, a log, a test artefact or the
  repository."
- "The per-PR gate's required checks (`Build`, `Test`) and their runtime
  budget: acceptance journeys do not join the PR gate."
- "Existing tests keep passing unmodified, except where an increment replaces
  a per-call-site test hook with the shared double and says so."
- "Data Model and Migration Impact: None planned." Increment 5's fixture files
  under `artifacts/api-server/fixtures/legacy/` are not changed by this
  increment, and no fixture refresh happens before #681 closes.

## Settled by David — do not re-open

- **2026-10-14, the fixture journeys and the prompt rows (option 2):** the
  acceptance run pins the three AI prompt rows (`fact_enrichment_system`,
  `fact_visual_concepts_system`, `fact_image_prompt_system`) to the code
  defaults after loading the fixture, as a documented step of the run; the
  fixture files are untouched. Premise, measured 2026-10-14 by replaying the
  committed recordings over the loaded fixture in this container: the only
  non-pricing misses before moderation stalled were the duplicate judge
  (`openai.chat gpt-6-luna`, called because the fixture holds an active fact
  "{NAME} has counted to infinity - twice." with a real embedding) and the
  enrichment call (`openai.chat gpt-5.5`, because the fixture's
  `fact_enrichment_system` row diverges from the code default at character
  1193); the run then waited 900 s for preparation and failed. So the
  recordings top-up is the duplicate judge plus the free `fal.pricing` rows,
  and one recording set serves both the fresh-database and the fixture runs.
- **2026-10-14, the nine Pexels-only stock memes (option 1):** no journey
  reads them; the acceptance evidence records their count as a known gap; the
  outbound-request check treats a Pexels request like any other vendor's;
  the live check on the Repl reads one of them as its Pexels coverage.
  Premise: with no `PEXELS_API_KEY`, `getPhotoById` throws before any fetch
  (`pexelsClient.ts:144-145`) and `searchPhotos` returns `[]` before any
  fetch (`:99-100`), so under an allowlisted boot no Pexels request can leave
  the process; the fixture holds 9 stock memes with no stored URL and 4 with
  one (counted from `memes.ndjson`, 65 rows).
- **2026-10-14, the live check's vendor spend (option 1):** its own per-run
  cap, default $5, enforced by the recorder's existing allowance class
  (`lib/aiDouble/recorder.ts`, `Allowance`), separate from the $20 recording
  ceiling, raised only by David.
- **2026-10-14, the live check and storage (option 2, "next"):** the live
  check runs the real AI vendors over the local storage double, the
  recorder's shape; storage stays proven by the production app and by
  increment 3's double. A real-storage live check is a later increment if a
  storage client upgrade ever needs it.
- **The recording spend ceiling is David's $20, with $2.94 used** (2026-10-12).
- **The legacy fixture keeps shapes only, is committed publicly, and keeps
  only active facts' live text** (option 1, 2026-10-08).
- **Deferred by David on 2026-10-13:** the processing-signature freshness
  record and the fixture-tool corrections are #681's, which must close before
  any fixture refresh; the fourth upload-lineage role waits for the
  `uim_transform_chk` schema fix, a Tier C fix David starts separately.
- **The Stripe fake (#566) gates only Phase 10.** Journey 6's spend clause is
  deferred to #651. The utility model is `gpt-6-luna` (#666).
- **Pre-launch, the disclosure check is not applied to security details.**
  Secrets and private customer data are still never public.
- **Doubles sit at the seam the production code already crosses, chosen by
  one selection rule** (`lib/doubleSelection.ts`); this increment adds no
  double.

## Now / next / never

- **Now:** everything under *What increment 6 must deliver*, over the fresh
  database and over the fixture; the recordings top-up those journeys need;
  the product-neutral contracts for the acceptance workflow and the live
  check, written in this repository; the DojoOS read recorded on #631.
- **Next:** increment 7 (the burn-down, including the 95 generic Deferred
  lines); a live check over the real storage bucket (David, 2026-10-14); porting the handbook-shaped contracts into the AI-Handbook
  repository, a handbook PR after this increment merges; #681; #651; #668;
  the `uim_transform_chk` fix (David's); the dev and production databases'
  stale `fact_enrichment_system` row, a product question raised 2026-10-14.
- **Never, in this increment:** a Pexels double; a change to increment 5's
  fixture files; a fixture refresh; the Stripe fake; a vendor credential in
  CI; the acceptance run as a required check.

## Ceremony

Internal tier (the parent: "Tier: internal, except the Stripe stub").
Feature mode, production phase, standard review loop; Opus builds. One touch
sits beside a sensitive-tier artefact: journey 1's production-mode launcher
(`src/testing/productionModeLauncher.ts`, increment 2, sensitive) gains the
allowlisted-environment refusal. It is test infrastructure with no production
import path (`__tests__/testHarnessIsolation.test.ts`), so the tier stays
internal; the plan names the change so the reviewer can weigh it.
```

## Preflight

**Increment test.** What this increment makes true: journeys 2–7 run on
demand with no credential and no outbound request, in CI and in this
container, over a fresh database and over the legacy fixture, and the run is
green only when all of them ran and passed; the same journeys run on the Repl
against the real AI vendors under a $5 cap; every journey launcher boots from
a constructed environment; the driver proves the images it reads back are
images. What bounds it: the six journeys the parent names, the two database
variants, the detector around the run, and the contracts written
product-neutral. Completion is recognised by the Definition of Done below:
one green acceptance workflow run per variant on the merged head, one green
live run on the Repl, the DojoOS read recorded on #631, the six UAT lines
deferred to this increment citing their checks. The parent's increment 7 is
the burn-down; nothing from it moves here.

**Affected-surface inventory (oracles run 2026-10-14 at `076e7b5`).**

- *Journey launch paths.* `git grep -n "productionModeLauncher\|aiRecorderLauncher\|record-ai-baseline\|photoUpload.spec\|e2e:storage" -- .github scripts docs/tests artifacts/api-server/scripts artifacts/api-server/src/testing artifacts/*/package.json`: three launches exist. Journey 1's, in CI, `build.yml:624-629`, constructed by removing three Resend variables (`env -u RESEND_API_KEY -u RESEND_API_KEY_DEV -u RESEND_API_KEY_PROD`) from an inherited environment; journey 7's, the documented dev-stack command at `TESTING.md:417-425`, which blanks fal and Arachnid keys; and the recorder's, `record-ai-baseline.ts:268-280`, the one constructed environment, refused by `aiRecorderGuard.ts` when any variable outside `RECORDER_ENV_ALLOWLIST` is present (`:61`). The acceptance run and the live check add two more launches, both of which take the constructed shape.
- *Outbound call sites in the server.* `git grep -ln "fetch(" artifacts/api-server/src --include=*.ts`, tests excluded: `captcha.ts`, `imagePromptJobs.ts`, `aiMemePipeline.ts`, `objectStorage.ts`, `videoPipelineRunner.ts`, `pexelsClient.ts`, `falClient.ts`, `aiDouble/recorder.ts`, `aiDouble/doubles.ts`; plus the SDK clients (fal, OpenAI, Stripe, Resend, Sentry, Arachnid, NCMEC). The detector does not enumerate these: it sits outside the process, so the list is context for what a red run can name, not the scope of the check.
- *UAT steps already deferred to this increment.* `git grep -n "increment 6" -- docs/tests/UAT`: six lines in five documents (PR242:31, PR293:150, PR308:108 and :130, PR402:186, PR582:139), covering journeys 2, 3 and 4. Each becomes a `scripted` step citing its acceptance check.
- *The fixture's effect on the recordings.* Measured by replaying the committed recordings over the loaded fixture (2026-10-14, this container): two non-pricing misses, the duplicate judge and the enrichment call, then a 900 s stall at preparation. Quoted in the oracle.
- *The detector's mechanism.* Measured in this container (2026-10-14): inside `unshare -rn`, with `ip link set lo up`, `ip route add default dev lo`, `iptables -t nat -A OUTPUT ! -d 127.0.0.0/8 -p tcp -j REDIRECT --to-ports 4443` and `… -p udp --dport 53 -j REDIRECT --to-ports 5353`, a child `fetch("https://api.openai.com/v1/models")` whose rejection the child caught and printed as `error The operation was aborted due to timeout` left `{"kind":"dns","qname":"api.openai.com"}` lines on the sink, and `fetch("https://1.1.1.1/")` left `{"kind":"tcp","from":"0.0.0.0:54096","name":null,"firstByte":22}` (a TLS ClientHello); the nat counters read `1 60 REDIRECT 6` and `2 120 REDIRECT 17`. Adding the same rule in the container's root namespace with an owner match was refused by this session's harness, so the private namespace is the mechanism the local command relies on.

**Claim oracles.** "The acceptance run is never a required check" rests on a construct: the required checks are the five names in `.agents/machinery.json` `requiredChecks` (`Classify changed paths`, `Build`, `Test`, `Frontend Test`, `E2E Smoke`) and the `main` ruleset that enforces them; the new workflow's job names are none of these, and the ruleset is not edited (`unable to verify: the ruleset's required-check list from this container; a read of the repository's rulesets at build time settles it`). "No request left the process" is **checked**, by the detector, never asserted: a run states the count the sink recorded. "Zero outbound at boot under the constructed environment" is a measurement each run makes, and the plan does not claim it in advance.

**Specification test.** Applied line by line below: invariants, refusals and evidence, not call sites. The driver's step list is named because its coverage is the increment's product, not its implementation.

## What increment 6 must deliver (from the parent, quoted)

The oracle carries the parent's increment 6, the second-consumer paragraph of its Definition of Done, the #637 gap (the allowlisted boot environment), the #654 gap (the image-content check) and increment 5's D8 handoff verbatim. This section does not restate them.

## The surface, measured (2026-10-14, read from source at `076e7b5`)

- **The runner.** `scripts/record-ai-baseline.ts` has two modes, `record` and `replay`. Both create a fresh database on the server `DATABASE_URL` names, mark it, push the schema, migrate, seed the two accounts, boot the server from a constructed environment on a free port with the local storage double, drive the baseline, and drop the database and the scratch directory (`cleanUp()`, `:116-126`; `--keep-db` keeps the database). Replay fails naming each baseline call that had no recording (`uncoveredCalls()`, `:214-246`), reading `ai-double-misses.jsonl`. Record enforces the allowance (`Allowance`, `recorder.ts:77-140`) and reports committed spend. `fal.pricing` misses are excluded by design.
- **The driver.** `scripts/drive-ai-baseline.ts` signs in free, paid and admin, completes onboarding, and walks: journey 3 (tokenise, duplicate check, hashtag suggestions, submit, provisional approve, prepare, pick a token-valid Visual Concept, tokenise and save it, approve it, wait for the three pinned review renders, approve for production, read the fact), journey 6 (generate, poll to `image_ready`, save a private meme, owner reads permalink and image, other user 404 on both), journey 7 (upload the fixture photo, owner 200, other 403), journey 4 (save a public photo meme, anonymous reads the image). Its evidence (`BaselineEvidence`, `:116-128`) carries ids, statuses and one byte count. `expectRenderFailure` returns early after journey 3's failed render (`:242-247`). The render scenario grid's cards carry `imageUrl` for a `done` render (`reviewRenderScenarios.ts:451-453`, served by `GET /admin/reviews/:id/renders/:renderJobId/image`, `reviews.ts:1723`), which the driver never reads.
- **Journey 2's queue.** `GET /api/admin/reviews` (`reviews.ts:251`) lists pending reviews for admins; a submission is created at `triage_pending` with no AI work enqueued (`:173-177`). Journey 5's gate: `POST /memes/ai/:factId/generate` is wrapped in `requireFeature("meme_ai_background", { errorCode: "legendary_required", message: "This feature requires a Legendary membership." })` (`memes.ts:1295-1298`), which answers 403 `{ error, message, feature }` before the handler runs (`featureAccess.ts:442`); the frontend does not key on the code (`git grep legendary_required artifacts/overhype-me/src`: no hits), it hides the control by entitlement.
- **The fixture over the recordings.** The loaded fixture changes two baseline requests: the duplicate judge (candidates above the 0.65 recall threshold now exist, `ai.ts:277`) and the enrichment call (the fixture's `fact_enrichment_system` row diverges from `FACT_ENRICHMENT_SYSTEM_DEFAULT` at character 1193; the other two prompt rows match the recorded requests). Each `*_system` row is read through `getConfigString` with the code default as fallback (`imagePromptConfig.ts:160-181` and its siblings), so pinning a row to the default makes the request the fresh database's. Hashtag suggestions prompt from the fact text alone (`ai.ts:79-89`), contrary to D8's expectation.
- **Pexels without a key.** `getPhotoById` throws before any fetch (`pexelsClient.ts:144-145`); `searchPhotos` returns `[]` before any fetch (`:99-100`); the meme image route falls back to the stored URL or an empty string, which the canvas loader turns into a 502 (`memes.ts:171-190`). The fixture holds 9 stock memes with no stored URL and 4 whose stored URL is the inline placeholder.
- **Image decoding available in the server package:** `sharp` and `@napi-rs/canvas` are dependencies (`package.json:29,54`). `sharp(...).metadata()` reads headers only: Astra truncated the committed `photo.jpg` (7,636 bytes) to 3,818 bytes in memory and `metadata()` still returned `{format: "jpeg", width: 640, height: 480}`, while a pixel decode rejected it with `VipsJpeg: premature end of JPEG image` (round 1).
- **The recorder's behaviour that the live check must account for.** `alreadyRecorded()` answers a request already written during the same run from disk (`recorder.ts:254-262`), so two meme saves of the same `preview.jpg` reach the vendor once; the `storage.upload` wrapper writes a recording only after a successful upload and nothing when it throws (`:299-305`); the NSFW reader substitutes `0` when the response carries no recognised score (`nsfwClassifier.ts:84`); the fixture's `nsfw_classifier_fail_open` is `true`, and the upload path proceeds on a caught classifier error when it is (`userImageUpload.ts:274-277`). A saved meme stores its classifier score (`memes.ts:47`, `nsfw_classifier_score`); an upload stores none.
- **What the meme journeys read back today.** Both saves send the committed `preview.jpg` as `previewImageBase64` (`drive-ai-baseline.ts:281,321`); the field is optional (`validators/memeBuilder.ts:160`). With a preview, `createMemeRecord` classifies and stores it and sets `storedImageSource = null` (`createMemeRecord.ts:326-390`), and `GET /memes/:slug/image` then serves that stored file from its legacy branch (`memes.ts:626-660`) without reading the uploaded or generated source. Without a preview the recipe is stored and the route composes the image from the source at read time; the owner-facing `GET /memes/ai-user/image?storagePath=` (`memes.ts:572`) serves a user's generated object. (Astra, round 2; verified.)
- **The double's failure selector and call record.** `AI_DOUBLE_FAIL` matches exactly `${kind}:${target}` (`doubles.ts:38-41`); the double keeps an in-process `doubleCalls` array (`:36`) and writes a file only for misses (`AI_DOUBLE_MISS_LOG`, `:54-55`). Moderation's reference images cross the same `fal.storage.upload` seam as journey 7's photo (`defaultReferenceResolver.ts:118-122`), so a selector that failed every upload would break journey 3 first.
- **The detector's second gap, measured here (2026-10-14).** Inside the namespace this container's kernel has no IPv6 at all (`/proc/sys/net/ipv6` absent; `ip -6 route add default dev lo` answers `Operation not supported`), so `fetch("https://[2606:4700:4700::1111]/")` fails with `EAFNOSUPPORT` at `socket()` before any packet exists, and the packet sink cannot see it. A UDP datagram to `203.0.113.1:9999` was redirected (`1 33 REDIRECT 17`) and recorded by the sink. `strace -f --seccomp-bpf -e trace=connect,sendto,sendmsg` around the same child recorded `sendmsg(21, {msg_name={sa_family=AF_INET, sin_port=htons(9999), sin_addr=inet_addr("203.0.113.1")}, …})`; a failed `socket(AF_INET6, …)` is recorded once `socket` is in the traced set (`unable to verify: the exact strace line; the self-test in D4 measures it on each run`). GitHub documents that its Linux runners run as a passwordless-`sudo` user (Astra, round 1, citing the runner documentation).
- **CI.** The E2E job runs Postgres as a `pgvector/pgvector:pg16` service container reached over TCP `localhost:5432` (`build.yml:313-333`); it has no unix socket. The ubuntu-24.04 runner image lists `iproute2 6.1.0-1ubuntu6.4`; its readme lists neither `iptables` nor a sudoers policy (`unable to verify: whether unprivileged user namespaces are restricted on the runner and whether iptables is present; the probe job in step 1 settles both`). `workflow_dispatch` fires only for a workflow file on the default branch; "Once a workflow has run at least once, you can dispatch it against any branch" (GitHub docs, read 2026-10-14). The repository's workflows set `permissions: contents: read, pull-requests: read` per job.
- **DojoOS** (`/home/user/theanswermanishere/dojoos` at `4ca316c`, read-only): `architecture.md` describes one application in two processes (`web` and `worker`) under one supervisor on one Postgres, Backblaze B2 through the S3 API, ffmpeg/ffprobe and a transcription client in the worker; `docs/plans/` is empty, `docs/tests/` carries the synced `TESTING.md`, `uat-doc-format.md` and `test-run-contract.md`.

## Design

### D1. One runner, one scaffold, four modes

The acceptance command and the GitHub workflow invoke one runner, grown from `record-ai-baseline.ts`, whose every mode shares one sequence: create and mark a fresh database on the server `DATABASE_URL` names, push the schema, migrate, **load the fixture when the variant says so**, seed the two accounts, boot the server from a constructed environment, drive journeys 2–7, write the evidence report, then drop the database and the scratch directory. The modes differ only in which backend answers AI calls, which credentials the constructed environment carries, whether the detector wraps the run, and what the report must contain:

| Mode | AI backend | Credentials in the environment | Detector | Where |
|---|---|---|---|---|
| `acceptance` | `recorded-double` | none | required; a recorded request fails the run | CI and any container |
| `live` | `recorder` into a scratch directory that is discarded | fal, OpenAI, Pexels and, when present, Arachnid, each passed explicitly | not run | the Repl, never CI |
| `replay` | `recorded-double` | none | optional | today's proof that the recordings carry the consumers |
| `record` / `--resume` | `recorder` into `--out` | fal and OpenAI | not run | the Repl, never CI |

Invariants: the same driver walks every mode, so a live run's requests are the acceptance run's requests; a mode never inherits the process environment; `acceptance` and `replay` refuse any credential variable; `live` and `record` refuse `CI` and a production environment, as `record` does today (`:67-70`).

### D2. Journeys 2–7: each outcome has an assertion and evidence (Astra S1)

The driver is extended, not duplicated. API-level execution stays, as the parent allows ("A Playwright or API test"), because the API is where every outcome below is observable and the recordings match by construction. The map:

| Journey | Steps the driver takes | Assertion | Evidence in the report |
|---|---|---|---|
| 2 | sign in as free; complete onboarding; tokenise, duplicate check, hashtags, submit | the review is listed by `GET /api/admin/reviews` at `triage_pending` before any moderation call | review id, stage |
| 3 | as today | as today, plus: each of the three pinned render cards is `done`, not stale, and its `imageUrl` streams a body that decodes | render keys, statuses, decoded dimensions |
| 4 | upload the fixture photo; save a public photo meme **as a recipe, with no preview image** | anonymous `GET /api/memes/:slug` 200 and `GET /api/memes/:slug/image` 200 whose body the server composed from the uploaded source and which decodes | slug, dimensions, the recipe's source |
| 5 | as free, `POST /api/memes/ai/:factId/generate` on the active fact | 403, body `{ error: "legendary_required", feature: "meme_ai_background" }`, and the double's call log shows no AI call for the step | status, body, call count |
| 6 | as today, but the private meme is saved **as a recipe, with no preview image** | as today, plus: the owner reads the generated object through `GET /api/memes/ai-user/image?storagePath=` and it decodes; the owner's meme image, composed from that object, decodes; another user is refused both as today; spend recorded against the user stays a **Deferred** line naming #651 | render job, object path, slug, dimensions, the deferral |
| 7 | as today | owner 200 and the body equals the uploaded fixture bytes byte-for-byte (the upload path stores them verbatim); other user 403 | object path, byte equality |

**Decodes** means a full pixel decode: `sharp(body).raw().toBuffer({ resolveWithObject: true })` succeeds, its format is consistent with the response's `content-type`, width and height are positive, and, where the request named an aspect ratio, they are within 2% of it. A header-only read (`metadata()`) is not a decode: Astra showed a JPEG truncated to half its bytes still reports its header dimensions. Journey 7 additionally compares the returned bytes with the uploaded bytes. **A fixed preview can satisfy none of these assertions**: journeys 4 and 6 save recipes that reference the uploaded and generated objects, so the meme image the server returns is composed from the selected source at read time, and an unreadable source fails the journey (D10 proves it with a corrupted source object). This is the #654 gap closed, and it applies to every image a journey reads back. Dropping the preview also removes the save-time preview classifier call from journeys 4 and 6, so their requests no longer depend on preview pixels; the classifier is exercised by journey 7's upload.

**Completion.** A run is green only when all six journeys are `passed` in the variant it ran; a journey not reached is reported `not-run`, never omitted, so an aborted chain leaves its remaining journeys visibly incomplete (Product Intent 3). The `expectRenderFailure` control is a separate `--control render-failure` invocation whose only acceptable outcome is journey 3's failed render; it can never produce an acceptance pass and the report labels it a control. Journey 5's refusal is asserted at the API because that is what the product gates server-side; the control's absence from the free user's builder is the frontend's entitlement rendering, which this increment does not test (noted, not claimed).

### D3. Every journey launcher boots from a constructed environment (the #637 gap)

One module in `src/testing/` owns the allowlist shape `aiRecorderGuard.ts` already has: a launch names its allowlist, the environment it passes contains only those keys, and the launcher refuses, before importing the application, when any other variable is present, naming it. Every launch path takes it:

- the acceptance runner's server boot and the live check (new);
- the recorder (already constructed; its guard moves onto the shared shape without changing its list);
- journey 1's production-mode launcher: `productionModeGuard.ts` gains the allowlist refusal beside its Resend refusal, and `build.yml`'s launch becomes a constructed `env` of named keys rather than `env -u` on an inherited one;
- journey 7's documented dev-stack command in `TESTING.md` is retired in favour of the runner's `--serve` mode, which boots the API from the same constructed environment and waits, so the browser spec `photoUpload.spec.ts` (`e2e:storage`) runs against it from a documented command rather than a hand-typed one. The browser spec is **not part of the acceptance run's green** and runs outside the detector's namespace: a browser's own traffic is not the application's, and a private loopback is unreachable from a browser outside it. Journey 7's acceptance evidence is the driver's (D2); the spec remains the UI check it is today, in the `scripted` lane. (My call on Astra's implementation note; recorded with the reason, open to dissent.)

Invariant: a vendor credential that is not on a launch's allowlist cannot reach that server, so a new vendor's key is excluded without anyone listing it. The Resend blanklist stays as a second refusal, because the mail sink's correctness still depends on it specifically.

### D4. The outbound-request detector: the namespace contains, two observers record (Astra S2)

**Containment.** The whole acceptance run — server, its in-process worker lanes, the driver, any child it spawns — executes inside a private network namespace whose only interface is loopback, with a default route via loopback for IPv4 and, where the kernel offers IPv6 there, for IPv6. No packet can leave it. That is the *no real external effect* guarantee, and it is not the evidence.

**Observer 1, the packet sink.** Inside the namespace, NAT rules redirect every TCP connection and every UDP datagram not addressed to loopback — IPv4 and IPv6 alike, all ports — to a sink listening inside the namespace, which records one line per event: the DNS name when the datagram parses as a query, otherwise the destination family and protocol, and for TCP the TLS server name or HTTP Host when the first bytes carry one. It sees what the kernel routed, with names.

**Observer 2, the syscall record.** The process tree runs under `strace -f --seccomp-bpf -e trace=socket,connect,sendto,sendmsg`, writing to a file the runner reads afterwards. Every attempt to open a non-local socket or address a non-loopback, non-unix destination is recorded with its address family and address, **whether or not a packet followed**: an IPv6 attempt on a kernel without IPv6 fails at `socket()` and is still a line. This is the observer that closes the class Astra named: a forbidden attempt that fails before reaching any sink. Its filter is in the kernel (seccomp), so only the traced calls stop the tracee; the report carries the run's wall-clock beside a `--no-trace` control run once, so the overhead is a number rather than a guess.

**The rule.** After the journeys and after the server has exited, a run is red if either observer recorded a non-permitted attempt, and the report lists every line from both, labelled by observer. Permitted: loopback TCP to the server's port and the sink; the database over a unix socket (directly where Postgres offers one the test role may use, otherwise through a relay the runner starts in the host namespace that forwards a socket path to `127.0.0.1:5432`; the constructed `DATABASE_URL` names the socket directory); unix and netlink sockets. There is no allowlist of remote hosts: an acceptance run has no legitimate one.

**Self-test, every run.** Before the server boots, a helper inside the tree makes four deliberate attempts — a hostname over HTTPS, a literal IPv4 address over HTTPS, a literal IPv6 address over HTTPS, and a UDP datagram to a non-DNS port — and the runner requires the syscall record to show all four and the sink to show every one the kernel could route (on a kernel without IPv6, the sink is not required to see the v6 attempt, and the report says so). Then both records are cleared and the journeys begin. A self-test that does not register is red for that reason, so the coverage claim is checked on each run, never asserted. The observers stay attached until the last covered child exits.

**Privilege.** The namespace is created unprivileged (`unshare -rn`) where the kernel allows it, as this container does; where unprivileged user namespaces are restricted, `sudo unshare -n` creates it, and GitHub documents passwordless `sudo` on its Linux runners. The detector never edits the host namespace's firewall; this session's harness refused exactly that, and a mechanism that needs it would not run here. The workflow's first job (Implementation step 1) exercises, on the runner, the self-test's four attempts, the database relay and permitted local traffic; a runner where tracing is unsupported is an environment failure, never reduced coverage and never green.

**Rejected:** a proxy environment variable, which Node's `fetch` and the vendor SDKs do not honour by default; a hook installed inside the server process, which is the application cooperating in its own audit; the AI double's miss log, which sees only calls that cross the double; a single packet-level observer, which the IPv6 measurement above showed blind to an attempt that fails before a packet.

### D5. The fixture variant and the recordings top-up (David, 2026-10-14, option 2)

The fixture variant inserts two steps between migrate and the account seed: `load-legacy-fixture.ts` against the committed fixture, then the **prompt pins**: `fact_enrichment_system`, `fact_visual_concepts_system` and `fact_image_prompt_system` are set to the exported code defaults (`FACT_ENRICHMENT_SYSTEM_DEFAULT`, `FACT_VISUAL_CONCEPTS_SYSTEM_DEFAULT`, `FACT_IMAGE_PROMPT_SYSTEM_DEFAULT`), by an `UPDATE admin_config SET value … WHERE key …` before the server boots, so no config cache exists yet to bust. The report records which rows were pinned and whether each differed from the fixture's value. The fixture files are untouched. Invariant: with the pins applied, a request's fingerprint depends on the catalogue only where the product reads the catalogue, which the replay measurement bounds to the duplicate judge and the pricing warm-up.

**The top-up** records those requests on the Repl with `--mode record --resume` over a copy of the committed recordings, loading the fixture first (the runner's fixture variant in record mode), under an allowance drawn from the $17.06 that remains of David's $20; the expected spend is the duplicate judge at `gpt-6-luna` and free `fal.pricing` rows, under $0.05. The baseline fact stays as it is: its near-duplicate in the fixture is what finally exercises the judge with real candidates, and the flag it raises changes only the submitter's activity-feed message (`reviews.ts:226-234`); changing the fact would invalidate every recording. After the top-up, `--mode replay` over the fixture must report zero uncovered calls; that replay is the acceptance run's fixture variant without the detector.

### D6. The live check (Astra S3; David, 2026-10-14, option 2)

`--mode live` runs on the Repl, started by me through the connector, never in CI (it refuses `CI` and a production environment as `record` does). It boots the server with `AI_BACKEND=recorder` writing to a scratch directory that is discarded at the end; **same-run reuse is off in this mode** (`alreadyRecorded()` is bypassed by a recorder option the live mode sets and `record --resume` does not), so every AI request reaches its vendor and no recording, committed or written minutes earlier, can stand in for a current response. The constructed environment carries the fal, OpenAI and Pexels keys, and Arachnid's when present, explicitly; storage is the local double (David's option 2). The `Allowance` enforces `--allowance`, which the runner refuses above $5 unless `--allowance-raised-by-david <date>` is given; with `--variant both`, one ledger file spans both variants in sequence, so the cap is per invocation. The live ledger never touches the recording ledger. The database is a fresh marked one on the Repl's test server, dropped after; the scratch directory is removed.

**Positive evidence per operation, not the absence of errors.** The live report carries a map from each operation a journey claims to its current-run evidence, and the run is green only when every row is satisfied. A row needs a vendor call in this run's ledger with outcome `ok` and a response the product's own reader turns into a usable value; the runner applies that reader to the recorded response rather than trusting the journey's success, because the application falls back in several places (the classifier fails open under the fixture's config; a classifier response without a recognised score reads as `0`; hashtags, keywords and the duplicate judge are best-effort). The map:

| Journey | Operations with required evidence | Usable value |
|---|---|---|
| 2 | none (no vendor) | the queue listing |
| 3 | `openai.chat` enrichment, Visual Concept, three image prompts; `fal.subscribe` for the three renders; `fal.storage.upload` for each reference image; `openai.embeddings` for the duplicate check; `openai.chat` for the duplicate judge, hashtags and keywords | enrichment parsed by its validator; a token-valid concept; three `done` renders whose images decode; an embedding of the configured dimension; the judge's JSON parsed |
| 4 | none at save (a recipe save classifies nothing; the upload was classified in journey 7) | the composed meme image decodes |
| 5 | none | the 403 |
| 6 | the image prompt and render, and the download of the generated image | a decoded generation read as its owner; the composed meme image decodes |
| 7 | `fal.storage.upload` of the photo; `fal.subscribe` NSFW | an `ok` upload line; `extractNsfwScore(response)` non-null |
| fixture variant | one read of a Pexels-only legacy meme; the duplicate judge | `GET /api/memes/:slug/image` 200 whose body decodes, which only a successful `getPhotoById` can produce; the judge's JSON parsed |

**Required operations are declared per mode and per variant, never derived from the calls that happened.** The Pexels-only meme read is required in live mode only; in acceptance mode the nine memes are recorded as the agreed coverage gap and no row requires them (David, 2026-10-14, option 1). The fresh database has no neighbours, so the duplicate check returns before the judge (`ai.ts:274`) and the judge is not required there; over the fixture it is. The expectation table is a constant in the runner, and a call that was expected and absent is a `missing` row.

**One evaluator for both modes.** The coverage evaluator reads a run record with one line per AI call — kind, target, fingerprint, outcome, and the path of the recorded response — and applies the map above. In live mode the record is the recorder's ledger. In acceptance mode the double writes the same shape to a call log (`AI_DOUBLE_CALL_LOG`, beside today's miss log), so the evaluator, its map and its readers are exercised credential-free on every acceptance run, and journey 5's "no AI call for the step" reads from the same log.

For this to be observable, the recorder's `storage.upload` wrapper records a failed upload as a ledger line with outcome `error` (today it records only success), and the ledger carries the fingerprint so a row can be matched to its operation. A missing credential, an allowance refusal, a vendor error, or a row without a usable value leaves that row `missing` and the run not green.

**Negative control.** `--control upload-failure` in acceptance mode makes the double fail **one** operation: the failure selector gains an optional request qualifier, `AI_DOUBLE_FAIL=fal.storage.upload:<sha256 of the fixture photo>`, so moderation's reference-image uploads (different bytes) are untouched and journey 3 completes. Journey 7's upload API then returns 200 on the fixture's fail-open configuration and the owner reads the photo back; the evaluator, fed the double's call log, marks row 7's upload evidence `missing`, and the run is red for that reason and that reason only. A green here is a defect in the evaluator, not a pass. The control's acceptance criterion names both halves: the journey completed, and the same evaluator live mode uses refused it.

### D7. Evidence: a report that outlives the run

Each run writes `acceptance-report.json` and a Markdown rendering of it before cleanup, success or failure: commit, mode, variant, fixture manifest digest when loaded, the recordings directory's file count and listing hash, the prompt pins applied, each journey's outcome and its evidence rows (D2), the detector's self-test result and every recorded line, the uncovered AI calls, the deferrals (journey 6's spend to #651; the nine Pexels-only memes as a count), and, for `live`, the allowance committed. The workflow uploads the report as an artefact; the scratch directory, the storage double's files and the server log are never uploaded (Astra: nothing captured leaves the runner but the report). The server log's last 200 lines are included in the report only when the run is red.

### D8. The workflow

`.github/workflows/acceptance.yml`: `workflow_dispatch` with a `variant` input (`fresh`, `fixture`, `both`; default `both`), plus `pull_request` filtered to the acceptance tooling's paths so the increment's own PR proves the workflow runs in CI before it reaches the default branch (dispatch fires only for a file on the default branch, *The surface, measured*). Its jobs are not in `requiredChecks` and never become so; `permissions: contents: read`; no secret is referenced. It provides the `pgvector/pgvector:pg16` service and the socket relay, installs nothing the runner lacks beyond what step 1 found, and runs `pnpm … --mode acceptance --variant <v>`. One green run per variant on the merged head is the parent's "run green on demand once before Phase 2 closes".

### D9. The contracts, written product-neutral, and the DojoOS read

`docs/engineering/acceptance-workflow.md` states, for any product in this fleet: the launcher pattern (a constructed environment from a named allowlist, refused on any other key, applied to a set of processes); the detector's boundary (a private network namespace around the whole process tree, a sink that records names, a self-test per run, database over a unix socket); the completion rule (every named journey reported, green only on all passed and zero recorded requests); the evidence report's required fields; and the live-check contract (same driver, real vendors, explicit credentials, a per-run cap enforced before each call, never CI, on the deployment's own host). It names Overhype only in examples. Read against DojoOS (`architecture.md`, `docs/tests/`), all six handbook-shaped parts the oracle names get a disposition in the #631 comment at close-out: **lane tags** — already in DojoOS (`docs/tests/uat-doc-format.md` and `scripts/check-uat-format.mjs` are synced there), serve unchanged; **the acceptance workflow shape** — the new contract serves a two-process application unchanged, because a namespace wraps a supervisor's whole tree and a constructed environment is per process; **the readiness table** — DojoOS's `docs/tests/UAT/` holds only a README, so the format serves unchanged when it gains docs; **the double-selection rule** and **the test-database marker** — absent from DojoOS as code, they serve unchanged as rule text (an explicit positive selector; a marker read from the database, never a name), with the implementation each product's own; **the launcher pattern** — serves unchanged. What the contracts leave to DojoOS's own harness increment: the two-process async harness itself, media probes and generated fixtures, and voice and transcription doubles. Porting the contract into the handbook is **next**: a handbook PR after this merges.

### D10. Tests and evidence

- Unit: the sink's DNS-name and server-name parsing on captured bytes; the syscall record's parser on captured `strace` lines (an `AF_INET6` `socket()` failure, a `sendmsg` to a literal address, a loopback connect ignored); the shared launcher guard's refusals (a stray key named, an allowlisted set accepted) for every launch path's list; the report's completion rule (twelve outcomes, red on any non-pass, red on any line from either observer, red on a failed self-test, red on any `missing` live-evidence row); the image decode helper on a PNG, a JPEG, a non-image body and a header-valid truncated JPEG; the coverage evaluator on synthetic run records (a row satisfied, a row with an `error` line, a row whose response the reader cannot use, a row absent in a variant that requires it, the same absence in a variant that does not); the failure selector with and without the request qualifier; the live cap refusal above $5 without the raise flag; the recorder's upload wrapper writing an `error` line on a thrown upload; reuse off under the live option.
- Integration, in this container and in CI: `--mode acceptance --variant fresh` and `--variant fixture` green; the detector's four-attempt self-test registering on both observers; a negative run with an injected forbidden request after the self-test (`--control forbidden-request`) red naming the host; `--control render-failure` reporting the failed render and never a pass; `--control upload-failure` red with row 7 `missing` after journey 7 completed; a meme whose source object is replaced by a non-image makes its journey's image read fail while a valid preview would not have; `replay` over the fixture with zero uncovered calls after the top-up.
- Journey 1's launcher: the existing E2E job green with the constructed environment, and `productionModeGuard.test.ts` covering the new refusal.
- Live: one `--mode live` run on the Repl, both variants, green, its report quoted in the PR body with the allowance committed.
- The six UAT lines: `check-uat-format` green with each now a `scripted` step citing its acceptance check.

## Not in this increment

Increment 7; the handbook port of the contract; a real-storage live check (David, option 2); a Pexels double; any change to the fixture files or a refresh; #681; #651; #668; the `uim_transform_chk` fix; the stale `fact_enrichment_system` rows in the dev and production databases (a product question raised 2026-10-14); the frontend's rendering of the paid gate; the Stripe fake.

## Implementation steps

1. **CI feasibility first.** Push the workflow with one probe job: create the namespace (unprivileged, else `sudo`), install the rules, attach the syscall observer, run the four-attempt self-test, reach the database through the relay, serve one permitted local request, report. Red on both privilege routes stops the increment and comes back to David with the measurement.
2. The shared launcher guard; the recorder, journey 1's launcher and `build.yml` moved onto it; `TESTING.md` updated.
3. The driver: journeys 2 and 5, the permalink and decode assertions, the byte comparison, `not-run` reporting.
4. The runner: modes, the fixture variant with the pins, the detector and sink, the relay, the report, the controls.
5. The recordings top-up on the Repl; replay over the fixture green; recordings committed.
6. The workflow's acceptance job; both variants green on the PR.
7. `--mode live`; one run on the Repl under $5; report in the PR body.
8. The contract document; the DojoOS read; the #631 comment naming what DojoOS keeps; the six UAT lines.

## Risks

- **The runner restricts unprivileged namespaces and `sudo` cannot create one either.** Step 1 measures it before anything depends on it; the fallback would be a different mechanism and a return to David.
- **A journey over the fixture differs from the measurement** (a request the replay stall hid). The top-up run reports it as uncovered; `--resume` records it within the remaining ceiling; a request that cannot be afforded comes back to David, never a weaker baseline.
- **The live check's vendor spend drifts above the estimate.** The cap refuses before dispatch; a refused run is red, not expensive.
- **The detector's sink and syscall parser become two more things to maintain.** Each is about a hundred lines with no dependency, tested on captured bytes, and their failure mode is a red run; the per-run self-test catches a parser that stopped matching.
- **The syscall observer slows a run.** The seccomp filter stops the tracee only on the traced calls; the report's wall-clock beside one `--no-trace` control makes the cost a number, and a cost that mattered would move the observer to a cheaper probe, not remove it.

## Questions for David

None open. The three of 2026-10-14 and the storage question are in the oracle.

## Definition of Done

- [ ] `acceptance.yml` ran green on the merged head for `fresh` and `fixture`, each report uploaded, each with zero recorded requests, twelve journey outcomes `passed`, the detector self-test registered.
- [ ] The negative controls behave: `forbidden-request` red naming the host; `render-failure` never a pass; `upload-failure` red with row 7 `missing`.
- [ ] Journey 1's E2E job boots the production-mode launcher from a constructed environment and is green.
- [ ] The recordings top-up is committed; `replay` over the fixture reports zero uncovered calls; the ledger's committed spend is quoted in the PR body against the $20.
- [ ] One `--mode live` run on the Repl, both variants, green, under $5, report quoted.
- [ ] `docs/engineering/acceptance-workflow.md` exists, product-neutral; the DojoOS read is a comment on #631 giving all six handbook-shaped parts a disposition and naming the three pieces left to DojoOS.
- [ ] The six UAT lines cite their checks; `check-uat-format` green.
- [ ] No fixture file changed; no credential in any workflow; `requiredChecks` unchanged.

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

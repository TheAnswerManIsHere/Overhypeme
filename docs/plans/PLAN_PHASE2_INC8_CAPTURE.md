# PLAN — Phase 2 increment 8: capture and read · technical design · v4 · APPROVED by David 2026-10-16 (Astra scope exchange and round 1 incorporated; D7 transfer re-measured after David enabled pushes from the Repl)

Parent: `docs/plans/PLAN_PHASE2_VERIFICATION.md` (v5 amendment adds increment 8) and `docs/plans/PLAN_PHASE2_INC7_BURN_DOWN.md`, *Settled by David*, answer 5. Nothing here changes scope; anything that would is marked **for David**.

```plan-oracle
# Oracle — Overhype.me #631, Phase 2 increment 8 (capture and read)

Agreed with David 2026-10-16 ("Go with your recommendations", answering the scope banner below and its baseline question).

**Direction:** Phase 2's Definition of Done requires increment 8 landed (#631; `docs/plans/PLAN_PHASE2_INC7_BURN_DOWN.md`, answer 5, 2026-10-14: "Increment 8: a capture run that writes the named screen into the run's evidence, the lane model told that a machine captures and Claude judges (a handbook change: the format, the checker and the `/uat` skill sync from it), and the capture scripts for the counted list").

**Product intent:** a UAT step whose Expect needs a screen looked at but no taste or product judgement is captured by a machine and judged by Claude at run time, with the captured screen in the run's evidence; David sees only judgement steps.

**Now:**
1. Handbook half: the lane model gains the capture shape in the format, the checker refuses a `human` step whose Expect carries no judgement marker, and the `uat` skill's run-time bullet reads the captured evidence. Its own PR there, synced here.
2. The capture run: a script here that drives the local stack at the commit under test with Playwright, signed in as the dev-admin test login, and writes each named screen into the run record's evidence.
3. Capture scripts for the 22 lines (the steps carrying `**Deferred:** #631 — increment 8 (capture and read)` on `main` at a1d8e7a), each Deferred line replaced by its Check.

**Must not change:** no product code; the human lane's definition; the Deferred rule; the live lane's read-only rule; `check-uat-format.mjs`'s existing refusals.

**Settled:** increment 8 before 7b part 2; all process skills live in the handbook (David, 2026-10-15); the checker change is increment 8's, not AI-Handbook #215's. **No committed baseline screenshots**: an Expect reading "looks as it did before this PR" is rewritten as a described screen judged from the capture alone, consistent with David's standing visual-regression carve-out. The colour clause of PR398 R5 (brand-orange name highlight) is increment 8's (David, 2026-10-16, 7b part 2 sizing answer 2).

**Ceremony:** internal tier, standard loop, both halves; Opus for the build.
```

## Preflight

**Increment test.** What this increment makes true: no UAT step whose answer is on a screen reaches David. The class no DOM assertion can answer has a re-runnable capture that Claude reads at the commit under test, with the image kept as evidence. That class is the pixels of an image: our compositor's output, or a real render's content. What bounds it: the 22 counted steps, the format and checker change that makes the class expressible, and the 11 other `human` steps that change forces a decision on. How completion is recognised: the oracles in *Definition of Done*.

**Affected-surface inventory.** The class is "a UAT step labelled `human` whose Expect a machine can answer". Oracles run at `a1d8e7a`, 2026-10-16:

- `git grep -c 'increment 8 (capture and read)' -- docs/tests/UAT` → 22 lines in 9 docs, every one on a `human` step, as a script reading each step's `**Lane:**` confirmed. Seven of the lines also carry a 7b gap. PR256 step 1 also carries a #628 Phase 4 item.
- `git grep -h '^\*\*Lane:\*\*' -- docs/tests/UAT | sort | uniq -c` → `ci` 287, `scripted` 51, `live` 12, `human` 33. The 33 are the 22 plus 11 others. Nine of those 11 carry a #628 deferral (Phase 4, 5, 7 or 8), and two carry none (PR687 steps 4 and 5).

The 11 are in scope because D3's checker rule forces each one to carry a judgement statement or change lane, and writing a statement on a step with no judgement would be a false record (Astra, scope C4). This is a consequence of the agreed checker rule, not an addition. It is named so David reads it.

**Claim oracles.** Each completeness claim names its oracle in *Definition of Done*. "The local capture run cannot reach a paid vendor or the deployed environment" is a **construct** (D5). "A real-render capture cannot exceed its allowance" is the recorder's existing **construct** (D7).

## Design

### D1. One rule assigns every clause its lane

Each clause of each Expect in the 33 steps goes to the cheapest lane that can answer it:

1. **`ci`** — the answer is in the DOM, a computed style, a response body, or bytes measurable without looking (dimensions, a hash comparison). It becomes an assertion in an existing suite that CI runs on every PR.
2. **`capture`** (new, D2) — the answer is only in pixels: text, placement, typography or framing our compositor draws into a finished meme, or the content of a real AI render (D7). Claude reads the image against a described Expect.
3. **`human`** — the action needs David's own account or device (a real Google or Apple sign-in), or the answer is his taste. The step carries `**Judgement:**` (D3).

A step whose clauses fall in two lanes is split into one step per lane, per the format's one-action rule. "Looks as it did before this PR" is rewritten as the described screen and then classified (David, 2026-10-16).

The per-step reading, provisional at `a1d8e7a`, is confirmed or corrected at build time and recorded in the PR body (Astra, scope C1). "Kept" names the obligations on the line that are not increment 8's and stay.

| Step | Lane(s) | Identity and state | Captures | Kept |
|---|---|---|---|---|
| PR223 1 | `capture` (real render, D7); caption name `ci` already cited | admin; a fact with a reference photo | reference photo + full-size result | — |
| PR229 6 | `capture` (real render, D7) | admin; a bubble naming an absent character | full-size result | — |
| PR234 1, 6 | `ci` | dev-admin; a fact in moderation step 2, and the Facts editor | — | 7b red-marker gap |
| PR256 1 | `ci` | anonymous; a variant with no images of its own | — | #628 Phase 4 item, 7b gap |
| PR256 R2, R5 | `ci` | anonymous feed and detail; dev-admin editor | — | 7b gaps |
| PR288 R1 | `ci` (described screen) | dev-admin | — | 7b gap |
| PR308 1 | `ci` (described screen) | anonymous | — | 7b limiter-timing gap |
| PR398 2 | `ci` (literal text, pinned) | anonymous; a meme by Nick Baron, he/him | — | 7b gaps |
| PR398 3, 4, 5 | preview and saved picture both `capture`, read for the same words and placement; control state `ci` | free test account; a fact with the name in the middle; split slider moved | preview canvas and served saved picture, per split | 7b gaps |
| PR398 8 | file-equals-page `ci` if bytes match (build reads the route); name in file `capture` | free test account | downloaded file | 7b gap |
| PR398 R1, R2, R3 | `capture` (described screen), including the drawn caption at two position-slider settings; control state and output dimensions `ci` | free test account; the detailed-photo fixture (D5) | finished meme per aspect ratio; preview at each slider setting | — |
| PR398 R5 | `ci` (computed colour) | anonymous; a fact with the name in its text | — | — |
| PR402 5, 10 | `ci` | anonymous | — | 7b gap |
| PR402 7 | `ci` | free (plain registered) test account | — | 7b opacity gap |
| PR472 R6 | `ci` (described screen per admin page) | dev-admin | — | — |

The 11 other `human` steps (Astra, scope C4):

| Step | Lane | Why |
|---|---|---|
| PR229 2, 4, 5, 13 | `capture`, #628 Phase 7 deferral kept | a balloon's tail and attribution on a real render; David's own example of the class |
| PR398 R4 | `capture`, #628 Phase 4 deferral kept | gradient templates are drawn by our code; they are cut in Phase 4 |
| PR687 4 | split: the message text and the refused save `ci`; "it is readable and tells you what to shorten" `human` with `**Judgement:**` | the Expect states a readability judgement, kept per `pr-docs`' authoring rule (Astra, round 1) |
| PR687 5 | `ci` | the Expect is text, layout, status and persistence, all screen fact |
| PR224 6 | `human`, #628 Phase 8 deferral kept | whether a tuned style still looks like itself is taste |
| PR292 R2, R3, R4 | `human`, #628 Phase 5 deferral kept | a real Google or Apple sign-in on his own account and device |

### D2. The `capture` lane (handbook)

A `capture` step is verified by Claude reading an image that a script captured at the commit under test, before David starts. It is a machine lane and obeys the self-contained rule. It carries `**Check:**` citing the capture script, optionally `file:shot name`. Its Expect is a described screen answerable yes or no from the image alone. No baseline image exists.

**Why a lane of its own, not a form of `scripted`** (Astra preferred `scripted`, scope C3): a `scripted` Check is a proof that passes or fails by itself. A capture that ran has proved only that an image exists, and the step's result is Claude's reading. A distinct lane lets the checker and `/uat` know a reading is owed, so "the script ran green" can never be recorded as the step's pass. That is the distinction Astra asks to keep, made structural rather than procedural.

`/uat` records each shot's name, commit, evidence link and Claude's reading per clause on the step's row. A shot that was not produced, or that cannot be read, leaves the step Blocked, never Pass.

### D3. A `human` step states its judgement (handbook)

Every `human` step carries `**Judgement:** <what only David can judge or do, and why no machine can>`. The checker refuses a `human` step without one, and a `**Judgement:**` line on any other lane. It cannot test whether the statement is true. It turns an invisible lane choice into a written claim that review can test. No line is written to satisfy the checker on a step that has no such judgement: that step changes lane instead (D1).

Fleet sequencing: the next sync to each consumer carries this refusal, so each consumer's sync PR migrates its `human` steps in the same PR, or its CI goes red. That failure announces itself. For this repository that is consumer PR B. `unable to verify:` DojoOS's count of `human` steps. That repository is outside this session's scope, and its sync PR settles it.

### D4. `/uat` runs the captures before David starts (handbook)

The `uat` skill's machine block gains the capture lane. It runs the consumer's capture command at the commit under test, writes each shot to the evidence store (D6), reads it, and records it per D2. A real-render capture (D7) runs only with the spending ceiling the consumer names, and its spend goes in the run record's spend line. Any capture Fail is filed before David sees the first human step, as any machine-lane failure is today.

### D5. The local capture run (this repository)

A Playwright capture set beside the existing suites drives a local stack started through the acceptance launcher path (`artifacts/api-server/src/testing/acceptanceLauncher.ts`, the runner's `serve` mode), which supplies the test-database refusal, the constructed environment, the AI doubles and local storage. The browser's target is derived from the stack that path starts (Astra, round 1). It signs in per step with the dev-admin login, the seeded free or paid test account, or no session (D1's table). It creates each shot's state through the product's own API, through the real compositor with the image doubles. Its setup stands on its own and depends on no 7b assertion (Astra, scope C1). Every intermediate state a step names is its own shot: the preview, the saved picture, each split, the downloaded file.

**It cannot reach a paid vendor or the deployed environment, by construction.** The acceptance launcher refuses a database without the test marker and starts the server in a constructed environment with no vendor key. The plain dev entrypoint does neither, so the capture set never boots through it. A sign-in the launcher's mode does not permit is taken from the seeded accounts. The build settles which identity each shot uses, within D1's table.

**Its source fixtures are chosen for the claims they support** (Astra, round 1). A photo with enough spatial detail to judge framing, crop and sharpness is used, because the acceptance fixture is a flat green card. Fixtures are inputs, not baseline screenshots.

**The capture set also runs in CI** in the E2E Smoke job, so a shot that can no longer be produced fails the PR that broke it. CI asserts only that each shot was produced with its anchor element visible. The reading is Claude's at run time. That keeps D2's distinction.

Container feasibility, measured 2026-10-16 at `a1d8e7a`: `scripts/setup-test-db.sh` brought the test database up. The dev API and Vite booted in 6 seconds. `POST /api/auth/dev-admin-login` returned 200. Chromium at `/opt/pw-browsers/chromium-1194` captured `/admin`, and Claude read the image as the Dashboard with its sidebar. The probe booted the plain dev entrypoint, which the capture set will not use (above). It proves the container runs the stack, the browser and the sign-in, not the launcher path.

### D6. The evidence store

Shots are committed to a dedicated branch, `uat-evidence`, one directory per run: the UAT PR, the commit under test and the run date. Each directory holds the images and a manifest naming each shot's doc, step, commit and sha256. The branch is append-only. Every branch's ruleset already blocks force pushes. It never merges. The run record on the workstream issue links each image by the evidence commit's SHA, so a resumed session or David can open it after the container is gone (Astra, scope C3).

The images show a throwaway test database: test accounts, seeded facts and double images. Nothing private reaches the public repository. A real render's reference photo (D7) is a committed test fixture, never a person's own photo.

### D7. Real-render captures (PR223 1, PR229 6; later, the Phase 7 steps)

A real AI render can only run where the vendor keys are, which is the Repl. TESTING.md *Re-recording* says recorder runs happen "on the Repl, never in CI", under the recorder's spending ceiling. The real-render capture uses that same launcher and ceiling. It boots a disposable test database and the API in recorder mode on the Repl. It drives the step's generation with the reference photo fixture through the API. It writes the full-size result and the reference image. The recorder returns the vendor's original result to the application (`recorder.ts:307`), and its stored copies are 96 pixels and do not serve. The reference photo is a recognisable, publishable subject committed as a fixture, never a person's own photo (Astra, round 1).

**Transfer to the evidence store.** The Repl commits the full-size originals and their manifest to `uat-evidence` and pushes that branch. Claude fetches it and reads the images. An image is never shrunk, and a push or fetch that fails leaves the step Blocked. Measured 2026-10-16, after David enabled pushes from the Repl. A plain `git push` from the Repl's shell still fails ("Invalid username or token"), because its `GIT_ASKPASS` names `replit-git-askpass`, which does not exist. A push authenticated with the Repl's `GITHUB_PAT` secret, which is never printed, landed for real. `git ls-remote` from this container then read `refs/heads/uat-evidence-probe` at `a1d8e7a`. The Repl deleted the branch, the delete printed "[deleted] uat-evidence-probe", and `git ls-remote` then returned nothing. So the D7 runner authenticates with that secret explicitly. Pushes to `main` stay refused by its ruleset, which has no bypass actor.

This is a generation, not a read. It is not the `live` lane, whose read-only rule is unchanged. It runs through the connector as an ops run, with an explicit allowance, against a disposable test database on the Repl, never through the product's deployed instance.

Cost: one generation per real-render step per UAT run. **The proposed allowance is $2.00 per UAT run**, passed as the recorder's allowance. The recorder enforces it before every vendor call and refuses a call that does not fit. `unable to verify:` the per-image price, which the recorder reads live from the vendor at run time; the run's ledger records the actual spend, and the run record's spend line carries it. David's approval of this plan approves runs within that bound with no per-run ask (Astra, round 1).

### D8. Each counted line is narrowed, never deleted

Each of the 22 lines loses its `increment 8 (capture and read)` clause and only that. The step gains its `**Check:**` for `ci` or `capture`. Every other clause on the line, and every existing `**Check:**`, stays as it was (the inc 7 plan's rule; Astra, scope C1). A line left with no clause is removed. A step whose clauses all became checks loses its `**Deferred:**` line.

## Data Model and Migration Impact

None. No schema, no migration, no product code. Capture state is created per run on a throwaway test database.

## Security, Permissions, and Validation

The dev-admin login and the seeded accounts are the test identities CI already uses, fail-closed off a test-marked database. The local capture run holds no vendor key, by D5's construct. The real-render run holds the Repl's vendor keys under the recorder's guard and allowance, as record mode already does. The local capture set's isolation comes from the acceptance launcher, not the plain dev entrypoint (D5). The evidence branch carries test data only (D6). Pre-launch, there is no disclosure gating for security details. Secrets and private customer data are never public.

## Testing Plan

- Handbook: the checker's tests gain the `capture` lane, both `**Judgement:**` refusals, and a deferred `capture` step without a Check. Every existing refusal stays green, as the oracle requires.
- This repository: each new `ci` assertion runs in its suite on its PR. The capture set runs in E2E Smoke. `node scripts/check-uat-format.mjs` passes on all 27 docs after the sync.
- The full path is run once at consumer PR B's head: local captures, the two real renders, the evidence commit, and Claude's reading per step. All of it is recorded in the PR body as proof that the run-time path works.

## Implementation Steps (sequencing)

1. **Consumer PR A (this repository, before the handbook change):** the `ci` reclassifications in existing lanes, each with its assertion and its line narrowed per D8. The local capture set and its CI step, producing shots no doc cites yet. Rewrites of "as before" Expects.
2. **Handbook PR:** D2, D3 and D4 in the format, the checker with its tests, and the `uat` and `pr-docs` skills. The prose sweep runs, since this reshapes a rule.
3. **Consumer PR B (this repository):** the sync to the new handbook `main`. The `capture` steps cite their shots. Every remaining `human` step carries its Judgement line. `overlay-declarations.md` names the capture commands, the evidence branch and the real-render allowance. Includes the D7 runner and the full-path proof.

Each PR runs the standard loop at the internal tier. PR A and the handbook PR can be built in parallel.

## Risks

- **CI proves a shot exists, not that it shows the right thing.** The reading happens at UAT time. Accepted, since the reading is the step's result.
- **Doubles hide a compositor regression that shows only with real images.** D7 covers AI results, not the saved-photo compositor. The compositor's framing, crop and text styling are judged on D5's detailed-photo fixture, through the real compositor.
- **The evidence branch grows.** One directory per run, a few hundred KB each. Accepted. Pruning is a later decision, not this increment's.
- **The Repl's push depends on its `GITHUB_PAT` secret staying valid.** If it lapses, the push fails, the step is Blocked, and the run names it. The fallback is base64 text in pieces through the connector's file reader, about 75 KB of image per piece, reconstructed and checked by sha256.

## Questions for David

None beyond approval. The approval ask names D7's $2.00-per-run allowance, which approving the plan accepts.

## Definition of Done

On `main` after consumer PR B merges:

- `git grep -c 'increment 8 (capture and read)' -- docs/tests/UAT` → no matches.
- `git grep -h '^\*\*Lane:\*\*' -- docs/tests/UAT | sort | uniq -c` shows a `capture` count, and the `human` count falls to the steps D1 leaves there.
- Every `human` step carries `**Judgement:**`, and no other lane does. This is a construct: the checker refuses both in CI.
- Every non-deferred `capture` step cites an existing capture script. The checker refuses a missing file.
- E2E Smoke runs the local capture set green on the merge commit.
- PR B's body records one full-path run at its head: every shot linked on `uat-evidence` and read clause by clause, including the two real renders.

## Amendment 1 — the real-render allowance is $3.00 per UAT run (approved by David 2026-10-16)

D7 proposed $2.00 per UAT run on the premise of "one generation per real-render step". The first real run (Repl, 2026-10-16) measured more for PR229 step 6: approving a concept starts the product's three-render review grid, and the moderation test render runs only after approval (`reviews.ts`, the `production_review` stage), so the step makes four renders. The recorder reserves four attempts per fal render (`FAL_SUBMISSION_ATTEMPTS`) and releases none, so the step needs about $2.20 committed against roughly $1.25 billed. David chose to raise the cap to **$3.00 per UAT run** (answer 1a, 2026-10-16), keeping the recorder's worst-case reservation, over counting a completed render once or leaving PR229 step 6 to him. A run is one UAT doc (`--doc`, #708 round 1). Everything else in D7 stands.


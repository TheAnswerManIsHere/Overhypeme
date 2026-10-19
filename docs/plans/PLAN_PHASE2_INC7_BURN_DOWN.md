# PLAN — Phase 2 increment 7: the burn-down · technical design · v3 (rounds 1–3 with Astra incorporated; David's capture-and-read decision of 2026-10-14 added) · APPROVED by David 2026-10-14 · amended 2026-10-14 after the 7a reading (below)

Parent: `docs/plans/PLAN_PHASE2_VERIFICATION.md` v4 (sha256 `db036f0f…`, approved by David 2026-10-08 / 2026-10-11), *Settled Decisions*, increment 7. Nothing here changes scope; anything that would is marked **for David**.

```plan-oracle
# Oracle — Phase 2 increment 7: the burn-down

Status: the scope below is the approved parent plan's increment 7
(`docs/plans/PLAN_PHASE2_VERIFICATION.md` v4, sha256
db036f0fbe7b86812a8b83dbe85f694f144c1f5dc5786c522cd188d4b0461ae1, approved by
David 2026-10-08 / 2026-10-11), quoted, plus the gaps increments 1 and 6
recorded for it on #631, plus David's four answers of 2026-10-14 ("1, 1, 1,
1" to the four numbered questions below) and his fifth decision of the same
day on the capture-and-read class (below). Nothing here is new scope beyond
that fifth decision, which is his.
Increments 1 to 6 are merged; `main` is `de15e8f`. The feature branch is
`claude/increment-7-burn-down`.

## Direction (parent, quoted)

"`launch-definition.md`, *Verification is a prerequisite*: every later phase
ships with its mechanical checks scripted, and David's share of a UAT is the
human residue. Phase 2 delivers reusable verification infrastructure and
proves it through a named baseline of journeys that exist today. Later
product phases add their mechanical checks as they build the corresponding
behaviour, on this infrastructure. Existing backlog steps keep an explicit
disposition, owner and evidence status; deferral never supplies passing
evidence."

## Product intent for this increment (parent, quoted)

Product Intent 5: "Every remaining step of the 30 UAT docs carries one of
the four dispositions; the mechanical ones are scripted or have a named
owner phase; a deferred step is never a pass."

Product Intent 3, which the live check and the gap fixes serve: "An
on-demand acceptance run, separate from the per-PR gate, runs the baseline
and reports green only when every baseline journey ran and passed; a skipped
or missing journey makes the run incomplete, never green."

## What increment 7 must deliver

The parent's increment 7, quoted: "**Burn-down.** Each remaining step
scripted into the lane its disposition names, or explicitly deferred to its
owner phase."

The parent's Definition of Done, quoted: "every remaining step of the 30
docs has a lane, a disposition and a result (an automated one naming its
check)".

Recorded for this increment on #631:

- The increment 1 correction (2026-10-10): "increment 7 (burn-down) owes, for
  each of those steps, the specific unasserted part written into its
  Deferred line before or as it scripts the check, so the record is what the
  PR described." The phrase "the cited check covers part of this step; the
  rest is not yet asserted" occurs 95 times.
- The increment 6 harvest (2026-10-14): "Recorded gaps, for increment 7: the
  live recordings identity over two variants; `netns-run.sh` has no trap, so
  an interrupted run can leave the sink process behind; the live check has
  not yet run at the merged head." The recorded-gap comment's suggested
  shape, from both assessors: "a per-variant recordings directory
  (`live-recordings/<variant>`), with its identity captured into that
  variant's report beside its coverage rows. One allowance must still span
  the whole invocation."
- The issue's increment list: "7 — Burn-down (including the specific
  unasserted part in each of the 95 generic Deferred lines, and increment
  6's recorded gaps)".

## The surface, measured (2026-10-14, read from `docs/tests/UAT/` at `de15e8f`)

26 files, 377 `**Lane:**` lines (291 `ci`, 60 `scripted`, 12 `live`, 14
`human`), 241 `**Deferred:**` lines. The Deferred lines by shape (a
line-based read: each Deferred line paired with the Lane and Check lines of
its own step):

| Count | Shape | Lane | Cites a check |
|---|---|---|---|
| 95 | "#631 — increment 7 (burn-down): the cited check covers part of this step; the rest is not yet asserted" | `ci` | yes, every one |
| 40 | "#631 — increment 7 (burn-down) — <a specific gap>" | 36 `ci`, 4 `scripted` | 4 of 40 |
| 31 | "#631 — increment 7 (burn-down)" with no reason | 14 `ci`, 17 `scripted` | none |
| 13 | "#631 — increment 4 (AI doubles) — <needs a real render / the model>" | 12 `ci`, 1 `live` | none |
| 24 | "#566 — the Stripe fake …" | `scripted` | 1 |
| 38 | "#628 — Phase N (…)" | 13 `ci`, 13 `scripted`, 8 `human`, 4 `live` | none |

So 179 lines name #631 as owner, and 13 of them name an increment that has
merged. The 38 (#628) lines already name an owner outside Phase 2; this
increment re-reads them only to confirm the owner is still right. **The 24
(#566) lines are re-read against what the Stripe fake already does** (Astra,
scope read, verified 2026-10-14): `artifacts/api-server/src/lib/stripeFakeDriver.ts`
serves the read path (account verification, managed-webhook registration,
the backfill into the `stripe.*` mirror, the catalog) and CI runs the
Billing sync browser suite against it (`build.yml`, "Run Billing sync
suite"); payment mutations (checkout, webhook, cancel, refund, dispute)
remain unsupported and stay with #566, which gates only Phase 10. A #566
line whose expectation the existing fake and suite already carry becomes a
`Check:` line in 7a, with the assertion read against the step's unchanged
`Expect`, never a pass on the premise alone (PR577 R2 is the example).

**Completion is all 377 steps reconciled**, not only the 179: every step
leaves 7b with a lane, a disposition and a check or a named owner, and the
parent's Definition of Done is read against that whole set.

## Must not change (parent, the items this increment can touch)

- "**No credential in CI**, in any form, for any vendor (#566)."
- "**No real external effect from a test**: no email delivered, no image
  generated at a vendor, no object written to the real bucket, no Stripe
  call." The live check is the one named exception, on the Repl with test
  credentials, never in CI.
- "The per-PR gate's required checks (`Build`, `Test`) and their runtime
  budget: acceptance journeys do not join the PR gate."
- "Existing tests keep passing unmodified, except where an increment replaces
  a per-call-site test hook with the shared double and says so."
- "**Three records, never merged:** a step's **lane**, its **disposition**,
  and its **result**. An automated step names the check that covers it."
- "Data Model and Migration Impact: None planned." Increment 5's fixture
  files are not changed; no fixture refresh before #681 closes.
- "The child-safety boundary." Nothing from the quarantine enters a test.

## Settled by David — do not re-open

- **2026-10-14 (answer 1): the live check runs now, at the merged head
  `de15e8f`, at the standing $5 cap**, on the Repl, before the burn-down
  touches the live mode. Its report is increment 7's baseline. The cap is
  $5 per run, raised only by David, separate from the $20 recording ceiling
  ($2.94 used).
- **2026-10-14 (answer 2): the split rule and the two-PR shape.** The rule:
  a step is scripted now when its gap is an assertion an existing test file
  or an existing acceptance journey can carry, and its surface is neither on
  the Phase 4 cut list nor owned by a later phase that reworks it;
  everything else gets a named owner phase, never left at #631. The shape:
  **7a** is docs-only, the inventory (each specific gap written into its
  Deferred line, the 13 stale increment 4 lines and every owner-phase line
  re-homed, a counted list of what 7b scripts); **7b** scripts that list.
- **2026-10-14 (answer 3): increment 6's two recorded gaps fold in** — the
  per-variant live recordings directory and identity, and a trap in
  `netns-run.sh`.
- **2026-10-14 (answer 4): the stale `fact_enrichment_system` prompt row
  stays outside increment 7.** It is an admin-editable `admin_config` row,
  seeded once; whether the default changes since migration 0082 were meant
  to reach deployed databases is a separate product question, brought to
  David as a diff in product English, shipped if so as its own migration PR.
- **2026-10-14 (answer 5): the capture-and-read class, and increment 8.**
  David: "there are tests that I'm still being asked to do that seem like
  they are simply you running the program and taking a screenshot of
  something … whether they're end-to-end tests or other types of CI tests
  that require looking at the screen to make sure something's been done,
  that needs to be a piece of what you can accomplish." He chose, from
  three options: **7a classifies the class now, and Phase 2 gains an
  increment 8 that builds the mechanism before Phase 2 closes.** The class:
  a step whose `Expect` needs a screen looked at but makes no product or
  taste judgement ("looks the same as before this PR", "the image looks
  right for your subject", "a clean speech balloon whose tail points at the
  subject"). Only a step that needs David's own taste or a product decision
  stays with him. Increment 8: a capture run that writes the named screen
  into the run's evidence, the lane model told that a machine captures and
  Claude judges (a handbook change: the format, the checker and the `/uat`
  skill sync from it), and the capture scripts for the counted list; its
  own short sub-plan after 7a's count is known; 7b and increment 8 in
  either order. Phase 2 is done only when increment 8 has landed. The
  parent plan's increment list gains increment 8 as a v5 amendment,
  committed with 7a (Planning rule 3; the v4 digest stays cited for the
  text it pinned).
- **The keyword extractor's evidence stays shape-only** (David, 2026-10-14:
  "Option 1 is fine but only for hashtags as the stock photo functionality
  will be removed soon"). **The stock-photo functionality is to be removed**;
  no investment in the keyword row or the Pexels-only meme read.
- **The live check uses the local storage double**; a real-storage live
  check is "next".
- **The acceptance run pins the three AI prompt rows** to the code defaults
  after loading the fixture; the nine Pexels-only memes are a known gap in
  acceptance mode.
- **Exit 90 writes no report, by contract §3.** **IPv6 is "not observable"
  on a kernel without it.**
- **Two-review limit on internal tooling**: after the second review, a
  finding is recorded or goes to David.
- **Journey 6's spend clause is deferred to #651. The Stripe fake (#566)
  gates only Phase 10. No fixture refresh before #681 closes. The
  `uim_transform_chk` fix is David's Tier C to start.**
- **Pre-launch, the disclosure check is not applied to security details.**
  Secrets and private customer data are never public.
- **Phase 2's exit is the parent's Definition of Done**, with the
  second-consumer check already recorded on #631 (2026-10-14).

## Now / next / never

- **Now (7a):** the inventory over all 241 Deferred lines: the specific
  unasserted part written into each of the 95 generic lines; a reason on
  each of the 31 bare lines; the 13 increment 4 lines re-dispositioned
  (scriptable against the doubles or the acceptance run, or `live`, or
  re-homed); every #631 line either marked for 7b or re-homed to a named
  #628 phase or #566 under the split rule; the #566 and #628 lines
  confirmed; a counted list for 7b. The live check at `de15e8f`, its report
  recorded. The parent plan's increment 7 split into 7a and 7b on the
  issue.
- **Now (7a, continued):** every step of the capture-and-read class marked
  `**Lane:** human` with `**Deferred:** #631 — increment 8 (capture and
  read) — <what the screen must show>`, inside today's format, so the
  class is counted by `git grep` and nothing passes on it until increment 8.
- **Now (increment 8, planned separately after 7a):** the capture run, the
  lane-model change in the handbook, the capture scripts for the counted
  list.
- **Now (7b):** the checks 7a lists, each a test assertion in an existing
  file or an extension of an existing acceptance journey, each Deferred line
  it closes replaced by its `Check:` line; increment 6's two gaps; the
  Phase 2 close on #631 against the parent's Definition of Done.
- **Next:** increment 8's design detail (its own sub-plan); a real-storage live check; porting the handbook-shaped
  contracts to the AI-Handbook; #681; #651; #668; the `uim_transform_chk`
  fix (David's); the prompt-row question (David's, separately); every step
  7a re-homes, in its owner phase.
- **Never, in this increment:** a new double; a new vendor; a fixture
  change or refresh; the Stripe fake; a check for a surface on the Phase 4
  cut list (stock photos, video, merch, PuLID); a vendor credential in CI;
  the acceptance run as a required check; a change to a UAT step's
  `Expect` text to fit a check (the step describes the product; the check
  serves the step); a deferred line left naming #631 at Phase 2's close.

## Ceremony

Internal tier (the parent: "Tier: internal, except the Stripe stub").
Feature mode, production phase, standard review loop, two-review limit;
Opus builds. 7a is docs-only but is not the Documentation class: its lines
are verification records the checker enforces and 7b builds from, so it
takes the standard loop at internal tier like the rest of Phase 2. No
sensitive-tier artefact is touched: the launchers and guards of increments
2 and 3 are not changed. **7b's checks land wherever an existing check
already runs** (Astra, scope read, verified 2026-10-14): the api-server
suite, the acceptance driver, the frontend vitest suite, and the Playwright
specs CI already runs (`e2e:smoke`, `e2e:surfaces`, `e2e:accounts`,
`e2e:billing`, `e2e:auth` in `.github/workflows/build.yml`), because an API
response cannot establish that a row collapses or a banner appears. Every
addition stays inside the per-PR gate's runtime budget (Must not change).

```

## Preflight

**Increment test.** What this increment makes true: no UAT step anywhere in
`docs/tests/UAT/` is deferred to Phase 2 itself; every mechanical step either
cites the check that asserts its `Expect` or names the later phase that owns
its surface; every step whose `Expect` no check can assert is in the `human`
lane, split between the steps that need David's judgement and the steps
that only need a screen looked at, the latter counted for increment 8; the live check's evidence names, per variant, the answers that variant
was judged against; an interrupted detecting run leaves no process behind.
What bounds it: the 26 documents and their 377 steps as they stand at
`de15e8f`, every one of them read, not only the 241 with a Deferred line
(Astra, round 1: 136 steps carry a `Check:` and no deferral, 121 `ci`, 2
`scripted`, 7 `live`, 6 `human`, and PR256 step 4 is one whose cited test
asserts less than its `Expect`); checks that extend files CI already runs;
the two increment 6 gaps. Completion is recognised by the Definition of Done below, read against
all 377 steps and the parent's Definition of Done. Two pull requests, 7a and
7b, by David's decision; nothing from a later phase moves here.

**Affected-surface inventory (oracles run 2026-10-14 at `de15e8f`).**

- *The lines this increment owns.* `git grep -n 'Deferred:\*\* #631' -- docs/tests/UAT/`: 179. Of those, `… #631 — increment 4`: 13 (an increment that merged on 2026-10-13); `covers part of this step; the rest is not yet asserted`: 95; `… increment 7 (burn-down)$` (no reason): 31; the remaining 40 name a specific gap. `Deferred:\*\* #566`: 24. `Deferred:\*\* #628`: 38, naming Phases 4, 5, 7, 11, 13 and 14. Any other owner: 0. Total 241, which is every `**Deferred:**` line in the directory.
- *The documents.* 26 files; the parent's "30" counted four that #632 itself deleted (`PR213`, `PR214`, `PR216`, `PR394`, retired with the cut; `git log --diff-filter=D -- 'docs/tests/UAT/*.md'`). Lanes: 291 `ci`, 60 `scripted`, 12 `live`, 14 `human` (377 `**Lane:**` lines).
- *Where a check can land today.* The api-server suite (211 `*.test.ts` files, 59 s in the `Test` job at `de15e8f`); the frontend vitest suite (92 test files, 66 s in `Frontend Test`); the acceptance driver (`src/testing/acceptance/driver.ts`, journeys 2–7, on demand); five Playwright suites CI runs in `E2E Smoke` (run 38610599073: route-load smoke 70 s, admin surfaces 59 s, test accounts 14 s, Billing sync 24 s, production-mode auth 29 s; the job 4 m 55 s end to end). Each `e2e:*` script names its spec files (`artifacts/overhype-me/package.json:16-22`).
- *The two gap sites.* `scripts/acceptance-run.ts:494` (`liveRecordings = path.join(scratch, "live-recordings")`, shared by both variants) and `:520` (identity taken once, after both); `src/testing/acceptance/netns-run.sh:71-74` (the sink is killed only after `strace` returns normally; no `trap`).
- *Steps with no Deferred line.* 136 of the 377 (a line-based read pairing each step's `Lane:` with the presence of a `Deferred:` line): 121 `ci`, 2 `scripted`, 7 `live`, 6 `human`. Example of why they are read too: `PR256_VARIANT_INDEPENDENCE_UAT.md` step 4 expects "It's accepted and generates"; its cited `memesGenerateGeneric.test.ts` asserts a 202 and an attempt row, and the file says at line 6 "The async worker is NOT running in these tests", so generation is unasserted and the step has no Deferred line.
- *The capture-and-read class, an upper bound.* A word search over `Expect` for looks / appears / visible / renders / displays / shows / badge / banner / label / button / page / modal / screen: 91 machine-lane steps with no check (68 `ci`, 23 `scripted`), 55 with a check (52 `ci`, 3 `live`), plus 14 `human` steps, of which about ten read as "unchanged from before" or "renders correctly". Most of the 91 are assertable facts (D2); the reading decides each. The word search is a bound, not the classification.
- *What the checker enforces* (`scripts/check-uat-format.mjs`): one lane per step; a non-deferred machine-lane step cites a backticked check whose path exists; a `**Deferred:**` line names an issue; at most one `**Check:**` and one `**Deferred:**` per step. It cannot read whether a cited test asserts the step's `Expect`; that is this increment's work, recorded per line.

**Claim oracles.** "No line names #631 at close" is checked by the inventory
oracle above returning 0 once 7a, 7b and increment 8 have all landed; at 7b's
close it returns only increment 8's lines, and at increment 8's close only
7b's if 7b lands later (each Definition of Done quotes the command and its
output). "A deferred step is never a pass" is a construct in `/uat`'s run
record (a `Deferred:` line is listed as outstanding, `uat-doc-format.md:70-73`).
"7b stays inside the per-PR gate's runtime budget" is a measurement: the
`E2E Smoke`, `Test` and `Frontend Test` job durations on 7b's head against the
`de15e8f` figures above; the plan sets the bound, not a hope. "The live
identity is per variant" is checked by a test over the report (D4).

**Specification test.** Applied line by line: the plan states what each line
must say, what a check must assert, what the report must carry, and how each
is demonstrated. It does not list the dispositions; producing that list is
7a, under the rule the oracle states.

## What increment 7 must deliver (from the parent, quoted)

The oracle carries the parent's increment 7, the increment 1 correction, the
increment 6 gaps and David's four answers verbatim. This section does not
restate them.

## The surface, measured (2026-10-14, read from source at `de15e8f`)

- **A Deferred line's shape today.** `**Deferred:** #631 — increment 7 (burn-down): the cited check covers part of this step; the rest is not yet asserted` on 95 `ci` steps, each with a `**Check:**` naming a test by file and title (for example `routes.admin.test.ts:queues the variant as a Stage-1 review carrying the parent`). The 31 bare lines sit on steps with no `**Check:**` at all (14 `ci`, 17 `scripted`); their `Expect` is typically a surface ("the success message reads …", "a queue row expands", "the public fact feed is unchanged"). The 13 increment 4 lines say "needs a real render" or "needs the model"; since #654 and #682 the doubles and the acceptance run supply both.
- **The live run's evidence.** `recordingsIdentity(dir, source)` lists a directory and hashes the listing (`acceptance-run.ts:203`); in live mode both variants record into one `live-recordings` directory, and the recorder overwrites a file that shares a request fingerprint, so the end-of-run identity describes the union. Each variant's coverage is evaluated before the next variant runs, so verdicts are unaffected. One `live-ledger.json` spans the invocation and enforces the $5 cap. The baseline at `de15e8f` (2026-10-14, Repl, `--mode live --variant both --allowance 5`): green, `committedUsd 3.8634`, 39 vendor calls, 41 recording files, listing `2711632481a9…`, every coverage row `satisfied` on both variants (the duplicate judge `not-required` on fresh), the hashtag suggester `1 usable of 1`, `pexelsMeme ok` (jpeg 1880×1058). The first attempt that day ran red for $0 because the Repl's install predated #679's `pg` dependency (the recorded memory note); `pnpm install --frozen-lockfile` and a re-run fixed it, no file changed.
- **The namespace wrapper.** `netns-run.sh` starts the sink in the background (`:61-64`), runs the payload under `strace` (`:72`), then `kill "$sink_pid"; wait` (`:73-74`). A SIGINT or SIGTERM to the wrapper, or a `fail` exit before `:73`, leaves the sink running inside the namespace until the namespace's last process exits; on the workflow's runner the namespace dies with the job, in a container or on the Repl a stray `node … sink.ts` can outlive the run (`unable to verify: observed on a real interruption; the trap test in D5 measures it`). **A trap alone is not enough** (Astra, round 1; measured here 2026-10-14): a Bash script whose foreground command is `sleep 4` received SIGTERM at +1.0 s and ran its `trap … TERM` handler at +4.0 s, after the foreground command returned; Bash delivers the trap only once the foreground child exits.
- **The Stripe fake's reach.** `stripeFakeDriver.ts` serves account verification, managed-webhook registration, the backfill into the `stripe.*` mirror and the catalog, holds no credential, and refuses to boot beside a real key; `adminBillingSync.spec.ts` runs against it in CI. Checkout, webhooks, cancel, refund and dispute are not in it (#566, Phase 10).
- **Phase 4's cut list** (`launch-definition.md`, *Cut, deleted or deferred*, and the `#628 — Phase 4` lines): video memes and PuLID, merch and Zazzle, gradient templates; **stock photos join it** (David, 2026-10-14). Queue Health and Email Queue are kept (`launch-feature-inventory.md:293-294`); Phase 13 reworks named admin screens, not every admin screen.

## Design

### D1. One rule decides every line, and the line records the decision

Every step in the directory, with or without a `**Deferred:**` line, is
re-read in 7a against its `Expect`, its cited `Check:` (where one exists) and
the rule the oracle states, and leaves 7a in exactly one of five shapes. The
shapes are the invariant; the count in each is 7a's output. A step whose
cited check asserts less than its `Expect` gets the same treatment as a
deferred one: the unasserted part is written and dispositioned, whether or
not a Deferred line was there before (Astra, round 1, R1).

1. **Check** — a `**Check:**` line citing a test, spec or journey that asserts
   the step's `Expect` as written, with the `**Deferred:**` line removed.
   Allowed in 7a only where that assertion already exists and was read, not
   inferred from a title (the increment 1 correction is the warning); 7b's
   additions take this shape as they land.
2. **7b** — `**Deferred:** #631 — 7b — <the specific part of Expect no check
   asserts> — <the existing file or journey the assertion lands in>`. The
   target is one of: an api-server test file, a frontend test file, a
   Playwright spec CI already runs, or an acceptance journey by number.
3. **Owner phase** — `**Deferred:** #628 — Phase N (<name>) — <why that phase
   owns it>` or `#566 — the Stripe fake — <the payment mutation it needs>`,
   when the surface is on the Phase 4 cut list, is reworked by a named later
   phase, or needs the fake's unbuilt payment path. A re-homed line keeps
   its partial `**Check:**` where one exists.
4. **Human** — `**Lane:** human` when the `Expect` is a judgement no
   mechanical check can make. Two sub-shapes, told apart in the line (David,
   2026-10-14, answer 5):
   - **4a, David's:** the step needs his taste or a product decision ("is
     this the copy we want"). No `Deferred:` line; `/uat` presents it to him.
   - **4b, capture and read:** the step needs a screen looked at but no
     product judgement ("looks the same as before", "the image looks right
     for your subject", "the balloon's tail points at the subject"). It is
     written `**Lane:** human` with `**Deferred:** #631 — increment 8
     (capture and read) — <what the screen must show>`, inside today's
     format: the checker accepts a deferred human step, `/uat` lists it as
     outstanding, and `git grep 'increment 8 (capture and read)'` counts the
     class. Increment 8 replaces each such line with its capture check and
     the lane-model change that lets Claude read the capture as the
     step's evidence. Nothing passes on a 4b step before then. **A mixed step keeps its mechanical obligations:** when
   the `Expect` also carries a clause a check can assert (PR223 step 1:
   "the image looks right for your subject" beside "the caption reads your
   full display name exactly as stored"), the step goes `human` for the
   judgement and keeps its `**Check:**` for the mechanical clause, with a
   `7b` or owner-phase `**Deferred:**` line naming that clause until its
   check lands. Moving to `human` discharges nothing mechanical (Astra,
   round 1, R2). `/uat` then presents the step to David with the machine
   evidence beside it.
5. **Retired** — the step deleted, only where the feature it describes is
   already gone from `main` (the cut landed), named in the PR body with the
   commit that removed the feature. Never for a feature merely scheduled to
   go.

A 4b line that needs a real render to be judged (an AI image, not a
placeholder from the doubles) says so after its gap, so increment 8's plan
knows which captures belong to the live mode and which to the acceptance
run.

**The lane follows the proof** (Astra, round 1, R2). A step is in the lane
of the mechanism that verifies it: `ci` for a per-PR assertion, `scripted`
for the on-demand acceptance run, `live` for a procedure against real
vendors, `human` for a judgement. A `ci` step whose proof turns out to be an
acceptance journey moves to `scripted`, and the move is recorded beside the
disposition in the PR body's table; a lane change supplies no passing
evidence. A line that names an increment that has merged (the 13) is in no
shape and cannot survive 7a. A `**Deferred:**` line naming #631 without the `7b`
or `increment 8 (capture and read)` marker cannot survive 7a either; the
oracle's inventory command, re-run on 7a's head, returns only those two
kinds, and their counts are 7b's and increment 8's scopes.

**A mixed step owes both, on one line** (Astra, round 3, R6; the checker
allows at most one `**Deferred:**` line per step, `check-uat-format.mjs:224`,
and Astra tested that one line carrying both obligations passes while two
lines fail). A step that owes a capture and an unresolved mechanical
assertion records them as two clauses on its single `**Deferred:**` line,
`#631 — 7b — <mechanical gap> — <target>; increment 8 (capture and read) —
<what the screen must show>`, and it counts in both work lists. Each
increment removes only the clause it satisfies, keeps the other, and keeps
the step's existing `**Check:**`; neither increment's completion alone
establishes that the whole step passed, which is what lets 7b and increment
8 land in either order.

**Why 7a classifies and increment 8 builds** (David, 2026-10-14): the
classification is the same reading 7a does for every step, so it costs
nothing there and yields a count; the mechanism touches the handbook-owned
lane model (format, checker, `/uat` skill) and is designed against that
count in its own short loop, not inside a PR whose size is itself unknown.

**Why the line, and not a separate inventory file.** The repository's
recurring failure is a second place claiming to define one concept; a list
beside the docs would drift from them. The Deferred line already is the
disposition record (`uat-doc-format.md:79-80`), the checker already reads it,
and `git grep` already counts it. 7a's PR body carries the per-document
table as a readout, not as a record.

### D2. What a 7b check must establish

A check closes a `7b` line only when it asserts the specific part the line
names, in the step's own terms, and the step's `**Do:**` and `**Expect:**`
are unchanged (the oracle's *Never*). Four invariants:

- **The assertion runs where CI already runs it.** An api-server or frontend
  test runs in `Test` or `Frontend Test`; a browser assertion runs in the
  Playwright suite that already opens that page, under the `e2e:*` script
  that names the spec; an API-and-persistence assertion for a journey the
  acceptance driver already walks is added to that journey. No new workflow,
  no new job, no new required check. A step whose `Expect` is a browser
  presentation (a row collapses, a banner shows, a label reads) gets a
  browser assertion; an API response cannot establish it (Astra, scope read).
- **A journey extension is still a journey.** An acceptance-driver addition
  asserts a user-observable outcome, never a call to a double, and reports
  through the existing evidence (`JourneyOutcome.evidence`), so the report
  names what was read.
- **The gate's budget is a number, and it is not an exit.** On 7b's head
  the `E2E Smoke` job stays under 7 minutes and `Test` and `Frontend Test`
  under 3 minutes each (`de15e8f`: 4 m 55 s, 2 m 05 s, 1 m 49 s). A check
  that would breach it is first investigated for an equivalent proof inside
  the approved mechanisms (a cheaper assertion, the acceptance journey for
  the persistence half); if the check and the budget stay incompatible, the
  measured choice goes to David as a now/next question. A PR-body note
  records a re-homing; it never authorises one (Astra, round 1, R3).
- **No new spec file.** David's rule is an assertion an existing test file
  or an existing acceptance journey can carry. A surface no existing spec
  opens is outside that rule: its step is re-homed to the phase that owns
  the surface, or, where that would leave a mechanical step with no owner,
  the case comes to David with the count. Moving code between files that
  are already eligible is file arrangement, not new coverage, and is fine.

### D3. The ordinary accounts stay the evidence

Where a 7b check concerns a paid path or a permission, it runs as the seeded
ordinary free or paid account (increment 2), never as the admin, per the
parent's *Settled Decisions*. The existing specs already sign in as the dev
admin for admin screens (`adminQueueHealth.spec.ts:52`); that is correct for
an admin surface and wrong for a user-facing gate.

### D4. The live check's evidence is per variant (increment 6 gap)

In live mode each variant records into its own directory
(`live-recordings/<variant>`), and that variant's report carries its own
recordings identity beside its coverage rows; the top-level `recordings`
field names the union only as a count. One allowance and one ledger still
span the invocation (the recorded-gap comment's shape, both assessors).
Record mode is unchanged: it writes one `--out` set for both variants by
design. The same-fingerprint overwrite the gap describes cannot then
attribute one variant's answer to the other; a fixture-variant transport
failure stays a `missing` row with no file, as today. Demonstrated without a vendor
run, by a test that drives the recording and coverage paths with the same
request fingerprint in both variants, including a second-variant call that
fails in transport: the first variant's file stays in its own directory,
the second variant's row reads `missing` with no file attributed to it, and
each variant's report carries its own identity (Astra, round 1). The change
touches where files land and how they are named, not what is sent.

### D5. The namespace wrapper cleans up on every exit (increment 6 gap)

`netns-run.sh` leaves no sink process on any exit: a `fail` exit after the
sink has started, a signal (INT, TERM, HUP) at any point, or a normal
return. The invariant is **prompt**: the wrapper exits and the sink is gone
before a sleeping payload would have finished on its own, with the exit
status the signal implies (a trap around a foreground `strace` does not
achieve that, measured above; the builder chooses the bounded shape, for
example the payload in the background with `wait` so the trap runs on
delivery and forwards the signal to the payload's process group). Demonstrated
by a script-level test: start the wrapper with a payload that sleeps well
past the test's timeout, send SIGTERM, assert the sink's PID is gone and
the wrapper has exited within a bound shorter than the sleep, with the
signal's status; and a `fail` after the sink started exits 90 with no sink
left. The self-test and the controls already cover the normal path (Astra,
round 1, R4).

### D6. 7a is a reading, and the reading is recorded

For each of the 377 steps, 7a reads the cited test's, spec's or journey's
assertions (not its title) against the step's `Expect` and writes the
specific unasserted part where there is one; a step already fully asserted
is recorded as read, in the PR body's per-document table, and its doc is
unchanged.
The reading may be dispatched per document to workers (bounded, stateless,
the kind of work `claude-core.md` routes down), with the invariant that
every written gap quotes or names the assertion it was read against, and a
sample of at least one line per document is re-read by me before the PR
opens; the PR body says how many lines each path took. The 24 #566 and 38
#628 lines are re-read to confirm the owner under the same rule, and the 136
steps with no Deferred line are read like any other.

### D7. Phase 2's close

Phase 2 is done only when 7a, 7b and increment 8 have all landed (David,
2026-10-14). At 7b's close, or increment 8's if it lands later, the
parent's Definition of Done ("every remaining step … has
a lane, a disposition and a result (an automated one naming its check)") is
read against all 377 steps, and **every surviving step has an identified
result record** (Astra, round 1, R1), without a new registry: one close-out
comment on #631 names, per lane, the record and the commit it covers.
`ci` steps: the `Build` workflow run on the merged head (every cited
api-server, frontend and Playwright check ran in it). `scripted` steps: the
Acceptance workflow run on the merged head, both variants and four
controls. `live` steps: the live baseline report at `de15e8f` for the
steps journeys 2–7 cover, and for each other `live` step the explicit
reason it is outstanding (a procedure nobody has run) with its owner.
`human` steps and owner-phase deferrals: outstanding, never inferred
passed, with `/uat` as the way they get a result; a 4b step still deferred
to increment 8 at 7b's close is listed with that owner, and increment 8's
close replaces the listing. Beside that: the
inventory oracle at 0 after the last of the three lands, `check-uat-format`
green, journey 1 green in the per-PR job, the DojoOS comment already on #631. #631's State of Play
records Phase 2 done; the parent #628's Phase 2 box is checked, after the
last of the three lands. The parent plan gains increment 8 as a v5
amendment committed with 7a (the heading's stale "v3" corrected in the
same edit; the v4 digest stays cited for the text it pinned). The handbook
port stays "next".

## Data Model and Migration Impact

None. No schema, no fixture, no migration.

## Security, Permissions, and Validation

No production code path changes. 7b's checks run as the seeded test
accounts against test databases marked by the increment 3 marker. No
credential enters CI; the live check ran on the Repl under its own cap and
is not repeated by this increment.

## Testing Plan

- 7a: `check-uat-format` green; the inventory oracle's output quoted in the
  PR body (179 → N `7b` lines, 0 other #631 lines, the per-shape counts).
- 7b: every new or extended test runs green in its CI job; the three job
  durations quoted against D2's bound; the acceptance workflow dispatched on
  the PR (it runs on pull requests touching its paths) and green; the D4
  report test and the D5 trap test; the inventory oracle returning only
  increment 8's clauses.

## Implementation steps

**7a (one PR, docs-only, standard loop at internal tier):**
1. The reading (D6) over all 377 steps, document by document; every step
   leaves in one of D1's five shapes, with its lane following its proof.
2. The 13 increment 4 lines re-dispositioned first, since their premise
   ("needs a real render") is gone.
3. The 24 #566 lines read against the fake's reach; the 38 #628 lines
   confirmed.
4. The PR body's per-document table and the oracle output; `/uat` and
   `pr-docs` need no change (the shapes are the format's own).
5. #631 updated: 7b's count, increment 8's count, the live baseline, the
   split recorded; the parent plan's v5 amendment (increment 8 added, the
   heading corrected) committed on the branch and its digest recorded.

**7b (one PR, standard loop at internal tier):**
6. D4 and D5 first, with their tests.
7. The `7b` lines, grouped by target file, each closed by its `Check:` line
   as its assertion lands; a line whose assertion turns out to need a new
   harness is re-homed under D1 shape 3 and named in the PR body, never
   left.
8. The budget measurement; the acceptance run on the PR; the close (D7).

## Risks

- **The reading finds that many "partial" checks assert nothing of the
  step.** Then 7b is larger than the 95 suggests. The count is known at 7a's
  close, before 7b is planned in detail; if it exceeds what one PR can carry
  under D2's budget, 7b splits by target family and that split comes to
  David as a now/next question with the counts.
- **Browser assertions flake.** Playwright specs here wait on roles and
  headings, not sleeps (`adminQueueHealth.spec.ts:48-49`); a new assertion
  follows that shape. A flaky one is investigated for its cause and given an
  equivalent proof inside the approved mechanisms; it is never retried into
  green, and dropping an eligible check is David's call, not a PR-body note
  (Astra, round 1, R3).
- **A step's `Expect` is subtly wider than any check can be** ("as it always
  has"). D1 shape 4b exists for exactly that: a capture Claude reads, never
  a weaker assertion and never David's time.
- **4b steps that need a real render.** The doubles serve placeholder
  images, so "the image looks right for your subject" cannot be judged from
  an acceptance capture; those lines say so. Whether increment 8 captures
  them in its live mode or offline is a technical choice for its sub-plan;
  leaving any counted capture outside Phase 2 would change the agreed scope
  and is a proposal to David, never a deferral the sub-plan makes alone
  (Astra, round 3).
- **Record ids go stale.** The live report lives in the Repl's `/tmp`; the
  close-out quotes its figures and the run ids (`Build` 38610599073,
  Acceptance 38610703160 at `de15e8f`) on #631 so the evidence outlives the
  scratch files.
- **The 7a reading is dispatched and a worker infers from titles.** D6's
  invariant and the per-document sample are the control; the increment 1
  correction is on file as what that costs.

## Questions for David

None open. The four of 2026-10-14 are in the oracle.

## Definition of Done

- [ ] 7a merged: all 377 steps read and tabled in the PR body by document and shape; the inventory oracle on its head returns only `#631 — 7b —` and `#631 — increment 8 (capture and read)` lines, each with a count; the parent plan's v5 amendment committed and its digest on #631; 0 lines name increment 4 or a bare increment 7; `check-uat-format` green; every `7b` line names its specific gap and its target; every lane change recorded.
- [ ] 7b merged: the inventory oracle returns 0 lines other than increment 8's; every step is `Check`, owner phase, or `human` (a mixed step `human` with its mechanical `Check:`); `check-uat-format` green.
- [ ] The close-out comment on #631 names a result record per lane (D7): the `Build` and Acceptance runs on the merged head, the live baseline, and each outstanding `live`, `human` and owner-phase step with its reason.
- [ ] `E2E Smoke` under 7 minutes, `Test` and `Frontend Test` under 3 minutes each, on 7b's head, quoted.
- [ ] The live report carries a per-variant recordings identity (D4), tested; `netns-run.sh` cleans up on signal and on `fail` (D5), tested.
- [ ] The acceptance workflow green on 7b's merged head, both variants and four controls; journey 1 green in the per-PR job.
- [ ] The live baseline at `de15e8f` quoted on #631; no vendor spend by this increment.
- [ ] Increment 8 merged (its own sub-plan): the inventory oracle returns 0; every 4b step cites its capture check.
- [ ] #631's State of Play reads Phase 2 done against the parent's Definition of Done after the last of 7a, 7b and increment 8; #628's Phase 2 box checked then.

## Amendments approved by David after the 7a reading (2026-10-14)

The approved v3 text above is sha256 `0e72af4b541bae673649408bc0fa43af63e5f3772ff6425ed37d39972e669ac2`.
David's answers to the reading's questions amend it as follows; nothing else
changes.

1. **D2, "No new spec file", is read to let the route smoke test carry
   admin pages no CI spec opened yet** (question 1, answer 1). Eleven steps
   on the Config, Email Queue and Refunds and Disputes screens are 7b lines
   targeting `artifacts/overhype-me/e2e/routeLoadSmoke.spec.ts`, which adds
   those pages to its route list and asserts the facts there. No new spec
   file is created.
2. **The dev-admin-login backdoor and its wordmark triple-tap are cut for
   launch** (Phase 4): *"We're going to remove that functionality for
   launch so leave as is."* The six browser-gesture lines in the PR221 UAT
   name Phase 4; the cut list, the launch inventory and `decisions.md`
   record it.
3. **Two behaviour mismatches are bugs, each fixed in its own bugfix PR**:
   the over-long Visual Concept shows an error code instead of the server's
   message (PR224 steps 1, 2 and 4), and a refused style shows the raw code
   `style_invalid` (PR223 step 5). Their 7b lines stay open until each fix
   lands with its regression test.
4. **The billing sync step's Expect is corrected to the product** (PR276
   step 2): a three-resource sync honestly reads "3 of 8 resources
   reported" unless every resource is already complete. This is the one
   Expect edit in 7a, by David's decision, not to fit a check.


## Amendments approved by David after 7a's review (2026-10-15)

The text above, with the 2026-10-14 amendments, is sha256
`55fa176f5eddcd00574032c95c971dd01ae09a3e8937376a0812830b0ec88c66`.

5. **7a's second-review findings are recorded, not fixed in 7a** (David,
   2026-10-15, option 1 of three): eleven clauses, recorded on #631
   (issuecomment-6182043216, with its addendum 6182167137). 7b opens with
   a full re-read.
6. **7b, part 1 is the re-read, its own documents-only PR** (David,
   2026-10-15, "1" to the scope gate). It covers every step that claims any
   coverage: 324 of the 377 steps at `2fefd3b`, the 269 with a `Check:`
   line and the 187 with a `#631 — 7b` line. Its rules:
   - Each `Expect` is listed clause by clause. A clause is **asserted** only
     when a quoted assertion, at its `file:line`, would fail if that clause
     broke. Otherwise it is a **gap**, and a Deferred clause names it, with
     a target (D2) or an owner.
   - The readers are Opus, not Sonnet. Every quote is checked mechanically
     against the file at the cited line before anything is written.
   - The result is committed as a clause ledger under
     `docs/plans/reviews/phase2-inc7/`. 7b's scripting is planned and
     sized from that ledger.
   - The 13 steps hand-cleared in 7a's round 1 are read first, PR425 step 14
     first of all. The eleven recorded clauses are written into their
     documents.
   - D1's never-list holds: no `Expect` edit, no test, no product, script
     or CI change. A step that the product contradicts goes to David.
   - The same ceremony as 7a: internal tier, standard loop, two-review limit.
7. **7b's scripting is part 2**, planned from the ledger's counts, and its
   split by target file comes to David with those counts.


## Amendments approved by David during 7b part 2 (2026-10-17)

The text above is sha256 `cb8b199a06bb3d092930164d0a6e73df8911291e9f45fee5e929736d64b9fd7b`.

8. **Verification tied to the legacy meme studio is killed** (David,
   2026-10-17: *"Everything that is tied to the legacy builder that we're no
   longer using should be killed."*). Its 7b clauses and wholly legacy steps
   name #628 Phase 4; the rule is `docs/ai-context/decisions.md`,
   *Verification work tied to the legacy meme studio is killed*.
9. **Acceptance journeys 5 and 6 are removed** (David, 2026-10-17: *"Kill
   them now."*). Wherever this plan or the parent's Definition of Done says
   journeys 2–7, the baseline is journeys 2, 3, 4 and 7; the acceptance
   clause of Phase 2's close is read against those. Claude's dissent is in
   `decisions.md`, *Acceptance journeys 5 and 6 are removed with the legacy
   studio*.
10. **7b part 2 runs as four PRs by target family**, in the order journeys,
    api, frontend, e2e, and **#692 is fixed before the e2e PR** so PR582's
    Queue Health clause closes inside Phase 2 (David, 2026-10-17).
11. **`E2E Smoke`'s bound is 12 minutes for the rest of increment 7**
    (David, 2026-10-19, option 2 of three). Wherever this plan says `E2E
    Smoke` stays under 7 minutes (D2, the Definition of Done), read 12. The
    job ran 8m28s–9m19s on the four 7b part 2 PR heads before the e2e PR,
    with growth from increment 8's described-screens and capture suites; the
    7 minutes was headroom over the `de15e8f` measurement (4m55s), and the
    parent's own rule — acceptance journeys do not join the per-PR gate, and
    `Build` and `Test` keep their budget — still holds. `Test` and `Frontend
    Test` keep their 3-minute bounds. The speed-up is #730, outside Phase 2.

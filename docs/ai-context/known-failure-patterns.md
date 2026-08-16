# Known Failure Patterns

> Mistakes AI agents have repeatedly made (or nearly made) on Overhype.me. Each
> has a real anchor in this codebase. Read this before visual-pipeline,
> enrichment, moderation, or migration work — **and before any change that adds
> or touches an export under `lib/api-zod/src/`** (see the codegen-revert
> pattern below; this one has been missed more than once because it doesn't
> "feel" like visual-pipeline/enrichment/moderation/migration work, but it is
> exactly this class of gotcha). Anchored IDs are linked from other docs.

Format per pattern: **what it looks like → why it's dangerous → how to avoid →
Overhype example.**

---

## Duplicate source of truth

**Looks like:** two places that both claim to define the same concept (two prompt
builders, two enrichment blobs, a cached copy that drifts from the live value).
**Dangerous:** they diverge silently; a fix to one leaves the other wrong; nobody
knows which is authoritative. **Avoid:** identify the single source of truth for
every concept you touch (the plan's *Source-of-Truth Analysis*) and route
everything through it. **Overhype:** `facts.*` is the sole *active* enrichment
truth — `fact_enrichment_versions` is an archive, not lineage. The visual
**compiler** owns identity/text-policy language; the planner must not re-author it.

## A test asserting what you believe a producer emits, instead of what it emits

**Looks like:** a test that hardcodes the producer's output — a marker value, a
slug, a character class — from your understanding of the producer rather than
from the producer itself. It passes. **Dangerous:** it doesn't just fail to
catch a broken contract, it **actively enforces the broken version**, so the
suite is greenest exactly when the contract is most broken. Both halves of a
producer/consumer pair can be individually tested, both green, and the pair
still dead. **Avoid:** for any generated artifact, assert against the **real
committed output** run through the **real consumer** — import the generated
module, pull the actual values out of it, and feed them to the actual guard. If
a test names a literal the producer emits, that literal is a belief, and beliefs
in tests are how this happens. **Overhype:** PR #472 hit this three times in one
build. (1) A test asserted `data-help-internal="true"` while the consumer had
been changed to read a *path* out of that attribute — every in-app Manual link
was silently inert, with that test and the consumer's own unit test both
passing, because neither touched the artifact. (2) A test asserted
`#emoji-🎉-heading` was a producible heading slug; `github-slugger` strips emoji
and actually emits `emoji--heading`. (3) Two successive hand-written Unicode
character classes for "what the slugger emits" were each measured wrong — the
first excluded 1164 characters it really emits, the second still excluded 61.
The fix in each case was to stop describing the producer and start executing it.

## A guard that matches spelling instead of resolving bindings fails open

**Looks like:** a static check that recognises its target by name — counting
`setLocation(` occurrences, matching a callee called `useLocation`, grepping for
an import string. **Dangerous:** it fails in the **open** direction. Renaming or
aliasing produces a fully functional second path that the guard cannot see, and
because the *original* spelling is usually still present somewhere, the guard's
own "did I find anything?" assertion stays satisfied — so it reports green while
certifying the exact regression it exists to prevent. **Avoid:** resolve the
**binding**, not the text — follow a destructuring to whatever name it binds,
and follow an import specifier (`propertyName ?? name`) to whatever the module
actually exported. And give the guard **bypass fixtures**: mutate a copy of the
source to introduce the violation and require the analysis to object, with an
assertion that the mutation actually applied — a fixture whose `.replace()`
silently no-ops is itself a vacuous test. **Overhype:** PR #472's navigation
guard, three versions deep. v1 counted `setLocation(` and was defeated by
`const [, navigate] = useLocation()`; v2 resolved the destructuring but matched
the hook by callee text and was defeated by
`import { useLocation as useHelpLocation }`; v3 resolves the import specifier.
Each version's guards-the-guard assertion passed throughout, because token
presence is not the property being guarded. See
`artifacts/overhype-me/src/components/admin/helpNavigationGuard.test.ts`.

## Preview/runtime mismatch

**Looks like:** an admin preview that shows something different from what
production actually renders/sends. **Dangerous:** moderators approve based on the
preview; if it lies, they ship the wrong thing. **Avoid:** previews and production
must call the **same** core path; feed previews a canonical test identity. **Overhype:**
the Runtime Compiled Prompt preview and production both go through
`assembleImagePromptForPreview()` → `generateImagePromptPlan()` +
`compileForSubjectRenderMode()`. The two preview surfaces once diverged by
hardcoding different names ("David" vs "David Franklin"); standardized on
`RUNTIME_PREVIEW_DEFAULT_NAME`. (Residual prose difference is **temperature 0.4**,
not caching — don't misdiagnose it.) See
[`visual-pipeline.md`](./visual-pipeline.md#admin-previewdebug-surfaces-runtime-compiled-prompt).

## Human override overwrite

**Looks like:** AI reprocessing (re-enrich, backfill) clobbers a moderator's
manual decision. **Dangerous:** silently destroys human judgment and moderation
audit trail; erodes trust in the whole pipeline. **Avoid:** keep AI-derived and
human-override layers separate; re-processing refreshes only the AI baseline and
preserves overrides; bulk jobs skip admin-edited rows unless explicitly forced.
**Overhype:** `enrichmentAiDerived` (immutable) vs `enrichmentOverrides`
(path-keyed) merged by `resolveEnrichment()`; `runEnrichmentForFact` is "sticky";
`factEnrichmentBackfillJob` skips admin-edited rows unless
`forceOverwriteAdminEdited`. See
[`taxonomy-and-enrichment.md`](./taxonomy-and-enrichment.md#re-enrichment-safety).

## Raw AI context injected into the final prompt

**Looks like:** dumping enrichment fields (cultural references, semantic entities,
modifier prose) straight into the engine prompt as meta-instructions. **Dangerous:**
leaks brand names / meta-instructions into the image, and creates a second prompt
channel behind the planner's back. **Avoid:** enrichment is a planner **input**;
let the planner + compiler decide what reaches the engine. **Overhype:** cultural
references / semantic entities are deliberately NOT re-emitted as "Interpret X
means Y" lines in `nanoBanana2.ts`; modifier directives are conservatively de-duped
against the assembled prompt.

## Manual `api-zod/src/index.ts` export silently reverted by codegen

**Looks like:** you add a new module under `lib/api-zod/src/` and add
`export * from "./yourModule"` to `lib/api-zod/src/index.ts`; typecheck and your
targeted tests pass, so you move on. Then a later step that runs codegen (the
full test suite's setup, `pnpm --filter @workspace/api-spec run codegen`, a
merge, a build) **regenerates `index.ts`** and your export line vanishes.
**Dangerous:** `@workspace/api-zod` resolves to `./src/index.ts` (see its
`package.json` `exports`), so the moment the export is gone **every consumer
breaks at runtime** with `does not provide an export named '…'` — and it looks
like a broad, mysterious cascade (dozens of unrelated suites failing at load,
including ones that pass in isolation), not an export problem. Earlier green runs
were on a stale build that still had the export. **Root cause:** codegen OWNS
`api-zod/src/index.ts` — it rewrites the file from the allowlist in
[`lib/api-spec/patch-generated.mjs`](../../lib/api-spec/patch-generated.mjs)
(`apiZodIndexLines`). A hand-edit to `index.ts` is not a source of truth; the
allowlist is. **The real fix:** add the new module to the `apiZodIndexLines`
array in `patch-generated.mjs`, then run codegen and confirm the export survives
(`git diff --exit-code lib/api-zod/src/index.ts` is clean after codegen).
`git checkout lib/api-zod/src/index.ts` restores the committed (correct) version
if a codegen run clobbers your working tree mid-session. Do **not** try to "just
re-add it to index.ts" — it will be reverted again.

**Recurred (PR #228):** added `export * from "./factTextEdit"` directly to
`index.ts` mid-session, verified with `tail`/`grep` and passing targeted tests,
and moved on without adding the line to `patch-generated.mjs`. CI's `pretest`
ran codegen and wiped it — surfaced as 9–10 unrelated test files across
multiple shards failing to even load (`visualConceptJobs`, `phase4.memes.save`,
`routes.admin.auth`, `routes.adminStripeSync`, `routes.facts`, …), exactly the
"broad, mysterious cascade" this entry already warned about. The doc existed
and was correct; it just wasn't consulted at the moment the new `lib/api-zod`
module was created. **The lesson isn't "read the doc harder" — it's a
mechanical check:** after adding *any* new file under `lib/api-zod/src/` (or
any export to an existing one), run
`pnpm --filter @workspace/api-spec run codegen` once, immediately, and confirm
`git diff --exit-code lib/api-zod/src/index.ts` is clean, before writing a
single consumer of that export. Don't defer this verification to "when I run
the full test suite later" — by then the mistake is buried under unrelated
work and looks like a cascade of broken tests, not a one-line miss.

**Now automated (2026-07-23, PR #236):** a doc reminder didn't stop this from
recurring once already (PR #228), so the mechanical check above is no longer
opt-in. CI's `Build` job runs `pnpm run check:codegen-drift`
([`scripts/check-codegen-drift.sh`](../../scripts/check-codegen-drift.sh)) on
every PR, which reruns codegen and fails the merge on any resulting drift —
same command works locally. **One correctness detail if you ever touch that
guard:** it checks `git status --porcelain -- lib/`, not
`git diff --exit-code -- lib/`. A `git diff` only sees modified *tracked*
files; when codegen splits out a brand-new generated file, that file is
*untracked*, and a diff-only guard would silently pass while the merged
checkout is still missing it (caught in Codex review on PR #236 — see
`code-review.md`'s Tests section for the general principle this became).

## Stale historical docs treated as current truth

**Looks like:** implementing from an old note (or training-data memory) that no
longer matches the repo. **Dangerous:** you rebuild something already removed, or
reintroduce a retired rule. **Avoid:** prefer, in order — David's latest
instruction, current repo implementation, recently merged plans, then old context
as background only. Verify; where you can't, ask. **Overhype (retired assumptions
NOT to reintroduce):** blanket "no readable text"; `gpt-4o-mini`/`gpt-image-1`/FLUX
as the render path; enrichment-time visual preview as source of truth; violence
auto-softeners; `enrichment_pending` stage name (it's `prep_pending`).

## A verification step placed where it cannot physically run

**Looks like:** writing a workflow that gates step N on evidence only
producible at step N+1 — most often treating post-merge verification as a
pre-merge gate. **Dangerous:** the contract reads as *more* rigorous, so it
survives review on its plausibility; in practice it either deadlocks (waiting
for evidence that cannot exist) or gets silently ignored, and the real gate
goes undefined. **Avoid:** for every check in a workflow, ask *where does the
thing being tested physically live at this moment, and can the tester reach
it?* **Overhype:** the app runs from the Repl, and the Repl tracks `main`, so
**everything that tests running behavior is post-merge** — David's UAT and
Replit's `TEST_RUN` alike. Merge + sync is what makes a build testable;
production is the separate, deferred `publish_app` step. This misfired twice
in one day on PR #413 (2026-08-11): Codex caught a `TEST_RUN`-as-merge-gate
example, and David caught the same shape in the close-out contract two turns
later, where the merge was gated on a UAT the merge is a prerequisite for.

## Async enqueue treated as completion

**Looks like:** reporting a job "done" when it was only *queued*; a single global
spinner for a bulk action. **Dangerous:** the user thinks work finished (or
failed) when it's still running; per-item failures/skips get hidden. **Avoid:**
poll the job's terminal state and show per-item + aggregate status — the full
contract is [`async-ui-status.md`](./async-ui-status.md); read it before building
any queued/bulk surface. **Overhype:** the async queue is `async_jobs` (`pending →
processing → done | failed`); **Taxonomy Health (`useTaxonomyHealthActions.ts`) is
the reference implementation** — copy it, don't invent a new status channel.

**A second, subtler version: a `done` job whose HANDLER-level result was
actually a skip.** A bulk-action picker can pre-skip an obviously ineligible
target before enqueueing (visible today via `outcomes`), but a job's own
handler can *also* discover mid-run that the work doesn't apply (e.g. a race —
the target became ineligible between pick and run) and complete successfully
with a skip result. If the job-status contract only reports `pending |
processing | done | failed`, that terminal skip renders as a plain "Done" —
exactly the "skipped collapsed into a checkmark" bug this whole doc's rule
forbids, just one layer deeper than the obvious case. **Avoid:** if a job
handler can return `{ok:true, result:{skipped:true, reason}}`, the job-status
endpoint must surface that (sanitized — validate the reason against a known
enum, never echo the raw result blob) and the polling hook must render it as
`skipped`, not `done`. **Overhype:** `factSendBackJob.ts`'s
`REFRESH_ALREADY_IN_PROGRESS` recovery path is exactly this case; PR #205
extended `JobStatusEntry`/`useTaxonomyHealthActions` with `{skipped,
skipReason}` to close the gap — for both the new send-back queue and any
future job handler that skips mid-run.

## Unbounded id list into a DB guard query

**Looks like:** a bulk/fan-out action recomputes its target set by loading
**all** matching rows into JS memory (the established pattern here — the
evaluator/picker architecture can't push its logic into SQL), then passes that
**entire** id list into a follow-up `inArray(...)` guard query (e.g. "which of
these are already in-flight / have an active variant") **before** applying the
action's own batch cap. **Dangerous:** the guard query's size is bounded only
by how much of the corpus currently matches — which can be the *whole active
table* (e.g. right after a corpus-wide invalidation), risking a query past
practical bind/parameter limits or a timeout, silently failing the endpoint
and enqueuing nothing even though the action only needed a small, capped
batch. Easy to miss because it works fine in dev/testing with a handful of
rows. **Avoid:** chunk any `inArray(...)` call whose input size scales with
corpus size (not with the request's own bound), and prefer resolving only as
many eligible targets as the cap needs rather than classifying the entire
candidate set up front, when the two aren't in tension (see the cap-vs-exact-
remaining-count trade-off noted below). **Overhype:**
`factsWithInFlightRefresh`/`factsWithActiveVariants` in
`adminTaxonomyHealth.ts` chunk their guard queries at 500 ids/query
(`GUARD_QUERY_CHUNK_SIZE`) rather than passing the full stale-for-reprocess id
set (which the Stale-for-reprocess card's own docs note can be "nearly the
whole corpus," especially after a "Mark major update" bump) in one call —
caught by Codex review on PR #205, not by the original tests (which only
exercised small id sets). See
[`taxonomy-and-enrichment.md`](./taxonomy-and-enrichment.md#known-failure-modes).

## Dedupe key coalesces two distinct intents

**Looks like:** a "force / fresh / regenerate" async action reuses the same stable
`dedupeKey` an idempotent path uses, so `enqueueJob` returns the *existing*
non-terminal job instead of scheduling new work — the fresh intent silently
attaches to (and is satisfied by) stale in-flight work. **Dangerous:** the user
thinks they triggered a new batch/run; they got the old one's result. A stable key
is a correctness tool for idempotency and a correctness *hazard* for "do it again."
**Avoid:** enqueue force/regenerate work with **no dedupe key** (or a
per-invocation one) so it can never coalesce, and move the double-click/concurrency
guard to the **state transition** itself (an atomic compare-and-set) rather than
relying on the queue. Separately, block a *new* cycle from starting while the prior
job is still non-terminal, so there's no in-flight job for it to coalesce onto.
**Overhype:** `enqueueJob` returns the existing pending/processing row for a
matching `(queue, dedupeKey)` (`async_jobs`); "approve the visual gag" therefore
force-enqueues `review_render_scenarios_prepare` with **no** key and guards the
`concept_review → production_review` advance with a compare-and-set — two
concurrent approvals yield exactly one force batch. Re-prep/regenerate is blocked
while `visual_concept_status = "pending"` for the same reason. See
[`moderation-workflow.md`](./moderation-workflow.md) and the PR #179 decision in
[`decisions.md`](./decisions.md).

## Repairing state on a caught async error races the thing it's repairing

**Looks like:** an enqueue helper writes optimistic status (e.g. `"pending"`)
before calling `enqueueJob`, then on a caught error rewrites that status to a
terminal value (e.g. `"failed"`) so the UI doesn't strand at "working."
**Dangerous:** `enqueueJob` can throw even when a job genuinely got created —
its own dedupe-conflict recovery has a narrow insert-retry race of its own — so
a caught error doesn't reliably mean "no job exists." An unconditional
repair-write can clobber a legitimately in-flight (or already-finished) job's
real status before it's ever observed. Even a "check first, then repair" fix
(SELECT for an in-flight job, then UPDATE only if none found) has its own
TOCTOU gap: the job can go terminal, or another writer can write its own
terminal status, in the window between the SELECT and the UPDATE. **Avoid:**
fold every condition the repair depends on into **one atomic UPDATE** — the
state is still what you last wrote AND no non-terminal row exists for the
dedupe key — evaluated in the same statement's `WHERE` clause (a `NOT EXISTS`
subquery), not a prior read. **Overhype:** `enqueueFactPexels`/
`enqueueFactAiMemeBackfill` (`artifacts/api-server/src/lib/factPexelsJobs.ts`,
`aiMemeBackfillJobs.ts`, PR #256) took three rounds of review to converge on
this: round 1 added an unconditional repair (wrong — clobbers a concurrent
success), round 2 added a SELECT-then-UPDATE (still racy), round 3 replaced
both with a single `UPDATE ... WHERE status = 'pending' AND NOT EXISTS
(SELECT 1 FROM async_jobs WHERE queue=? AND dedupe_key=? AND status IN
('pending','processing'))`.

## One-example bug fixes

**Looks like:** patching only the exact reported sentence/case instead of the
general mechanism. **Dangerous:** the class of bug remains; it resurfaces with the
next input. **Avoid:** fix the mechanism and add a test that asserts the
**invariant**, with negative cases. **Overhype:** the tokenizer's
`autoConjugatePersonSubjectVerbs` net solves the *general* "person-subject verb
must agree" rule (not just "They keeps"), with a narrow anchor so it never
mis-wraps non-person subjects ("Sharks have …"), plus idempotency tests. See
[`token-rendering-and-grammar.md`](./token-rendering-and-grammar.md#regression-examples-must-stay-green).

## Regex grammar rewrite reaches past a safe anchor

**Looks like:** a deterministic text-rewrite rule (regex-based grammar/token
repair) is extended to "walk into" a syntactically similar but semantically
different region — e.g. auto-*wrapping* a verb across a coordinating
conjunction on the assumption the subject is unchanged. **Dangerous:** regex has
no semantic understanding; it can't tell "and hides" (same subject) from "and
dogs bark" (a new subject) — the rewrite silently corrupts input that merely
*looks* similar. **Avoid:** keep a rewrite that *creates* a token anchored to a
position where the subject is unambiguous (immediately after the trigger
token); prefer "no rewrite" over "wrong rewrite" when reach would require
guessing. A rewrite that only *collapses* an existing token can safely reach
further, because it can be bounded by a strict stop-set (any brace or
clause-boundary punctuation) without needing to positively identify the new
construct. **Overhype:** the tokenizer's conjugation net
(`autoConjugatePersonSubjectVerbs`) stays adjacency-only — it will not walk a
coordination chain to *wrap* a later verb, because `{Subj} runs and dogs bark`
is indistinguishable from `{Subj} runs and hides` by regex alone; the AI prompt
(not the deterministic net) is responsible for coordinated verbs. The
complementary `{NAME}`-subject *collapse*
(`collapseNameSubjectConjugationPairs`) safely reaches further because it only
removes an existing pair, bounded by clause/brace/punctuation stops — it never
creates a new wrap. See
[`token-rendering-and-grammar.md`](./token-rendering-and-grammar.md#the-core-conjugation-invariant).

## Uniform default over a falsely-ambiguous space

**Looks like:** a deterministic normalization pass treats an entire class of
input as "ambiguous" and picks one default reading for all of it — but a
subset of that class actually has a knowable, unambiguous answer that the
chosen default gets wrong. **Dangerous:** the fallback *looks* safe ("the more
common reading") and passes tests built around the reported example, but
silently corrupts the subset it's actually wrong for — which can be common in
casual English, not a rare edge case. **Avoid:** before picking a uniform
default, ask "is there a narrow, high-confidence signal that resolves *part*
of this space with certainty?" — carve that subset out with its own rule, and
default only the genuinely irreducible remainder. **Overhype:**
`expandSubjectContractions()` originally defaulted every `'s` contraction to
the copula `{is|are}`, reasoning that is/has ambiguity is "the far more common
reading" — but "'s got"/"'s been"/"'s had" can ONLY mean "has" ("is
got"/"is been"/"is had" isn't grammatical English), so the uniform default was
silently producing "They are got the keys" for they/them. Caught by code
review (Codex), not by the shipped tests — they proved the chosen default
worked for the genuinely ambiguous remainder, but never asked whether the
assumed-ambiguous set was actually uniform. Fixed with
`HAS_ONLY_FOLLOWING_WORDS`, a small next-word peek that resolves the
unambiguous subset before falling back to the copula for truly ambiguous words
(e.g. "done"). See
[`token-rendering-and-grammar.md`](./token-rendering-and-grammar.md#retiring-theys).

## Migration/backfill blind spots

**Looks like:** a schema/data change that ignores old rows, partial states,
failures, skips, or no-ops; a non-idempotent backfill. **Dangerous:** half-migrated
data, silent data loss, un-rerunnable scripts, no visibility into what changed.
**Avoid:** reason explicitly about old/new/partial/failed/skipped/no-op rows; make
backfills idempotent; expose counts. **Overhype:** `drizzle-kit generate` is
broken, so migrations use idempotent `ADD COLUMN IF NOT EXISTS`; the
projection-repair job rewrites only derived columns and is safe to re-run. See
[`../engineering/migrations-and-backfills.md`](../engineering/migrations-and-backfills.md).

## Admin state ambiguity

**Looks like:** an admin surface that can't distinguish empty vs loading vs
running vs failed vs partial vs skipped vs complete vs no-op. **Dangerous:**
operators can't tell what happened or what to do next; they retry destructive
actions or assume success. **Avoid:** design every admin surface to show all the
states it can actually be in, plus the next action. **Overhype:** Taxonomy Health
cards name the issue, the count, and the remediation with a safety label
(costs-money vs safe/instant).

## Client-only permission assumptions

**Looks like:** gating a capability only in the frontend; trusting a client-sent
role/flag. **Dangerous:** trivially bypassed; privilege escalation, data exposure.
**Avoid:** enforce every permission **server-side**; the client gate is UX only.
**Overhype:** `requireAdmin`/`requireRole("admin")` guards every admin route; the
`AdminLayout` gate is convenience, not security. Auth also has real subtleties (see
`.agents/memory/auth-bearer-cookie-fallback.md`).

## Raw internal ID surfaced to a human

**Looks like:** an admin/audit UI attributes an action to "by {raw-id}" instead
of a name — a FK column or a jsonb-embedded provenance field (`createdBy`,
`updatedBy`, `performedBy`) rendered directly instead of resolved to a display
label. **Dangerous:** violates the hard rule that no internal ID/GUID may ever
reach a human-visible surface (admin included) — see
[`agent-working-rules.md`](./agent-working-rules.md#never-surface-a-raw-internal-id-anywhere-in-the-product);
also a sign the same write path may have sibling occurrences elsewhere.
**Avoid:** resolve to `displayName ?? email ?? (omit)` — never fall back to the
raw id; join at read time when the id lives in a real FK column, or stamp a
resolved label at write time when it's embedded in jsonb with no join path.
**Overhype:** the Facts admin's Enrichment Version History panel rendered
`factEnrichmentVersionsTable.createdBy` raw; the Enrichment Editor's "Last
edited by" line rendered `visualPromptStrategyOverride.updatedBy` raw. Both
fixed; pre-existing jsonb-stamped rows from before the fix may still hold a raw
id until next edited (a backfill would be separate migration-shaped work).

## Cost-skip heuristic checks one signal, misses a co-equal one

**Looks like:** an optimization heuristic that skips an expensive step when
"nothing is left to do" checks for ONE signal of remaining work (e.g. a plain
subject name) but not a co-equal signal that would ALSO require the same step
(e.g. a plain subject pronoun). **Dangerous:** a mixed/partially-resolved
input — some parts already correct, one signal class still plain — passes the
"nothing left to do" check and permanently skips the only pass that would fix
it, silently hardcoding the miss instead of surfacing it. **Avoid:** when a
completion/skip heuristic checks for "is there personalizable/actionable
content remaining," enumerate every distinct signal class it would need to
act on and require ALL of them absent — not just the one that's cheapest or
most obvious to check. **Overhype:** the Visual-Concept-authoring batch
tokenize route's `isAlreadyTokenizedNoPlainName` skip predicate checked only
for a plain subject *name* — a moderator field partially tokenized via chips
(`"{NAME} holds his trophy"`) had no plain name left, so it reported "already
tokenized" and skipped the LLM call that would have converted "his,"
hardcoding the pronoun instead of resolving it per-render. Caught by a Codex
review before merge (PR #206); fixed by also requiring no plain subject
pronoun, mirroring the check the sibling `hasNoLikelySubjectReference`
predicate already had. See
[`token-rendering-and-grammar.md`](./token-rendering-and-grammar.md#shared-core-fact-submission-and-admin-visual-concept-authoring-pr-206).

## Self-retriggering recovery with no bounded exit

**Looks like:** recovery / self-heal code that can *re-invoke the very action
that failed* — `window.location.reload()` on a failed dynamic import, an
auto-retry that re-runs on mount, a supervisor that restarts a crashed process
— with no state carried across the retrigger to stop it. **Dangerous:** a
transient upstream fault (a flapping dev server, a briefly-missing chunk, an
OOM kill) becomes an infinite, self-amplifying loop, because each retrigger
wipes in-memory state — a reload clears all JS; a process restart clears all
globals — so any guard kept in memory resets to "first try" every cycle and the
loop has no exit condition. This class slips **both** of Overhype's safety nets:
it's invisible to diff review (the defect is a *missing* guard, and it only
manifests under a runtime fault the review never simulates) and invisible to
David's product-testing (it's dev-infra, not a product surface). **Avoid:** any
code that can retrigger itself must carry a **bounded exit condition that
survives the retrigger** — persist a counter/timestamp somewhere that outlives
the recovery action (`sessionStorage` across a page reload; a rolling
`/tmp`/on-disk window across a process restart), cap the rate, and when the cap
trips **fail loud and settled** (surface an error boundary, or a give-up log
that names the real reason) instead of silently trying again. Prefer "stop and
show the error" over "reload again" whenever the fault could be persistent, and
make the crash reason durable so it isn't lost to a fast restart. **Overhype:**
`lazyWithRetry` (`artifacts/overhype-me/src/lib/lazy-retry.ts`) originally
called `window.location.reload()` unconditionally on a double import failure —
a flapping Vite dev server (esbuild thread exhaustion; see the `optimizeDeps`
notes in `artifacts/overhype-me/vite.config.ts`) turned that into a ~1.3s reload
loop that also tore down the HMR WebSocket. Fixed with a `sessionStorage`
reload-timestamp cooldown that rejects to the Sentry error boundary instead of
looping. `scripts/dev-supervisor.sh` is the process-level version done right: a
rolling 20-crashes-per-300s window (bookkept across restarts) that gives up
loudly — and now also captures + replays the child's last stderr and decodes the
exit signal, so a silent fast crash (the one that made the esbuild panic take
hours to find) is visible. The dev route-load smoke test
(`artifacts/overhype-me/e2e/routeLoadSmoke.spec.ts`) is the regression net for
the whole class. Full write-up in
[`decisions.md`](./decisions.md) is unnecessary; the fix lives in the three
anchors above.

## Over-engineered speculative abstractions

**Looks like:** building a framework/config system/plugin layer for a need that
doesn't exist yet, or expanding scope "while we're here." **Dangerous:** more
surface to maintain and break, slower to launch, harder to review. **Avoid:** make
the **smallest coherent change** that satisfies the approved plan; defer
speculative generality. **Overhype:** pre-launch priorities are stability + content
quality — new external vendors and new abstractions need a strong reason and
David's sign-off (see [`product-direction.md`](./product-direction.md)).

## Security classification by URL path instead of resolved authorization

**Looks like:** deciding a security posture (is this cacheable? cross-origin
embeddable? public?) from a route's path *shape* — an allowlist of URL patterns —
rather than from the ownership/visibility resolved for that specific response.
**Dangerous:** one path serves both public and private responses, so a pattern
match is wrong for half of them. `/api/memes/:slug/image` matches a public meme,
a **private** meme, AND the owner-gated `/api/memes/ai-user/image`; marking it
`cross-origin` by path leaks owner-only bytes (defeating CORP). The same shape
also produces path-traversal when a path param is interpolated into a storage
key (`video_style_previews/${id}.gif` with `id=../../x`). **Avoid:** classify at
the point visibility is *known* — one shared choke point that runs after the ACL
resolves — and derive any storage key from a sanitized/hashed form, never the raw
input. **Overhype:** cross-origin CORP is set in `setPublicCors()`
(`cacheHeaders.ts`), called *only* on confirmed-public responses; private
responses call `setNoStore` and stay `same-origin`. The style preview key goes
through `safeStylePreviewKey()`. See
[`security-model.md`](./security-model.md#http-security-headers-c5) (C5/C9).

## Trusting self-set mutable metadata as a security assertion across a deploy

**Looks like:** an app writes a flag onto an object it controls (a Stripe PI's
`membership=true` metadata, a signed cookie claim, a DB column) and later reads
that flag back as *proof* of a security property. **Dangerous:** the flag was set
by an *older* version of the code with weaker rules, and in-flight objects
(pre-existing checkout sessions, cached tokens) carry it — so the new gate that
trusts the flag can be satisfied by a pre-staged object the old code stamped
wrongly. **Avoid:** verify the underlying fact from an authoritative,
non-self-set source at read time (the actual purchased product from the Checkout
Session line items), not the flag you wrote. **Overhype:** the one-time
membership grant reads `session.line_items[].price.product` and ignores the
`membership=true` PI stamp our own checkout set, closing the window where a
legacy pre-allowlist session mints Legendary after deploy. See
[`security-model.md`](./security-model.md#payment-trust--membership-grants-c6) (C6).

## Head-of-line blocking in a shared background worker

**Looks like:** one dispatch loop (one claim query, one concurrency pool, one
re-entrancy/"is it my turn" guard) processing several kinds of work that have
very different costs — some cheap and interactive, some slow and external.
**Dangerous:** a cheap, interactive action silently inherits the latency of
whatever expensive work happens to be queued or already running ahead of it —
looks like a hang or a broken feature, not a scheduling artifact, so it's hard
to diagnose from the symptom alone. A single shared re-entrancy guard makes it
worse: the *next* dispatch cycle can't even start until the *current* one's
entire batch — including any slow job in it — finishes. **Avoid:** when a
shared dispatcher serves work with meaningfully different latency profiles
(interactive vs. external-API vs. bulk-background), give each class its own
independent scheduling lane — own timer, own **closure-local** (never shared)
re-entrancy guard, own claim filter, own concurrency bound — so one lane can
never suppress another's progress. Don't just add more concurrency to the one
shared pool; that doesn't fix FIFO ordering starving a fast job behind older
slow ones. **Overhype:** the `async_jobs` worker (`asyncJobs.ts`) originally
drained all 9 queues through one loop; a pure-DB admin action (Taxonomy Health
"Send back to review," no model call) or a moderator-watched test render could
sit in "Queued…" for 30s+ behind unrelated LLM/image-gen or bulk-backfill work.
Fixed in PR #216 by splitting into `fast` / `render` / `bulk` lanes — see
[`decisions.md`](./decisions.md#2026-07--split-the-async-jobs-worker-into-fastrenderbulk-lanes)
and [`architecture-map.md`](./architecture-map.md#async-jobs-and-queues).

A related engineering gotcha surfaced while fixing this — defaulting a new
lane-specific config knob to a fresh literal instead of the old shared knob's
resolved value — is in
[`.agents/memory/env-knob-split-preserve-legacy-default.md`](../../.agents/memory/env-knob-split-preserve-legacy-default.md).

**A related but distinct lesson from the same claim-then-dispatch shape,
caught during NCMEC phase 3 review (PR #349, known gap G15, not yet built):**
`asyncJobsTick` stamps a whole claimed batch `processing` in one transaction
*before* `mapWithConcurrency` dispatches any row to a handler at limited
concurrency — so a row claimed late in a same-queue batch can queue for real
minutes before its own handler starts, even with no other queue involved at
all. Lane-splitting doesn't fix this one; it's within-queue, not cross-queue.
The lesson is narrower and specific to safety deadlines: **a wall-clock
invariant meant to bound total elapsed risk must be measured from the true
start of the risk window (claim time), not from a later sub-phase within it
(handler start)** — a test that only checks the sub-phase's own constant
against a cutoff can pass while the invariant it's protecting is still
violable. Tracked, not yet exploitable (no caller exists for the NCMEC
worker this would affect); phase 5's worker must bound elapsed time since
claim.

## A live FK's `ON DELETE SET NULL` can erase the fact an unrelated predicate depends on

**Looks like:** a predicate infers a historical fact ("did this row ever have
X") from a live column's *current* value ("is X currently non-null"), where
that column is the target end of a foreign key declared `onDelete: "set
null"`. **Dangerous:** an entirely unrelated action elsewhere in the app —
deleting the referenced row for its own, unconnected reasons — silently nulls
the column via the database's own cascade, with no application code path
that notices or logs it happening. The predicate then reads the row as
"never had X" instead of "had X, then lost it," and if the predicate gates a
security- or compliance-relevant decision, the wrong branch fires with
nobody having decided anything — it looks like normal operation from every
surface. **Avoid:** don't infer an immutable historical fact from a column
that participates in a live FK cascade; capture the fact separately, once,
at the moment it's true, into a column nothing can silently null out from
under it. **Overhype:** `isIdentityUnresolved` (NCMEC phase 3,
`artifacts/api-server/src/lib/moderation/ncmecWorker.ts`) infers "this row's uploader identity was
never captured" from `reporterSnapshot === null && userId !== null` — but
`ncmec_reports.user_id` has `onDelete: "set null"`, and the pre-existing,
unrelated account hard-delete admin action (`routes/admin.ts`) runs
`db.delete(usersTable)`, which cascades. An admin hard-deleting the uploader
of a row correctly parked as `identity_unresolved` (a capture defect) turns
it into a row that reads as honestly anonymous and files automatically with
the uploader silently omitted — nobody having approved that. Caught in PR
#349's round-1 review before any caller existed to make it reachable;
tracked as known gap G14, needing an immutable snapshot-time capture that
the cascade can't touch (phase 4).

## Un-frozen input re-resolved live after its freeze point

**Looks like:** a value (identity, config, a selected option) is fixed at one
point in a pipeline — enqueue time, or a job's finalization — but a later
consumer (the worker that runs it, or a reader that classifies it afterward)
re-derives that same value **live** — a fresh DB query, a fresh config read —
instead of reading whatever was fixed at that earlier point.
**Dangerous:** if the underlying source changes in the window between the
freeze point and the later read (a profile edit, a config change, a row
deactivated, an admin raising a limit), the consumer silently uses the NEW
value while other parts of the same record (text already rendered, or a
status already decided from the OLD value) still reflect the old one —
producing output that is internally inconsistent with itself, and
non-reproducible (re-reading later can produce a different answer than it
would have at the freeze point). **Avoid:** resolve every input exactly ONCE,
at the point it's actually known, and persist a validated snapshot on the
job/row; every later consumer reads the snapshot and never re-queries the live
source for that input. **Overhype:**
- The `image_prompt_generation` worker re-queried the user's
  `displayName`/`pronouns` and re-resolved the selected look-style live on
  every run, even though the fact text had already been frozen at enqueue —
  a profile edit or a style edit/deactivation in that window could produce a
  render whose frozen fact text and whose live-resolved identity/style
  disagreed. Fixed by `prepareImagePromptAttemptInputs()` freezing a
  `PromptIdentitySnapshot` + `ResolvedRenderStyleSnapshot` once and rendering
  the fact text from that same identity (PR #223). See
  [`visual-pipeline.md`](./visual-pipeline.md#frozen-render-inputs-identity--style-reproducibility).
- The Queue Health surface's `abandoned_no_retry` classification re-resolved
  a queue's retry ceiling from **current** `admin_config` at read time for
  any row still carrying the `0` sentinel (the common case — no per-row
  override). A row that legitimately exhausted retries under an old, lower
  ceiling would silently flip to `abandoned_no_retry` the moment an admin
  later raised that queue's limit — degrading *after* the fact,
  with no code change to explain it. Fixed by persisting the resolved
  ceiling onto the row at the one moment it's finalized to `failed` (PR
  #288); a pre-fix legacy row (still carrying the sentinel, since the
  migration doesn't backfill) is classified conservatively rather than risk
  the same bug on data that can't be resolved safely. See
  [`decisions.md`](./decisions.md#2026-07-30--queue-health-classification-persists-the-retry-ceiling-at-finalization-instead-of-re-deriving-it-live).

## Budget-constrained assembly blindly truncates wherever length lands

**Looks like:** an assembly pipeline builds output up to a hard character/token
ceiling, and when the assembled result overflows, it hard-cuts the END of the
string to fit — regardless of what content happens to be there.
**Dangerous:** if safety-critical content (a policy guardrail, a required
disclaimer, an exclusion rule) is emitted LAST — often because it's the final
"and don't do X" section — blind end-truncation can silently remove exactly
that content under budget pressure, while everything upstream of the cut still
looks fine. The failure is invisible until someone notices the guardrail
didn't apply. **Avoid:** never let a length ceiling silently drop
safety-critical content; either reserve budget for it so it always survives
truncation, or — safer — treat an overflow of required content as a hard
failure (fail loud, don't ship) instead of truncating at all. **Overhype:** the
Nano Banana 2 compiler's `assembleSections()` used to hard-truncate the fully
assembled prompt to `MAX_PROMPT_CHARS` as a last resort — and STRICT
CONSTRAINTS (the violence/text-policy safety guardrails) is the LAST section
emitted, so an overflow could cut exactly the guardrails. Retired in PR #224:
required-content overflow now surfaces `diagnostics.requiredBudgetOverflow`
and the async worker fails terminal (`required_budget_overflow`) instead of
shipping a truncated prompt; save-time validation (below) makes new
over-budget content essentially unreachable. See
[`visual-pipeline.md`](./visual-pipeline.md#render-time-prompt-budget).

## Predicting a downstream system's output by summing raw component inputs

**Looks like:** a save-time (or any pre-flight) check needs to predict how big
/ long / expensive a downstream system's OUTPUT will be, and does it by summing
or estimating the raw INPUT components — without accounting for formatting,
wrapping, joins, labels, or other transformation the downstream system applies
on the way from input to output. **Dangerous:** the estimate systematically
undercounts, so content the pre-flight check accepts can still overflow/break
downstream — and the gap is invisible in code review, because the estimate
"looks reasonable" and the actual overflow only shows up at the OTHER end of
the pipeline, often much later. **Avoid:** when you must predict a downstream
system's real output, measure it by actually running (or a faithful,
minimal-diff invocation of) that system — don't hand-derive a proxy formula
that will drift the moment the downstream system's formatting changes.
**Overhype:** two instances in the same feature. (1) The compiler's fixed
required-section overhead is measured by literally compiling a maximum-shape
prompt through the real compiler (`measureRequiredPromptBudget()`), not
hand-estimated — this was right from the start. (2) The save-time check for a
moderator's "additions" content originally summed each field's raw projected
text length, missing the compiler's `"Do not …"` negation prefixes,
`"label: "` role-binding forms, `"; "`-joins, and per-section labels that only
appear once a field is populated — a save that check accepted could still
overflow at render. Caught by Codex mid-review (PR #224); fixed by
`measureModeratorAdditionsEmission()`, which compiles the fixed shape twice
(once with worst-case-projected content, once empty) and takes the delta, so
every fixed cost cancels and only the true additions contribution remains. See
[`visual-pipeline.md`](./visual-pipeline.md#render-time-prompt-budget).

## Not merged ≠ not disclosed (public-repo PR history)

**Looks like:** using a branch or PR on a **public** repo as a "private" or
"throwaway" channel for content you never intend to ship — a plan, a draft, a
scratch file — assuming that because the PR is a *draft* or will be *closed
without merging*, its contents aren't really public. **Dangerous:** this repo is
public, so **every pushed commit and every closed-unmerged PR is permanently in
public history** — searchable, forkable, cached — regardless of draft status or
merge outcome. For content that describes an unpatched vulnerability, an exploit
path, secrets, private customer/commercial data, or embargoed work, that
*discloses* it the moment it's pushed, often before any fix ships. "It never
merged" buys **zero** privacy. **Avoid:** before pushing non-shippable content to
the public repo, run a disclosure check; route anything security-sensitive or
confidential to a private/manual channel instead of the public PR. Treat "draft"
and "will close unmerged" as no privacy at all. **Overhype:** the automated
plan-review loop (PR #226) deliberately uses a *never-merged public draft PR* as
its review channel — the first design had **no** disclosure gate, so a
security-remediation plan run through it would have published the exploit before
the fix landed. Fixed with a mandatory pre-open disclosure check that keeps such
plans off the public channel (see
[`decisions.md`](./decisions.md#2026-07-22--plan-review-automated-via-a-codex-draft-pr-loop-replaces-the-manual-chatgpt-paste)).
Compare PR #217 — a production DB dump that sat committed on public `main`.

## Security-relevant dependency claims written from assumption, not verification

**Looks like:** writing something confident and specific about a dependency's
security status into a durable doc — "no known CVE," "just a safe hygiene
bump," "these three patches are generic maintenance" — without actually
checking the package's changelog or advisory database first. **Dangerous:**
these claims read as authoritative once committed, so a later reader (a
`/maintenance` pass, a future agent, David) trusts them instead of re-checking,
and a real, disclosed CVE stays effectively invisible — mis-triaged as
low-priority precisely because the doc says it's safe. It compounds: an
unverified "safe" claim can gate a genuinely urgent fix behind an unrelated,
lower-priority blocker. **Avoid:** for any claim of the shape "no known
issue," "safe to defer," or "just hygiene," actually check — the package's own
changelog/GHSA/CVE listing, not memory or a plausible-sounding assumption — and
cite what was checked. Re-verify an existing claim before trusting it, same as
any other unverified product truth. **Overhype:** the original
`deferred-work.md` entry for the parked sharp bump (PR #243) asserted the
prior version "has no known CVE" — false; sharp inherits CVEs from libvips
(alert tagged `Direct`), just not the ones actually blocking the upgrade
(those were a typings regression). Separately, three *other* packages bundled
in that same PR (`drizzle-orm`, `vite`, `postcss`) were first filed as generic
"safe patch" hygiene, not worth prioritizing — until a full alert triage found
each closed a real, disclosed CVE, including a SQL injection in `drizzle-orm`,
the production ORM. (The same triage separately found and fixed CVEs in
`esbuild` and `fast-uri` too — not among these three, but part of the same
PR #246 sweep — bringing the total to 9 disclosed CVEs closed; see
[`decisions.md`](./decisions.md#2026-07-24--dependabot-alert-triage-found-the-safe-patch-bumps-parked-in-pr-243-were-actually-9-disclosed-cves-including-a-sql-injection-in-the-production-orm)
for the full breakdown.)

## Stripe plan selection: classify by price identity, not product identity

**Looks like:** turning Stripe's product/price catalog into "which plan is
this?" by inspecting the **product** — its name (string-matching "monthly" /
"annual" / "lifetime" / "forever" keywords) or just its first/cheapest price —
instead of inspecting **each price's own `recurring` field**. **Dangerous:**
Stripe's natural dashboard setup is one product with several price points
(e.g. a single "Legendary" product carrying monthly, annual, and one-time
prices together), so classifying by product collapses all of them into
whichever single bucket the product's name or first price happens to match,
silently dropping the others — a customer-facing plan picker can end up
showing only one price option even though the catalog has three. **Avoid:**
classify each price independently (`!recurring` → one-time, `recurring.interval
=== "month"` → monthly, `=== "year"` → annual) and never group by the parent
product. A second, adjacent trap: don't stop at classifying — also filter to
prices whose product carries the membership allowlist tag before doing so.
`/api/stripe/plans` returns **every** active product in the catalog (not just
membership ones), and the grant layer (`/stripe/checkout`, the confirm
endpoint, the webhook — see
[`security-model.md`](./security-model.md#payment-trust--membership-grants-c6))
already enforces `overhype_membership=true` as the sole gate; a display/
selection surface that skips the same filter can advertise a future
non-membership SKU (render credits, merch, tips) as a Legendary plan, which
then gets rejected at checkout. **Overhype:** `Pricing.tsx`'s `classifyPlan()`
did the product-name/first-price version of this (PR #255) — a single
"Legendary" product with three attached prices showed only its "Forever"
one-time price, hiding monthly/annual. Codex review on the same PR caught the
missing-membership-filter half before it shipped. Both are now centralized in
`artifacts/overhype-me/src/pages/pricingPlans.ts`'s `selectPlanPrices()` —
filter to `overhype_membership` first, then classify each remaining price by
its own `recurring` field. See the decision in
[`decisions.md`](./decisions.md#2026-07-25--stripe-plan-selection-classifies-by-each-prices-own-recurring-field-and-only-from-membership-tagged-products).

## Persisted sync/job failure invisible after reload

**Looks like:** an admin sync/job progress panel that renders its per-resource
status only while a condition like `syncing || finalMessage || inProgress` is
true. **Dangerous:** all three go false the moment the page is left and
reloaded — so a per-resource `error` status the backend already computed,
persisted, and serves via its status endpoint is fetched and then silently
discarded. What remains on screen (a stale-but-plausible "N products found ·
last synced X ago") reads exactly like success, not "the last run partially
failed." **Avoid:** always render the last-known persisted state on load,
independent of whether a run is currently being watched — distinguish "last
run failed" from "last run succeeded, N ago" from "never run," per the admin
state-legibility rule in
[`async-ui-status.md`](./async-ui-status.md#admin-state-legibility).
**Overhype:** `stripeSyncRunner.ts`'s `readSyncStatus` correctly persists and
returns each resource's `status`/`error_message`; `billing.tsx`'s progress
panel just never rendered it outside an active run. This is why the "pricing
page shows only one plan" bug (see
[`decisions.md`](./decisions.md#2026-07-28--the-lifetime-only-upgrade-bugs-real-root-cause-was-a-silently-failed-stripe-sync-not-plan-selection-logic))
survived two unrelated code fixes (PR #255, #260), and re-running the sync
silently fixed it: the actual failure was never visible enough to investigate.

**A trap in how this was found, worth naming for future debugging:**
reproducing one layer of a suspected pipeline in isolation proves *that
layer* correct — it says nothing about whether the *live* run that produced
the current symptom actually succeeded. Confirming the sync library's storage
and read-query layers were faithful (by replaying its migrations and upsert
SQL locally) correctly ruled out the pricing-selection code, but was twice
over-read as "the sync is fine," when the live sync itself had simply failed
on an earlier run. The faster test that would have settled it sooner:
re-running the live operation and checking whether the symptom changes,
before building a from-scratch reproduction of its internals.

## A sample ordered by anything correlated with the outcome isn't representative

**Looks like:** measuring some subset of items by sorting on a convenient,
available field (creation order, an id, alphabetical) and taking a fixed
fraction — because the field is deterministic and easy to reason about, not
because it's independent of what you're trying to detect. **Dangerous:** if
the ordering field correlates with the property under measurement, the
sample can be composed entirely of the "easy" or "early" cases while the
metric's own reason for existing — catching the hard, late cases — goes
completely unchecked, and a validation gate built on that sample (a
disagreement threshold, an acceptance test) can pass cleanly while being
blind to exactly the failures it exists to catch. **Avoid:** either measure
the full population when the cost allows it (deletes the whole class of
defect), or stratify explicitly across whatever dimension correlates with
the outcome (here: review round) rather than trusting a single convenient
sort key. A "the sample is deterministic" property is not the same as "the
sample is representative" — the first is about reproducibility, the second
is about coverage, and a fix can satisfy one while still failing the other.
**Overhype:** the loop-ledger's blind-adjudication sample (PR #270) first
sorted findings by GitHub comment id ascending and took the first 30% — but
comment ids track creation order, and propagation/wrong-fix findings (the
metric's actual self-inflicted numerator) can only occur in round 2 onward,
so the sample oversampled round 1's disproportionately-new-ground findings.
The next fix, round-robin sampling across rounds, was still deterministic
and still wrong: its "every round contributes" guarantee was false whenever
a loop had more nonempty rounds than the sample size, and starting the
robin at round 1 meant it systematically dropped the *latest* rounds —
exactly where the numerator lives. Both defects were confirmed by
independent review before the sampling design was replaced entirely with
full-population adjudication. See
[`decisions.md`](./decisions.md#2026-07-27--the-loop-ledger-every-review-loop-gets-a-permanent-falsifiable-row--adjudicated-over-the-full-population-not-a-sample).

## A widening cast over a field the SDK's current version doesn't have

**Looks like:** reading a property off a typed third-party object via a cast —
`(obj as Type & { field?: X }).field` — instead of the field actually being on
`Type`. TypeScript accepts the cast without complaint, because a widening
intersection cast can add any property regardless of whether the base type has
it. **Dangerous:** the code compiles clean, and the field silently reads
`undefined` on every real call — not an error, not a crash, just a `null` where
a real value belonged. Neither typecheck nor an ordinary product-testing pass
catches it: typecheck can't, because the cast is *why* it compiles; testing
often can't either, because the field degrading to `null` doesn't break the
feature it's attached to, it just quietly loses one piece of data forever.
**Avoid:** before reading any field off a pinned SDK's object, grep the SDK's
own `.d.ts` for that field name rather than trusting memory of an older API
version or writing a cast to make TypeScript stop complaining — a cast that
"fixes" a type error on a third-party object is a signal to go verify the
field actually moved, not license to keep going. **Overhype:** `stripe@20`
relocated three fields this same PR needed, each caught only by an independent
reviewer, not by typecheck: `Invoice` has no top-level `subscription` (only
`parent.subscription_details.subscription`); `Charge` has no `invoice` field
at all (use `invoicePayments.list` as the reverse lookup instead); and
`Subscription` has no top-level `current_period_end` (moved to each
`SubscriptionItem`) — the last one shipped as
`(subscription as Stripe.Subscription & { current_period_end?: number }).current_period_end`
and stored `null` on every refreshed entitlement source until PR #287's round
9 review caught it. See
[`membership-entitlements.md`](./membership-entitlements.md#the-trust-boundary--w1a).

## A sequence's `last_value` is not a commit-order watermark

**Looks like:** reading a Postgres sequence's current position (`SELECT
last_value FROM some_seq`, or the analogous "current version counter") before
starting some work, then later comparing a row's stamped version against that
watermark to answer "has anything touched this row since I began?" **Dangerous:**
`nextval()` is **not transactional** — a sequence value is consumed the instant
`nextval()` runs, independent of whether the transaction that called it ever
commits, and independent of *when* it commits relative to other transactions.
So a concurrent writer can allocate a token (making it visible to a `last_value`
read) and then commit its write *after* your watermark was taken — its row now
carries a version equal to your watermark, and a `<= watermark` comparison calls
that freshly-committed row stale. Sequence allocation order is simply not the
same thing as commit order, and nothing about `last_value` makes it so.
**Avoid:** compare **committed row values to committed row values** instead of
either side to a sequence position — read each row's own version before the
work begins, then read it again after, and treat "the version changed" as "an
authoritative write landed," whoever performed it. **Overhype:** the
reinstatement fail-closed path (PR #287, review round 8) took
`membership_source_state_seq`'s `last_value` as a watermark before refreshing a
user's sources, then compared each source's `source_state_as_of` against it —
exactly the race above, confirmed independently by review. Replaced with
`loadSourceStateVersions`, which snapshots each source's own version before and
after. See
[`membership-entitlements.md`](./membership-entitlements.md#the-admin-surfaces-are-entitlements-not-fake-payments-or-a-tier-field).

## A transaction alone doesn't give two reads one consistent snapshot

**Looks like:** wrapping two related `SELECT`s in `db.transaction(...)` to make
them "atomic," when the actual goal is that both statements see the same
database state — e.g. deriving a status from one query and selecting the row
that status applies to with a second. **Dangerous:** the database's default
isolation level, READ COMMITTED, gives a transaction atomicity **on write**
(all-or-nothing), not a consistent snapshot **on read** — every statement
inside a READ COMMITTED transaction still takes its own fresh snapshot at the
moment it runs. A write landing between the two `SELECT`s (a webhook cancelling
row B, say) is invisible to the first statement and visible to the second, so
the two reads can legitimately disagree about the same row — reintroducing
exactly the inconsistency the transaction looked like it was preventing.
**Avoid:** for a multi-statement read that must see one snapshot, either
collapse it into one statement, or explicitly request `{ isolationLevel:
"repeatable read" }` — safe on a read-only block, since a serialization failure
there has nothing to undo and no write to retry. **Overhype:** twice in one PR
(#287, rounds 8–9): `GET /stripe/subscription` selected a qualifying source in
one statement and the row to return in a second, which could disagree about
which of two subscriptions was current; and the grace-drift admin panel read an
uncapped `count(*)` and a capped sample as two separate statements against a
predicate the hourly sweep was actively changing, which could report a total
smaller than the list beside it. Both were plain `db.transaction(...)` blocks
before the fix — the first was corrected to `repeatable read`, the second to
`count(*) OVER ()` in one statement.

## A guard's population-safety lock protects the count, but not the decision to check it at all

**Looks like:** a mutation reads the target row's current state to DECIDE
whether a lockout/safety guard needs to run at all — then, only if that
decision says yes, opens a transaction, takes the advisory lock, and asks
the guard to count survivors. **Dangerous:** the guard's lock and count are
airtight once invoked, but the READ that decides whether to invoke it at all
happens before the lock exists, so a concurrent mutation can change the
target's state in the window between that read and the eventual write — the
DECISION goes stale even though the COUNT never would have. This is easy to
miss precisely because the guard itself looks correct in isolation (its own
tests pass, its lock/count logic is sound); the bug is entirely in what
happens *before* the guarded transaction, not inside it. **Avoid:** acquire
the same lock the guard uses FIRST, before reading anything the "does this
even need guarding" decision depends on — then make that decision from a
read taken under the lock, inside the same transaction, immediately before
the guard's own count. A helper that only exposes "acquire the lock" (not
just "acquire the lock and count") lets a caller that needs to decide-then-
guard do both under one lock without duplicating the count logic.
**Overhype:** PR #425's admin-lockout guard (`assertAdminPopulationSurvives`,
under `pg_advisory_xact_lock(ADMIN_POPULATION_LOCK_KEY)`) recurred in this
exact shape **twice in the same PR**: round 4 found `PATCH
/admin/users/:id`'s email-change handler reading the target's
email/`isAdmin` via a plain `db.select(...)` before opening any transaction,
so `removesAdminAccess` — whether to call the guard at all — could be
computed from data a concurrent admin-removal was about to invalidate; round
5 found the identical shape in the separate `GET /auth/verify-email`
pending-email-promotion path, which had gotten the crossing-boundary CHECK
right in an earlier round but not the lock-ordering. Both fixed by exporting
`acquireAdminPopulationLock(tx)` (factored out of the guard's own
lock+count) and moving each handler's read + decision inside the
transaction, after acquiring it, before the guard's count. The second
recurrence — same root cause, sibling code path, found one round later — is
also a worked example of *class recurrence* under this repo's own
review-loop bucket rubric
([`working-modes.md`](./working-modes.md#review-loops-need-a-stopping-rule-not-just-a-convergence-target)):
porting a fix to one of several similarly-shaped call sites and missing a
sibling is common enough to specifically check for once a first instance of
a shape like this is found, not just fixed in place.

## A broad error-class match convicts more than the one case it was written for

**Looks like:** catching an error and testing a general property of it — an
error code, a substring of the message — to answer a specific question ("was
this a duplicate?", "was this a timeout?"), when the general property is shared
by cases the specific question doesn't apply to. **Dangerous:** the broad test
passes on the wrong case just as readily as the right one, and silently
mis-routes it — often into the code path that swallows or acknowledges the
error, which is the most expensive place to be wrong. The bug is invisible in
the common case (where only the intended cause ever produces that error) and
appears only under a specific concurrent or edge condition that produces the
same broad symptom for a different reason. **Avoid:** match the most specific
identifying detail available — a Postgres error's `constraint` name, not just
`code === "23505"`; a specific error subclass, not a message substring — so the
test can only be true for the actual case it exists to handle. **Overhype:** a
webhook handler's catch block tested `code === "23505" || message.includes("unique")`
to detect "this event was already processed," inside a `try` that also covers
domain writes touching *other* unique constraints. Two racing first-purchase
deliveries could violate an unrelated unique-customer constraint during
prepare — a real failure — and the broad test called it a duplicate, silently
acking an event whose purchase was never granted (PR #287, review round 9).
Fixed by matching `err.constraint === "stripe_processed_events_pkey"`
specifically.

## Reading a scoped limit message as a blanket outage

**Symptom:** a tool reports that *one specific capability* is unavailable, and
you conclude the whole tool is down. Work that depended on the still-working
capability silently stops happening — and because you concluded it was
unavailable, you never retry, so nothing surfaces the mistake. The gap looks
like an outage rather than an unasked question.

**Why it happens:** the qualifier is the least load-bearing-looking part of the
sentence. "You have reached your usage limits **for security reviews**" reads
at a glance as "you have reached your usage limits," because the actionable
part (a limit was hit) lands first and the scope arrives as trailing detail.
The failure is reinforced by *consistency*: the message keeps appearing, which
feels like confirmation, when it is only the same scoped condition recurring.

**The nastiest version — and the one that actually happened — is when a written
rule already quotes the qualifier and still draws the unscoped conclusion.**
`pr-watch`'s pre-2026-08-15 rule reproduced the "for security reviews" wording
verbatim and concluded "proceed as if that round's review is unavailable."
Having the evidence in the document did not prevent the error, because the
rule's *conclusion* was what got applied, not its quoted evidence. A wrong
conclusion sitting next to correct evidence is more durable than a plain
mistake: it looks sourced.

**Avoid:** when a tool reports a limit, refusal, or failure, **read which
thing it names** before concluding anything is unavailable — the scope is part
of the message, not colour. Then check the cheap disconfirming evidence: did
the supposedly-unavailable capability produce output anyway, before or after?
On PR #458 a full code review landed six minutes after the "outage," which
would have refuted the reading immediately had anyone looked. And when writing
a rule from an observed failure, make the rule's conclusion quote the same
scope its evidence does.

**Overhype:** the canonical fact and the standing rule live in
[`code-review.md`](../engineering/code-review.md#codex-has-two-usage-limits--a-security-review-bounce-is-not-a-code-review-outage).
Cost: PR #459 sat unreviewed until David corrected the reading, and the
resulting "Codex is unavailable" framing fed into asking him to merge PR #458
while a requested round was still outstanding — 7 findings then landed 47
seconds post-merge, as defects on `main`.

### Sub-pattern: a confident claim about tooling that the tooling doesn't support

The same session produced three of these, which is why it is recorded as a
pattern rather than an anecdote:

| Claim asserted | Reality | How it would have been caught |
|---|---|---|
| No persistable effort setting exists | `effortLevel` is in the settings **schema**; only the docs *page* omits it | Read the schema, not the prose docs |
| The Codex bounce means no review is coming | It means no *security* review | Read the qualifier; check whether a review arrived anyway |
| Self-wakes get counted in the loop ledger | `MECHANICAL_KEYS` has eight GitHub-derived fields and no wake count | `grep` the field list before claiming it |

**The common shape:** each was a claim about what a *tool* can do, asserted
from recollection or from a plausible-but-incomplete source, and each was
cheap to verify — one file read would have settled it. Two of the three were
caught by review rather than by the author.

**Avoid:** before writing down what a tool does or doesn't support, open the
thing that defines it — the schema, the field list, the message text. Treat a
docs page's *silence* as no evidence at all: a curated page will omit a key
but will never invent one, so absence there is not absence.

## Fixing the flagged site and leaving its siblings

**Symptom:** a reviewer names one place a fact is wrong or duplicated. You fix
exactly that place, push, and the next review round names the next copy. Repeat
for as many rounds as the fact has homes. Each round looks like progress and
the finding count never falls.

**Why it happens:** review comments are anchored to a *line*, so they arrive
scoped to one site even when the defect is repo-wide. Fixing what was pointed
at feels complete and is locally verifiable — the flagged line is now correct —
so nothing prompts the wider search. Worse, correcting one copy can *create* a
contradiction, because the other copies now disagree with a document that was
previously consistent with them.

**Avoid:** treat a finding as naming a **fact**, not a line. Before pushing the
fix, grep the whole repo for every other site asserting that fact — including
docs the PR does not otherwise touch — and fix or explicitly qualify each one.
Verify against the *fact*, not the string you happened to delete: a paraphrase
forks exactly as well as a quotation, so a grep for the removed wording can
pass while the claim survives three lines away in different words.

**Overhype:** PR #291 (the async-lane de-fork) narrated six review rounds in
its own body, but the loop ledger's fully-paginated, mechanically-derived
count (row 23 of `.agents/metrics/loop-ledger.md`) is seven — that figure is
the one of record, per this file's own reason to exist, and the "six" here is
superseded by it rather than reconciled against it. This pattern accounted
for a finding in five of the narrated rounds. The clearest instance: a claim
equating async-jobs handler concurrency with database pool occupancy was
corrected in `architecture-map.md` in round 4, which left `background-work.md`
and `deferred-work.md` asserting the disproved version — so the repo
contradicted itself in three places *because* one site had been fixed, and
`decisions.md` turned out to be a fourth. In another instance the round-1 fix
deleted the offending sentences and left paraphrases of the same two facts
inside the very sentence that linked to the spec; the author's own verification
grepped for the deleted strings, passed, and missed it.

**The lexical half of this is now a CI guard** —
`scripts/check-manual-tuning-language.mjs` fails the build on values and their
prose stand-ins in `docs/manual/`, which is what most of those rounds were
actually about. The guard is deliberately narrow and **cannot** detect a fact
with two homes, a paraphrased spec section, or a false claim. Those remain the
human half, and this entry is the reminder that they exist.

**The pattern generalizes past docs to code call sites (PR #308).** Mounting
a new global rate limiter gave several `/api` pollers their first-ever
rate-limit 429 path to handle — **not every poller**, since some endpoints
already had their own pre-existing 429 (see below) — a new failure mode with
**at least four independent call sites** (not a
verified-exhaustive count, per the same undercounting this file's own
"fixing the flagged site" lesson warns about) across two components' worth
of poll loops. The plan's own implementation fixed one (the video/PuLID
pollers) up front; round 1 of review found a second (`AiBgPicker`'s render
poller); round 2 found a third, in an entirely different component
(`SourceImageConfirmModal`) that no earlier fix had touched, plus a fourth
handler (`handleConfirmCancel`) left outside a sibling fix in the *same*
file. Each fix was locally correct and each round looked like progress while
the finding count didn't fall to zero until round 3. **Not every poller of
an endpoint the global limiter now covers was newly exposed** — a Codex
round on this very `/document` harvest found a fifth poller
(`useTaxonomyHealthActions.ts` → `/api/admin/taxonomy-health/job-status` —
the client-visible path; `/admin/...` is only the router-local path before
`app.use("/api", router)` mounts it) whose
429 handling predates this PR entirely, because that route already had its
own `checkSharedRateLimit` call (it's one of the pre-existing DB-backed
limiters `adminTaxonomyHealth.ts` is documented as, elsewhere in this repo's
docs) — a reminder that "every caller of a newly-changed resource" still
needs checking against what was already true, not assumed to be uniformly
new. Same avoidance: when a change introduces a new failure mode on a shared
resource (an endpoint, a response shape, an error code), grep for **every**
caller of that resource before considering the fix complete — not just the
one a review comment or the plan happened to name, and not assuming the
count found is the count that exists.

### Sub-pattern: the sweep itself has three failure modes, learned one per round

PRs #458/#459 ran five review rounds where **every round's finding was
something the previous round's sweep was structurally incapable of catching**.
Each round taught a distinct lesson, and each invalidated the verification
method that had felt sufficient the round before. The parent pattern above
covers only the first.

1. **Sweep by class, not by phrasing.** The first sweep grepped the exact
   strings it had just removed ("switch me to", "Sonnet gate") and passed —
   while `maintenance/SKILL.md` still said *"suggest switching before
   starting."* Same rule, different words. Grep for what the rule **means**,
   with an alternation wide enough to catch paraphrase, and accept noise over
   a false clean.
2. **Re-sweep what the fixes themselves introduce.** The second sweep
   correctly enumerated every home of every rule the PR *set out to change* —
   and missed the Opus-reserved-execution exception entirely, because that
   rule was **created by the previous round's fix**. A sweep anchored to the
   starting set cannot see what the fixes add. Re-run the enumeration over
   the round's own output before calling it done.
3. **The unit is the assertion, not the file.** The third sweep asked, per
   file, *"does this file carry the exception?"* — a boolean that passes the
   moment **one** mention exists. `CLAUDE.md` passed while containing both
   the exception and a contradicting sibling two sections away. Check every
   individual site, and specifically look for **two rules that fire on the
   same condition and disagree** — that shape accounted for three of the last
   four findings.

**A fourth home is easy to forget entirely: the PR body.** It asserts the
rules too, it is what the human actually reads, and no sweep that greps the
working tree will ever touch it. In #459 it still described a superseded
version of the contract — one cap instead of two, a claim the ledger tracked
self-wakes, a rejected case listed as allowed — after five rounds had
corrected all three in the files.

**Avoid:** treat "I swept for it" as a claim needing the same verification as
any other. The honest generalization from these rounds is that self-review
converges on *the method you already had*; an outside reviewer is what
corrects the method. Where no reviewer is available, at minimum re-derive the
sweep from the rule's meaning rather than re-running the grep that already
passed.

## Satisfying a lexical guard by changing a value's form, not its meaning

**Looks like:** a CI text guard flags a stated value in prose. The fix changes
*how* the value is written — a digit becomes a spelled-out word, a cardinal
becomes an ordinal, a bare value gets wrapped in markdown emphasis or a link,
a phrase gets reflowed across a line break — without changing what the
sentence actually asserts. The guard goes green; the value it exists to keep
out of that document is still fully present, just spelled differently.

**Dangerous:** a green check reads as "compliant," so the sentence doesn't get
looked at again — but the source-of-truth risk the rule exists to prevent (the
same fact living in two places, able to drift independently) is completely
intact. Because each round of this only narrows the *specific* form just
caught, not the general risk, a review loop chasing it can run for many
rounds, one surface form at a time, and look like slow but real progress the
whole way.

**Avoid:** when a value is flagged, ask "does this sentence's truth depend on
the number, in *any* form?" — not "does it still contain the literal string
the rule matched." Removing the concept (say that something exists or is
true, not how much) is the fix; rewording the same count in a different part
of speech is not, and is usually just as fast to write, which is what makes it
tempting. Authoring or extending a guard like this has the mirror-image
discipline: after closing one evasion, actively probe for the *next* form of
the same class (spelled-out numbers, teens, ordinals, hyphenated compounds,
markdown markup, a hard-wrapped line split) instead of declaring the class
closed after the one instance found.

**Overhype:** PR #298 (the manual tuning-language guard) went through six
finding-bearing Codex review rounds, and this exact pattern recurred inside
its own fix history — round 5 found "a simpler 2-lane split ... in favor of
3" and fixed
it by spelling the count out ("a simpler two-way split ... in favor of a
third, separate lane"), which round 6 caught as the same lane count restated
as an ordinal instead of removed; the round-6 fix describes the split
qualitatively with no number in any form, which is what a genuine fix looks
like for this pattern — but that fix was never independently re-reviewed
before merge (see [`loop-ledger.md`](../../.agents/metrics/loop-ledger.md)
row 22), so its correctness is this PR's own claim, not a confirmed close.
Separately, the guard's own detection had to grow across rounds to
cover markdown emphasis/links hiding a value from the regex, a hard-wrapped
phrase split across two physical lines, and a spelled-out-number extension
whose digit-derived "attached s" shorthand accidentally matched an ordinary
English word ("hundred" + "s" = "hundreds," not a duration). The full list of
evasions the guard now covers, and why each was needed, lives in
`scripts/check-manual-tuning-language.mjs`'s own header and rule comments —
not duplicated here.

## Chasing completeness against an adversarial reviewer past the artifact's real risk

**Looks like:** a review loop where every finding is correct, every fix is
sound, and the finding count **stops falling** — often while the artifact grows
and the later fixes start specifying guarantees the platform cannot actually
provide. **Dangerous:** each round is individually justified, so there is no
natural stopping point, and the cost is invisible because the work looks like
diligence. It ends with a large over-specified artifact and real time gone. The
tell is never a single finding — they're usually right — it is the **trend**,
plus the shape of the late-round fixes. **Avoid:** size ceremony to blast radius
at intake, not to how the request was phrased
([`working-modes.md`](./working-modes.md#feature-mode-ceremony-scales-to-blast-radius-not-to-phrasing-david-2026-08-05));
require findings to fall round over round or stop and reassess with David; and
triage every finding into **fix / accept-and-document / escalate** rather than
reading "Required Revision" as automatically meaning fix. **Overhype:** twice
in one day, 2026-08-05 — PR #329's Bash guard (9 → 11 → 12 → 19 findings, an
unbounded parsing surface; see the sub-pattern below) and PR #333's `/status`
plan (12 → 1 → 4 → 6 → 12 findings, **six review rounds and a 660-line plan for
two markdown skill files**, with round 6 specifying compare-and-swap semantics
GitHub's label API does not offer and acceptance cases with no way to run
them). **The second happened hours after the first was written up**, because
the first was recorded narrowly as a *parser* problem and the lesson did not
transfer — which is exactly why this entry states it at the general level and
demotes the parser case to a sub-pattern.

**A third instance, two days later, on a different kind of unachievable
guarantee (PR #293).** Migration `0097`'s attempt to make the NCMEC
audit-ledger's append-only guarantee a real PostgreSQL privilege boundary ran
17 review rounds and accounted for roughly 65 of the PR's 90-plus findings —
not by finding fewer bugs each round, but by refining the same reachability
model past what the platform can support: `pg_has_role(...,'usage')` →
`'member'` → literal `SET ROLE` success → `ADMIN OPTION` → an *inherited*
admin-option chain → containing-schema ownership → the guard function's own
schema ownership. Each fix was a real, verified correction — and each one
sat on the same unfixable foundation: a migration running as the application
role cannot grant that role a privilege boundary the role cannot already
cross (see the 2026-08-07 `decisions.md` entry). The late-round shape
matches the general pattern exactly — fixes that specify guarantees
(`CREATE ROLE` without conferring membership, a `REVOKE` the current role
cannot execute) the actor available to the migration cannot actually
provide. David cut the scope after the concentration became visible: the
migration now creates the objects and reports the residual state; closing
the boundary moved to a superuser runbook
([`docs/engineering/ncmec-audit-ledger-hardening.md`](../engineering/ncmec-audit-ledger-hardening.md)).
The tell was available well before round 17 — a scope-vs-blast-radius check
at round 5 or so, once "every fix targets the same reachability model,"
would have caught it much earlier than a David-initiated review of the
finding distribution did.

**A fourth instance, the very next day, on an artifact with no blast radius
at all (PR #356, 2026-08-08).** The TEST_RUN checklist for PR #293 — a doc
that is *deleted after one Replit run* — went five review rounds and 36
findings (9 → 6 → 6 → 6 → 9), nearly all against instructions for re-running
test suites that had already passed in CI on the same code. Every finding was
technically correct; every round was a misallocation, because the artifact's
worst case was one confused test run, not a production defect. Each isolation
fix opened the next round's gap (culminating in round 5 discovering the
repo's own test wrappers silently override the variable all the prior fixes
depended on), and the loop only ended when David asked what any of it had to
do with the product — the answer being "nothing," the fix was to **delete the
findings' entire subject from the doc**, not repair it a fifth time. Where
the first three instances were about *unachievable guarantees*, this one is
about **criticality**: the loop's subject was achievable and simply not worth
achieving. That question now has a formal gate — rate the artifact 1–100 on
"what breaks in production if this is wrong" *before* requesting round 2, and
single-digit artifacts never loop
([`working-modes.md`](./working-modes.md#review-loops-need-a-stopping-rule-not-just-a-convergence-target)).

**A fifth instance belongs to a different pattern, and is filed separately
(PR #404, 2026-08-11).** The admin-permissions plan loop shares this entry's
surface — correct findings, late-round fixes specifying machinery — but its
root cause is neither an unachievable guarantee nor a criticality mismatch:
the plan's *boundary moved* while it was being reviewed, growing 56% across
three rounds because a totalising Product Intent made every discovery in-scope
by definition. Diagnosing it as this pattern would prescribe the wrong fix
(cut the subject / stop the loop) instead of the right one (split the artifact
and keep going on the smaller half). See
[*A plan that grew during its own review*](#a-plan-that-grew-during-its-own-review).

**A sixth instance, caught earlier than the others (PR #425, 2026-08-13/14).**
The permission-chokepoint CI guards
(`scripts/check-permission-chokepoint.mjs` and its frontend sibling) exist to
catch a hand-written `tier === "legendary"`-shaped comparison outside the
resolver. Across the implementation review loop, four rounds — spread over
a five-round span, round 5 was an unrelated finding — found a genuinely new
gap: round 3 (file-level allowlist scope, fixed),
round 4 (`!==`, fixed), round 6 (a formatter-wrapped multi-line comparison,
fixed), round 7 (a reversed operand, `"legendary" === tier` — confirmed
real, and **declined**, not fixed). Every probe was real and every
finding accurate — this is the identical finding-never-falls shape as the
other five instances, three hardenings deep before the fourth probe is
what finally got a different response. **What's different here is where
the loop stopped.** Rounds 4 and 6 closed gaps in the space of
forms a developer or an agent would actually write by habit — those were
worth fixing. Round 7's reversed operand is a Yoda condition nobody on this
team or Codex writes in this codebase, and the space of
syntactically-valid-but-never-written forms a regex (or even a full AST
parser — it would still miss a new helper function or an `.includes()`
check) could be asked to cover next is unbounded regardless, so "catch
every form" was never a reachable goal for a guard scoped to catch mistakes,
not adversarial evasion. Declined on the merits at round 7, four rounds in —
not round 17 or 20 — because the question this whole entry teaches ("does
this round's fix target the original design or the shape of the previous
round's fix?") was asked directly at the point the answer changed from yes
to no, instead of waiting for a rising-count or growing-artifact tell to
force it. The decision, and the guard's now-explicit tripwire-vs-proof scope
contract written into both scripts' headers so a future round doesn't have
to rediscover the same boundary, is in
[`decisions.md`](./decisions.md#2026-08-14--the-permission-chokepoint-guards-are-scoped-as-a-tripwire-against-habitual-mistakes-not-a-proof-against-adversarial-evasion).

### Sub-pattern: hand-rolled parser chasing full coverage of a real language's syntax

**Looks like:** writing a from-scratch recognizer — tokenizer plus rules —
meant to catch **every** way a general-purpose scripting/shell language can
express a specific dangerous operation ("does this Bash string, however
written, ever run a force push?"). **Dangerous:** each review round finds a
*new class* of bypass instead of a shrinking set, because the target
language's "ways to dispatch a command" surface (wrapper commands, quoting
forms, script-dispatch mechanisms, alias systems) is not practically
enumerable — the same losing shape as blocklist-based XSS sanitization.
Diligence cannot fix a wrong-shaped defense; more review rounds just find
more gaps, and a shrinking-then-growing trend across rounds (see below) is
the tell that the surface isn't converging. **Avoid:** before hand-rolling a
parser for a general-purpose language's command-dispatch semantics, check
whether the operation can instead be made correct **by construction**
(an allowlist/encoder shape instead of a blocklist scanner) or whether a
narrower control that doesn't need to parse intent at all — a server-side
rule, a protocol-level restriction — already covers the actual risk. Size
the defense to the *realistic* threat model (an honest mistake) rather than
a fully adversarial one, when the two genuinely differ, and say so out loud
rather than quietly absorbing round after round. **Overhype:**
`.claude/guard.sh` / `scripts/guard-decision.mjs` (PR #329) — Codex review
rounds found 11, then 11, then 12, then 19 parser gaps (fixing 9, 11, 11, 0).
The count of newly-found gaps never fell across four rounds, even as each
round's fixes landed. David stopped the loop there
rather than open a round 5: the hook was narrowed to "make the lease
mandatory" and accepted as a best-effort local backstop behind GitHub's
server-side ruleset on `main` (which needs no Bash parsing at all — it
rejects the actual git protocol operation), not chased to full-coverage
completeness. See the
[2026-08-05 `decisions.md` entry](./decisions.md#2026-08-05--the-bash-guard-is-narrowed-to-make-the-lease-mandatory-then-review-loop-iteration-stops-after-round-4-widened-instead-of-narrowed)
and `scripts/guard-decision.mjs`'s own `ROUND 4, AND THE DECISION TO STOP`
docstring section.

## A plan that grew during its own review

**Looks like:** a plan-review loop where the finding counts look *fine* — they
may even be falling — while the plan file itself keeps getting longer. Each
round's fixes are correct. Each fix adds a mechanism (an endpoint, a
reservation system, a lock, a column, a role). The next round then finds
problems in the *previous round's solutions* rather than in the original
design, and the loop silently converts itself from reviewing a document into
writing one. **Dangerous:** every existing tripwire can read green. The
finding-count rule only fires on a *rise*, and growth routinely happens while
counts fall — so the loop looks like convergence right up until the round
where all the newly-added surface comes due at once.

**The tell is the document, not the findings.** Two questions catch it:
*is the plan longer than when review started?* and *do this round's findings
attach to the original design, or to scope that has been added since?* If most
findings attach to recent additions, the artifact under review is no longer
the artifact that was approved for review.

**Root cause is almost always one document serving as both an end-state vision
and a build plan.** A totalising Product Intent — "any and all X",
"exclusively", "one source of truth" — makes every discovery in-scope *by
definition*: the document has no way to say "true, and next," only "true, so
in." **Avoid:** separate **directions** (end states, reviewed once, never
looped) from **plans** (one bounded increment, citing its direction), per
[`working-modes.md`](./working-modes.md#directions-and-plans-are-different-artifacts-david-2026-08-11);
apply the increment test *before* writing (universal quantifier ⇒ direction;
a *Phases* section whose phases are independently shippable ⇒ each phase was
a plan — an ordered migrate/rollout/verify sequence within one increment is
not this signal); record the plan's line count
at round 1 and state it every round; and frame mid-flight scope as **now vs.
next**, defaulting to next.

**Overhype:** PR #404 (workstream #405), 2026-08-10/11 — the admin-permissions
plan ran three rounds at **24 → 14 → 21** findings while growing **877 →
~1,370 lines (+56%)**. The rounds-1-to-2 fall looked like convergence and
concealed the growth entirely; round 3's rise is what finally tripped the
existing stopping rule. Of round 3's 21 findings, roughly 7 attached to the
original core and roughly **14 attached to scope added after review began**
(metered limits, a tester role, engine bands). The diagnostic fact that
separates this from the entries above: across all 59 findings, **not one
overturned a decision from the pre-plan conversation** — the loop was working
correctly on an artifact that contained three projects. The specific miss was
a framing one: when the scope question was put to David, the options offered
were *widen the grid now* or *leave it out*; **now vs. next was never on the
table**, and when a split was finally proposed he took it immediately. The
process changes this produced are #408.

**Not the same as *chasing completeness against an adversarial reviewer***
(above), though they co-occur and PR #404 shows both. That entry is about
loops whose *subject* is wrong — an unachievable guarantee, or an artifact
whose criticality never justified the rounds. This one is about a loop whose
subject is legitimate and whose *boundary* keeps moving. The distinction
decides the fix: the other entry's is to cut the subject or stop the loop;
this one's is to **split the artifact and keep going on the smaller half**.

## PostgreSQL role/constraint verification traps that look safe and aren't

**Looks like:** code (application, migration, or test) that infers a
PostgreSQL privilege or constraint's real behavior from a surface signal that
seems like it should imply it — a role membership check, a rendered
`pg_get_constraintdef()` string — rather than the thing that actually governs
behavior. **Dangerous:** each trap fails silently in the safe-looking
direction (permission appears absent when it is present, or a constraint
appears correct when it accepts values it shouldn't), so it surfaces as a
production security gap or a migration that "passed" over an unenforced
guarantee, not as a crash. All three below were verified empirically against
this repository's own PostgreSQL 16 target, not taken from documentation —
each contradicted the intuitive reading. **Avoid:** treat every PostgreSQL
privilege/constraint check in migration or authorization code as needing
direct verification against a live instance before trusting it, and prefer
the specific fixes named below over re-deriving them.

- **`pg_has_role(role, target, 'member')` is not "can this role act as
  target."** It is true for a grant with `INHERIT FALSE, SET FALSE` — a
  membership that confers no actual capability. **Use `'usage'`** (ambient,
  inherited privileges) or `'set'` (can `SET ROLE` to it on demand) for a
  narrowly defined, single-grant-shape question — never `'member'` for an
  authorization decision. **Neither `'usage'` nor `'set'` alone answers the
  broader "can this role EFFECTIVELY reach target at all" question** —
  `'usage'` misses a SET-only grant, `'set'` misses an INHERIT-only one, and
  both miss an admin-option chain that lets the role grant itself the
  target on demand. This repo already implements and tests that full union
  (`usage OR set OR a transitive admin-option chain`) in
  `canEffectivelyAssumeRole()` (`lib/db/src/index.ts`) — route an
  effective-reachability decision through that helper rather than a bare
  `pg_has_role` call, or risk reintroducing the exact under-reporting this
  entry's own history is about.
- **`CREATE ROLE x` by a non-superuser `CREATEROLE` role auto-grants `x` to
  the creator, WITH ADMIN OPTION — and the grantor is the bootstrap
  superuser, not the creator.** The creator therefore cannot revoke its own
  new membership: `REVOKE x FROM <creator>` run by a non-superuser who
  isn't the grantor does not raise an error. It emits a `WARNING` and changes nothing — a
  superuser other than the grantor CAN still remove it, bypassing the
  grantor check entirely; only a non-superuser lacking the grantor's
  authority is stuck. Code
  that creates a role and then tries to revoke its own automatic membership
  needs to verify the revoke actually happened (re-read
  `pg_auth_members`), not trust the absence of an exception. There is no
  privileged path around this available to the creator; only the grantor —
  here, a real superuser — or a superuser can remove the row. (PR #293,
  `lib/db/migrations/0097_ncmec_submission.sql`'s original `overhype_audit_maintenance`
  provisioning, later removed entirely — see the 2026-08-07 `decisions.md`
  entry.)
- **`pg_get_constraintdef()` is not a fixed point.** Feeding its own output
  back into `ADD CONSTRAINT` for the identical predicate produces a
  *different* string: `"action" IN (...)` renders as
  `ANY ((ARRAY['x'::varchar, ...])::text[])`, but re-applying that rendered
  text moves the cast onto each array element —
  `ANY (ARRAY[('x'::varchar)::text, ...])`. Any code that round-trips a
  constraint through its rendered text (a migration verifying a constraint
  by comparing `pg_get_constraintdef()` output, `pg_dump`/restore, or
  `drizzle-kit push` reconciling against a Drizzle-rendered snapshot) can
  land in either form for a semantically identical constraint. Worse: no
  amount of pattern-matching on the rendered text can soundly verify a
  CHECK constraint's *meaning* at all — five successive attempts in PR #293
  (a literal string match, matching the mentioned literal set, an anchored
  shape, evaluating the predicate against probe values, then widening the
  anchored shape for both renderings above) were each defeated by a
  predicate that rendered acceptably while enforcing something else, most
  recently one accepting all nine intended literals plus any 13-character
  string via a `CASE WHEN length(action) = 13 ...` disjunct hidden inside
  the array. **The fix that actually converged was to stop verifying and
  rebuild the constraint unconditionally** (`DROP CONSTRAINT IF EXISTS` +
  `ADD CONSTRAINT`) wherever the role has permission, so the post-condition
  holds by construction instead of by inspection — but unconditional
  replacement is only safe when no row can already violate the *new*
  constraint: append-only triggers stop later mutation, not an `INSERT`
  the *currently drifted* CHECK still admits, so a row a prior drifted
  predicate let through would make the replacement `ADD CONSTRAINT` raise
  a violation and roll back the whole migration. Safe here specifically
  because phase 1 has no ledger writers yet (the table is empty at replay
  time) — reusing this "just rebuild it" move against a table that already
  has rows needs a preflight check (or an owner-run repair of nonconforming
  rows) first, not an assumption that unconditional replacement is
  generally replay-safe. See the 2026-08-07 `decisions.md` entry and
  `lib/db/migrations/0097_ncmec_submission.sql`'s action-CHECK block.
- **A hand-authored constraint with no matching declaration in `schema/*.ts`
  is silently removed by the next `drizzle-kit push` — while the migration
  tracker still reports the migration as applied.** `push` reconciles the live
  database against the *TypeScript schema*, not against the migration history,
  so a CHECK that exists only in raw migration SQL reads to `push` as drift to
  be dropped. Nothing surfaces: the journal still lists the migration, a
  re-run of the migration skips it as already-applied, and the constraint is
  simply gone from the database. Found on the live workspace during the PR242
  post-merge checklist, months after 0092 added
  `facts_active_requires_concept` — the *backfilled data* was still correct,
  which is what made it invisible; only the enforcement had disappeared, so the
  next writer to violate it would have succeeded. **Every raw-SQL constraint
  needs a matching `check()` (or index/FK) declaration in the schema file that
  owns the table**, not just the migration — and a repair for a lost one has to
  be a *new forward-only* migration guarded on `pg_constraint`
  (`lib/db/migrations/0098_fact_lifecycle_check_repair.sql`), because re-running
  the original is a no-op the tracker will never perform. Corollary for
  verification: "the migration is recorded as applied" is not evidence the
  constraint exists — query `pg_constraint` directly.
- **Recurred 2026-08-13 with SEQUENCES — the rule covers every object type
  `push` DOES reconcile, not just constraints.** `membership_source_state_seq` and
  `membership_lease_fence_seq` were created by 0095's raw SQL and never
  declared in `schema/membershipEntitlements.ts`, so `push --force` dropped
  both; 16 membership-lease/grace-sweep tests then failed on
  `nextval(...)`. The entry above already stated the general rule, but its
  parenthetical enumerated only `check()`/index/FK — and a sequence isn't any
  of those, which is exactly how a documented pattern recurred in a new
  shape. **Read that list as illustrative rather than exhaustive — but the
  rule is bounded by what `push` actually reconciles**, which is the object
  types drizzle-kit introspects: tables, columns, constraints, indexes, enums,
  and sequences (the last via `pgSequence`). It does **not** extend to
  functions and triggers — drizzle-kit does not model those at all, so `push`
  leaves them untouched and there is no declaration to add. Verified rather
  than assumed: 0095's own `membership_entitlements_guard_immutable` function
  and its trigger are undeclared and have survived many pushes intact, in the
  same migration whose sequences did not. Stating the rule as "anything in raw
  SQL needs a declaration" would send the next author hunting for a
  declaration that cannot exist.
  **What hid it for so long is worth more than the fix:** the drop needs
  *two* pushes to be observable — the first creates from a pristine database,
  the second reconciles against a schema that never mentioned the object.
  GitHub CI builds an ephemeral Postgres and runs push+migrate exactly **once**
  per database, so it never reaches the state that exposes the drop and stays
  green; only a PERSISTENT database (Replit's `heliumdb_test`, a long-lived
  sandbox) gets a second push. **A green CI is therefore not evidence the
  schema is push-safe** — but note that this is a property of how the workflow
  is currently shaped, *not* an inherent limit: pushing a second time within
  one job and asserting the objects survive would reproduce the whole
  transition in CI. That guard is deliberately deferred to its own change
  rather than bundled here (David, 2026-08-13); until it lands, this class is
  caught by nothing but the rule above. Verified empirically before fixing: second push-force
  dropped both sequences, exited 0, and logged nothing. Verification
  corollary matching the one above — query `pg_class WHERE relkind='S'`, and
  when a persistent test database starts failing where CI passes, suspect this
  before suspecting the tests.

## Editing an already-merged migration file — even a comment — makes the hash-tracked runner replay it

**Symptom would have been:** a database that already ran migration N silently
runs it again on the next deploy, re-executing every statement in the file —
including a real `DELETE`, a data overwrite, and a duplicate audit-log
`INSERT` — with no error and no obvious trigger.

**Why it happens:** `lib/db/src/migrate.ts`'s `applyMigrations()` decides
whether a migration is "already applied" by SHA-256 of the migration file's
**entire content** (`crypto.createHash("sha256").update(sql)`, `sql =
fs.readFileSync(path, "utf8")`), not by its tag, filename, or journal index.
Editing *any* byte — including a comment — changes that hash. A database that
already recorded the old hash as applied then sees the new hash as an
unrecognized, pending migration on its next `migrate()` call and runs the
whole file from scratch, `BEGIN…COMMIT` and all.

**Caught during PR #427's review (round 9), not by any automated check.**
Round 8 made a documentation-only fix inside `0099_admin_permissions_core.sql`
— a migration from a *different*, already-merged PR (#425) — to correct a
comment that had become stale. The file happened to be sitting in the diff
because a doc fix elsewhere referenced it; nothing about editing it felt
different from editing any other file. Codex's round-9 review named the exact
mechanism and the exact consequence (the file's own `INSERT INTO
feature_permissions_migration_log` and its conditional `DELETE` are not
idempotent-safe to run twice with intent — a second run inserts a duplicate
audit row and can delete a row a later admin action had deliberately
restored). **Verified, not just restored on the finding's say-so:** the
edited file's SHA-256 matched zero rows in a real database's
`drizzle.__drizzle_migrations` table; the restored, byte-identical file's hash
matched a row already there. Fixed by `git checkout origin/main -- <file>`
(byte-for-byte, diffed empty) and moving the same doc correction into the
adjacent `schema/*.ts` file instead — plain TypeScript, never hash-tracked,
safe to edit freely.

**The rule: a migration file that has already merged into `main` is
byte-for-byte immutable, full stop — not "immutable except for comments" or
"immutable except for whitespace."** There is no safe partial edit, because
the hash function has no concept of "cosmetic." If a migration's comment is
wrong, wrong, or its behavior needs to change, the fix is always a **new**
forward-only migration (or, for pure documentation, editing prose in a
non-migrations file that references it) — never touching the original file's
bytes. This applies regardless of *why* the file is in your diff: it doesn't
matter whether you authored it, whether it's part of the same PR, or whether
the edit is "just a comment" — the moment a migration has a real chance of
having already been applied somewhere (which for anything on `main` is not a
theoretical concern), touching it is a mistake with no small-blast-radius
version.

**A file living in `lib/db/migrations/` is not "docs I can touch" the moment
it sits in your diff.** Before editing anything under that directory, ask
whether it's the migration *this* change is introducing (safe — nothing has
run it yet) or someone else's, already-merged one (never safe). See
[`migrations-and-backfills.md`](../engineering/migrations-and-backfills.md)
for the working rule and
[`.agents/memory/migration-file-immutable-once-merged.md`](../../.agents/memory/migration-file-immutable-once-merged.md)
for the quick-reference version.

## An entitlement gate that reads the tier column when the rule is role-based

**Symptom:** a capability works for everyone it should — except admins, who
are the people least likely to report it, because they assume they have
everything. Nothing errors. The feature simply doesn't happen, and the caller
is told it did.

**Why it happens:** two vocabularies describe the same permission and only one
of them includes admin. `users.membership_tier` is
`unregistered | registered | legendary` and `is_admin` is an orthogonal
boolean, so an admin's *stored tier* is `registered` unless they separately
hold a paid entitlement. The role vocabulary
(`deriveUserRole` → `isAtLeastLegendary`) folds the flag in; a
`hasFeature(membershipTier, …)` lookup cannot, because the feature table is
keyed by tier and no caller ever passes `'admin'` — the `admin` rows seeded in
migrations `0028`/`0029` are unreachable by construction. Because most
legendary gates in the codebase *are* role-based and work fine for admins, the
one that isn't looks correct under exactly the account most likely to test it.

**Avoid — and this is now structural, not advisory.** The whole "decide which
vocabulary a gate speaks" question is gone, because there is only one:
`artifacts/api-server/src/lib/featureAccess.ts`. Route code asks
`can(principal, key)`; the tier-keyed lookup is module-private and
`scripts/check-permission-chokepoint.mjs` fails the build if anything outside
that module references it, reads the grid tables, or adds a new inline role
comparison in a product-feature path. Admin resolution is a union
(`features(tier) ∪ features('admin')`), so the grid's Admin column is what
grants admins a feature — not a hand-written exception beside the lookup.

The old advice ("resolve from the role, optionally OR-ed with the feature
lookup") is what produced the mess: it made the OR a *convention*, and twelve
places ended up gating one capability by two different rules. `facts.ts`'s
captcha bypass was the worked example of the good version and was still wrong —
its comment claimed the direct check was authoritative and the table entry
"secondary", which is two sources of truth stated as a feature.

Sibling gates in the same function remain the tell that something has drifted
back: `createMemeRecord` had `canPulid` on the role and `canPrivate` on the
tier three lines apart.

**And never coerce a denied *privacy* request into its permissive default.**
The gate above was only half the defect. The other half was what it did on
denial: it silently rewrote `isPublic: false` to `true` and returned 201. A
capability quietly not applied is an annoyance; a *privacy* choice quietly not
applied is a disclosure — the caller was told the save succeeded, and the meme
was world-readable at its permalink. Fail closed and say so. An unhonourable
security request is an error, never a downgrade.

**Overhype:** PR #394 restored the builder's Public/Private control, and the
first private meme saved through it was published anyway. The builder maps
`admin → legendary` (`roleToTier`) so the Private pill was selectable and
selected; `createMemeRecord` resolved the entitlement from the tier column,
found `registered`, and coerced the meme public. Both surfaces believed they
were consistent with the other — `VisibilityToggle`'s own comment claimed the
control "can never display a value the server would silently overwrite,"
which was true for every tier except the one the author was testing on.

*Closed structurally, not by fixing the two sites.* `roleToTier` is deleted and
the client is told its entitlements by the server; `VisibilityToggle` takes the
resolved `canSetPrivate` rather than a derived tier, so the control's lock and
the server's gate are one expression evaluated once. A CI guard
(`scripts/check-permission-chokepoint.mjs`) fails the build if the tier-keyed
lookup becomes reachable from route code again.

## Permission-prompt fatigue defeats a "safe" default with no curated allow/deny list

**Looks like:** a genuinely risky tool or environment (one that can push to
`main`, touch a live database, execute arbitrary code) gets its access gated
by ordinary per-action permission prompts — no deny list, just a `default`/
`ask` mode — reasoning that "it'll ask before anything dangerous" is
sufficient. **Dangerous:** it fails exactly when review matters most. A human
facing a *wall* of prompts during real work does not read each one; they
start clicking through, and one-off "allow" clicks silently persist as
standing grants. On 2026-08-11 this produced live, accumulated permission for
an in-Repl agent session to `git commit`, `git push`, `gh auth`, and run
arbitrary `python3 -c` code — the exact review-bypass and code-execution risk
the session's whole operator role existed to prevent — not because anyone
decided to grant it, but because clicking "allow" sixty times is what using
the tool felt like. **Avoid:** for any environment where a mistaken grant has
real blast radius, pair the prompting default with an explicit **deny list**
that takes precedence over `allow` — that's what makes the design
fatigue-proof, since even a reflexive click on a future prompt can't cross a
denied boundary. Then curate a **generous allow list of genuinely low-risk
operations that cannot read arbitrary file content or execute another
command through themselves** (status/log/diff reads, `ls`, `ps`, env
reads) so that prompts become rare enough to actually be read, not merely
fewer — one prompt an hour gets scrutinized, fifty a session get clicked
through. **The allow list itself needs the same scrutiny as the deny
list, not just the presence of one:** a first draft of this exact list
allowed `cat`/`grep`/`find` as "obviously read-only," and a review caught
that each defeats the design in its own way — `cat`/`grep` read file
content through a door (a raw shell command) the `Read`-tool-scoped deny
rules don't cover, and `find -exec` runs an arbitrary command, including
anything else on the deny list, through a prefix the rule never inspects
past. **Overhype:** the local settings override in the Repl (see
[`replit-environment.md`](replit-environment.md#the-repl-requires-a-local-settings-override-that-is-not-in-git),
which also has the corrected list and the full reasoning).

## A derived metric that silently undercounts because its collector only reads one delivery channel

**Symptom:** a number computed from an external source looks authoritative —
counted, not recalled, by a script written specifically so nobody types it from
memory — and is quietly wrong in one direction. Not because the arithmetic is
wrong, but because the *collector* reads one channel and the source emits on
several. The failure is invisible at the point of use: a zero from "nothing
happened" and a zero from "the thing happened somewhere I don't look" are the
same zero.

**The three live instances**, all in `scripts/loop-metrics.mjs`, all found on
2026-08-15 during and immediately after the first `/maintenance` ledger flush:

| Channel | What the collector reads | What it misses |
|---|---|---|
| Findings | inline **review threads** | a finding delivered in the review **body** — PR #447's round 1 raised a real one (broken TEST_RUN↔UAT sibling links), so the record reads `findings: 0` on a loop that had one |
| Rounds | issue comments and review bodies carrying a `**Reviewed commit:**` marker | a **👍-only clean pass** — the connector's documented behaviour is "if Codex has suggestions, it will comment; otherwise it will react with 👍," and a reaction emits no marker, so PRs #414, #415 and #416 record `rounds: 0` |
| Rounds | the same marker | a clean pass posted in the **`## Review Result`** comment format, which carries prose, a testing checklist and permalinks but **no marker at all** — unlike the older `Codex Review: Didn't find any major issues. **Reviewed commit:** <sha>` shape, which has one |

**The third one is the most instructive, because it happened *to this entry's
own PR* (#465) minutes after the first two were written.** Codex returned a
full, clean, visibly thorough code review — and it will still record as
`rounds: 0`, because the connector emits at least two clean-pass formats and
only one of them carries the marker. The lesson is not "there are two gaps,"
it is that **the collector keys on a convention the source never promised to
keep**, so the gap list is open-ended and will grow again whenever the
connector changes its output shape.

**Why it bites harder than an ordinary bug:** the undercount is *credible*.
`loop-metrics.mjs` exists because recalled figures in this repo were wrong
three times out of three, so a counted figure carries earned authority — and
that authority transfers to the gaps. On the 2026-08-15 pass the `rounds: 0`
on #414/#415/#416 was read as "these PRs were never reviewed," reported to
David as a process failure, and nearly written into three records as a
finding. The truth was the opposite: all three were reviewed and came back
clean. **Each record's own original note had said so correctly**; the sweep
that re-derived them replaced a right answer with a wrong one, because the
sweep trusted the number over the prose.

**Avoid:** before reading a zero as an absence, ask *which channel would this
have arrived on, and does the collector read it?* Check the cheap
disconfirming signal — for a review, that is the PR's reactions and its review
bodies, neither of which the marker scan touches. And when a record's prose
disagrees with its own derived number, **that is a signal to investigate, not
prose to correct**: the human note was written with context the collector
never had.

**Do not hand-fix the numbers.** The never-type-mechanical-values rule still
governs — a hand-edited count is exactly the failure `loop-metrics.mjs` was
built to prevent, and a corrected-by-hand record is indistinguishable from a
fabricated one. Record the gap in the affected record's `notes` and leave the
derived value alone, which is what #414, #415, #416 and #447 now do.

**The real fix, if this recurs:** teach the collector the missing channels —
reactions for the clean-pass case, and a body-level finding count for the
other — rather than documenting around them a third time. Per this repo's
standing rule, a pattern that recurs graduates from a memory note to a
deterministic check.

**Overhype:** the store's own contract is
[`.agents/metrics/loops/README.md`](../../.agents/metrics/loops/README.md); the
ledger obligation that binds every agent is
[`working-modes.md`](./working-modes.md#the-loop-ledger).

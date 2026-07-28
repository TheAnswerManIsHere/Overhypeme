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

## Un-frozen input re-resolved live between enqueue and async execution

**Looks like:** a value (identity, config, a selected option) is fixed at the
moment a user takes an action, but an async worker that processes the
resulting job re-derives that same value **live** — a fresh DB query, a fresh
config read — instead of reading whatever was fixed at enqueue time.
**Dangerous:** if the underlying source changes in the window between enqueue
and execution (a profile edit, a config change, a row deactivated), the worker
silently uses the NEW value while other parts of the same job (text already
rendered from the OLD value) still reflect the old one — producing output that
is internally inconsistent with itself, and non-reproducible (the same job
re-run later can produce a different result than it would have at enqueue
time). **Avoid:** resolve every input a job needs exactly ONCE, at the point of
enqueue, and persist a validated snapshot on the job/row; the worker reads the
snapshot and never re-queries the live source for that input. **Overhype:** the
`image_prompt_generation` worker re-queried the user's `displayName`/`pronouns`
and re-resolved the selected look-style live on every run, even though the
fact text had already been frozen at enqueue — a profile edit or a style
edit/deactivation in that window could produce a render whose frozen fact text
and whose live-resolved identity/style disagreed. Fixed by
`prepareImagePromptAttemptInputs()` freezing a `PromptIdentitySnapshot` +
`ResolvedRenderStyleSnapshot` once and rendering the fact text from that same
identity (PR #223). See
[`visual-pipeline.md`](./visual-pipeline.md#frozen-render-inputs-identity--style-reproducibility).

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

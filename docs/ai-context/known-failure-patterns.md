# Known Failure Patterns

> Mistakes AI agents have repeatedly made (or nearly made) on Overhype.me. Each
> has a real anchor in this codebase. Read this before visual-pipeline,
> enrichment, moderation, or migration work. Anchored IDs are linked from other
> docs.

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

## Over-engineered speculative abstractions

**Looks like:** building a framework/config system/plugin layer for a need that
doesn't exist yet, or expanding scope "while we're here." **Dangerous:** more
surface to maintain and break, slower to launch, harder to review. **Avoid:** make
the **smallest coherent change** that satisfies the approved plan; defer
speculative generality. **Overhype:** pre-launch priorities are stability + content
quality — new external vendors and new abstractions need a strong reason and
David's sign-off (see [`product-direction.md`](./product-direction.md)).

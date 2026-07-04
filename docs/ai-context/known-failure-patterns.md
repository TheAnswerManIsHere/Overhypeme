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

## One-example bug fixes

**Looks like:** patching only the exact reported sentence/case instead of the
general mechanism. **Dangerous:** the class of bug remains; it resurfaces with the
next input. **Avoid:** fix the mechanism and add a test that asserts the
**invariant**, with negative cases. **Overhype:** the tokenizer's
`autoConjugatePersonSubjectVerbs` net solves the *general* "person-subject verb
must agree" rule (not just "They keeps"), with a narrow anchor so it never
mis-wraps non-person subjects ("Sharks have …"), plus idempotency tests. See
[`token-rendering-and-grammar.md`](./token-rendering-and-grammar.md#regression-examples-must-stay-green).

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

## Over-engineered speculative abstractions

**Looks like:** building a framework/config system/plugin layer for a need that
doesn't exist yet, or expanding scope "while we're here." **Dangerous:** more
surface to maintain and break, slower to launch, harder to review. **Avoid:** make
the **smallest coherent change** that satisfies the approved plan; defer
speculative generality. **Overhype:** pre-launch priorities are stability + content
quality — new external vendors and new abstractions need a strong reason and
David's sign-off (see [`product-direction.md`](./product-direction.md)).

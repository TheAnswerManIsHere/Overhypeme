# Plan — Admin help system: render the Manual in-app at `/admin/help`

**Workstream:** [#463](https://github.com/TheAnswerManIsHere/Overhypeme/issues/463)
**Mode:** feature-building, full ceremony · **Criticality:** ~15/100
**Status:** draft for Codex plan review. Not approved. Not started.

---

## Preflight: is this a plan, or a direction?

**Increment test — passes as a plan.**

- *Universal quantifier?* No. The scope is one route, one generated artifact,
  one deep-link map over today's admin nav. Nothing here reads "every X" over
  an open-ended set.
- *Independently-shippable Phases?* No. The generator, the route, the search
  index, and the `?` map are one mechanism: the route has nothing to render
  without the generator, search has nothing to index without the artifact, and
  the `?` links have nowhere to point without the route. Splitting would create
  ordering dependencies between pieces that are useless alone — the
  manufactured-ceremony case, not the coupled-mechanism case.

Recorded in issue #463 decision 6: one increment, David invited to push back
and did not.

**Specification test applied while drafting.** Where the compiler, the test
suite, or diff review would catch a mistake, this plan stays silent. It
specifies invariants — the source-of-truth boundary, where the drift gate must
live, link resolution semantics, the map's completeness contract, the
no-executable-content rule — and leaves component structure, file names, and
test assertions to the build.

---

## Problem

An admin who wants to know how a part of the product works has to leave the
console, find the repo on GitHub, and navigate `docs/manual/`. The Manual is
already written — twelve chapters, ~160 KB of narrative — and it is the answer
to almost every "what does this screen actually do?" question the console
raises. It just isn't reachable from the place the question gets asked.

## Direction

No standing direction document covers in-app help; this increment stands alone
and issue #463 is its only antecedent. Stated explicitly rather than left
blank, per the template.

The *next* step beyond it — a public or user-facing help centre — is recorded
in #463 as out of scope here, so a reviewer should read any pull toward
public-facing concerns (SEO, anonymous access, a second content pipeline) as
scope this plan has already declined.

## Product Intent

**This increment makes true:** an admin can read any Manual chapter inside the
admin console at a bookmarkable URL, search it, and jump into the relevant
chapter from a `?` control on the admin screen they are already looking at.

It does *not* make the Manual editable from the UI, and it adds no reading
surface *in the console* for anyone who is not already an admin. It makes no
claim about the confidentiality of the prose itself — that text is already
published on a public repository, and the generated chunk is a
publicly-fetchable static asset like every other route's. See *Security,
Permissions, and Validation* for why the stronger-sounding version of this
sentence was withdrawn.

## Must Not Change

1. **`docs/manual/*.md` remain the single source of truth for Manual content.**
   The help system reads them. It never forks, edits, or becomes a second place
   the text can be changed.
2. **The Manual keeps rendering correctly on GitHub.** The generator adapts to
   the Manual's existing markdown; the Manual is never reshaped to suit the
   generator. If a chapter would have to change to be renderable in-app, the
   generator is wrong, not the chapter.
3. **No change to admin nav behavior**, the `AdminLayout` privilege gate, or the
   existing `stage`/badge/collapse behavior of the sidebar. A new nav entry is
   added; nothing existing moves.
4. **No change to the docs-accuracy gate** (`scripts/check-docs-accuracy.mjs`)
   or the manual-tuning gate (`scripts/check-manual-tuning-language.mjs`). Both
   continue to run over `docs/manual/` exactly as today.
5. **No new backend surface** — no API route, no DB table, no server-side
   rendering path.
6. **No new privilege rail.** `/admin/help` is gated by exactly what every other
   admin route is gated by, and adds no second notion of who may read it.

## Settled Decisions

From issue #463, agreed with David 2026-08-15:

1. **Full page at `/admin/help`**, inside the existing `AdminLayout`.
   Per-section URLs are bookmarkable. (Chosen over a slide-over drawer.)
2. **Links out of the Manual resolve to GitHub**; intra-Manual links become
   in-app routes.
3. **Search ships in this increment** — client-side, over a build-time index.
4. **Content is baked in at build time** as a committed generated artifact with
   a CI drift check. No backend, no new API, no DB.
5. **Each admin screen gets a `?` deep-link** into the relevant chapter or
   section.
6. **One increment, not phased.**

Decided during this plan (the open question #463 deferred here, plus what the
repo dictates):

7. **Markdown is converted to HTML at generation time, not at runtime** — see
   *Source-of-Truth Analysis* and *Risks* for why, and what it costs.
8. **The drift gate runs in the always-on Build job, not in the Frontend Test
   suite** — see *The drift gate cannot sit where the precedent sits*, below.
   This is the sharpest invariant in the plan.

Decided in response to Codex round 1:

9. **Generation validates fragments, not just files** — every `#anchor` whose
   target file lives in this repo must resolve to a real heading, or generation
   fails. Nothing in the repo checks this today.
10. **Generation enforces chapter-number agreement across all four
    representations** — contents table, filename prefix, chapter heading, and
    the previous chapter's `**Next:**` footer.
11. **The plan's admin-only-reading claim is withdrawn as unenforceable**, and
    replaced by an input-boundary invariant: the generator reads only
    `docs/manual/`, which is already public, so nothing non-public can reach a
    publicly-fetchable asset.

Decided in response to Codex round 2:

12. **`/admin/help` renders the README**, so every in-app link target has a
    rendered destination. Fragments are validated against that **rendered
    destination**, not the source file — the two coincide only for chapters.
13. **Fragment navigation is an explicit mechanism, not an assumption** —
    post-mount, against the real scroll container, across all three entry
    paths (cold bookmark, cross-chapter, same-page).

## Repo Context Inspected

- `docs/manual/` — all 12 chapters plus `README.md` (the charter, chapter
  template, contents table, and the tuning-language boundary). ~161 KB total.
- `artifacts/overhype-me/scripts/generate-admin-field-reference.ts` and
  `src/components/admin/fieldDocs/renderMarkdown.ts` — the generated-artifact
  precedent named in #463.
- `artifacts/overhype-me/src/components/admin/fieldDocs/fieldDocs.test.ts:135-148`
  — where that precedent's determinism and staleness checks actually live.
- `artifacts/overhype-me/src/components/admin/AdminLayout.tsx` — `NAV_ITEMS`
  (15 entries), the privilege gate, `isAdminNavItemActive`, the mobile drawer.
- `artifacts/overhype-me/src/App.tsx:377-394` — admin route table, `lazy`
  route-chunk convention (`lazyWithRetry`).
- `artifacts/overhype-me/vite.config.ts` — aliases, `optimizeDeps`, and the
  Vite root that puts `docs/` outside importable range.
- `.github/workflows/build.yml` — job topology: the `changes` classifier, the
  always-on `build` job (which runs `pnpm install` before its later gates), and
  the `if:`-gated `test` / frontend / e2e jobs.
- `scripts/classify-ci-paths.mjs:59-76` — `isInertPath`, including the
  `docs/ADMIN_FIELD_REFERENCE.md` carve-out and its stated reasoning.
- `scripts/check-docs-accuracy.mjs:33-36` — `LIBRARY_DIRS` includes
  `docs/manual`, so link and path checks already cover it.
- `scripts/check-permission-chokepoint-frontend.mjs` — confirms the
  `role === "admin"` rail is exempt (per #463).
- `artifacts/overhype-me/e2e/routeLoadSmoke.spec.ts` — the route-load smoke
  net and its admin-auth bypass.
- `package.json` (root and `artifacts/overhype-me`) — confirms **no markdown
  parser, renderer, or sanitizer exists anywhere in the workspace today**.
- `docs/ai-context/documentation-workflow.md`, `docs/ai-context/admin-console.md`,
  `docs/engineering/code-review.md`, `docs/ai-context/working-modes.md`.

## Current Behavior

- `docs/manual/` is authored by hand, gated by `check:docs` (links + cited
  paths) and `check:manual-tuning` (lexical value-language check), both in the
  always-on Build job. It is readable only on GitHub or in a checkout.
- The admin console is a wouter route table under `/admin/*`, each page
  lazy-loaded into its own chunk, all rendered inside `AdminLayout`, which
  performs the `role === "admin"` gate and renders a fixed 15-item sidebar.
- One generated doc artifact exists (`docs/ADMIN_FIELD_REFERENCE.md`),
  produced from a code-side registry by `generate:field-docs`, with
  determinism and byte-parity assertions in the **Frontend Test** vitest suite.
- CI classifies changed paths: anything under `docs/` is inert and skips the
  Test / Frontend Test / E2E Smoke jobs, with one explicit carve-out for
  `docs/ADMIN_FIELD_REFERENCE.md`.

## Source-of-Truth Analysis

| Concept | Source of truth | How this plan keeps it single |
| --- | --- | --- |
| Manual prose | `docs/manual/*.md` | Generated artifact is derived and committed; never hand-edited; drift gate proves it matches. |
| Chapter numbering & order | The contents table in `docs/manual/README.md` | Generator reads chapter order from that table rather than from filename sort or a hand-kept list, so the Manual's own stated source of truth stays the only one. |
| Search index | The generated artifact | The index is derived from the same generation pass, never from a second read of the Manual — otherwise a bug could make search and page content disagree. |
| Screen → help target map | One table in code | Not derivable from anything; it is a product judgment. It gets a completeness test instead of a second source. |
| Who may read the Manual in-app | `AdminLayout`'s existing gate | No second check is introduced. |

**The generator direction is the inverse of the field-docs precedent**, and
that inversion is what makes the CI question below load-bearing. Field docs:
source in code → artifact in `docs/`. Help content: source in `docs/` →
artifact in code.

### The drift gate cannot sit where the precedent sits

`isInertPath` (`scripts/classify-ci-paths.mjs:67`) classifies everything under
`docs/` as inert, so a PR that edits only a Manual chapter skips the Test,
Frontend Test, and E2E Smoke jobs. The field-docs staleness assertion lives in
the Frontend Test suite, which is correct **for that direction** — its source is
code, so any change that could invalidate the artifact is itself a heavy path,
and its one `docs/`-side output is explicitly carved out of the inert list.

Reversed, the same placement fails silently: a chapter-only edit is entirely
inert, the heavy jobs never run, and a stale committed help artifact merges
green. The console would then show a Manual that no longer matches
`docs/manual/`, with every CI check passing and nothing to notice it — the
single-source-of-truth invariant broken by exactly the workflow it exists to
protect.

**Invariant: the help artifact's drift check must run on every PR that can
change either side of it, without depending on path classification.** The
always-on Build job is the only place that holds unconditionally, and it
already runs `pnpm install` before its later gates, so the generator's
dev-time toolchain is available there.

Adding `docs/manual/**` to the inert carve-out list is the alternative and is
**rejected**: it would force the full heavy suite — two Postgres boots, a
Chromium download, the integration and e2e suites — onto every prose edit, and
this repo's `/document` harvests are a large share of its PR volume. The
carve-out solves the correctness problem by paying the cost the classifier was
built to avoid.

## Proposed Design

Four pieces, one mechanism.

### 1. A generator, following the `generate:field-docs` shape

A script in `artifacts/overhype-me/scripts/` reads `docs/manual/`, converts
each chapter to render-ready content plus a search index, and writes a
**committed generated module** under the frontend's `src/` tree. Invoked by a
`generate:help` package script, mirroring `generate:field-docs`.

Invariants the generator owes:

- **Deterministic.** Two runs over identical input produce byte-identical
  output. (Same assertion the field-docs precedent carries; it is what makes a
  drift check meaningful at all.)
- **Chapter order comes from the README contents table**, not filename sort —
  `10-`, `11-`, `12-` sort before `2-` lexically, and the table is the Manual's
  declared source of truth for numbering.
- **A chapter present on disk but absent from the contents table, or vice
  versa, is a generation error**, not a silent omission. The Manual's own rules
  make that table authoritative; a generator that quietly diverges from it
  creates the second source of truth this plan forbids.
- **All four representations of a chapter's number must agree, or generation
  fails** (Codex round 1). Membership alone is not enough: `README.md:216-223`
  states that the number lives in the contents table, the filename prefix, the
  chapter's own `# Chapter N · Title` heading, **and** the preceding chapter's
  `**Next:** chapter N — …` footer, and that all must agree. A row reordered in
  the table without touching the files leaves every file still *present* in the
  table, so a membership check passes while the help system orders chapters by
  one numbering and titles and routes them by another — the exact
  two-sources-of-truth split this plan claims to prevent.

  That same README passage says outright: *"Nothing enforces this yet; a
  consistency check is a good candidate for the Build job if it ever drifts."*
  This generator is that check's natural home — it must read all four
  representations to do its job anyway — so adopting it here is closing a gap
  the Manual already asked for, not scope this plan invented.
- **The generator never writes to `docs/`.** One direction only.

### 2. Content conversion at build time

Markdown becomes HTML during generation. The runtime ships strings and renders
them; no markdown parser enters the client bundle.

**Why build-time** (the open question #463 deferred to this plan): the Manual
is ~161 KB of prose, and a runtime renderer would add a parser *on top of*
shipping the same prose. Build-time conversion also puts the output where a
dependency-free CI gate can assert things about it, and matches the one
generated-artifact precedent the repo already has.

**The trust boundary, stated plainly.** Generated HTML is injected into the
admin console as markup. The content is repo-authored and passes through code
review, so the threat model is not untrusted input — but "reviewed by a human"
is not a mechanical guarantee, and the failure it protects against (script
execution inside an authenticated admin session) is the one place this
low-criticality feature touches something that matters.

**Invariant: the generated artifact contains no executable content.** No
`<script>`, no event-handler attributes, no `javascript:` URLs, no embedded
`<iframe>`/`<object>`. Raw-HTML passthrough is disabled at conversion, and the
generator **asserts** the property on its own output before writing — a
generation-time failure, not a reviewer's promise. Being generator-enforced,
this holds for chapters written later by anyone, which review alone does not.

Rejected alternative: emitting a structured node tree and rendering it with
React components, which would make injection impossible by construction rather
than by assertion. It is the stronger shape, and it is rejected on proportion —
it means owning a renderer for the Manual's full markdown vocabulary (tables,
nested lists, block quotes, code fences, inline HTML comments) for an
admin-only reader, and the assertion above closes the same hole at a fraction
of the surface. Recorded so the trade is visible rather than implied.

### 3. The route

`/admin/help` and `/admin/help/:chapter` (and an in-page anchor for sections),
lazy-loaded like every other admin page, rendered inside `AdminLayout`, with a
new sidebar entry.

**`/admin/help` renders `docs/manual/README.md`** — the Manual's charter — with
the chapter list and search as navigation chrome around it (Codex round 2). An
earlier draft classified `./README.md` links as in-app but specified the index
route as a chapter list only, so `12-background-work.md:88` ("the manual's
charter") would have landed on unrelated content and `:255`'s
`./README.md#contents` on nothing at all.

**Rendering it whole is forced, not chosen.** The README mixes reader-facing
orientation (*How to read this manual*) with authoring guidance (chapter
template, quality bar, the tuning-language boundary) that an admin looking for
product help does not need. Filtering it would mean generating an edited
variant of a `docs/manual/` file — a second, divergent version of the text —
which *Must Not Change* #1 forbids outright. So the whole document renders, and
the mild noise is accepted.

One consequence worth taking deliberately: the README's own **contents table is
the chapter list**, rather than the UI maintaining a parallel one. That keeps
the chapter-ordering source of truth single, per *Source-of-Truth Analysis*.

Invariants:

- **Per-chapter URLs are bookmarkable and shareable**, and a section anchor
  lands on that section. This is decision 1's actual content.
- **Chapter slugs are stable and derived from the chapter files**, so a
  bookmark does not break when a chapter's prose changes. Renaming or
  renumbering a chapter file is already a deliberate, multi-file act per the
  Manual's own rules; that it also changes a help URL is acceptable and is
  called out in *Risks*.
- **Section anchors match the anchors GitHub generates** for the same headings,
  so a link that works in one place works in the other, and the `?` map's
  targets can be validated against the source markdown.
- **A fragment lands on its heading *after* the chapter's chunk has mounted,
  and scrolls the container that actually scrolls** (Codex round 2). This
  invariant is stated separately from "anchors match" because a correct anchor
  and a correct `id` are not sufficient here, and the naive implementation
  fails silently in three compounding ways this app specifically has:

  1. **Lazy mount timing.** Chapters load as their own chunks, so the browser
     can process the fragment before the target heading exists. Nothing scrolls
     and nothing errors.
  2. **The scroll container is not the window.** The admin shell is
     `fixed inset-0` and scrolling happens in an inner `overflow-auto`
     (`AdminLayout.tsx:337`). Anything that scrolls `window` moves nothing.
  3. **An existing handler actively resets it.** `ScrollToTop`
     (`App.tsx:351-355`) fires `window.scrollTo({top: 0})` on *every* location
     change. It is a no-op inside the admin shell today, but any fragment
     handling must not be defeated by it, and it must not start defeating
     fragment handling if the shell's scroll model changes.

  Confirmed by search: the frontend has **no** `location.hash` or `hashchange`
  handler anywhere; the only two `scrollIntoView` calls are unrelated
  (`Step2Image.tsx:326`, `FactDetail.tsx:497`). So there is no existing
  mechanism to inherit — this has to be built, and a plan that assumed
  "anchors just work" would have shipped a feature whose deep links quietly
  do nothing.

  **The invariant covers all three entry paths**, because they differ in
  timing: a cold load of a bookmarked `/admin/help/:chapter#section`, a
  cross-chapter navigation (search result or `?` link) where a new chunk
  loads, and a same-page anchor click where nothing loads.
- **An unknown chapter slug renders a not-found state inside the console**, not
  a blank page or a crash — the route is reachable by bookmark, so a stale one
  is an expected input, not an error case.
- **Help content must not enter the main bundle or any existing admin chunk.**
  ~161 KB of prose loaded on every admin page view is a real regression to
  screens that have nothing to do with help. Per-chapter granularity is an
  implementation choice; keeping it out of unrelated chunks is the invariant.

### 4. Link rewriting

Every link in the Manual falls into one of these classes, and the generator
resolves each at generation time:

| Link shape in source | Resolves to |
| --- | --- |
| `./N-chapter.md` (± `#anchor`) | In-app chapter route under `/admin/help` |
| `./README.md` (± `#anchor`) | `/admin/help` itself, which **renders the README** — see below |
| Any other repo-relative path (`../ai-context/*.md`, `../ADMIN_FIELD_REFERENCE.md`, `../SENTRY.md`, `../tests/TESTING.md`, `../engineering/*.md`, and bare directories like `../ai-context/`) | GitHub URL at a pinned ref, opened in a new tab |
| Absolute `http(s)://` | Unchanged, new tab |
| Bare `#anchor` | In-page anchor |

Invariants:

- **Every relative link resolves to something.** A link the generator cannot
  classify is a **generation error**, not a silently-passed-through href. The
  failure this prevents is a dead in-app link that looks live — the class of
  bug `check:docs` exists to prevent on the GitHub side, and which would
  otherwise reappear untested on the in-app side.
- **Fragments resolve too, not just files** (Codex round 1). Classifying a
  link by target *shape* leaves the `#anchor` unchecked, and
  `check-docs-accuracy.mjs:140` strips the fragment (`m[1].split("#")[0]`)
  before testing existence — so today **nothing anywhere** verifies that a
  Manual link's anchor points at a real heading. Renaming a heading therefore
  breaks every incoming link silently, in-app and on GitHub alike, under fully
  green CI.

  **Invariant: every fragment whose target file is in this repository must
  resolve to a real heading in that file, or generation fails.** That covers
  both intra-Manual links and the repo-relative off-Manual ones
  (`../ai-context/*.md` and friends) — the files are all present at generation
  time, so there is no reason to check one and not the other. Only fragments on
  absolute `http(s)://` links are out of reach and stay unchecked.

- **Fragments are validated against the RENDERED destination, not the source
  file** (Codex round 2). These coincide for chapters and diverge everywhere
  else, which is how the round-1 invariant above could pass while an in-app
  link still landed nowhere: a `#anchor` can be perfectly valid in the source
  markdown and absent from whatever the app actually renders for that target.
  Validating the source proves the *author* wrote a real reference; only
  validating the destination proves the *admin* arrives somewhere.

  **Corollary — every in-app link target must have a rendered destination that
  preserves that document's headings.** A source document rewritten to an
  in-app route without being rendered anywhere is a generation error, not a
  link that merely looks odd.

  This is deliberately **wider than the two instances Codex cited**, because
  the class is wider: a sweep of `docs/manual/` finds **222 fragment links, of
  which only 4 are intra-Manual and 218 are off-Manual** (overwhelmingly
  `glossary.md` term anchors). Fixing only the intra-Manual case would have
  addressed under 2% of the class and left the Manual's most-used link shape
  exactly as unprotected as before.

  **The same sweep finds 0 currently broken**, so this invariant is adoptable
  immediately at zero cost — it clears no backlog of pre-existing breakage and
  blocks nothing. Anchor computation must match GitHub's own algorithm, which
  preserves underscores; a checker that drops them reports false breakage on
  headings containing identifiers like `parent_id`.
- **GitHub links point at `main`, not at a commit sha**, so a link followed six
  months later shows current truth rather than a snapshot. (`check:docs`
  already guarantees these paths exist on `main`.)
- **Off-Manual links are visibly external** — an admin should know before
  clicking that they are leaving the console for GitHub.
- The generator's classification is by **link target shape only**. It never
  needs the Manual to adopt a new link convention, per *Must Not Change* #2.

### 5. Search

Client-side, over an index built in the same generation pass.

Invariants:

- **The index is derived from the generated content**, never from a second read
  of `docs/manual/` — one pass, one truth.
- **A result identifies the chapter and section it came from and links to that
  anchor.** A hit that only names a chapter makes search useless for the
  161 KB case it exists to serve.
- **The index must not load with the main admin bundle** — same reasoning as
  the content itself.
- Ranking quality is not specified here. It is observable, tunable, and
  cheaply fixed; the plan constrains where the index comes from, not how it
  scores.

### 6. The per-screen `?` map

A single table mapping admin route → help target (chapter, optionally a
section anchor). `AdminLayout` renders a `?` control in the header, which
deep-links to that target.

**Invariants, both of which need a test because nothing else catches them:**

- **Completeness** — every admin nav route has a help target. A nav item added
  later with no entry means a `?` that silently does nothing.
- **Resolvability** — every target names a chapter that exists and a section
  anchor that exists in it. This is the one that rots on its own: the Manual's
  own README notes that renaming a heading breaks every link into it, and that
  `check:docs` validates linked *files* but **not** anchors. A `?` pointing at
  a heading that was renamed six weeks ago is invisible until an admin clicks
  it.

**Proposed map — for David to react to.** Note #463 said 16 nav items; the
actual `NAV_ITEMS` list is **15**, which is what this map covers. The three
redirect routes (`/admin/comments`, `/admin/reviews` → moderation; `/admin/ai`
→ config) inherit their destination's target and need no entry.

| Admin screen | Help target |
| --- | --- |
| Dashboard (`/admin`) | Ch. 11 Admin Console (chapter top) |
| Facts | Ch. 2 Content Lifecycle |
| Users | Ch. 11 § Managing people |
| Moderation | Ch. 3 Moderation |
| Eval | Ch. 5 Visual Pipeline |
| Billing | Ch. 10 § For the admin |
| Refunds & Disputes | Ch. 10 § For the admin |
| Affiliate | Ch. 7 § Turning a meme into merch |
| Video Styles | Ch. 6 Meme and Video Studio |
| Engines | Ch. 11 § Tuning how the product behaves |
| Taxonomy Health | Ch. 4 § For the admin (Taxonomy Health) |
| Email Queue | Ch. 12 § Email, the most consequential rider |
| Queue Health | Ch. 12 § Worker liveness and the Queue Health surface |
| Features | Ch. 11 § Tuning how the product behaves |
| Configuration | Ch. 11 § Tuning how the product behaves |

**Two honest weaknesses in this map, surfaced rather than smoothed over:**

1. **Eval has no real home in the Manual.** No chapter describes the eval
   dashboard; Ch. 5 is the nearest neighbour because eval scores image-prompt
   attempts. This is a genuine documentation gap, not a mapping mistake. It is
   *not* fixed here — writing a new chapter section is `/document`'s job, and
   doing it inside this plan would be scope David hasn't agreed. Flagged as a
   follow-up.
2. **Engines, Features, and Configuration all land on the same section.** That
   is accurate to what the Manual currently says — Ch. 11 § *Tuning how the
   product behaves* covers all three together. It is honest, and it is a signal
   about chapter depth rather than about this feature.

## Data Model and Migration Impact

**None.** No schema change, no stored data, no backfill, no migration. The
feature reads committed files and ships static content.

## Runtime Behavior

- An admin opens `/admin/help` → chapter list plus search entry.
- Selecting a chapter navigates to its own URL; the sidebar shows Help active;
  the chapter's content loads as its own chunk.
- A section anchor scrolls to that section.
- Searching filters against the index; selecting a result navigates to the
  chapter and section.
- Clicking `?` on any admin screen navigates to that screen's mapped target.
- An intra-Manual link navigates in-app; an off-Manual link opens GitHub in a
  new tab.
- An unknown chapter slug (stale bookmark) renders a not-found state inside the
  console, with a route back to the chapter list.

**No async status surface applies.** Everything here is static content already
in the bundle; there is no job, no fetch, and nothing to report progress on —
so `docs/ai-context/async-ui-status.md` has no obligation to discharge. Stated
because its absence should read as a decision, not an omission.

## Admin/User UX Impact

- One new sidebar entry (Help), consistent with the existing pattern, collapsed
  and mobile-drawer behavior included.
- One new `?` control in the `AdminLayout` header, present on every admin
  screen.
- States: chapter list, chapter content, search-with-results, search-with-no-
  results, unknown-chapter. No loading state beyond the existing route-level
  Suspense fallback, and no error state beyond the existing boundary — the
  content is in the bundle.
- No moderation implications. No end-user-visible change of any kind.

## Security, Permissions, and Validation

- **No new privilege rail.** `/admin/help` renders inside `AdminLayout`, which
  performs the same `role === "admin"` gate as every other admin route. The
  frontend permission-chokepoint checker exempts that rail (#463), so no new
  tier or role comparison is introduced and no exemption needs widening.
- **No new server surface** — no route, no handler, no validation schema.
- **The one real security property is the no-executable-content invariant**
  above, enforced at generation. It matters because the content renders inside
  an authenticated admin session.
- **The admin gate governs the console surface, not the prose's
  confidentiality** (corrected after Codex round 1). An earlier draft of this
  plan promised that the console "must not become a second, unauthenticated way
  to read" the Manual. **That promise was unenforceable and is withdrawn.**
  `/admin/help`'s content ships as a lazy-loaded static chunk, exactly like
  every other admin route's chunk; a static asset is served to whoever requests
  its URL, and `AdminLayout`'s `role === "admin"` check runs only *after* that
  JavaScript has been fetched and executed. No client-side gate can change
  that, and no gate was ever going to.

  **The correct statement of the property:** the admin gate controls who sees
  the *console surface* — the nav entry, the `?` controls, the rendered
  reading experience. It does not, and is not claimed to, control who can
  retrieve the underlying prose.

  **The enforceable invariant that replaces it: the generator's only input is
  `docs/manual/`.** Every byte of that directory is already published on a
  public GitHub repository, so nothing non-public can enter a
  publicly-fetchable asset — guaranteed by the generator's input boundary
  rather than by a runtime check that cannot work. The exposure delta of this
  feature is therefore **zero**: it re-serves already-public prose from a
  second public location.

  **Why this is not a decision for David.** Codex raised it as a product fork —
  accept public asset-level retrieval, or drop the no-backend decision. The
  second branch is vacuous: adding a backend to authenticate access to text
  that David has already published on a public repo protects nothing, at the
  cost of a settled decision (#463 decision 4). A fork with one empty branch is
  not a fork, so this resolves as a correction to the plan's wording rather
  than an escalation. Recorded here so the reasoning is auditable rather than
  silently applied.

## Testing Plan

Automated, with the runner each belongs to:

1. **Generator determinism** — two runs byte-identical. (Frontend Test suite,
   mirroring `fieldDocs.test.ts`.)
2. **Artifact freshness** — the committed artifact matches a fresh generation.
   **Runs in the always-on Build job**, per the invariant above, so a
   chapter-only PR cannot skip it.
3. **Link classification** — every relative link in every chapter classifies
   into a known class; an unclassifiable link fails. Proves the general
   invariant, not a sampled set, by running over the real Manual.
3a. **Fragment resolvability** — every `#anchor` on a repo-resolvable link
   points at a real heading in its target file. Runs over the real Manual (222
   fragment links today), so it proves the class rather than a sample. Negative
   case: renaming a referenced heading without updating its incoming link must
   fail the gate. The anchor algorithm must match GitHub's, underscores
   included — a checker that drops them reports false breakage.
3b. **Chapter-number agreement** — contents-table ordinal, filename prefix,
   `# Chapter N` heading, and the previous chapter's `**Next:** chapter N`
   footer all agree. Negative case: changing only a table row's number or
   position must fail Build after regeneration.
4. **No executable content** — asserted over the generated artifact, negative
   cases included (a fixture chapter containing `<script>`, an `onclick=`
   attribute, and a `javascript:` href must each fail generation).
5. **`?` map completeness** — every `NAV_ITEMS` route has a target; a nav item
   with no entry fails.
6. **`?` map resolvability** — every target's chapter and section anchor exist
   in the source Manual. This is the anchor check `check:docs` explicitly does
   not do.
7. **Contents-table agreement** — a chapter on disk but not in the README
   table, or vice versa, fails generation.
8. **Route smoke** — `/admin/help` added to `routeLoadSmoke.spec.ts`, which is
   the existing net for the lazy-chunk failure class.
9. **Fragment landing** — end-to-end, because this is a render-timing property
   that unit tests cannot observe. All three entry paths assert the heading is
   actually in view *after* Suspense resolves: a cold-loaded bookmarked
   `/admin/help/:chapter#section`, a cross-chapter link that loads a new chunk,
   and a same-page anchor. A test that only asserts the `id` exists would pass
   against the broken implementation, which is the whole point.
10. **Rendered-destination resolvability** — every in-app link target renders
    somewhere, and its fragments resolve against that rendering. Negative case:
    an in-app-classified link whose target has no rendered destination must
    fail generation.

Manual QA belongs in the UAT doc at PR time, not here.

## Implementation Steps

Ordered smallest-coherent-change first; each leaves the tree green.

1. Add the generator's dev-time toolchain as a **devDependency of the frontend
   workspace only**, and confirm nothing new reaches the client bundle.
2. Write the generator: read chapters, order from the contents table, convert,
   rewrite links, build the search index, then assert its four properties —
   no-executable-content, link classification, fragment resolvability, and
   chapter-number agreement across all four representations — and write the
   committed artifact. Add the `generate:help` script.
3. Add the freshness + determinism gates, with the freshness gate wired into
   the always-on Build job.
4. Add the `/admin/help` route, chapter rendering, sidebar entry, and
   not-found state.
5. Add search over the generated index.
6. Add the `?` map, the header control, and the two map tests.
7. Add `/admin/help` to the route-load smoke spec.
8. `/simplify` pass, then open the PR with the plan's oracle sections and a
   UAT doc.

## Risks and Mitigations

| Risk | Mitigation |
| --- | --- |
| **Stale artifact merges green** on a chapter-only PR, because `docs/**` is inert. | The freshness gate runs in the always-on Build job, not the path-gated suites. This is the plan's core CI invariant. |
| **Generated markup executes script** in an authenticated admin session. | Raw-HTML passthrough disabled; generator asserts its own output and fails generation. Enforced for future chapters, not just today's. |
| **`?` links rot** when a heading is renamed — invisible until clicked. | Resolvability test over the real Manual; renaming a heading fails CI, which is what `check:docs` cannot do for anchors. |
| **Any Manual link's anchor rots** the same way — 222 fragment links, none checked by anything today (Codex round 1). | Generation validates every repo-resolvable fragment, not just `?` map entries. Sweep confirms 0 currently broken, so this costs nothing to adopt. |
| **Chapter numbering forks** — table reordered without touching filenames, headings, or `**Next:**` footers (Codex round 1). | Generation fails unless all four representations agree. The Manual's README asked for exactly this check. |
| **Deep links silently do nothing** — correct anchor, correct `id`, no scroll, because the chunk mounts after the browser processes the fragment and the scroll container is not the window (Codex round 2). | Fragment navigation specified as an explicit post-mount mechanism against the real container, with an e2e test across all three entry paths. A unit test asserting the `id` exists would pass against the broken build. |
| **An in-app link points at a document nothing renders** (Codex round 2). | Every in-app link target must have a rendered destination, and fragments validate against that destination rather than the source file. |
| **Bundle regression** on admin screens unrelated to help. | Content and index kept out of the main and existing admin chunks. |
| **A chapter renumber breaks bookmarks.** | Accepted. Renumbering is already a deliberate multi-file act per the Manual's rules, and it is rare. Not worth a redirect table for an admin-only surface — flagged so the acceptance is explicit rather than an oversight. |
| **New markdown constructs in future chapters** render badly or not at all. | The generator errors on what it cannot classify rather than passing it through; a future chapter using something unsupported fails CI rather than shipping broken. |
| **Eval's missing chapter coverage** makes one `?` link unsatisfying. | Named above as a follow-up for `/document`, deliberately not absorbed into this plan's scope. |

## External-Claim Verification

**Not applicable.** This plan makes no external API, SDK, model, pricing, or
rate-limit claim. Every constraint it relies on was verified against this
repository at the paths cited in *Repo Context Inspected*. The one dependency
decision (a markdown toolchain as a frontend devDependency) is deliberately not
pinned to a named package here — that is implementation, and the invariant this
plan owns is "nothing new in the client bundle," which the build verifies.

## Questions for David

**One**, and it is a reaction rather than a blocker:

1. **The `?` map above** — does each admin screen point where you would expect?
   The two spots I would most expect you to want changed are **Eval** (no
   Manual coverage exists; it currently points at Ch. 5 Visual Pipeline as the
   nearest neighbour) and **Engines / Features / Configuration** (all three
   land on Ch. 11 § *Tuning how the product behaves*, which is genuinely what
   the Manual covers them under).

Everything else the repo answered, and those resolutions are recorded above
rather than raised here.

## Definition of Done

- [ ] `/admin/help` renders every Manual chapter inside the admin console, at a
      bookmarkable per-chapter URL, with section anchors that land.
- [ ] Search returns chapter + section hits across the whole Manual and links
      to them.
- [ ] Every admin screen has a `?` that lands on a real chapter and a real
      section.
- [ ] Intra-Manual links navigate in-app; off-Manual links open GitHub in a new
      tab; no relative link is dead.
- [ ] A cold-loaded bookmarked `/admin/help/:chapter#section` lands on that
      heading after the chunk mounts — not merely renders an element with that
      `id`. Same for a cross-chapter link and a same-page anchor.
- [ ] `/admin/help` renders the README, and `./README.md#contents` from
      chapter 12 lands on its contents section.
- [ ] Renaming a heading that an existing Manual link points at fails
      generation — verified deliberately against a real anchor, not assumed.
- [ ] Renumbering a chapter in the contents table without updating its file,
      heading, and the preceding `**Next:**` footer fails Build.
- [ ] Editing a chapter and pushing **without** regenerating fails CI in the
      always-on Build job — verified deliberately, not assumed.
- [ ] The generated artifact contains no executable content, proven by negative
      fixtures.
- [ ] `docs/manual/*.md` are unchanged by this work, and the Manual still
      renders correctly on GitHub.
- [ ] No new backend route, no schema change, no new privilege rail.
- [ ] Admin screens unrelated to help load no additional help content.
- [ ] The behavior can be exercised in the product: an admin clicks `?` on
      Taxonomy Health and lands on Ch. 4 § *For the admin*.

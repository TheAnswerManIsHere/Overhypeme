# Admin Console

> A map of the admin console: every page, what it's for, and where the
> real depth already lives. **This is a tour, not a deep dive** — fact
> moderation is [`moderation-workflow.md`](./moderation-workflow.md) /
> [`content-lifecycle.md`](../manual/content-lifecycle.md); comment
> moderation, ratings, and hearts are
> [`community-and-engagement.md`](./community-and-engagement.md); admin
> role grants, reinstatement, and soft/hard user delete are
> [`accounts-and-auth.md`](./accounts-and-auth.md); the entitlement model
> is [`membership-entitlements.md`](./membership-entitlements.md);
> enrichment/taxonomy admin review is
> [`taxonomy-and-enrichment.md`](./taxonomy-and-enrichment.md). This spec
> only covers what those don't: the rest of the console, and how access
> to it works at the UI level. Primary code:
> `artifacts/overhype-me/src/pages/admin/*`,
> `artifacts/overhype-me/src/components/admin/AdminLayout.tsx`.

## Page inventory

Mounted routes, from `App.tsx` and `AdminLayout.tsx`'s 14 `NAV_ITEMS`:

| Route | File | What it's for |
| --- | --- | --- |
| `/admin` | `index.tsx` | Dashboard: fact/user counts, a real route-visit-count leaderboard (`GET /admin/route-stats`), quick links, Sentry diagnostic triggers. |
| `/admin/facts` | `facts.tsx` | Broad fact browse/search/edit/delete + bulk import + enrichment backfill — see below. |
| `/admin/users` | `users.tsx` | User browse/search + everything not already covered in `accounts-and-auth.md` — see below. |
| `/admin/billing` | `billing.tsx` | Stripe config/plan summary, live-mode toggle, test-event trigger, price-sync status. |
| `/admin/refunds-disputes` | `refundsDisputes.tsx` | Refund/dispute event log plus a manual grace-sweep trigger. |
| `/admin/moderation` | `moderation.tsx` | Fact review queue (covered elsewhere) **plus** an embedded comment-review panel — see *Dead and misleading surfaces*. |
| `/admin/eval` | `evalDashboard.tsx` | Render-quality eval dashboard: golden fact set, cost-confirmed eval runs, per-render rating, run-vs-run comparison. |
| `/admin/affiliate` | `affiliate.tsx` | The Zazzle click-through stats page, already documented in [`public-site-and-sharing.md`](./public-site-and-sharing.md). |
| `/admin/video-styles` | `videoStyles.tsx` | CRUD for video-builder motion styles (prompt text + optional preview). |
| `/admin/config` | `config.tsx` | The generic `admin_config` key/value editor — see *Config surfaces*. |
| `/admin/engines` | `engines.tsx` | The AI engine catalogue: per-engine model id, durations, resolutions, params. |
| `/admin/taxonomy-health` | `taxonomy-health.tsx` | Covered in [`taxonomy-and-enrichment.md`](./taxonomy-and-enrichment.md). |
| `/admin/features` | `features.tsx` | The tier × feature-flag permission matrix — see *Config surfaces*. |
| `/admin/email-queue` | `emailQueue.tsx` | Outbound transactional-email outbox: pending/failed rows, retry, requeue. |
| `/admin/queue-health` | `queueHealth.tsx` | Background job-queue infra dashboard: per-queue/lane status counts, oldest-pending age, per-item drill-in. |

`/admin/comments` and `/admin/ai` are routed to redirect components
(`AdminModerationRedirect`, `AdminAIRedirect`) rather than to the
`comments.tsx`/`ai.tsx` files that still exist on disk — see *Dead and
misleading surfaces* below.

## Admin access at the UI level

No separate admin login — admins sign in through the normal auth flow
(mechanics in [`accounts-and-auth.md`](./accounts-and-auth.md)).
`AdminLayout` itself gates on the frontend `role`, showing an
"Access Denied" panel with first-time-setup guidance (pointing at
`ADMIN_USER_IDS`) otherwise. Nav is a persistent collapsible sidebar
(collapse state in `localStorage`) plus a separate mobile drawer; one nav
item ("Moderation") carries a live badge summing the fact-review count
and the pending-comment count. Header has a "View Site" link back to the
public app and sign-out. **The admin "view as user" toggle does not live
in this component** — that's the `isAdmin`/impersonation mechanic
documented in `accounts-and-auth.md`.

## Config surfaces

Two distinct pages, not one:

- **`/admin/config`** — the generic `admin_config` key/value editor,
  grouped into cards: Budget (per-tier AI spend), Limits (image/meme/
  gallery caps), Email (sender, retry, retention), Zazzle (affiliate
  params), Moderation (duplicate-detection threshold), plus a generic
  catch-all and a nested AI-settings group (system prompts, gallery
  display limit). A global Debug-Mode toggle swaps every key to its
  debug value set.
- **`/admin/features`** — the tier × feature-flag matrix
  (`unregistered/registered/legendary/admin` × feature keys). Confirmed
  actually read by `tierFeatures.ts` and consumed in `memes.ts`,
  `videos.ts`, `render.ts`, `facts.ts`, `videoJobs.ts` — this one is
  genuinely wired end to end, unlike some of the findings below.

**A subtle, currently-live "looks editable but isn't" gap:** five seeded
NCMEC-related `admin_config` keys (CyberTipline filing config) reject
writes with a 403 (`isNcmecReservedConfigKey`, gated because
`submitNcmecReport()` is still a stub with no live filing worker — see
`architecture-map.md`), but they render through the exact same generic
config card as everything else, with nothing in the UI distinguishing
them from the three adjacent, genuinely-editable keys in the same
conceptual group. There's no dedicated safety/legal config page — these
keys are only reachable via the generic `/admin/config` list.

## User management (beyond accounts-and-auth.md)

`accounts-and-auth.md` covers soft/hard delete, reinstatement, and role
grants. `/admin/users` additionally provides: search + pagination + an
inactive-users filter; a per-user membership panel (tier, source —
Stripe vs. admin grant — and grant metadata); a manual **lifetime
membership grant/revoke** action, independent of any Stripe event; manual
email-verification; and an "Add User" form for direct account creation
with an initial password and tier.

## Content management (beyond fact/comment moderation)

**Facts:** `/admin/facts` is the broader "all facts" surface — search,
an active/inactive/both filter, taxonomy-override and
needs-review quick filters, a full per-fact edit panel (text, taxonomy
fields), a "Resubmit for Moderation" action that puts a fact back through
the review pipeline, and soft/hard delete. A separate Utilities tab
handles bulk import (paste, file upload, several formats) and triggers a
background enrichment-backfill job for previously unenriched facts.

**Memes:** **there is no dedicated "all memes" browse/edit admin page.**
The only meme-facing admin surfaces are the Visual Concept flow (covered
elsewhere) and the legal/safety quarantine path, which currently has no
purpose-built UI of its own — access is config-only, through the generic
`admin_config` editor above.

## Analytics and stats surfaces

Beyond the already-documented affiliate stats page: the dashboard
(`/admin`) itself is a light analytics surface (counts + a genuinely-wired
route-visit leaderboard with real time-range options — unlike the
non-functional Top-Facts time filters documented in
[`public-site-and-sharing.md`](./public-site-and-sharing.md)); the eval
dashboard (`/admin/eval`, render-quality metrics, run-vs-run diffing);
queue health (`/admin/queue-health`, job-infra throughput); and refunds/
disputes (`/admin/refunds-disputes`, an event log, not aggregate revenue
analytics). There is no dedicated growth or aggregate-revenue dashboard
beyond what the billing page's plan/price summary shows.

## The generated Admin Field Reference — narrow scope

[`ADMIN_FIELD_REFERENCE.md`](../ADMIN_FIELD_REFERENCE.md) is generated
from the in-app field-documentation registry
(`components/admin/fieldDocs/`), with a CI test enforcing it isn't stale.
**Its scope is narrow: the Enrichment Editor's fields only** (AI Visual
Classification, Visual Strategy Override, References & Scene Entities) —
used in moderation Step 2 → Advanced Options and in Admin → Facts. **It
is not a general admin field index** — config, engines, users, billing,
and every other page's fields aren't covered by it.

## Dead and misleading surfaces

- **`comments.tsx` is dead, duplicated code.** `/admin/comments` routes
  to a redirect (`AdminModerationRedirect` → `/admin/moderation`), never
  to this file. `moderation.tsx` contains its own fully-functional
  comment-review panel, hitting the identical endpoints — functionally
  near-identical to the orphaned file. Not linked from the nav.
- **`ai.tsx` is dead code left behind by a completed migration.**
  `/admin/ai` routes to a redirect (`AdminAIRedirect` → `/admin/config`).
  The file's own header comment documents that its content was
  superseded by `/admin/engines` and the `look_styles` table — the file
  itself was just never removed. Not linked from the nav.
- **`architecture-map.md`'s admin page inventory is stale relative to
  actual routing** — it lists "Comments" and "AI Settings" as if they're
  separate reachable pages (they're the two dead files above), while
  omitting Eval and Queue Health, which *are* live, nav-linked pages.
  Corrected in the same PR that adds this spec.
- **The "Flagged comments" tab's own UI copy is misleading, corroborating
  a gap already documented in
  [`community-and-engagement.md`](./community-and-engagement.md).** Its
  copy describes flagged comments as ones "later flagged by AI for spam
  or abuse," but `moderateComment()` (the LLM-based comment classifier)
  is never called anywhere in the codebase — the only live path that
  sets `flagged: true` is an admin's own manual reject action. Not a new
  finding — cited here because it directly explains why this admin tab's
  own description doesn't match what actually populates it.

## Files to inspect before admin-console work

- `artifacts/overhype-me/src/components/admin/AdminLayout.tsx` — nav,
  access gating, the badge-count logic.
- `artifacts/overhype-me/src/pages/admin/*.tsx` — one file per page
  (see inventory above); `comments.tsx` and `ai.tsx` are dead, don't
  extend them expecting them to be reachable.
- `artifacts/overhype-me/src/pages/admin/_configShared.tsx` — the
  shared hook/context behind `config.tsx`.
- `artifacts/api-server/src/routes/admin.ts` — the backend surface
  behind nearly every page above.
- `artifacts/api-server/src/__tests__/routes.admin.auth.test.ts` — a
  drift-protection test that introspects the admin router and asserts
  its own route list matches every registered `/admin/*` route; the
  authoritative backend-side enumeration if this doc ever drifts.
- `docs/ADMIN_FIELD_REFERENCE.md` — generated, enrichment-fields-only,
  never hand-edited.
- For the flows this spec deliberately doesn't cover:
  [`moderation-workflow.md`](./moderation-workflow.md),
  [`community-and-engagement.md`](./community-and-engagement.md),
  [`accounts-and-auth.md`](./accounts-and-auth.md),
  [`membership-entitlements.md`](./membership-entitlements.md),
  [`taxonomy-and-enrichment.md`](./taxonomy-and-enrichment.md).

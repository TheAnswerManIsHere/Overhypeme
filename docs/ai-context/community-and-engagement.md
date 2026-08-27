# Community and Engagement

> Ratings, comments, comment/meme hearts, and the activity feed — how
> people react to content and see the status of their own contributions.
> **Not the fact moderation pipeline** (triage → enrich → activate) — see
> [`2-content-lifecycle.md`](../manual/2-content-lifecycle.md) and
> [`moderation-workflow.md`](./moderation-workflow.md) for that; comments
> have their own, much simpler moderation queue, documented here. Primary
> code: `artifacts/api-server/src/lib/reactions.ts` (ratings + hearts, the
> shared mechanism), `artifacts/api-server/src/routes/facts.ts` (rating,
> comment create/list, comment heart), `artifacts/api-server/src/routes/memes.ts`
> (meme heart), `artifacts/api-server/src/routes/reviews.ts` (activity
> feed — despite the filename), `artifacts/api-server/src/routes/admin.ts`
> (comment moderation queue).

## Ratings

`POST /facts/:factId/rating` (`facts.ts:390-405`, auth required, 404 if
the fact isn't active) — **thumbs up/down/none, not a scale.**
`RateFactBody.rating` is `"up" | "down" | "none"`
(`lib/api-zod/src/generated/api.ts:310-312`). Delegates to
`setFactRating()` (`reactions.ts:69-120`).

**Upsert, not multi-rate — at most one active rating per user per
fact.** `"none"` deletes the user's rating row; `"up"`/`"down"` deletes
any opposing rating first, then inserts (`.onConflictDoNothing()` against
the unique `(userId, targetType, targetId, reactionType)` index,
`lib/db/src/schema/reactions.ts:23`). The frontend implements toggle
semantics on top of this: clicking your existing rating again sends
`"none"` (removes it); clicking the other one flips it
(`FactActionCluster.tsx:85-90`) — there's no separate "remove rating" UI
element, it's the same toggle-pill.

**`wilsonScore` is computed inline, in the same transaction as every
rating write — not by a batch job.** `computeWilsonScore(upvotes,
downvotes)` (`reactions.ts:12-20`, standard 95% Wilson lower-bound,
`z=1.96`) runs inside `refreshTargetCounts(tx, "fact", targetId)`
(`reactions.ts:29-44`), called from within `setFactRating`'s own
transaction (`reactions.ts:99`) — it recomputes `upvotes`, `downvotes`,
`score`, and `wilsonScore` from a live count over the `reactions` table
and writes all four onto `factsTable`. The only scheduled job touching
this is a one-time boot-time backfill (`backfillWilsonScores()`,
`lib/seed.ts:710-747`, fired at `index.ts:411`) that only fixes legacy
rows where `wilsonScore === 0 && upvotes+downvotes > 0` — a
migration-safety net, not an ongoing recompute. `wilsonScore` feeds Home's
hero weighting, the Leaderboard sort, and the related-facts tiebreak —
**not Search**, which hardcodes `sort:"newest"` regardless of rating
(`Search.tsx:25-29`) — all documented in
[`public-site-and-sharing.md`](./public-site-and-sharing.md), not
re-derived here.

**A legacy `ratingsTable` still exists in the schema but is dead at the
route level** (`lib/db/src/schema/ratings.ts`) — fully superseded by the
polymorphic `reactions` table; nothing writes to it anymore except a
reseed script's cleanup delete.

## Comments

**Create:** `POST /facts/:factId/comments` (`facts.ts:454-508`, auth
required). Body requires `text` and a `captchaToken`
(`AddCommentBody`, `lib/api-zod/src/generated/api.ts:370-375`).

**CAPTCHA is required by default**, verified via `verifyCaptcha()`
(`facts.ts:474-479`) — bypassed only for admin/Legendary or accounts with
the `comment_captcha_bypass` tier feature (`facts.ts:470-472`). **No
route-level rate limiter** on comment creation (unlike fact-sharing,
which has `checkSharedRateLimit`) and no pending-count cap analogous to
fact submission's.

**Every new comment inserts as `status: "pending"` — always requires
moderator approval, never auto-approved** (`facts.ts:481`). On insert:
`logActivity({actionType:"comment_posted", ...})` to the author's own
feed, and `notifyAdmins({type:"comment", ...})` emails every
notification-opted-in admin (`facts.ts:483-497`). Response includes
`pending: true` so the client can show an awaiting-moderation state
immediately.

**Authorship is always a real account.** `authorId` is hard-set from
`req.user.id` on the one and only comment-insert route; the column is
nullable and the admin UI defensively renders "Anonymous" for a null
value, but no live code path produces one.

**List:** `GET /facts/:factId/comments` (`facts.ts:408-451`) returns only
`status:"approved" && flagged:false` — pending/rejected/flagged comments
never appear publicly. `sort` is `"top"` (default,
`desc(heartCount), desc(createdAt)`) or `"new"`. Standard limit/offset
pagination.

**No self-service edit or delete.** Grep of every route confirms no
`PUT`/`PATCH`/`DELETE /comments/:id` reachable by a non-admin — once
posted, a comment can't be edited or withdrawn by its author.

**Comment moderation is human-only, admin-initiated — not the fact
pipeline, and not AI-assisted despite dead code suggesting otherwise.**
`GET /admin/comments/pending` feeds the live moderation queue.
**`GET /admin/comments/flagged` (`admin.ts:2192-2205`), by contrast, is
unreachable in practice** — it selects rows where `status:"approved" &&
flagged:true`, but neither live status-changing action produces that
combination: `approve()` sets `approved` with `flagged:false`
(`admin.ts:2237`), and `reject()` sets `flagged:true` but with
`status:"rejected"`, not `"approved"` (`admin.ts:2266`). The only thing
that could have produced an approved-and-flagged row is the AI
`moderateComment` detector below, which has no caller. This "Flagged"
admin tab is dead UI over an empty, unreachable query, not a working
parallel queue to "Pending."
`POST /admin/comments/:id/approve` (`admin.ts:2229-2253`) flips to
approved, clears `flagged`, increments `factsTable.commentCount`, and
notifies the author via `logActivity`; `POST /admin/comments/:id/reject`
(`admin.ts:2256-2285`) sets rejected+flagged with an optional admin note,
decrements the count if it had been approved, and notifies the author.
**There is no user-facing "report this comment" route** — a comment is
only ever flagged by an admin action.

**Dead code: `moderateComment` (an LLM-based spam/abuse detector,
`routes/ai.ts:121-164`) is fully implemented and imported into
`facts.ts:3` but never called anywhere** — comments get zero AI
pre-screening in practice; every flag/approve/reject is a human admin
action. `checkDuplicateInternal`, imported alongside it, is similarly
unused within `facts.ts` (its real caller is the unrelated
`/ai/check-duplicate` fact-submission route).

## Hearts — one shared mechanism for memes and comments

`toggleHeart(userId, targetType, targetId)` (`reactions.ts:126-172`),
type-constrained to `"meme" | "comment"` only — **not** "similarly named
but separately implemented": both are backed by the exact same
polymorphic `reactions` table (`lib/db/src/schema/reactions.ts:12-27`,
its own doc comment: "sole home for new meme/comment heart reactions"),
the same toggle function, and the same unique index. Toggling deletes an
existing `(userId, targetType, targetId, "heart")` row or inserts one,
then recomputes and writes the denormalized `heartCount` onto
`memesTable` or `commentsTable` via the same `refreshTargetCounts()` used
for ratings. Both routes return the identical shape,
`{heartCount, viewerHasHearted}`.

- **Comment heart:** `POST /comments/:id/heart` (`facts.ts:511-524`) —
  auth required, requires the comment to be `approved && !flagged`
  before allowing a toggle.
- **Meme heart:** `POST /memes/:id/heart` (`memes.ts:533-546`) — auth
  required, checks existence/`deletedAt` only. **Does not call
  `canViewMeme()`** — the one known gap in this mechanism, already
  tracked as [GitHub #375](https://github.com/TheAnswerManIsHere/Overhypeme/issues/375)
  and documented in
  [`public-site-and-sharing.md`](./public-site-and-sharing.md#profiles-and-library--the-self-view-split);
  not re-derived here. Comments have no equivalent gap — they have no
  private/public visibility concept to enforce, only `status`/`flagged`.

## Activity feed

`GET /activity-feed` and `POST /activity-feed/mark-read`
(`routes/reviews.ts:1922-1953` — lives in `reviews.ts`, not a
dedicated file). Both `requireAuth`; every query filters to the caller's
own `userId`.

**This is strictly "status of my own content," not a broader site
feed of everyone's activity.** Every entry concerns the *viewer's own*
submission or comment — but that's not the same as "the viewer's own
action." For the moderation-outcome events, an admin is the one who
acted (approving/rejecting), and the entry is logged under the content's
author, not the admin who took the action — e.g.
`logActivity({userId: current.authorId, actionType:"comment_approved",
...})` inside the admin approve route (`admin.ts:2244-2250`), same
pattern for `reviews.ts:809-815`'s fact-approval event. So the real
invariant is "every entry is about the viewer's own content," not
"every entry records something the viewer personally did" — what's
still true is that no entry is ever about a *reaction* someone else gave
to your content (see below). Confirmed live call sites (grep across the
whole repo for `logActivity(`):
`review_submitted`, `review_approved`, `review_rejected` (fact review
lifecycle), `comment_posted`, `comment_approved`, `comment_rejected`
(comment lifecycle). **Five declared `ActivityType` members are never
triggered in production:** `fact_submitted`, `fact_approved`,
`duplicate_flagged`, `vote_cast`, `system_message` — each has full
icon/label UI treatment in `ActivityFeed.tsx` but no production call
site logs them; they appear only in test fixtures. **Ratings and hearts
never produce any activity-feed entry at all** — there is no "someone
hearted your meme" or "your fact got upvoted" notification, despite the
unused `vote_cast` type suggesting one may have been planned.

**Pagination is real, page-based — a confirmed exception to the "no
pagination on the public site" pattern** documented in
[`public-site-and-sharing.md`](./public-site-and-sharing.md#home).
`page`/`limit` query params (clamped, default `limit:20`, max `50`),
`offset = (page-1)*limit`, response includes `{entries, total, unread,
page, limit}` (`reviews.ts:1922-1944`). Frontend drives it with real
prev/next controls off `totalPages = Math.ceil(total/limit)`.

## Files to inspect before community/engagement work

- `artifacts/api-server/src/lib/reactions.ts` — `computeWilsonScore`,
  `refreshTargetCounts`, `setFactRating`, `toggleHeart`: the shared
  mechanism behind ratings and both heart types.
- `artifacts/api-server/src/routes/facts.ts` — rating, comment
  create/list, comment heart.
- `artifacts/api-server/src/routes/memes.ts` — meme heart (and its
  known `canViewMeme()` gap, #375).
- `artifacts/api-server/src/routes/reviews.ts` — activity feed routes
  (despite the filename).
- `artifacts/api-server/src/routes/admin.ts` — comment
  approve/reject/pending/flagged queue.
- `artifacts/api-server/src/routes/ai.ts` — `moderateComment` (dead,
  never called), for context if ever wiring it up.
- `artifacts/api-server/src/lib/activity.ts` — `logActivity`,
  `ActivityType` union (including the five unused members).
- `lib/db/src/schema/reactions.ts` — the polymorphic table;
  `lib/db/src/schema/ratings.ts` — the dead legacy table, schema-only.
- Frontend: `components/facts/FactActionCluster.tsx` (rating pill),
  `components/comments/FactComments.tsx` + `CommentHeartButton.tsx`,
  `components/memes/MemeHeartButton.tsx`, `pages/ActivityFeed.tsx`,
  `pages/admin/comments.tsx`.
- Tests: `__tests__/routes.facts.test.ts` (rating, comment listing —
  comment *creation* and both heart routes have no dedicated test),
  `__tests__/activity.test.ts`, `__tests__/routes.reviews.test.ts`
  (activity feed).
- For fact-submission moderation (a different, AI-assisted pipeline
  comments don't share): [`2-content-lifecycle.md`](../manual/2-content-lifecycle.md),
  [`moderation-workflow.md`](./moderation-workflow.md).
- For what `wilsonScore` is used for downstream (search, leaderboard,
  hero): [`public-site-and-sharing.md`](./public-site-and-sharing.md).

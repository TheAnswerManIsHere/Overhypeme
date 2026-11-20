# Plan — Library: organised Submissions

```plan-oracle
# Scope of work — Library: organised Submissions

Agreed by David 2026-11-20 ("Approved") (his request, same date, verbatim): "We need to
better organize the Submissions section. There should be tabs below the
Submissions header that shows all the different types of submissions including
Facts, Comments, and anything else a user can submit that goes into moderation.
... Then in each tab we need sub tabs for the different dispositions including
Under Review, Approved and Live, and Declined. If there's any other
organization on that page that you thinks makes sense, please propose it too
such as filters, searching, etc. Try to make it as helpful and user friendly as
possible so a user really knows what's going on. I'm leaving it to you to
improve the UX rather than building only and exactly what I've told you to do."

## Direction served

The Library is the signed-in owner's own view of everything they made
(public-site-and-sharing.md). Every submission passes a human moderator before
it is visible; the submitter should always be able to see where each thing they
submitted stands and what happens next.

## Product intent for this increment

1. Inside the Library's Submissions tab, a row of type tabs: Facts and
   Comments, each with its true total. (Investigation found no third
   human-moderated submission type: memes are not human-approved before they
   show, external links carry no moderation status, support requests and bug
   reports are not moderated content.)
2. Inside each type, status tabs: Under Review, Approved & Live, Declined,
   each with its true count, and a fourth, No longer live, for approved
   content that has since been taken down, shown only when it has something in
   it (David, Q1: option 1, 2026-11-20). It opens on the status that most
   needs the person's attention.
3. Every submission appears in exactly one status. Today an approved fact
   shows twice: as an "APPROVED" card under the Under Review heading and again
   as a live fact.
4. Each status says in one plain line what it means and what happens next.
5. An Under Review fact shows how far it has got, in plain words, without
   exposing internal moderation step names.
6. A Declined item shows why: the reason and the team's note, for facts as
   today and for comments where a note exists.
7. A comment that was approved and later hidden is not shown as "Visible".
8. Search within the current type by wording (and by hashtag for facts), and
   a newest/oldest sort.
9. Counts and lists are complete. Today each list silently stops at 50 and
   the tab count is the sum of the capped lists. Long lists page with the
   Library's existing "Load more".
10. The selected type and status are in the page address, so a link or the
    back button returns to the same view.
11. A helpful empty state per status, and a layout that works on a phone.

## Must not change

- Only the owner sees their submissions; no other user's are ever shown.
- Moderation itself: what moderators see and do, the statuses, the emails.
- The other Library tabs.
- The wording of decline reasons and the team's note as moderators wrote them.
- An approved, live fact still renders as the full fact card (personalised
  wording, votes, comment count, link to the fact).

## Settled decisions

- Facts and comments each need a human approval before they are visible
  (glossary: Moderation workflow; Comment moderation).
- No rollout flag (agent-working-rules.md).

## Boundaries

- Now: items 1-11.
- Next (not in this increment): withdrawing a submission that is still under
  review; "edit and resubmit" from a declined fact; emails linking straight to
  the declined item; the same organisation for My Memes / My Images.
- Never (here): showing legal/safety quarantine decisions in this tab.

## Ceremony tier

product. One increment, one pull request. No sensitive subsystem; no schema
change expected.
```

## Problem

The Library's Submissions tab is one long list that misreports where things
stand. A fact that was approved shows twice: as an "APPROVED" card under the
"Under Review" heading and again as a live fact. Each of the three lists behind
the tab silently stops at 50 items and the number on the tab is the sum of
those capped lists. A comment that was approved and later hidden still reads
"Visible". Nothing says what a status means or what happens next.

## Direction

The Library is the owner's own view of everything they made
(`public-site-and-sharing.md`). This increment makes one thing true: a person
can see, for every fact and comment they submitted, exactly one current status,
what it means, and what happens next.

## Product Intent, Must Not Change, Settled Decisions

As in the oracle above, verbatim. Two settled decisions are added by
investigation:

- **Affected-surface inventory.** The class is "readers of the submitter's own
  submission lists". Oracle, run on the working tree at `cc51266`, 2026-11-20:
  `git grep -n "pendingSubmissions\|submittedFacts\|myComments" -- 'artifacts/**' 'lib/**' ':!**/generated/**'`
  returned `routes/users.ts` (the writer), `pages/Library.tsx` (the only
  reader), `openapi.yaml` (the contract) and two test files. So the Library is
  the only consumer.
- **"Deprecated means removed"** (`decisions.md`, 2026-11-17): once the Library
  reads the new source, the three profile fields are removed from the profile
  response and its contract, not left as a second, capped source of truth.

## Repo Context Inspected

`artifacts/overhype-me/src/pages/Library.tsx`,
`components/library/SubmissionReviewList.tsx` and its test,
`artifacts/api-server/src/routes/users.ts` (GET /users/me),
`routes/admin.ts` (comment approve/reject, flagged queue, fact deactivate),
`routes/facts.ts` (public comment reads), `routes/reviews.ts` (stage
transitions), `lib/db/src/schema/reviews.ts`, `comments.ts`, `facts.ts`,
`memes.ts`, `links.ts`, `supportRequests.ts`, migrations 0151 and 0152,
`lib/api-zod/src/moderationWorkflow.ts`, `lib/api-spec/openapi.yaml`
(UserProfile, PendingSubmission, MyComment),
`__tests__/routes.users.test.ts` (Issue #1057's tests),
`docs/ai-context/moderation-workflow.md` (banner), `glossary.md`,
`public-site-and-sharing.md`.

## Current Behavior

`GET /users/me` returns three independent lists, each `limit(50)`: active facts
the user submitted, every `pending_reviews` row they submitted whatever its
status, and every comment they wrote. `SubmissionReviewList` puts every review
that is not rejected under "Under Review", approved ones included. A review's
reason and note are withheld until it is rejected (Issue #1057). A comment's
label is derived from `status` alone, ignoring `flagged`, while the public
site shows a comment only when `status = 'approved' AND flagged = false`.

## Source-of-Truth Analysis

No new stored state. Status is derived, at read time, from what moderation
already writes:

| Concept | Source of truth |
| --- | --- |
| A fact was approved | `facts.approved_at IS NOT NULL` (set once, never cleared) |
| A fact is live | `facts.is_active` |
| A submission is in moderation, and how far | `pending_reviews.status = 'pending'`, `workflow_stage` |
| A submission was declined, and why | `pending_reviews.status = 'rejected'`, `reason`, `admin_note` |
| A comment's moderation state | `comments.status`, `comments.flagged` |
| A comment's decline note | `comments.flag_reason`, only when `status = 'rejected'` |

## Proposed Design

### One identity per submission (concern C2)

**Facts.** A fact submission is exactly one of:

- **a fact** the person submitted with `approved_at IS NOT NULL`, whatever
  reviews exist behind it (none for an imported fact, several for a fact with
  retained approval records); or
- **a review** the person submitted whose status is `pending` or `rejected`.

A review with status `approved` is never listed: the fact it produced is. A
staging fact (never approved) is never listed: its review is.

**Comments.** One comment is one submission.

### One classification, used by counts, search and lists alike

A single server-side definition maps each submission to one status. Counts,
search results and pages are all produced from that one definition, so they
cannot disagree.

| Status | Facts | Comments |
| --- | --- | --- |
| Under Review | review with status `pending` | status is neither `approved` nor `rejected`; or `approved` and `flagged` (hidden while it is looked at again) |
| Approved & Live | approved fact, active | `approved`, not flagged, on an active fact |
| Declined | review with status `rejected` | `rejected` |
| No longer live | approved fact, not active | `approved`, not flagged, on a fact that is not active |

The comment column is total by construction: the Under Review rule is written
as "everything else", so an unrecognised status string can never read as live.
(`comments.status` is an unconstrained varchar; the three values above are the
only ones the code writes: `git grep -n "status: \"" -- artifacts/api-server/src/routes/facts.ts artifacts/api-server/src/routes/admin.ts`.)

### A dedicated owner-scoped read

Two reads under `/users/me/submissions`, both requiring a session and both
filtered by the session's user id and nothing a caller supplies:

- **counts**: for each type, the number in each status; with a search term,
  also the number matching in each status.
- **list**: one type, one status, optional search term, newest or oldest,
  cursor-paged like the Library's other lists.

The three submission fields leave `GET /users/me` and its contract.

### What a card carries

- **Under Review fact**: wording as submitted, hashtags, submitted date, and a
  two-step progress line derived from `workflow_stage`: `triage` reads as
  waiting for a first look; `reading`, `gags` and `test_renders` read as
  passed the first look and being prepared. Neither promises publication. The
  stage name itself is not sent to the browser.
- **Declined fact**: wording, the reason's label, the team's note, dates.
  Reason and note are returned only for a rejected review.
- **Approved & Live fact**: the existing `FactCard`, unchanged.
- **No longer live fact**: the wording and a line saying it was approved and
  has since been taken down; no link to a page that no longer opens.
- **Comment**: the comment, the fact it is on (quoted), its date, a link to
  the fact only when the fact is live, the team's note only when declined.
  A flagged approved comment says it is hidden while it is looked at again.

### Ordering

Each list has one stable order, newest first by default, by the date that
status began: submitted date for Under Review and for comments, approval date
for Approved & Live and No longer live, decision date for Declined (submitted
date where no decision date was recorded).

### Search

Case-insensitive; for facts it looks at the saved wording and the hashtags
(with or without the leading `#`), for comments at the comment. Every word
typed must appear, in any order, so "lifts the moon" finds a fact saved as
`{NAME} {lifts|lift} the moon`. What it does not find is the personalised
part: the viewer's own name and pronouns are filled in when a card is shown
and are not in the saved wording (Q2). This is the same saved-wording matching
the public search uses. Totals on the
tabs do not change while searching; each status tab adds its match count
("2 of 7"), so a match in another status is visible without clicking through.
The search term survives switching status and is cleared by switching type.

## Data Model and Migration Impact

None. No schema change, no migration, no backfill. The existing indexes on
`pending_reviews.submitted_by_id` serve the review reads; whether the fact and
comment reads need an index is measured during the build with the plan's
largest realistic account (hundreds of items), and adding one would be a
migration under the migration ceremony, raised before it is written.

## Runtime Behavior

- **Opening status.** With no status in the address, the first status that
  has items, in this order: Under Review, Approved & Live, Declined, No longer
  live. Under Review's empty state shows only when the type has no
  submissions at all. A status named in the address is honoured even when
  empty. The opening type is Facts.
- **Address.** The Library tab, type, status, search term and sort are query
  parameters; changing type or status adds a history entry, typing in search
  does not.
- **No longer live** appears as a tab only when its count for that type is
  above zero, or when the address names it.
- **The Submissions tab's own number** is the total across both types, from
  the counts read.
- Taking a fact down keeps the fact and its comments (the admin action only
  deactivates; there is no fact deletion today), so both move to No longer
  live and nothing disappears from the owner's view.

## Admin/User UX Impact

No admin change. For the owner, per status: a one-line explanation under the
status tabs, a loading skeleton, an error state with retry, an empty state
(Under Review empty on Facts offers "Submit a fact"; a search with no matches
says so and offers to clear it), and "Load more". On a phone the two tab rows
scroll sideways like the Library's top row and the search and sort sit on one
line above the list. Built to `overhype-design` tokens. Copy is mine to draft
and David's to judge in UAT.

## Security, Permissions, and Validation

- Both reads return 401 without a session and select only rows whose
  submitter or author is the session user; no user id is accepted from the
  request.
- A pending review's `reason` and `admin_note` are a moderator's unsaved draft
  and are never returned (Issue #1057's boundary, carried to the new read).
  `production_rejection_note`, reviewer ids, enrichment and duplicate-check
  fields are never returned.
- A comment's `flag_reason` is returned only when the comment is rejected.
- Type, status, sort and cursor are validated by the generated request
  schemas; the search term is length-capped and its wildcard characters are
  matched literally.

## Testing Plan

Server (`pnpm --filter @workspace/api-server test`): the classification, as a
general property over generated mixes of records, not the screenshot's
example: every submission lands in exactly one status; counts equal the
lengths of the fully paged lists; an approved fact with zero, one and several
reviews counts once; an account with more than 50 in one status pages to the
end in both sort orders with no repeat and no gap, including items with
identical dates and ids whose order differs from the date order; search counts equal search
lists; another user's submissions never appear; a pending review exposes no
reason or note; a flagged approved comment is never Approved & Live; an
unrecognised comment status is Under Review. Issue #1057's two tests move to
the new read.

Frontend (`pnpm --filter @workspace/overhype-me test`): each card kind renders
its status truthfully; the opening-status rule, including a type whose only
items are No longer live; the tab for No longer live is
absent at zero.

Browser (`E2E Smoke`): type and status tabs switch, the address restores the
view on reload and on back, search narrows and shows match counts, "Load more"
reaches the end.

UAT, for David: whether the page tells him what is going on at a glance, the
wording of each status line and progress line, and the phone layout.

## Implementation Steps

1. The classification and the two reads, with the contract and generated
   clients, and their tests.
2. The Submissions panel: type tabs, status tabs, cards, search, sort,
   address state, states.
3. Remove the three profile fields, `SubmissionReviewList` and its test.
4. `/simplify`, the PR with its UAT section, review loop, close-out.

## Risks and Mitigations

- **A fact whose submitter differs between review and fact** would be counted
  under whichever record carries the user. The fact's submitter is the source
  for approved facts; the build checks the approval path copies it and the
  test database for any mismatch, and reports what it finds.
- **Search over saved wording** can surprise someone searching their own
  name (Q2). The no-matches state says names and pronouns are not searched.
- **Query cost** on a very large account: measured during the build, as above.

## Questions for David

Q1 was answered (option 1) with the scope.

**Q2. Should search also match the personalised wording shown on a card?**
Search finds words in a fact's saved wording and hashtags. Your own name and
pronouns, which are filled in when a card is shown, will not match.

1. Keep it to saved wording and hashtags for this increment, and say so when
   a search finds nothing. Simple, and the same as the public search.
2. Also match the personalised wording as displayed. Finds a copied phrase
   containing the name, at the cost of personalisation-aware filtering before
   paging: more to build and to get wrong.

Recommendation (mine and Astra's): 1.

## Definition of Done

- Every fact and comment the owner submitted appears in exactly one status,
  with true counts, in the running product.
- The duplicate "APPROVED under Under Review" cards are gone.
- An account with more than 50 submissions can reach all of them.
- Reloading or pressing back returns to the same type, status and search.
- CI green, Codex review returned and threads resolved, UAT section in the PR.

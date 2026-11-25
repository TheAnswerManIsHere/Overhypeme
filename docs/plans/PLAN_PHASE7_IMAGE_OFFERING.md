# Plan — Launch Phase 7: the image offering

Workstream: Issue #1289 (parent #628). Tier: product, standard loop; the
credit ledger and the Stripe increments are payment-sensitive and take the
migration review.

```plan-oracle
# Oracle — Launch Phase 7, the image offering

Scope of work agreed with David on 2026-11-25 (Issue #1289; parent #628). His
answers: "q1 1. q2 1. q3 1".

## Direction served

`docs/ai-context/product-strategy.md`, approved 2026-11-11: Overhype.me is
something you make about a friend and send to them. Credits make AI pictures;
one credit is one picture; credits never expire and there is one balance.
Anyone holding credits can make an AI picture. One free AI picture per verified
account. Every AI picture is of a real person or pet from the user's life, from
a photo the user supplies. The strategy wins over the older Phase 7 text in
`docs/plans/PLAN_GET_TO_LAUNCH.md` where they disagree.

## Product intent of this phase

A verified member can make an AI picture that stars a real person or pet in a
fact's approved gag, pay for it with a credit, get the first one free, buy more
credits as a pack or receive them with a membership, and use the picture as a
meme background. A visitor can see what each fact's gags look like before
signing up.

## Now — seven increments, in build order

1. **Credits.** One balance per account. The free picture is one credit
   granted when the account is verified. A picture that fails or is refused
   returns its credit.
2. **Make an AI picture.** Who it is for, the photo, a gag picker showing each
   gag's examples (only where a fact has more than one gag does the member
   choose), the look, visible progress while it draws. The result is listed in
   My content and is usable as a meme background.
3. **Examples in public.** Each fact page shows its approved gags' examples
   (male, female, pet). A signed-out visitor sees them with an invitation to
   sign up for the free picture. Examples are never meme backgrounds.
4. **The credit pack.** A one-time purchase by anyone with an account. A
   refund or a dispute takes the credits back.
5. **Membership with credits.** Monthly membership adds credits every month.
   Annual membership grants its whole year of credits at purchase (Q2: 1); a
   refund takes back unspent credits and spent ones reduce the refund. Every
   save carries the visible Overhype.me watermark by default; a member may
   turn it off for a meme with a checkbox, "Include Overhype.me watermark",
   which a free account sees checked and locked, with a gold lock and a
   tooltip saying it is a Legendary feature (David, 2026-11-25, amending
   "members' saves do not").
6. **Looks.** The style list tuned to the two settled engines (GPT Image 2.6
   photoreal, Nano Banana 2.1 styled), one site-wide sample per style, optional
   styled examples per gag.
7. **Upkeep.** `sharp` upgraded from 0.34.5; HEIC and PNG photo uploads
   accepted.

## Next — not this phase

- The friend-photo consent flow (private-first delivery, the friend's
  approval, one-click removal). Not built, not even switched off, until counsel
  answers (Q1: 1). At launch an AI picture stars the member or their pet; a
  friend gets their name on the fact.
- Issue #875: the UI/UX of every image surface.
- Phase 10 keeps: test-versus-live proof (`livemode`), the reconciliation
  runbook, upgrade messaging. Phase 7 takes the credit pack and membership
  credits out of Phase 10 (Q3: 1).
- Phase 11: the service-wide spend ceiling and the emergency stop.
- Final prices and credit counts (placeholders: pack $4.99 for 30 credits;
  membership $4.99 a month with 40, or $34.99 a year with 400).

## Never

Pictures of generic people; a picture with no photo; free-typed prompts;
spending by anyone without an account; examples used as meme backgrounds;
lifetime membership as a new sale.

## Dropped from the older Phase 7 text (overtaken by the strategy)

Hero renders as free backgrounds; the hero hard gate (a live fact already
requires an approved gag with its examples); the catalogue-wide hero
re-render; AI pictures as a members-only feature; the aspect-ratio-at-approval
decision.

## Must not change

- Blind moderation and the legal-safety rules.
- Faces only from photos a user supplies.
- The membership payment system and its safeguards: `membership_tier` is
  derived, never assigned; a paid entitlement is created only from provider
  state retrieved inside the trust boundary; the Stripe account guard.
- The provenance mark on every image that leaves Overhype.me.
- Verified email gates every authenticated action; an anonymous visitor can
  preview only.
- Only a user's own uploads or creations are offered to them as personal
  media.
- No spending by anyone without an account; every paid engine call passes the
  budget gate and is recorded in the cost ledger.
- The engines are settled: GPT Image 2.6 for photoreal, Nano Banana 2.1 for
  styled; no engine-selection rounds.

## Settled decisions carried in

- 2026-11-11, the product strategy (credits, pack, membership with credits,
  one free picture, two engines, up to three gags).
- 2026-11-14, every gag is its own record; where a fact has more than one
  available gag the user picks, and anything that draws without a picker uses
  the fact's default gag.
- 2026-11-14, every picture starts from a photo.
- 2026-11-15, a picture's subject is a person or a pet.
- 2026-11-15, a gag carries a male, a female and a pet example.
- 2026-11-17, deprecated means removed.
- 2026-11-23, your own photo is your picture, for every member.
- 2026-11-06, build order 8 → 7 → 6; Phase 6 demonstrates the loop on what
  this phase builds.

## Ceremony tier

Product, standard loop. The visual pipeline and payments are sensitive
subsystems: the credit ledger and Stripe increments take the migration review
and the payment-sensitive review.
```

## Problem

Since launch Phase 4 deleted PuLID, no member can make an AI picture, a
signed-out visitor has nothing to look at on a fact but its text, and nothing
is for sale except a membership whose perks are private memes and higher
limits. The gags and their example pictures exist and are approved fact by
fact, and nothing shows them to anyone but a moderator.

## Direction

`docs/ai-context/product-strategy.md` (2026-11-11). This phase makes true: a
verified member can spend a credit to draw themselves or their pet into a
fact's approved gag, and can get credits free once, by pack, or with a
membership.

## Product Intent, Must Not Change, Settled Decisions

The `plan-oracle` block above, verbatim. Two additions that are technical
choices of this plan, not requirements of David's:

- **The free picture is a credit.** One credit is granted the first time an
  account is verified, and never again for that account. There is no separate
  "first one is free" mechanism.
- **Affected-surface inventory (Preflight).** The pattern this plan touches is
  "a paid engine call made for a member". Oracle, run 2026-11-25 at
  `9f2a9a7`: non-test callers of `checkBudget` and `recordCost` in
  `artifacts/api-server/src` — none (the inventory agent's grep; to be re-run
  by the builder at increment 2). So this phase adds the only member call
  site; there is no existing one to convert.

## Repo Context Inspected

Read directly: `product-strategy.md`, `PLAN_GET_TO_LAUNCH.md` (Phase 6–11),
`launch-definition.md` (Image memes, Cut), `decisions.md` (2026-11-06 to
2026-11-25 headings; the 2026-11-11 entry), `membership-entitlements.md`
(to the account guard), `workstream-tracking.md`;
`lib/gags/resolver.ts` (`availableGags`, `resolveOfferedGag`),
`lib/budgetGate.ts` (header, exports), `lib/imagePromptJobs.ts` (exports,
purposes), `routes/gags.ts` (render and image routes),
`lib/webhookHandlers.ts` (event list, `invoice.paid`),
`lib/membershipRefresh.ts` (`prepareOneTimeCheckout`),
`lib/db/src/schema/userAiImages.ts`, `lookStyles.ts`,
`lib/validators/memeBuilder.ts` (render mode).

Taken from a Sonnet inventory pass (2026-11-25), not re-read by me, and marked
where the plan leans on them: `featureAccess.ts` keys, `userImageUpload.ts`
accepted types, `Step2Image.tsx` and `behaviorMatrix.ts` states,
`factGags.ts` example table shape, `imageEngineRouting.ts`.

## Current Behavior

- **Credits:** none. No table, route or screen.
- **AI pictures for members:** none. The only picture producers are the
  moderator's example renders (`POST /admin/facts/:factId/gags/:gagId/renders`)
  and the comparison tool. The render worker still has a member-sized
  (`final`) purpose and still copies a finished picture into
  `user_ai_images` "for the account that asked", but no member route starts
  one.
- **Gags:** `availableGags(factId)` returns a live fact's published gags with
  their approved male, female and pet example attempt ids;
  `resolveOfferedGag` is the documented entry point for this phase. Neither
  has a caller outside tests. Example images are streamed to admins only.
- **Meme backgrounds:** the member's own uploaded photo, or their profile
  photo. A signed-out visitor is shown a sign-up panel and can build nothing.
- **Membership:** monthly, annual and lifetime prices are read live from
  Stripe; a product grants membership only when its metadata says so. A
  one-time purchase of any other product is verified and then ignored
  ("Merch or credits. Not an error, and no entitlement source").
  `invoice.paid` records history and refreshes the subscription source.
- **Spend:** `checkBudget` and `recordCost` exist with CI guards and no
  caller. No per-account picture limit exists.
- **Uploads:** the server accepts JPEG only; the browser converts PNG and
  WebP first. HEIC is refused. `sharp` is 0.34.5.
- **Watermark:** every meme carries a visible Overhype.me mark, drawn by the
  shared renderer (`drawMeme`) that the builder preview and the server both
  use, and the invisible provenance mark. Nobody can remove the visible one.
- **Picture size:** the worker's member purpose (`final`) asks for about four
  megapixels; the strategy's pictures are near screen size.
- **Recovery:** a render whose receipt was lost, or whose request is known
  to have failed, is submitted again on purpose (`PLAN_JOB_RESUME.md`,
  Q13: 1). A job's abandonment hook runs after the failure is committed and
  its errors are swallowed.

## Source-of-Truth Analysis

| Concept | Source of truth | This plan |
|---|---|---|
| A member's credits | **new:** the credit ledger | The balance is derived from ledger rows by one module, the way `membership_tier` is derived from entitlement sources. No second writer. |
| What a picture cost Overhype.me in dollars | `user_generation_costs` (`recordCost`) | Unchanged. Credits are what the member pays; dollars are what the engine charged. Neither is computed from the other. |
| Which gags a member may draw | `availableGags` / `resolveOfferedGag` | Used as written; the picker lists exactly what it returns. |
| The scene drawn | the gag's published content | Unchanged. The member chooses a gag, a photo and a look, never words. |
| Which engine draws | `IMAGE_ENGINE_IDS` by look | Unchanged. |
| A member's pictures | `user_ai_images` | Reused. Its `gender` and `image_type` columns predate gags; the plan adds what a gag-based picture needs and does not start a parallel table. |
| A render's lifecycle | `image_prompt_attempts` | Reused. A member's picture is an attempt owned by that member. |
| Membership | entitlement sources | Unchanged. Credits never grant or imply a tier; a tier never implies a balance. |
| What a paid Stripe object was | the object retrieved inside the trust boundary | Extended, not bypassed: a credit grant from a purchase or an invoice is made only from the retrieved object. |
| The price and size of a pack or a membership grant | Stripe product metadata sets what is offered; **the terms snapshot taken at sale is what a payment is fulfilled and refunded against** | No number in code or in admin settings. Placeholders live on the sandbox products. |

## Proposed Design

### 1. Credits

- **An append-only ledger.** Each row: the account, a signed whole number of
  credits, a reason, and a reference that makes the row unique for its
  reason. Rows are never updated or deleted. The balance is the sum.
- **Every grant is a lot that remembers its source** (the free grant, this
  pack payment, this invoice), with the purchase terms frozen on it: what was
  paid and how many credits it bought. A picture consumes lots oldest first
  and records which lot it took from; a returned picture restores that same
  lot. The member sees one balance; the system can always answer "how many
  credits from this purchase are unspent", which a refund needs.
- **Reasons and their references:** free grant (the account), pack purchase
  (the payment), membership grant (the invoice), picture (the member's
  request), picture returned (the same request), reversal (the purchase and
  the numbered reconciliation that produced it), admin adjustment (the admin
  action).
- **A reversal is reconciled, not replayed.** For each purchase the system
  works out, from the refunds and disputes Stripe reports for it when
  retrieved, how many of its credits should currently be taken back, and
  appends only the difference from what is already applied, as that
  purchase's next numbered reconciliation; comparing and appending are
  serialized on the purchase, so two events for it cannot both apply the
  same difference or suppress each other. A refund counts
  once it has succeeded; a failed or cancelled refund moves nothing; a
  dispute counts while open or lost and stops counting when won. Refunds and
  disputes together never take back more than the purchase granted: half a
  pack refunded and then the whole charge disputed takes back the pack once,
  and winning the dispute restores only the half the refund did not cover.
  One rounding rule on the cumulative amount, so two half refunds equal one
  whole.
- **A deficit is repaid by the next grant.** When a reversal exceeds what is
  left of its lot (Q4: 1, David 2026-11-25), the shortfall is a deficit on the account. A
  later grant repays it: the repayment is recorded as an allocation against
  that later lot, naming the purchase whose deficit it paid, never as a
  smaller grant. No credit is at once spendable, refundable and owed, and
  if the first purchase's dispute is then won the repayment is released:
  the member is back to the full later grant, and each purchase's unspent
  count is again right for its own refund.
- **Exactly-once by construction:** a uniqueness constraint on (reason,
  reference). A redelivered webhook, a retried job or a double click cannot
  grant, spend or return twice; the second write is a no-op, not an error.
- **Spending never overdraws:** a picture's spend row is written in the same
  transaction that creates its render attempt, under a lock on the account,
  and is refused when the balance is below one. Two simultaneous requests
  with one credit yield one picture.
- **A balance can go below zero only by a reversal** (a refund or dispute
  after the credits were spent). While it is at or below zero the member
  cannot make a picture.
- **Append-only, with one exception:** the account purge removes a deleted
  account's ledger with the rest of its payment history, under the existing
  retention rule. Nothing else deletes a row. An open dispute on a credit
  payment holds that purge, as an open membership dispute does today; the
  hold reads the credit payment's own dispute state and no membership
  entitlement is invented for it.
- **The free credit** is written wherever an account first becomes verified:
  the local email-verification route, a provider sign-in that arrives
  verified, and an admin marking an account verified. A later email change and re-verification finds the row already
  there. Accounts already verified when this ships receive it in the
  migration.
- **One module owns every ledger write.** A CI check refuses a ledger insert
  anywhere else, as `check-budget-gate-unconditional.mjs` does for the gate.
- **Admin:** a member's balance and ledger on the Users page; an adjustment
  with a required note, recorded as an admin action.

### 2. Make an AI picture

- **Entry points:** the meme builder's picture step gains "Make an AI
  picture" beside "Upload a photo"; the fact page's examples lead into it
  (increment 3).
- **The steps a member sees:** who it is for (me, my pet, or a friend: for a
  friend the fact carries the friend's name and the picture still stars the
  member or their pet, from the member's own photo — Q5: 2); the photo (the existing upload and its
  moderation, plus the existing person-or-pet check); the gag (shown with
  its examples, a choice only when the fact has more than one); the look
  (photoreal, or a style); a confirmation that names the cost — "1 credit",
  or "your free picture" — and the balance after.
- **The request is refused, with a reason a person can act on,** when the
  account is unverified, the balance is below one, the fact has no available
  gag, the photo fails moderation or is not a person or pet, the budget gate
  refuses, or read-only mode is on.
- **One command, one picture.** The member's request carries a stable
  identity; sending it again (a retry, a double click, a lost response)
  returns the same picture and spends nothing more. The attempt, the spend
  and the first queued job commit together or not at all.
- **Size:** a member's picture is requested at about one megapixel, from the
  sizes each engine already supports, and is priced on what was actually
  requested.
- **Drawing:** the request resolves the gag through `resolveOfferedGag` and
  queues the existing render worker. The worker's existing refusal
  fallback (photoreal retried once on the styled engine) stays; it is one
  picture and one credit.
- **The budget gate sits at each new submission to an engine**: the first,
  the fallback, and a redraw that recovery makes on purpose. Cost is
  attributed to the recorded engine request, not to the picture: collecting
  a request ensures its cost is recorded once, however many times it is
  collected. Several submissions can cost dollars while the member spends
  one credit. The worker calls neither gate nor ledger today; this is new.
  The cost ledger keeps its documented meaning: an estimate from the
  provider's rate, not a reconciled bill, and a failed ledger write is still
  counted and skipped as it is today.
- **Other paid calls in this flow** are under the same rule: the
  person-or-pet check on the photo (a utility-model call) and the output
  check below.
- **The per-account dollar cap becomes a backstop with one rule for every
  account.** Today's defaults ($0.50 a month for a registered account, $10
  for a member) would stop someone using credits they bought, and would make
  membership the gate again. A fixed dollar figure has the same flaw at any
  size, because credits never expire and packs are unlimited. So the
  allowance follows the credits: the engine dollars an account may cause in
  total are bounded by the credits it has ever been granted, times a
  per-credit ceiling that leaves room for a fallback and a redraw. A
  returned credit adds no allowance, so a picture that keeps failing cannot
  keep spending. Someone holding credits is therefore never stopped by it in
  ordinary use; an account whose pictures cost several times what they
  should is. A picture it blocks ends as "temporarily unavailable — your
  credit was returned", never as "out of credits". The service-wide ceiling
  stays Phase 11's.
- **A finished picture is delivered as the member's own, or not at all.**
  The attempt's success, the `user_ai_images` row and the credit's final
  state commit together; a failure to record the member's copy fails the
  picture and returns the credit (today that failure is swallowed). A
  member's picture is never added to the fact's shared gallery
  (`facts.ai_meme_images`): that gallery is what makes My content ignore a
  picture, and the worker's copy into it is removed for member pictures.
  What still writes or serves that gallery after this (`routes/facts.ts`
  sends it to members) is removed with it, as deprecated means removed.
- **A meme can name an owned AI picture as its background** through its own
  image source, checked on the server against the caller's live
  `user_ai_images` rows. It does not pass as an upload, and an example or
  another member's picture can never satisfy the check.
- **The output is checked before it is delivered.** Today the worker stores
  an engine's picture without running the output classifier. A member's
  picture passes it first; a refused one is quarantined under the existing
  rules, shown as the existing generic rejection, never becomes a
  background, and returns its credit.
- **Every picture settles, and settlement does not depend on a callback.**
  Delivered: the spend stands. Failed at either stage (writing the prompt or
  drawing), refused by the engine after its fallback, refused by the output
  check, or stranded: the credit is returned. A recovery pass for member
  pictures runs repeatedly and settles anything failed, abandoned or
  stranded, so a crash between a job failing and its hook running loses
  nothing. Returning and delivering are serialized on the picture: one that
  has been returned can never afterwards deliver, and one delivered is never
  returned. The invariant the tests hold: no picture is failed with a spend
  and no return, and none is delivered with a return.
- **Progress** follows `async-ui-status.md`: queued, drawing, done, failed
  with the reason and "your credit was returned". Leaving and coming back
  shows the same picture's state; My content lists it while it draws.
- **The result** is a `user_ai_images` row recording the fact, the gag and
  the look, shown in My content with per-item delete (existing), and
  selectable as a meme background for that fact. Only its owner is ever
  offered it.
- **No regenerate for free.** Another picture is another credit. *(Named so
  David reads it; the strategy's "one credit is one picture" covers it.)*

### 3. Examples in public

- A fact page shows, for each available gag, its approved male, female and
  pet examples, and a line inviting the visitor to star in it: sign up for a
  free picture when signed out, "Make yours" when signed in.
- Example images are served from a public, cacheable route that serves **only**
  the attempt ids `availableGags` returns for a live fact. A draft example, a
  removed gag's example and an inactive fact's examples are not reachable
  through it. The admin stream is unchanged.
- An example is never offered as a meme background and has no "use this"
  action.
- A fact whose gag predates example sets (fewer than three examples) shows
  what it has; a fact with none shows no examples block. Launch readiness
  row 11 already requires every such gag to complete its set before Seed, so
  this phase adds no gate, no substitute picture and no re-render.
- The meme page's signed-out call to action stops promising "free hero
  renders".

### 4. The credit pack

- A Stripe product marked as a credit pack in its own metadata key, carrying
  its credit count there. The pack has its own checkout route and its own
  verified classification ("a credit pack of N", from the retrieved session
  and its enumerated line items, never from the caller). The membership
  checkout keeps refusing every non-membership price and the membership
  allowlist is not widened; a product cannot be both.
- The grant row's reference is the payment, so the confirm route and the
  webhook racing each other grant once.
- **Its terms are fixed when checkout is created**: the price and the credit
  count are snapshotted then, and the payment is verified against that
  snapshot. Changing the product's metadata later changes future sales only.
- A refund (full or partial) and a dispute take back credits in proportion
  to the money returned, by the reconciliation rule in section 1.
- **A refund's later change of state is reconciled too.** Only
  `charge.refunded` is handled today; a refund that succeeds later, or one
  applied and then failed, arrives as a different Stripe event. Increment 4
  first establishes that those events are delivered to the handler (the
  sync library's supported-event list decides what is registered and
  replayed) and supplies the delivery if it is missing.
- The pack never creates an entitlement source and never touches the tier.
- Buying needs a verified account. The pricing page gains the pack; the
  out-of-credits state links to it.

### 5. Membership with credits, and the watermark

- A membership product carries its credit grant in metadata: per paid month
  for monthly, per paid year for annual.
- **The grant follows a paid invoice**, retrieved inside the trust boundary,
  and is decided by that invoice's own lines: a line that pays a full period
  of a qualifying membership price grants that period's credits, at the
  terms snapshotted for that price. An invoice is not disqualified because
  it also carries proration lines: the monthly-to-annual switch produces
  exactly that, and grants the annual amount once. A trial invoice of zero,
  a proration-only invoice and an invoice for another product grant nothing.
  A late monthly payment that lands after a switch grants the monthly
  amount it paid for, not the current plan's. Nothing is taken back from
  periods already paid.
- **An invoice that arrives before the account is linked is not dropped.**
  Today `invoice.paid` does nothing when it cannot find the account. The
  account is resolved from the retrieved subscription, or the event is left
  for redelivery; the credit grant commits with the event's processed
  claim.
- A refund of a subscription invoice takes back that invoice's grant, in
  proportion; a dispute likewise. Cancelling stops future grants and removes
  nothing.
- **Lifetime stops being sold.** The code still sells it: the pricing page
  picks a lifetime price and the checkout route creates one-time membership
  sessions. The page offers monthly and annual only, and the server refuses
  a new one-time membership checkout. An existing lifetime source keeps
  qualifying exactly as now.
- **Deleting an account with unspent paid credits (Q8: 1).** The deletion
  screen shows how many credits will be lost before the member confirms,
  and the pack and membership purchase screens say credits are not
  refundable on deletion. Nothing is refunded when the member deletes the
  account or is removed for breaking the Terms. When Overhype.me ends an
  account that did nothing wrong, the Refunds page shows the suggested
  refund of its unspent paid credits by the Q7 formula, and the operator
  issues it in Stripe before the purge. Terms section 6 gains one line
  saying unspent credits are not refunded when you delete your account,
  published as a new Terms version.
- Lifetime members (existing sources only) and admin grants receive no
  automatic credits (Q6: 1, David 2026-11-25).
- **The Refunds page shows, for a charge, the credits it granted, how many
  are unspent, and a suggested refund** worked out from that purchase's
  frozen terms: the price times the share of that purchase's credits still
  unspent (Q7: 1, David 2026-11-25; annual at $34.99 with 100 of 400 spent
  suggests $26.24). Nothing in the product issues a refund
  today, and this phase adds no refund button: the operator issues it in
  Stripe for the suggested amount, and the reversal follows from the
  refund Stripe reports. This is how "spent ones reduce the refund" is
  applied before the money moves.
- **The watermark is on by default for everyone, and a member may turn it
  off** (David, 2026-11-25). The builder shows a checkbox, "Include
  Overhype.me watermark", checked every time a meme is started. A member
  can uncheck it for that meme. A free account sees the same checkbox,
  checked and unable to be unchecked, with a small gold lock and a tooltip
  saying that removing the watermark is a Legendary feature. The choice is
  per meme and is not remembered: the next meme starts checked again.
- **The server decides, not the checkbox.** Removing the mark is a new key
  in the entitlement grid, read the way `meme_private_visibility` is; a
  request to save or download without the mark from an account that lacks
  it is refused, as a private save is today. The builder preview shows the
  same result as the save, through the one shared renderer. A saved meme
  stays the file it was baked as: it is not redrawn for whoever downloads
  it or when its maker's membership changes. The invisible provenance mark
  is untouched and is on every meme whatever the checkbox says.

### 6. Looks

- The style list is reviewed against the two engines: each active style is
  drawn on Nano Banana 2.1 across the three subject kinds, and a style that
  does not hold is tuned or deactivated. Issue #888's comparison with other
  platforms decides additions. No engine round.
- One site-wide sample per style, shown in the look picker.
- A gag may carry styled examples in addition to its three required unstyled
  ones; they are optional and never gate approval, and the required set
  stays the unstyled male, female and pet in loading, publication and
  approval alike (a styled example never stands in for one).
- The stale PuLID and video wording in the look catalogue and its frontend
  fallback list is removed.

### 7. Upkeep

- `sharp` to the current release; the audit's three High findings clear.
- The server accepts PNG and HEIC as well as JPEG and stores JPEG; the
  browser's conversion stays as an optimisation, not a requirement. A file
  whose bytes are not what its type claims is still refused.
- **HEIC is not delivered by the `sharp` upgrade.** Measured 2026-11-25:
  `sharp` 0.35.5 reads a phone HEIC's size and then fails to decode it
  ("Support for this compression format has not been built in: HEVC"), on
  two real files. A WebAssembly decoder (`heic-convert`) turned both into
  JPEG, a 3992×2992 photo in about two seconds. So a HEIC is converted by
  that kind of decoder, off the request thread so a large photo does not
  stall other requests, and the JPEG it yields goes through every existing
  upload check unchanged.

## Data Model and Migration Impact

- **New:** the credit ledger (append-only; uniqueness on reason and
  reference; an update or delete refused by trigger, like the frozen
  entitlement identity columns).
- **Changed:** `user_ai_images` gains the gag and the look, nullable for the
  rows that predate them; `image_prompt_attempts` already carries the owner
  and the gag. The entitlement grid gains the watermark-removal key. The gag
  examples table gains what an optional styled example needs (increment 6).
- **Backfill:** one free-grant row per already-verified account, suspended
  ones included (a suspended account cannot spend, and would otherwise never
  receive it). An account that verifies while the migration is deploying is
  covered by running the same idempotent grant again afterwards. Idempotent
  by the uniqueness constraint; the migration logs how many it wrote and how
  many it found already present. Unverified accounts get theirs on
  verification.
- **Row states:** old (verified, no grant) → granted by the backfill; new
  (verifies after ship) → granted at verification; partial (backfill
  interrupted) → re-run completes it, duplicates impossible; failed → the
  migration fails closed and is re-run; skipped (unverified, deleted) → no
  row, by rule.
- **Forward-only**, backward-compatible with the running code: each
  increment's migration adds, and nothing is dropped in this phase. The
  retired `gender` and `image_type` columns' removal is taken as next.
- **Rollback:** an increment's code can be reverted with its tables left in
  place; ledger rows are never destroyed by a rollback.

## Runtime Behavior — the edges that decide the design

- **A member with one credit clicks twice:** one picture.
- **The worker dies mid-picture:** resumed. A picture the engine finished
  is collected; one whose receipt is lost or ambiguous is drawn again on
  purpose (the existing rule), which costs Overhype.me twice and the member
  one credit.
- **The engine refuses the scene for this photo:** one styled retry, then
  failed and the credit returned, with the reason in words.
- **A gag is unpublished while a picture of it is drawing:** the picture
  completes; it was drawn from the published content at request time.
- **A fact is deactivated:** existing pictures stay in My content; new ones
  are refused.
- **A pack is refunded after its credits were spent:** the balance goes
  negative by the shortfall (Q4), and the next grant repays it.
- **A pack is half refunded, then disputed in full, then the dispute is
  won:** half the pack is gone, once.
- **A picture is being drawn when a reversal lands:** the picture completes
  on the credit already spent; the reversal applies to what is left and the
  rest becomes deficit.
- **Stripe delivers `invoice.paid` twice, or after a refund:** one grant;
  the reversal is reconciled to what Stripe reports and stands.
- **An account is suspended:** it cannot spend; its ledger is untouched. An
  account deleted: its ledger follows the account-deletion rules for
  financial records (kept as long as payment history is).
- **Read-only mode:** no picture, no purchase; webhooks still processed, so
  grants and reversals still land.

## Admin/User UX Impact

- **Member:** the balance in the account menu and on the picture step; the
  pricing page with the pack and membership credits; My content showing
  pictures as they draw; the out-of-credits state; "your credit was
  returned".
- **Visitor:** examples on fact pages and a sign-up invitation.
- **Admin:** balance, ledger and adjustment on Users; credits granted and
  unspent on Refunds; a count on Operations of pictures stuck past their
  deadline and of credits returned today.
- **Moderator:** optional styled examples on a gag; the site-wide style
  samples.

## Security, Permissions, and Validation

- Every picture and purchase route requires a verified, unsuspended session
  server-side; the client's buttons are a courtesy.
- The picture request accepts ids only: a fact, a gag, a look, and one of
  the caller's own uploads. Ownership of the upload is checked on the server
  (Issue #757's class). No text reaches a prompt from the member.
- A credit grant from money is made only from a Stripe object retrieved
  inside the trust boundary; no route accepts a credit count from a caller.
- The public example route serves an id only if `availableGags` currently
  returns it.
- Rate limits: the existing upload cap, plus a per-account cap on pictures
  in progress at once.
- Admin adjustments are recorded with who, how many and why.
- A `/security-review` is owed when the pack and membership increments
  merge (payment-touching).

## Testing Plan

Per increment, in CI unless marked:

1. **Credits:** exactly-once for every reason under duplicate and concurrent
   writes; no overdraw under simultaneous spends; the backfill's row states;
   the free grant on each verification path and its absence on
   re-verification; the single-writer check.
2. **AI picture:** each refusal reason; the same command sent twice yields
   one picture; the settle invariant across delivered, failed at the prompt
   stage, failed at drawing, refused by the engine, refused by the output
   check, interrupted after the job failed and before settlement, recovery
   run twice, and a late completion racing a return, against the AI double;
   cost recorded once per engine request across collection and redraw; only the owner is offered the result; a browser journey from
   fact to saved meme with the engine doubled. `live`: one real picture on
   each engine after the sync, within the paid-run budget. David: likeness
   and scene fidelity on his own photo.
3. **Examples:** the public route serves exactly the available set and
   refuses a draft, removed or inactive one; a browser check that the fact
   page shows them signed out. David: how the block looks.
4. **Pack:** through the Stripe fake — purchase, the confirm/webhook race,
   partial and full refund, two half refunds equal to one whole, a failed
   refund, a refund reported before the grant, half refund then full dispute
   then win, a refund pending then succeeded and one applied then failed
   (both through the event path), spend A's pack, dispute A, buy B, win A's
   dispute (balance back to B's full grant, each purchase's unspent count
   right), a spend racing a reversal, dispute opened, won and lost, a
   non-pack product; an open pack dispute holding account deletion and its
   resolution releasing it. `live` (sandbox): one real test-mode purchase and refund.
5. **Membership credits:** through the fake — monthly renewals, annual
   purchase, trial, plan switch, failed payment then recovery, refund,
   dispute, cancel; the first invoice arriving before the account is linked;
   a switch invoice carrying both a full period and prorations; a late
   monthly payment after a switch; product metadata changed between checkout
   and payment. The watermark: present by default for a member and a free
   account alike; absent only when a member unchecks the box; a free
   account's request to save without it refused by the server; asserted on
   pixels, the same in preview and save; a saved meme unchanged when its
   maker's membership changes; the locked checkbox, gold lock and tooltip
   present for a free account (a browser check).
6. **Looks:** the catalogue's active styles each resolve to the styled
   engine. David: the style samples.
7. **Upkeep:** PNG and HEIC accepted and stored as JPEG; a mislabelled file
   refused; `pnpm audit --prod` shows no High from `sharp`.

Runner commands are those in `docs/tests/TESTING.md`; nothing new is needed
to run them.

## Implementation Steps

Seven increments in the order above, one PR each (the picture increment may
split server from screen if its diff is too large to review well). Each is
merged, synced and verified before the next starts. Increments 3, 6 and 7
depend on nothing after increment 2 and may be reordered if one is blocked.

## Risks and Mitigations

- **A returned credit does not return the engine's bill.** A picture that
  fails after the engine was paid costs Overhype.me its dollars and the
  member nothing; the cost ledger keeps the dollars, the credit ledger
  returns the credit. Operations shows credits returned per day so a rising
  number is seen.
- **Free pictures farmed with throwaway accounts.** Each costs about six
  cents. Verification and Turnstile at sign-up are the brakes today; the
  service-wide ceiling is Phase 11, which gates Seed, so no stranger can
  reach this before it exists. Accepted until then.
- **Real engine bills differ from the placeholder prices.** Prices and
  counts live in Stripe metadata, so changing them is not a code change.
- **The render worker's member path has not run since Phase 4.** Increment
  2's first step is to run it end to end against the AI double before any
  screen is built; what it finds is fixed there.
- **The Stripe fake's event channel (#695) is not built.** The pack and
  membership tests need refund, dispute and invoice events from it.
  Increment 4 starts by checking what the fake delivers; a missing event is
  added to the fake in that increment.
- **Credits and the tier drifting into one concept.** Kept apart in the
  source-of-truth table and by the single-writer rule; no code reads one to
  decide the other, except the grant following a paid membership invoice.

## Questions for David

Answered 2026-11-25 ("q4 1. q5 2. q6 1. q7 1"):

- **Q4: 1.** After a refund or dispute on credits already spent, the balance
  goes negative; no new pictures until later credits pay it off.
- **Q5: 2.** A meme made for a friend can carry an AI picture too, starring
  the sender or their pet, behind the friend's name. (Claude and Astra
  recommended 1, an uploaded photo only.)
- **Q6: 1.** Existing lifetime and admin-granted members get no automatic
  credits.
- **Q7: 1.** A membership refund is the price times the share of that
  purchase's credits still unspent.

- **Q8: 1.** When an account is deleted with unspent paid credits, nothing
  is refunded if the member deleted it or was removed for breaking the
  Terms; the deletion screen shows the credits they will lose before they
  confirm, and the purchase screen says credits are not refundable on
  deletion. When Overhype.me ends an account that did nothing wrong, the
  Refunds page suggests the unspent share by the Q7 formula. Free credits
  are never refunded.

Plan approved by David, 2026-11-25 ("q8 1. approved").

## Definition of Done

- A verified member with a credit can go from a fact to a saved meme whose
  background is an AI picture of them in that fact's gag, in the product.
- A new verified account has exactly one credit, once.
- A failed or refused picture leaves the balance where it started.
- A pack bought in the Stripe sandbox adds its credits once; refunding it
  removes them.
- The pricing page sells no lifetime plan and the server refuses a new one.
- A paid membership invoice adds its credits once.
- Every save shows the watermark unless a member unchecks "Include
  Overhype.me watermark"; a free account sees the box locked, with the gold
  lock and the Legendary tooltip.
- A signed-out visitor sees a fact's examples and cannot use one as a
  background.
- Every member picture appears in the cost ledger, and none was drawn
  without passing the budget gate.
- Deleting an account with paid credits shows the loss before confirming,
  and the purchase screens and Terms say so.
- HEIC and PNG upload; `sharp` is current.
- `launch-definition.md`, `PLAN_GET_TO_LAUNCH.md` (Phases 7 and 10),
  `product-brief.md` and the Manual's payment and visual-pipeline chapters
  say what was built.

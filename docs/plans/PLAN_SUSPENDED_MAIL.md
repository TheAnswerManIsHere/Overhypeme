# Plan — a suspended member does not receive ordinary emails (Issue #1212)

```plan-oracle
# Oracle — Issue #1212: a suspended member does not receive ordinary emails

## Settled decisions this follows
- Suspension blocks the person, never the catalogue; content and billing are untouched (decisions.md, 2026-10-30).
- Q7 (David, 2026-11-21, Issue #628): a suspended member is emailed when suspended and when the suspension is lifted (PR #1216; decisions.md 2026-11-24 says those two notices "are the only mail suspension itself sends" and that a later suppression rule must exempt them).
- Phase 16 Q4:1 / design E: a suspended member may use the support form, without signing in.
- A suspended account is sent no password-reset email, and its reset and verification links are refused (existing).

## The gap (Issue #1212, found by Astra while scoping Issue #1110)
Nothing refuses ordinary mail to a suspended account except password recovery: review notifications choose recipients by `isActive`, Fact of the Day by membership and `isActive`, membership-access notices send unconditionally, and neither enqueue nor queued delivery checks suspension, so mail queued before a suspension still goes out after it.

## Product intent
- While an account is suspended, the site sends it no ordinary mail: activity and engagement notices (review results, Fact of the Day, share invitations to its address, and the like) are held back, including mail queued before the suspension.
- The mail a suspended member still needs keeps going: the two suspension notices, the support form's acknowledgement, and whatever David decides about billing and account-lifecycle mail.

## Must not change
- Unsuspended accounts and addresses with no account receive exactly what they receive today.
- The two suspension notices (account_suspended, account_reinstated) always go.
- A suspended member can still use the support form and is acknowledged.
- The existing refusals for password reset and verification stay.

Ceremony: production phase, feature mode, accounts and email delivery (sensitive).
```

## Problem

Nothing refuses ordinary mail to a suspended account except password recovery, and the
existing gaps are confirmed in the code:
- Review results choose recipients by `isActive` (`routes/reviews.ts:597`).
- Fact of the Day chooses Legendary members by `isActive` (`lib/stripeStorage.ts:113`).
- Membership-access notices send unconditionally (`lib/userNotify.ts:31`).
- Share invitations go to any address.
- Neither the enqueue (`sendEmail`, `lib/email.ts:286`) nor the delivery path checks
  suspension, so mail queued before a suspension goes out after it.

## Repo Context Inspected

- `lib/email.ts`:
  - `sendEmail` (enqueue; `kind` is optional and many producers leave it null).
  - `emailJobHandler` / `runEmailJob` (delivery). It records a possible send
    (`delivery.state`) before calling the provider, and the frozen `delivery.message` holds
    the address actually sent to.
  - `emailRetryReset`, the admin retry.
- The shared queue completes a job with `result.skipped = true`, and Queue Health shows it as
  skipped (`lib/queueHealth.ts:85`).
- The Email Queue page labels every `done` job "Delivered" (`routes/admin.ts:2304`,
  `pages/admin/emailQueue.tsx:160`).
- `lib/accountSuspension.ts`: `suspendAccount` sets `suspended_at` under the row's
  `FOR UPDATE` lock.
- Producers whose mail a suspended member may still need: the suspension notices
  (`account_suspended`, `account_reinstated`, PR #1216), `support_ack`, deletion notices
  (`account_deletion_scheduled`, `account_deletion_cancelled`, and the unfinished-sign-up
  cleanup notice), and billing mail. Billing mail covers payment-action requests, renewal
  reminders and card-update notices in `lib/webhookHandlers.ts`, plus access-revoked notices
  in `lib/userNotify.ts`; all of these are currently `kind: null`.

## Source-of-Truth Analysis

**The decision is made at delivery, from the recipient's current account state** (Astra, scope
S1). It is not made at enqueue, and it does not depend on who caused the send.

The recipient is the address in the job's frozen `delivery.message`, the one the worker will
actually send to. It is matched case-insensitively to an account's `email`. When that account
is suspended and the job's kind is not on the permitted list, the job is skipped. The same
check applies to new jobs, jobs queued before the suspension, ordinary retries, recovery after
an interruption, and an admin's manual retry, so a retry is never a way round a suspension.

**The cutoff** (scope S5; Q24 below). Each dispatch attempt checks the recipient's suspension
in the transaction that records its authorisation to send. That transaction reads the account
`FOR SHARE`, which conflicts with `suspendAccount`'s `FOR UPDATE`:
- If the suspension commits first, the attempt is skipped.
- If the authorisation commits first, that attempt may still reach the provider after the
  suspension commits.

Several such attempts can be authorised at once, since the email lane runs up to three jobs
together (`asyncJobs.ts:505`). Every later retry decides afresh; an earlier authorisation
grants no lasting exemption. A job already recorded as sent stays sent.

## Proposed Design

1. **A permitted-kinds list in `lib/email.ts`.**
   - Always permitted: `account_suspended`, `account_reinstated`, `support_ack`. These are
     settled by Q7 and Phase 16.
   - Permitted by David's answers to Q21 and Q22 (below):
     - billing: `billing_payment_action`, `billing_renewal_reminder`, `billing_card_updated`,
       `access_revoked`;
     - account lifecycle: `account_deletion_scheduled`, `account_deletion_cancelled`. The
       unfinished-sign-up notice already uses `account_deletion_scheduled`
       (`accountDeletion.ts:488`) and keeps it.
2. **Kinds for every producer that lacks one.**
   - The billing and access notices get the kinds above.
   - Fact of the Day, review results, share invitations, user email-change mail and admin
     notices get explicit ordinary kinds, so the Email Queue can say what each one is.
   - Password reset and verification keep their source-side refusals unchanged.
3. **The delivery check.** In `runEmailJob`, keep the `sent` shortcut first. Then decide
   suspension *before* the existing delivery-failure branches (the expired `possibly_sent`
   refusal and the disabled-provider retry; Astra A1), so a suspended ordinary job is skipped,
   not failed or retried. The existing recovery safeguards stay in force whenever sending is
   still allowed, and a skip keeps whatever delivery history the job already holds. The final
   check runs inside the transaction that records the authorisation to send:
   - Look up the account owning the recipient address. If it is suspended and the kind is not
     permitted, finish the job as skipped, with `result: { skipped: true, reason:
     "recipient_suspended" }`.
   - A skip makes no provider call, uses no retry, and raises no abandoned-email alert.
   - The recipient is the frozen `delivery.message` destination, matched case-insensitively.
     Tests cover a job whose top-level and frozen addresses differ.
   - An address with no account, or an unsuspended account, is unaffected.
4. **Withheld mail is skipped for good** (Q23). Nothing replays it on reinstatement, so a
   reinstated member does not get a backlog of stale daily facts and invitations.
5. **Older jobs queued without a kind** (scope S2, reopened in round 1). Before suppression can
   take effect, the jobs that could still be delivered are identified, whoever the recipient
   is now. That covers jobs that are pending, retrying or recoverably failed, including any
   created by the outgoing release during the cutover. Jobs that are billing or access notices
   by David's Q21 answer get their kind written onto the existing row. Their sending record,
   frozen message and idempotency key are kept, and no extra send is authorised. This runs as
   a one-off, idempotent step after the deploy, through the connector. Its count is reported
   in the merge report, and an empty backlog is recorded as such. Jobs it can't recognise stay
   ordinary.
6. **The Email Queue shows skips truthfully.** The admin API returns the job's result.
   - The row, its detail and its filter show "Skipped — recipient suspended" instead of
     "Delivered".
   - The "Clear delivered" control, which clears every finished row, is renamed "Clear
     finished".
   - Queue Health learns `recipient_suspended` as a known skip reason (`queueHealth.ts:73`).
7. **Docs.**
   - `accounts-and-auth.md` § Suspension.
   - The email-delivery section.
   - Manual chapter 9, with the help regenerated.
   - A `decisions.md` entry recording the permitted kinds and David's answers.

## Data Model and Migration Impact

None. Kinds live in the job payload, which already holds a free-form string. The skip uses the
existing `result` column.

## Security, Permissions, and Validation

The check keys on the address the worker sends to, so mail addressed by someone else (a share
invitation) is covered. The suspension state is read under a share lock, so it cannot be
stale at the moment of the decision. The admin retry goes through the same check. Nothing here
changes who can suspend, sign in or use support.

## Testing Plan

API and worker tests in `__tests__/emailSuspension.test.ts`, using the transport test seam:
- **Ordinary mail** (each new kind, plus a null-kind job) to a suspended recipient makes no
  transport call and finishes skipped, with the reason. This holds for a job queued before
  the suspension, a retry, and an admin retry.
- **Every permitted kind** still sends to a suspended recipient. This includes a
  reinstatement notice delivered while the account is suspended again.
- **An unsuspended recipient**, and an address with no account, receive exactly as before.
- **The overlap:** a suspension waiting on the delivery transaction's lock commits after the
  intent to send is recorded, and that send goes. A suspension committed first skips the send.
- **A skipped job** raises no abandoned alert, and the Email Queue API returns its reason.
- **The existing behaviour stays:** a signed-out suspended member's support request is
  acknowledged, and reset and verification refusals are unchanged.

- **Each permitted producer** really writes its permitted kind. This is checked at the
  producer, not on jobs built by hand.
- **Precedence:** an expired `possibly_sent` job and a disabled-provider job, each to a
  suspended recipient, are skipped and keep their delivery history. The existing
  `emailResume.test.ts` still passes.
- **The cutover step** classifies an older billing job by writing its kind onto the existing
  row, without changing its sending record, and leaves unknown jobs ordinary.

A frontend test checks that the Email Queue row, its filter and the renamed "Clear finished"
control all read truthfully.

## UAT (for the PR)

- **T1 (human):** read the Email Queue's wording for a skipped email ("Skipped — recipient
  suspended") and the renamed "Clear finished" control. Judge whether an admin would
  understand them at a glance. Whether skipping happens is the machine's job (R1–R3).
- **R1 (ci):** ordinary mail to a suspended recipient is skipped, whether new, queued before
  the suspension or retried.
- **R2 (ci):** the suspension notices, and your Q21 and Q22 kinds, still go.
- **R3 (ci):** an unsuspended member receives exactly as before.

## Questions for David

- **Q21 — Billing mail to a suspended member.** Suspension leaves billing running, so the
  member may still be charged.
  1. **Keep sending:** payment-action requests, renewal reminders, card-update notices and
     access-revoked notices.
  2. **Hold them back** like other mail.

  *Astra and I both recommend 1:* someone who is being charged should hear about the charges,
  and option 2 would leave a suspended paying member blind to their own bill.
- **Q22 — Account-lifecycle mail to a suspended member:** "your account is scheduled for
  deletion", "deletion cancelled", and the unfinished-sign-up cleanup notice.
  1. **Keep sending.**
  2. **Hold them back.**

  *Astra and I both recommend 1:* deletion runs regardless of suspension, so the member should
  be told. This grants no new permission: a suspended member still cannot cancel a deletion
  themselves.
- **Q23 — What happens to the ordinary mail that is held back?**
  1. **Dropped for good.** Nothing is replayed when the suspension is lifted.
  2. **Saved and sent after reinstatement.**

  *Astra and I both recommend 1:* a reinstated member would otherwise get a pile of stale
  daily facts and old invitations. Saving them would need retention and release rules this
  plan does not include.

- **Q24 — The moment a suspension takes effect for email.** An email whose send was already
  authorised just before the suspension committed can still go out, at most a few, since the
  email lane sends up to three at once. Every later attempt checks again.
  1. **Accept this boundary.** The suspension stops every send decided after it commits.
  2. **Make suspension wait** until any sends already in flight to that member have finished.

  *Astra and I both recommend 1:* option 2 ties an admin's suspension to the email provider's
  speed, for at most a few seconds' difference.

## Definition of Done

While an account is suspended, no ordinary mail is decided for it after the suspension
commits, whether new, queued earlier or retried (the boundary per Q24). Every permitted kind still goes. Unsuspended recipients are unchanged. The Email
Queue shows skips as skips. Tests pass, the docs are updated, and the PR is merged and synced.

# Plan — email a member when their account is suspended, and when it is lifted (Issue #1110, Q7)

```plan-oracle
David's request (2026-11-20, verbatim, Issue #1110):
> Is there supposed to be an email that is sent to the user when their account is suspended?
> If not, there should be. The email should have boilerplate copy around what having your
> account suspended means and it should also include any additional admin notes on why the
> account was suspended.

David's decision (Q7, wave-2 backlog plan approved 2026-11-21, recorded on Issue #628):
> Q7 (#1110): keep the internal reason private and add a separate optional note to the
> member; lifting a suspension also emails.

Product intent:
- When an admin suspends an account, the member receives one email saying what suspension
  means (they cannot sign in or act; what happens to their content and membership), how to
  reach support, and, when the admin wrote one, the admin's note to the member.
- When an admin lifts a suspension, the member receives one email saying they can sign in again.

Must not change:
- The internal suspension reason stays visible to admins only; it never reaches the member,
  in the email or anywhere else (Phase 5 plan item 8; lib/eligibility.ts).
- Suspension still blocks sign-in and every action, ends every session, and keeps password
  recovery and verification closed to the suspended account.
- The existing refusals stay: a suspended account is sent no password-reset email, and its
  reset and verification links are refused.
- Suspending or unsuspending still succeeds when the email cannot be queued.

Settled decisions: Q7, above; 2026-10-30 (suspension leaves content and billing untouched).
Ceremony: production phase, feature mode, product tier (accounts — sensitive).
```

## Problem

Nothing tells a member their account was suspended or reinstated. They find out by being
signed out and refused at sign-in, with a screen that says "This account is suspended" and
never why (`pages/AccountSuspended.tsx`). The only text an admin writes today,
`suspended_reason`, was promised to be admin-only (`routes/accountSuspension.ts:17`:
*"Say why the account is suspended. Only admins see it."*), so it cannot be what the
member reads.

## Repo Context Inspected

- `routes/accountSuspension.ts` (suspend: body `{ reason }`, required, ≤ 500; unsuspend: no
  body) and `lib/accountSuspension.ts` (`suspendAccount` locks the row `FOR UPDATE` in a
  transaction and returns `"suspended" | "already_suspended" | "not_found"`;
  `unsuspendAccount` is one conditional `UPDATE … WHERE suspended_at IS NOT NULL RETURNING`
  and returns `"unsuspended" | "not_suspended" | "not_found"`). Neither reads the email
  address nor sends mail.
- `lib/email.ts`: `sendEmail({ to, kind, subject, text, html })` enqueues on the shared
  `async_jobs` queue; templates are exported builders over `buildEmailShell`, `ctaButton`,
  `divider`, `escapeHtml`; `SUPPORT_ADDRESS = "support@overhype.me"`. Closest model:
  `buildAccountDeletionCancelledEmail` and its enqueue in `accountDeletion.ts:165`.
- `pages/admin/users.tsx` ~1352–1396: the suspend form is one inline `reason` field;
  `setSuspension()` posts it and shows a success line.
- `__tests__/phase5.suspension.test.ts` (five cases; none about email);
  `docs/tests/TESTING.md`, the production-mode stack with the mail sink.
- `docs/ai-context/decisions.md`, 2026-10-30: suspension leaves content and billing untouched.
- Phase 16 Q4:1 / design E (`PLAN_PHASE16_ANALYTICS_OPERATIONS.md:17`): the support form
  needs no sign-in, and `POST /support/contact` is a gate exception for suspended accounts
  (`middlewares/requireEligibleActor.ts:56`). `routes/support.ts:44,127` shows how a send
  distinguishes "no email transport" and opts in to the outbox.

## Source-of-Truth Analysis

- **Whether a notice is owed** comes from the engine's outcome, never from the request:
  only a real transition (`suspended`, `unsuspended`) sends. A repeated suspend
  (`already_suspended`) or unsuspend (`not_suspended`) sends nothing. Because the suspend
  path takes the row lock and the unsuspend path is a single conditional update, two
  concurrent identical requests produce exactly one transition, so exactly one email.
- **What the member reads** is the boilerplate plus the member note typed for *this*
  suspension. The note lives in the queued email job's frozen payload and nowhere else; the
  internal reason is never passed to the email builder, so there is no code path by which it
  can fall in.
- **The address** is read in the same statement that makes the transition (the engine
  returns it), so the email goes to the address the account had at that moment.

## Proposed Design

1. **The engine reports who to tell.** `suspendAccount` and `unsuspendAccount` return the
   account's email (and first name, for the greeting) with a real transition. Their
   locking and outcomes are otherwise unchanged.
2. **The route tries to queue the notice after the change is committed**, never inside the
   transaction, so a queueing problem cannot undo a suspension or bring back a session.
   On a real transition it queues kind `account_suspended` or `account_reinstated`, the
   way the support route does: it checks the email transport first, and opts in to the
   outbox. There are three outcomes, and the response says which:
   - **queued** — a job now exists. That is not a claim it was delivered.
   - **not queued** — the account has no email address, no email transport is set up, or
     the insert failed (logged). The suspend or unsuspend itself still succeeds.
   - **no new email** — a repeated request (`alreadySuspended` / `wasSuspended: false`)
     changed nothing, so no notice is owed.

   The limitation is stated, not hidden. When no job was created there is nothing in the
   Email Queue to retry, and repeating the action does not resend, because it is no
   longer a transition.
3. **The suspend request gains an optional `memberNote`** (trimmed; empty means none; at
   most 1,000 characters, refused over that with a clear message). The `reason` stays
   required and admin-only, with its wording unchanged.
4. **Two templates** in `email.ts`, in the house style. The note is HTML-escaped and shown in
   its own quoted block, and the plain-text version carries it too.
   - **Suspended.** Subject: *"Your Overhype.me account is suspended"*. The body says:
     - An admin has suspended your account. While it is suspended you can't sign in,
       post, vote, comment or make memes.
     - Suspension doesn't delete your content or cancel your membership, and recurring
       charges continue unless you cancel.
     - For help with the suspension or with cancelling, email support@overhype.me or use
       the support form. No sign-in is needed. *(link: `/support?category=account`)*
     - *[only when written]* A note from the team: "…"
   - **Reinstated.** Subject: *"Your Overhype.me account is active again"*. The body says
     the suspension is lifted, you can sign in again, and gives a Sign In button to the
     site.
   The exact copy is settled at build within these points, and David reads it in UAT.
5. **The admin form** gains a second, optional field under the reason: *"Note to the member
   (optional) — this goes in the email they receive. Don't repeat anything you wouldn't
   say to them."* The reason's label stays *"Why? Only admins see this."* The result
   line reports the three outcomes for both actions:
   - *"Suspended. The email to them is queued."*
   - *"Suspended. No email was queued (no address / email isn't set up / it failed —
     see the server log)."*
   - *"Already suspended — no new email."*
   - The unsuspend wording mirrors these.
6. **Docs.** `accounts-and-auth.md` (suspension), Manual chapter 9 (with the help
   regenerated), and a `decisions.md` entry. The entry records that the reason stays
   private, adds a note to the member, and that the two notices are the only mail
   suspension itself sends.

## Data Model and Migration Impact

None. The member note is not stored on the account; the queued email job keeps it. No
schema change and no migration.

## Security, Permissions, and Validation

Both routes keep `requireAdmin` and the self-demotion guard. The note is length-checked on
the server and escaped in HTML. The reason never enters the email path. Address-based
mail is unaffected.

## Testing Plan

API tests in `phase5.suspension.test.ts`, through the real route to the outbox
(`async_jobs`, `queue = 'email'`). They use the outbox opt-in the support route uses, since
a test key otherwise suppresses insertion:
- **A suspension with a note** queues one `account_suspended` email to the member. It
  carries the note and the boilerplate, and the internal reason is in neither the text nor
  the HTML. The response says queued.
- **A suspension without a note** queues the email with no note block.
- **Repeating a suspend, or two concurrent suspends**, queue exactly one email, and the
  repeat's response says no new email. A later, separate suspension after an unsuspend
  queues another.
- **Unsuspending** queues one `account_reinstated` email. A repeated unsuspend queues none
  and says so.
- **For both transitions, nothing is queued** with no email transport, with an account that
  has no address, and with a forced insert failure. The response says not queued, the
  account change stands, and on suspend the sessions are ended.
- **The note's limit**: 1,001 characters is refused with 400, and nothing changes.
- **A template test**: HTML in a note is escaped.
- **A frontend test** for the admin form: two separate fields, only the reason required,
  and the result line for queued, not queued and already-in-that-state.
- The existing five suspension tests and the auth suites still pass.

## UAT (for the PR)

- **T1 (judgement):** suspend a test account with a member note. David reads the email in
  the Email Queue preview, judging whether the explanation reads right to a member.
  Whether the note appears, and that the reason does not, is the automated tests' job.
- **T2 (judgement):** lift the suspension. David reads the reinstated email.
- **R1 (ci):** the internal reason is absent from both emails.
- **R2 (ci):** the support form still accepts a suspended member's message.

## Taken as next, not in this plan

- **A suspended member can still get ordinary emails** (Astra, scope exchange C1). These
  include review notifications, Fact of the Day for a Legendary member, membership-access
  notices, and anything queued before the suspension. Nothing today refuses mail to a
  suspended account except password recovery. That is an existing gap, not something this
  change creates, and closing it means a suppression rule in the email queue with
  exceptions for these two notices. It is filed as Issue #1212, ranked with the
  should-haves.
- **The admin panel showing the note that was sent.** It can be read in the Email Queue for
  now.

## Questions for David

None. Q7 settled the choices this needed; the 2026-10-30 decision settles what the email
says about content and billing.

## Definition of Done

Both emails are queued on real transitions only and carry the right copy. The note reaches
the member, and the reason never does. Account actions succeed regardless of email. Tests
above pass. Docs and help are updated. PR merged and synced.

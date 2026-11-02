# Data Lifecycle & Retention Matrix

| Domain | Tables | Retention Window | Lifecycle Action | Rationale |
|---|---|---:|---|---|
| Auth | `users`, `sessions`, `email_verification_tokens`, `password_reset_tokens` | sessions/token TTL; user account until its owner's deletion request (purged 14 days later), an admin's removal (at once), or 30 days for a sign-up never onboarded | suspension revokes sessions and blocks sign-in, deleting nothing; the deletion purge removes the user row and, by cascade, its sessions and tokens | Security minimization, account recovery windows, consumer deletion rights |
| Profile | profile fields on `users` | until the account deletion purge | removed with the user row at the purge | Data minimization, reduced residual exposure |
| Payments | `membership_entitlements`, `membership_history`, `stripe_checkout_request_ledger` | until the account deletion purge; a billing dispute holds the purge until it is settled | deleted with the user row at the purge (history and ledger explicitly, entitlements by cascade); the financial record of each charge is Stripe's. **Needs David confirmation:** whether any local retention (the old "7 years, anonymised" baseline) is required beyond Stripe's records — the compliance phase's question | Payment records live at Stripe; locally only what the account needs while it exists |
| Social content | `comments`, `facts`, `memes` authored metadata | business-defined content lifetime | facts always kept, credited to a former member (`submitter_deleted_at`); comments, pending submissions, links, votes and hearts kept without the person's name on their own deletion, deleted on an admin's removal; memes deleted | community continuity with privacy protection |
| Uploads | `user_ai_images` + object storage artifacts | until deletion request or product TTL | storage objects and rows removed at the deletion purge, through the 7-day preserve backup; a fact gallery's background is kept | storage cost/control + privacy |
| Logs & analytics | route/event logs, `search_history` | 30-90 day rolling windows | scheduled deletion for obsolete activity trails | observability needs balanced with minimization |

## Operational Controls

- **One deletion engine** (launch Phase 5): a request revokes access and hides the person's memes, uploads and generated images at once, starts cancelling billing (retried until Stripe confirms), and is purged after a 14-day cooling-off ("Keep my account" cancels it) or at once on an admin's removal; a billing dispute holds the purge. Suspension is separate and destroys nothing. Spec: [`accounts-and-auth.md`](ai-context/accounts-and-auth.md#account-lifecycle-suspension-and-deletion).
- **Legal hold path:** a billing dispute holds the account purge until it is settled; NCMEC reports and quarantined memes keep their rows with the person set null. Local payment rows are not retained past the purge today (the Payments row's open question).
- **DSR tooling:** data export is admin-only; account deletion is self-service (re-authenticated) as well as an admin action.
- **Scheduled retention job:** stale invites, expired auth tokens, and aged search history are purged on schedule.

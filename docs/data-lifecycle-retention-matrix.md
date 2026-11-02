# Data Lifecycle & Retention Matrix

| Domain | Tables | Retention Window | Lifecycle Action | Rationale |
|---|---|---:|---|---|
| Auth | `users`, `sessions`, `email_verification_tokens`, `password_reset_tokens` | sessions/token TTL; user account until its owner's deletion request (purged 14 days later), an admin's removal (at once), or 30 days for a sign-up never onboarded | suspension revokes sessions and blocks sign-in, deleting nothing; the deletion purge removes the user row and, by cascade, its sessions and tokens | Security minimization, account recovery windows, consumer deletion rights |
| Profile | profile fields on `users` | until the account deletion purge | removed with the user row at the purge | Data minimization, reduced residual exposure |
| Payments | `subscriptions`, `lifetime_entitlements`, `membership_history` | 7 years (tax/accounting baseline) | irreversible anonymization instead of deletion where financial audit integrity is required | Preserve transaction integrity while removing direct identifiers |
| Social content | `comments`, `facts`, `memes` authored metadata | business-defined content lifetime | facts always kept, credited to a former member (`submitter_deleted_at`); comments, pending submissions, links, votes and hearts kept without the person's name on their own deletion, deleted on an admin's removal; memes deleted | community continuity with privacy protection |
| Uploads | `user_ai_images` + object storage artifacts | until deletion request or product TTL | storage objects and rows removed at the deletion purge, through the 7-day preserve backup; a fact gallery's background is kept | storage cost/control + privacy |
| Logs & analytics | route/event logs, `search_history` | 30-90 day rolling windows | scheduled deletion for obsolete activity trails | observability needs balanced with minimization |

## Operational Controls

- **One deletion engine** (launch Phase 5): a request revokes access and hides content at once, cancels billing, and is purged after a 14-day cooling-off ("Keep my account" cancels it) or at once on an admin's removal; a billing dispute holds the purge. Suspension is separate and destroys nothing. Spec: [`accounts-and-auth.md`](ai-context/accounts-and-auth.md#account-lifecycle-suspension-and-deletion).
- **Legal hold path:** payment-domain records are anonymized, not dropped, when deletion would break fiscal obligations.
- **DSR tooling:** data export is admin-only; account deletion is self-service (re-authenticated) as well as an admin action.
- **Scheduled retention job:** stale invites, expired auth tokens, and aged search history are purged on schedule.

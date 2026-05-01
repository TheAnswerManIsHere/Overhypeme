# Data Lifecycle & Retention Matrix

| Domain | Tables | Retention Window | Lifecycle Action | Rationale |
|---|---|---:|---|---|
| Auth | `users`, `sessions`, `email_verification_tokens`, `password_reset_tokens` | sessions/token TTL; user account until request/closure | soft-delete disables access + revokes sessions; hard-delete removes user and auth artifacts | Security minimization, account recovery windows, consumer deletion rights |
| Profile | profile fields on `users` | until account deletion request | PII nulling during soft-delete; full removal on hard-delete | Data minimization, reduced residual exposure |
| Payments | `subscriptions`, `lifetime_entitlements`, `membership_history` | 7 years (tax/accounting baseline) | irreversible anonymization instead of deletion where financial audit integrity is required | Preserve transaction integrity while removing direct identifiers |
| Social content | `comments`, `facts`, `memes` authored metadata | business-defined content lifetime | retain public content where policy allows, remove direct user linkage (`authorId`/`createdById` null or anonymized) | community continuity with privacy protection |
| Uploads | `user_ai_images` + object storage artifacts | until deletion request or product TTL | remove storage objects at hard-delete, remove metadata links | storage cost/control + privacy |
| Logs & analytics | route/event logs, `search_history` | 30-90 day rolling windows | scheduled deletion for obsolete activity trails | observability needs balanced with minimization |

## Operational Controls

- **Two-phase deletion:** soft-delete first (access revocation), hard-delete second (destructive purge) with audit traces.
- **Legal hold path:** payment-domain records are anonymized, not dropped, when deletion would break fiscal obligations.
- **Admin-only DSR tooling:** export/delete actions are gated to administrator routes.
- **Scheduled retention job:** stale invites, expired auth tokens, and aged search history are purged on schedule.

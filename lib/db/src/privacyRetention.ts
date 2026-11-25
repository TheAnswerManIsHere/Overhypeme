/**
 * @purpose The Privacy page's "How long we keep it" table, as data: each public row names the database tables (`retentionSchedule.ts`) and the stores outside the database it speaks for, so a test can fail when a store of personal data has no row, and the legal-page generator renders the table from here (launch Phase 14, increment 6b; plan increment 6, "The Privacy page's table is rendered from the schedule").
 * @subsystem data-lifecycle
 *
 * Two rules every row keeps (plan, increment 6):
 * - It promises only what a running mechanism or a provider's published
 *   terms support. Where a provider's period depends on an account plan or a
 *   setting the repository cannot show, the row states the longest that
 *   provider allows ("up to"), which stays true whatever the setting.
 * - A provider with no published period is named "under that provider's own
 *   terms", never given a number.
 *
 * The evidence for each store outside the database is the 2026-11-19
 * working-notes comment on Issue #1030 (code lines and provider pages).
 *
 * Changing a row's words changes the rendered Privacy text, so the legal
 * generator's version lock makes the change carry a new Privacy version.
 */

/** A copy of personal data held outside the app's database. */
export interface OffDatabaseStore {
  holds: string;
  period: string;
  mechanism: "app job" | "provider setting" | "provider default" | "provider terms";
}

export const OFF_DATABASE_STORES: Readonly<Record<string, OffDatabaseStore>> = {
  "media-backup": {
    holds: "copies of stored photos, memes and pictures, and a full database dump in each restore point",
    period: "a copy stays while any retained restore point includes it: about 7 days after it is removed from live storage (restore points are kept 7 days, mediaBackup/config.ts BACKUP_RETENTION_DAYS), and the latest complete restore point is kept until a newer one replaces it (mediaBackup/expiry.ts)",
    mechanism: "app job",
  },
  "database-restore": {
    holds: "the database's point-in-time restore history",
    period: "7 days on Replit Core, up to 28 on Pro (replit-platform.md)",
    mechanism: "provider setting",
  },
  "server-logs": {
    holds: "the app's request and error logs",
    period: "30 days (replit-platform.md, Logs)",
    mechanism: "provider default",
  },
  "worker-logs": {
    holds: "the Cloudflare Worker's logs: the address and time of share-preview and image requests",
    period: "3 days on Workers Free, at most 7",
    mechanism: "provider default",
  },
  sentry: {
    holds: "error reports, page-speed samples, feedback sent through its button",
    period: "errors up to 90 days by plan; performance samples up to 13 months on its largest plan",
    mechanism: "provider default",
  },
  "google-analytics": {
    holds: "visits and steps, with a random identifier",
    period: "2 or 14 months, the property's setting",
    mechanism: "provider setting",
  },
  posthog: {
    holds: "visits and steps, with a random identifier",
    period: "1 year on the Free plan this project is on (billing overview, 2026-11-20); 2 years on pay-as-you-go",
    mechanism: "provider default",
  },
  "fal-classifier-photo": {
    holds: "a member's photo, for the upload safety check",
    period: "1 hour (X-Fal-Object-Lifecycle-Preference); the request is not kept (X-Fal-Store-IO: 0)",
    mechanism: "provider setting",
  },
  "fal-generated": {
    holds: "generated pictures and the requests that made them",
    period: "pictures 30 days; request history 90 days (falRetention.ts)",
    mechanism: "provider setting",
  },
  openai: {
    holds: "text sent for writing aids and checks, a first name for pronouns, a photo in some checks",
    period: "up to 30 days (OpenAI's API data controls)",
    mechanism: "provider default",
  },
  resend: {
    holds: "sent emails and their delivery logs",
    period: "30 days (Resend)",
    mechanism: "provider default",
  },
  stripe: {
    holds: "payments and the customer record",
    period: "under Stripe's own terms, including after an account closes where the law requires",
    mechanism: "provider terms",
  },
  "project-arachnid": {
    holds: "uploaded images, for matching against known child sexual abuse material",
    period: "under the Canadian Centre for Child Protection's own terms",
    mechanism: "provider terms",
  },
  cloudflare: {
    holds: "IP addresses and requests, bot-check results, and the routing of email sent to our addresses",
    period: "under Cloudflare's own terms",
    mechanism: "provider terms",
  },
  "support-mailbox": {
    holds: "emails people send to legal@, privacy@, copyright@ and support@overhype.me, and a copy of every contact-page message (sent to support@), forwarded to the site's Gmail mailbox",
    period: "kept in the mailbox until deleted by hand; no automatic deletion and no rule",
    mechanism: "provider terms",
  },
  "sign-in-providers": {
    holds: "what a member approves in Google's or Apple's sign-in screen",
    period: "under Google's or Apple's own terms",
    mechanism: "provider terms",
  },
};

export interface PrivacyRetentionRow {
  /** The "Information" cell, in plain words. */
  information: string;
  /** The "How long" cell. */
  howLong: string;
  /** The database tables (retentionSchedule.ts keys) and off-database stores (OFF_DATABASE_STORES keys) the row speaks for. */
  covers: readonly string[];
}

export const PRIVACY_RETENTION_ROWS: readonly PrivacyRetentionRow[] = [
  {
    information: "Your account",
    howLong: "Until you delete it. Deletion takes effect 14 days after you ask, so you can change your mind; an open payment dispute delays it until the dispute is settled",
    covers: ["users", "account_deletion_requests", "activity_feed", "user_fact_preferences", "image_prompt_attempts", "legal_acceptances"],
  },
  {
    information: "An account that never finished signing up",
    howLong: "Once it is 30 days old it is scheduled for deletion and we email you; it is deleted 14 days later unless you choose to keep it. An account you choose to keep is then kept like any other",
    covers: ["users"],
  },
  {
    information: "Sign-in sessions and sign-in links",
    howLong: "Removed once they expire (a session 7 days after its last use; a sign-in or password link when its time runs out; a Google or Apple sign-in step after 10 minutes), and when your account is deleted",
    covers: ["sessions", "email_verification_tokens", "password_reset_tokens", "oauth_pending_states"],
  },
  {
    information: "Photos, memes and pictures you delete",
    howLong: "Removed 30 days after you delete them. Our backups keep them about 7 more days after that; if newer backups fail, the latest complete backup is kept until a newer one replaces it",
    covers: ["memes", "upload_image_metadata", "user_ai_images", "share_intents", "media-backup"],
  },
  {
    information: "Your photos, memes and pictures when your account is deleted",
    howLong: "Removed when the deletion takes effect, then kept in our backups about 7 more days, under the same backup rule",
    covers: ["memes", "upload_image_metadata", "user_ai_images", "media-backup"],
  },
  {
    information: "Facts you submitted",
    howLong: "Kept in the catalogue after you leave, credited to \"a former member\"",
    covers: ["facts", "pending_reviews"],
  },
  {
    information: "Comments, votes and reactions",
    howLong: "Kept without your name after you leave; deleted if we remove your account for abuse",
    covers: ["comments", "external_links", "reactions"],
  },
  {
    information: "Your searches",
    howLong: "90 days",
    covers: ["search_history"],
  },
  {
    information: "What your pictures cost us",
    howLong: "13 months, and removed when your account is deleted",
    covers: ["user_generation_costs"],
  },
  {
    information: "Payment records",
    howLong: "While your account exists. Stripe keeps its own record of each payment under its terms; records of payment notices are kept 90 days",
    covers: ["membership_entitlements", "entitlement_source_disputes", "membership_history", "stripe_checkout_request_ledger", "stripe_processed_events", "stripe_webhook_audit", "stripe"],
  },
  {
    information: "Messages you send to support",
    howLong: "Our record is kept until your account is deleted, or kept to answer a request you made without an account. Each message also arrives in our mailbox as an email, and that copy is kept until we delete it, as are emails you send to our addresses",
    covers: ["support_requests", "support-mailbox"],
  },
  {
    information: "Records of how each picture was made",
    howLong: "Kept indefinitely, including the account and email address that made it, so a picture can be traced if it is misused",
    covers: ["image_provenance", "image_generation_requests"],
  },
  {
    information: "Abuse limits (your IP address, account, session or an email address you entered)",
    howLong: "While a limit's window runs, which is at most a day (the daily upload limit), then removed within about a day after it ends; a scrambled form of your IP address for preview pictures, 30 days",
    covers: ["rate_limit_counters", "transient_renders"],
  },
  {
    information: "Emails we send you",
    howLong: "Our record of each email is removed 30 days after it was queued. Our email provider, Resend, keeps sent emails and their logs for 30 days",
    covers: ["async_jobs", "resend"],
  },
  {
    information: "Records of what our staff did",
    howLong: "Kept; a staff member's name is removed when their account is deleted",
    covers: [
      "admin_actions", "tier_feature_permission_audit", "fact_taxonomy_runs", "fact_readings", "fact_gags", "fact_gag_examples",
      "prompt_recipe_versions", "prompt_recipe_promotions", "comparison_sets", "comparison_panels",
      "comparison_cells", "comparison_picks", "comparison_runs", "comparison_reservations",
    ],
  },
  {
    information: "Database backups",
    howLong: "Up to 28 days in our hosting provider's restore history, to restore the service after a fault; copies inside our own backups follow the backup rule above",
    covers: ["database-restore", "media-backup"],
  },
  {
    information: "Server and edge logs",
    howLong: "Up to 30 days in our hosting provider's logs, and up to 7 days in our Cloudflare Worker's logs",
    covers: ["server-logs", "worker-logs"],
  },
  {
    information: "Network and security records at Cloudflare (your IP address, requests, bot checks, and the routing of email you send us)",
    howLong: "Under Cloudflare's own terms",
    covers: ["cloudflare"],
  },
  {
    information: "Emails you send to our addresses (legal@, privacy@, copyright@, support@)",
    howLong: "Kept in our mailbox until we delete them",
    covers: ["support-mailbox"],
  },
  {
    information: "Error reports (Sentry)",
    howLong: "Up to 90 days; page-speed samples up to 13 months",
    covers: ["sentry"],
  },
  {
    information: "Visit statistics (Google Analytics and PostHog)",
    howLong: "Up to 14 months in Google Analytics and up to 2 years in PostHog",
    covers: ["google-analytics", "posthog"],
  },
  {
    information: "Your photo, when we check it for safety at upload",
    howLong: "fal.ai is asked to delete it within an hour and not to keep the request. Photos checked before we put this in place follow fal.ai's account settings",
    covers: ["fal-classifier-photo"],
  },
  {
    information: "Pictures made by AI, at fal.ai",
    howLong: "fal.ai is asked to delete each picture after 30 days and keeps its request for up to 90 days. Pictures made before we put this in place follow fal.ai's account settings. We keep our own copy as described above",
    covers: ["fal-generated"],
  },
  {
    information: "Text and images sent to OpenAI",
    howLong: "Up to 30 days, under OpenAI's API data controls",
    covers: ["openai"],
  },
  {
    information: "Images checked against known child sexual abuse material, and sign-ins through Google or Apple",
    howLong: "Under the Canadian Centre for Child Protection's, Google's and Apple's own terms",
    covers: ["project-arachnid", "sign-in-providers"],
  },
  {
    information: "Child-safety evidence and reports",
    howLong: "As long as the law requires, and longer if we must preserve it",
    covers: ["quarantined_memes", "ncmec_reports", "ncmec_safety_audit_log"],
  },
];

/** Escapes a cell for a Markdown table. */
function cell(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/** The table as Markdown, for the Privacy page's `{{retention-table}}` line. */
export function renderPrivacyRetentionTable(rows: readonly PrivacyRetentionRow[] = PRIVACY_RETENTION_ROWS): string {
  return [
    "| Information | How long |",
    "|---|---|",
    ...rows.map((r) => `| ${cell(r.information)} | ${cell(r.howLong)} |`),
  ].join("\n");
}

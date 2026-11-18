/**
 * @purpose The retention schedule for the database: for every table, whether it holds personal data, how long its rows are kept, and what actually enforces that, so no table can exist without a stated rule (launch Phase 14, increment 6, plan S-h).
 * @subsystem data-lifecycle
 *
 * What enforces a rule is one of:
 *   - `job`: a job in the daily maintenance run (api-server lib/maintenance.ts,
 *     named by its id), which a test holds to that list;
 *   - `with-parent`: the rows go when the named parent row goes;
 *   - `account-deletion`: deleted, or stripped of the person, when the
 *     account is purged (itself the `account-deletion` job);
 *   - `kept`: kept on purpose, with the reason (or the decision) that says so;
 *   - `legal-hold`: kept because the law requires it (the child-safety
 *     records; increment 7 adds their purge after filing);
 *   - `gap`: no rule is enforced yet. Named so it is visible, never hidden;
 *     each says what would close it.
 *
 * A table may carry several rules (a meme goes at its account's purge and
 * after its restore window). The tests (api-server
 * `retentionSchedule.test.ts`) fail when a table exists that this file does
 * not name, when it names one that does not exist, and when a `job` rule
 * names a job the maintenance run does not have.
 *
 * Scope here is the database. Backups, monitoring and vendors' copies, and the
 * Privacy page's table rendered from this, are the increment's second part.
 */

export type RetentionRule =
  | { kind: "job"; job: string; window: string }
  | { kind: "with-parent"; parent: string }
  | { kind: "account-deletion"; effect: "deleted" | "anonymised" }
  | { kind: "kept"; reason: string }
  | { kind: "legal-hold"; reason: string }
  | { kind: "gap"; closeBy: string };

export interface RetentionEntry {
  /** What personal data a row holds, in a few words; null for none. */
  personal: string | null;
  rules: readonly RetentionRule[];
}

const configKept: RetentionEntry = { personal: null, rules: [{ kind: "kept", reason: "configuration: how the system behaves" }] };
const systemKept = (reason: string): RetentionEntry => ({ personal: null, rules: [{ kind: "kept", reason }] });
const adminRecord = (parent: string | null, reason: string): RetentionEntry => ({
  personal: "an admin's account id (cleared when that account is deleted)",
  rules: parent ? [{ kind: "with-parent", parent }, { kind: "kept", reason }] : [{ kind: "kept", reason }],
});

const PAYMENT_LEDGER = "payment records, kept while the account exists; the purge removes them and Stripe keeps the financial record";

export const RETENTION_SCHEDULE: Readonly<Record<string, RetentionEntry>> = {
  // ── Accounts and sign-in ─────────────────────────────────────────────────
  users: {
    personal: "email, name, birth date, pronouns, profile picture, password hash, marketing consent",
    rules: [{ kind: "account-deletion", effect: "deleted" }],
  },
  sessions: {
    personal: "the account a session belongs to",
    rules: [
      { kind: "job", job: "expired-sessions", window: "until it expires (7 days after its last use)" },
      { kind: "account-deletion", effect: "deleted" },
    ],
  },
  email_verification_tokens: {
    personal: "the account and the email address being verified",
    rules: [{ kind: "job", job: "retention-windows", window: "until it expires" }, { kind: "account-deletion", effect: "deleted" }],
  },
  password_reset_tokens: {
    personal: "the account",
    rules: [{ kind: "job", job: "retention-windows", window: "until it expires" }, { kind: "account-deletion", effect: "deleted" }],
  },
  oauth_pending_states: {
    personal: "the account being linked, during a Google or Apple sign-in",
    rules: [{ kind: "job", job: "expired-sign-in-states", window: "10 minutes" }, { kind: "account-deletion", effect: "deleted" }],
  },
  account_deletion_requests: {
    personal: "the account, who asked, and any hold reason",
    rules: [{ kind: "account-deletion", effect: "deleted" }],
  },

  // ── What members make ────────────────────────────────────────────────────
  facts: {
    personal: "who submitted it",
    rules: [
      { kind: "account-deletion", effect: "anonymised" },
      { kind: "kept", reason: "facts persist, credited to a former member (decisions.md, account deletion)" },
    ],
  },
  pending_reviews: {
    personal: "the submitter and the submitted text",
    rules: [
      { kind: "account-deletion", effect: "anonymised" },
      { kind: "kept", reason: "submissions stay with the community, without the person's name (decisions.md, account deletion)" },
    ],
  },
  comments: {
    personal: "the author and what they wrote",
    rules: [
      { kind: "account-deletion", effect: "anonymised" },
      { kind: "with-parent", parent: "facts" },
      { kind: "kept", reason: "comments stay with the community, without the person's name (decisions.md, account deletion)" },
    ],
  },
  external_links: {
    personal: "who added it",
    rules: [
      { kind: "account-deletion", effect: "anonymised" },
      { kind: "with-parent", parent: "facts" },
      { kind: "kept", reason: "links stay with the community, without the person's name (decisions.md, account deletion)" },
    ],
  },
  reactions: {
    personal: "who voted or hearted what",
    rules: [
      { kind: "account-deletion", effect: "anonymised" },
      { kind: "kept", reason: "votes stay in every total, without the person's name (decisions.md, account deletion)" },
    ],
  },
  memes: {
    personal: "the maker, the meme's text and picture",
    rules: [
      { kind: "job", job: "content-purge", window: "deleted ones, after the restore window (30 days)" },
      { kind: "account-deletion", effect: "deleted" },
      { kind: "with-parent", parent: "facts" },
    ],
  },
  upload_image_metadata: {
    personal: "an uploaded photo and its owner",
    rules: [
      { kind: "job", job: "content-purge", window: "deleted ones, after the restore window (30 days)" },
      { kind: "account-deletion", effect: "deleted" },
    ],
  },
  user_ai_images: {
    personal: "a generated picture of a person and its owner",
    rules: [
      { kind: "job", job: "content-purge", window: "deleted ones, after the restore window (30 days)" },
      { kind: "account-deletion", effect: "deleted" },
    ],
  },
  share_intents: {
    personal: "who shared which meme where",
    rules: [{ kind: "account-deletion", effect: "deleted" }, { kind: "with-parent", parent: "memes" }],
  },
  search_history: {
    personal: "a member's searches",
    rules: [{ kind: "job", job: "retention-windows", window: "90 days" }, { kind: "account-deletion", effect: "deleted" }],
  },
  user_fact_preferences: {
    personal: "when a member last saw a fact",
    rules: [{ kind: "account-deletion", effect: "deleted" }, { kind: "with-parent", parent: "facts" }],
  },
  activity_feed: {
    personal: "a member's activity entries",
    rules: [{ kind: "account-deletion", effect: "deleted" }],
  },
  user_generation_costs: {
    personal: "an account id against what its pictures cost",
    rules: [
      {
        kind: "gap",
        closeBy:
          "nothing deletes these rows, and the account purge does not reach them (no foreign key), so the account id outlives the account; deciding a window (the monthly spend limit needs only the current month) closes it",
      },
    ],
  },

  // ── How pictures were made ───────────────────────────────────────────────
  image_provenance: {
    personal: "the account id and email of whoever made a picture",
    rules: [
      { kind: "job", job: "image-provenance", window: "the image_provenance.retention_days setting; 0 (the default) keeps it" },
      { kind: "kept", reason: "the provenance record outlives deletion, indefinitely by default (decisions.md 2026-11-10)" },
    ],
  },
  image_generation_requests: {
    personal: "the account id and email of whoever asked, and the request sent to the engine",
    rules: [
      { kind: "job", job: "image-provenance", window: "with its provenance records, under the same setting" },
      { kind: "kept", reason: "part of the provenance record (decisions.md 2026-11-10)" },
    ],
  },
  image_prompt_attempts: {
    personal: "a description of a member's photo and the account (cleared when the account is deleted)",
    rules: [
      { kind: "with-parent", parent: "facts" },
      {
        kind: "gap",
        closeBy: "the photo description stays after the account and the photo are gone; a window, or clearing it at the purge, closes it",
      },
    ],
  },
  transient_renders: {
    personal: "a hashed IP address, and the account (cleared when the account is deleted)",
    rules: [{ kind: "job", job: "transient-renders", window: "the transient_renders.retention_days setting (30 days)" }],
  },

  // ── Payments ─────────────────────────────────────────────────────────────
  membership_entitlements: { personal: "the account and its Stripe references", rules: [{ kind: "account-deletion", effect: "deleted" }] },
  entitlement_source_disputes: { personal: "a Stripe dispute reference", rules: [{ kind: "with-parent", parent: "membership_entitlements" }] },
  membership_history: { personal: "the account and its Stripe payment references", rules: [{ kind: "account-deletion", effect: "deleted" }, { kind: "kept", reason: PAYMENT_LEDGER }] },
  stripe_checkout_request_ledger: { personal: "the account and its checkout session", rules: [{ kind: "account-deletion", effect: "deleted" }, { kind: "kept", reason: PAYMENT_LEDGER }] },
  membership_leases: systemKept("short-lived locks released by the code that took them"),
  stripe_processed_events: systemKept("Stripe event ids, kept so a replayed event is never applied twice"),
  stripe_webhook_audit: {
    personal: null,
    rules: [{ kind: "gap", closeBy: "nothing deletes these rows; whether `detail` can hold a customer reference is unverified, and a window (it is read for recent deliveries only) closes it" }],
  },

  // ── Child safety ─────────────────────────────────────────────────────────
  quarantined_memes: { personal: "the uploader and the preserved evidence", rules: [{ kind: "legal-hold", reason: "18 U.S.C. § 2258A preservation; increment 7 deletes evidence only after filing plus the retention period" }] },
  ncmec_reports: { personal: "the uploader's details a report needs", rules: [{ kind: "legal-hold", reason: "18 U.S.C. § 2258A; increment 7 sets the period from the filing" }] },
  ncmec_safety_audit_log: { personal: "the admin who acted", rules: [{ kind: "legal-hold", reason: "the audit trail of the reports it records" }] },

  // ── Background work and runtime ──────────────────────────────────────────
  async_jobs: {
    personal: "what a job was given (an email job carries its recipient)",
    rules: [{ kind: "job", job: "finished-jobs", window: "finished rows, each queue's retention setting (30 days)" }],
  },
  rate_limit_counters: {
    personal: "the IP address, session or email a limit counts",
    rules: [{ kind: "job", job: "rate-limit-counters", window: "until the counter expires, plus 5 minutes" }],
  },
  worker_lane_heartbeats: systemKept("worker liveness, pruned by the worker itself"),
  fact_gag_fold_archive: systemKept("the reversal record of the gag fold (migration 0147)"),
  reference_research_cache: systemKept("cached research about a fact"),
  fal_pricing_cache: systemKept("engine prices"),
  entitlement_grid_revision: systemKept("a version counter"),
  feature_permissions_migration_log: systemKept("a migration's record"),

  // ── Admin records (an admin's account id, cleared at that account's deletion) ─
  admin_actions: adminRecord(null, "the record of moderation decisions"),
  engine_revision_bumps: adminRecord(null, "the record of engine changes"),
  tier_feature_permission_audit: adminRecord(null, "the record of entitlement changes"),
  enrichment_override_history: adminRecord("facts", "a fact's edit record"),
  fact_enrichment_versions: adminRecord("facts", "a fact's enrichment record"),
  fact_readings: adminRecord("facts", "a fact's readings: the research and draft humor note of each run"),
  fact_text_edit_history: adminRecord("facts", "a fact's edit record"),
  fact_gags: adminRecord("facts", "a fact's gags"),
  fact_gag_examples: adminRecord("fact_gags", "a gag's examples"),
  eval_runs: adminRecord(null, "prompt evaluation results"),
  prompt_recipe_versions: adminRecord(null, "prompt wording, never edited"),
  prompt_recipe_promotions: adminRecord(null, "which prompt wording was live when"),
  comparison_sets: adminRecord(null, "engine comparison data"),
  comparison_panels: adminRecord("comparison_sets", "engine comparison data"),
  comparison_cells: adminRecord("comparison_panels", "engine comparison data"),
  comparison_picks: adminRecord("comparison_panels", "engine comparison judgements"),
  comparison_runs: adminRecord("comparison_sets", "engine comparison runs"),
  comparison_reservations: adminRecord("comparison_runs", "engine comparison spend"),
  hashtags: systemKept("the hashtag list"),
  fact_hashtags: { personal: null, rules: [{ kind: "with-parent", parent: "facts" }] },

  // ── Configuration ────────────────────────────────────────────────────────
  admin_config: configKept,
  feature_flags: configKept,
  look_styles: configKept,
  tier_feature_permissions: configKept,
};

/**
 * @purpose The one committed classification of every table in the public schema — product data, configuration, runtime state, or one of the excluded classes — and, for each configuration table, which columns the code, an admin, or the runtime owns.
 * @subsystem data-lifecycle
 *
 * Launch Phase 3, increment 3 (#770; plan docs/plans/PLAN_PHASE3_DATA_ENVIRONMENTS.md
 * §3). What it is for:
 *
 *   - the config diff (artifacts/api-server/scripts/config-diff.ts) compares the
 *     configuration tables of an existing database against a freshly built one,
 *     and reads from here which differences are a missing seed (code-owned), an
 *     operator's setting (admin-owned) or noise (runtime-owned);
 *   - the boot-preservation test sets every admin-owned column, reboots, and
 *     reads it back;
 *   - a test fails when a table exists that this file does not name, or a
 *     configuration table has a column no owner claims, so a table or column
 *     added later cannot slip past the diff.
 *
 * Classes:
 *   - `product`  — users and what they make. Disposable before launch (the
 *                  2026-08-28 decision), never seeded, never diffed.
 *   - `config`   — decisions about how the system behaves. Code-owned values
 *                  must come from a migration or a boot seed; admin-owned
 *                  values are an operator's to set and no boot may overwrite.
 *   - `runtime`  — counters, caches, heartbeats, logs and audit trails the
 *                  system writes for itself.
 *   - `excluded` — the four row classes the 2026-08-28 decision keeps out of
 *                  "disposable" (excludedClassesInventory.ts reads them):
 *                  sessions and auth state, non-terminal jobs, child-safety
 *                  records, and payment records.
 */

export type TableClass = "product" | "config" | "runtime" | "excluded";

export type ExcludedClass = "sessions" | "jobs" | "childSafety" | "payments";

export interface ConfigOwnership {
  /** Columns that identify a row; a row missing from a fresh build is a missing seed. */
  key: readonly string[];
  /** Set by migrations, seeds or boot reconciliation; a difference is a gap in code. */
  code: readonly string[];
  /** An operator's to set; no boot overwrites them. A difference is an operator setting. */
  admin: readonly string[];
  /** Timestamps and bookkeeping; ignored. */
  runtime: readonly string[];
  /**
   * An admin-owned column that is admin-owned only on the rows a SQL predicate
   * selects; on every other row the code owns it. Engines' endpoint_id: the
   * model an LLM engine calls is an admin's choice, a media engine's endpoint
   * is re-asserted from code on every boot (engines/reconcile.ts).
   */
  adminOnlyWhere?: Readonly<Record<string, string>>;
  /**
   * An admin can create rows here, not only change them: a row the target
   * holds and code does not produce is then an operator's setting, not a
   * missing seed. The entitlement grid: toggling a cell upserts its row.
   */
  adminMayAddRows?: boolean;
}

export type TableEntry =
  | { class: "product" | "runtime" }
  | { class: "excluded"; excluded: ExcludedClass }
  | { class: "config"; columns: ConfigOwnership };

export const TABLE_CLASSIFICATION: Readonly<Record<string, TableEntry>> = {
  // ── Configuration ─────────────────────────────────────────────────────────
  admin_config: {
    class: "config",
    columns: {
      key: ["key"],
      // Seeded by migrations and ensureSchema() with ON CONFLICT DO NOTHING.
      code: ["data_type", "label", "description", "min_value", "max_value", "is_public"],
      // PATCH /admin/config/:key writes value and value_label.
      admin: ["value", "value_label"],
      runtime: ["updated_at", "updated_by_id"],
    },
  },
  engines: {
    class: "config",
    columns: {
      key: ["id"],
      // reconcileEngines() rewrites these on every boot (engines/reconcile.ts).
      code: [
        "provider",
        "label",
        "description",
        "kind",
        "allowed_resolutions",
        "allowed_aspect_ratios",
        "param_schema",
      ],
      // ADMIN_EDITABLE_FIELDS (engines/types.ts) plus the soft-delete tombstone;
      // a test holds the two lists equal.
      admin: [
        "is_active",
        "is_default",
        "sort_order",
        "tier_requirement",
        "feature_flag_required",
        "default_resolution",
        "default_aspect_ratio",
        "expected_run_ms",
        "estimated_cost_usd_per_call",
        "endpoint_id",
        "default_temperature",
        "default_max_tokens",
        "default_reasoning_effort",
        "deleted_at",
      ],
      runtime: ["created_at", "updated_at"],
      adminOnlyWhere: { endpoint_id: "provider = 'openai'" },
    },
  },
  feature_flags: {
    class: "config",
    // The feature registry, written by migrations only.
    columns: { key: ["key"], code: ["display_name", "description"], admin: [], runtime: ["created_at"] },
  },
  look_styles: {
    class: "config",
    // Seeded by migration 0057 onward; no admin route writes it.
    columns: {
      key: ["id"],
      code: ["label", "description", "prompt_suffix", "prompt_suffix_reference", "preview_image_path", "sort_order", "is_active"],
      admin: [],
      runtime: ["created_at", "updated_at"],
    },
  },
  tier_feature_permissions: {
    class: "config",
    // The entitlement grid: rows seeded by migrations, `enabled` toggled by an
    // admin (featureAccess.ts setTierFeaturePermission).
    columns: { key: ["tier", "feature_key"], code: [], admin: ["enabled"], runtime: ["updated_at"], adminMayAddRows: true },
  },

  // ── Runtime state ─────────────────────────────────────────────────────────
  engine_revision_bumps: { class: "runtime" },
  entitlement_grid_revision: { class: "runtime" },
  fal_pricing_cache: { class: "runtime" },
  feature_permissions_migration_log: { class: "runtime" },
  rate_limit_counters: { class: "runtime" },
  reference_research_cache: { class: "runtime" },
  tier_feature_permission_audit: { class: "runtime" },
  transient_renders: { class: "runtime" },
  worker_lane_heartbeats: { class: "runtime" },

  // ── Excluded classes ──────────────────────────────────────────────────────
  sessions: { class: "excluded", excluded: "sessions" },
  email_verification_tokens: { class: "excluded", excluded: "sessions" },
  password_reset_tokens: { class: "excluded", excluded: "sessions" },
  oauth_pending_states: { class: "excluded", excluded: "sessions" },
  async_jobs: { class: "excluded", excluded: "jobs" },
  ncmec_reports: { class: "excluded", excluded: "childSafety" },
  ncmec_safety_audit_log: { class: "excluded", excluded: "childSafety" },
  quarantined_memes: { class: "excluded", excluded: "childSafety" },
  entitlement_source_disputes: { class: "excluded", excluded: "payments" },
  membership_entitlements: { class: "excluded", excluded: "payments" },
  membership_history: { class: "excluded", excluded: "payments" },
  membership_leases: { class: "excluded", excluded: "payments" },
  stripe_checkout_request_ledger: { class: "excluded", excluded: "payments" },
  stripe_processed_events: { class: "excluded", excluded: "payments" },
  stripe_webhook_audit: { class: "excluded", excluded: "payments" },

  // ── Product data ──────────────────────────────────────────────────────────
  activity_feed: { class: "product" },
  comments: { class: "product" },
  enrichment_override_history: { class: "product" },
  eval_runs: { class: "product" },
  external_links: { class: "product" },
  fact_enrichment_versions: { class: "product" },
  fact_hashtags: { class: "product" },
  fact_text_edit_history: { class: "product" },
  facts: { class: "product" },
  hashtags: { class: "product" },
  image_prompt_attempts: { class: "product" },
  memes: { class: "product" },
  pending_reviews: { class: "product" },
  reactions: { class: "product" },
  search_history: { class: "product" },
  share_intents: { class: "product" },
  upload_image_metadata: { class: "product" },
  user_ai_images: { class: "product" },
  user_fact_preferences: { class: "product" },
  user_generation_costs: { class: "product" },
  users: { class: "product" },
};

/** The configuration tables and their column ownership, in a stable order. */
export function configTables(): Array<[string, ConfigOwnership]> {
  return Object.entries(TABLE_CLASSIFICATION)
    .flatMap(([t, e]) => (e.class === "config" ? [[t, e.columns] as [string, ConfigOwnership]] : []))
    .sort(([a], [b]) => a.localeCompare(b));
}

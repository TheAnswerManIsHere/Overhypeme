/**
 * The NCMEC `admin_config` keys, and which of them the generic config route
 * refuses to write.
 *
 * Migration 0097 seeds these keys into `admin_config`, and the pre-existing
 * generic `PATCH /admin/config/:key` route writes any key that exists there
 * after validating nothing but data type and min/max. Without the reserved list
 * below, the moment 0097 landed an admin could set
 * `ncmec_submission_enabled = true` and `ncmec_ispws_environment = production`
 * through a route that knows nothing about backlog audits — and once the worker
 * and reconciler register, that configuration files real reports with the
 * activation gate bypassed.
 *
 * The guarded write path that *does* own these keys (`POST /admin/safety/config`,
 * with its Zod contract, its mandatory audit row, and the tuple-gated activation
 * check) arrives with the rest of the admin surface. Until then the reserved
 * keys are writable by nothing at all, which is the right posture for a period
 * when the worker is being built.
 */

/**
 * Keys that can cause or authorize a filing. This is the whole reserved set —
 * membership is "could this write make us file, or make filing permissible?",
 * not "is this key NCMEC-related".
 */
export const NCMEC_RESERVED_CONFIG_KEYS = [
  /** The master switch. */
  "ncmec_submission_enabled",
  /** Chooses between exttest (nothing is filed for real) and production. */
  "ncmec_ispws_environment",
  /** Whether classifier-sourced quarantines are filed at all. */
  "ncmec_report_classifier_hits",
  /** Bounds the backlog audit's scope, which is what the activation gate checks against. */
  "ncmec_backlog_audit_cutoff",
  /** Marks the backlog audit complete, which is the activation gate's precondition. */
  "ncmec_backlog_audit_completed_at",
] as const;

export type NcmecReservedConfigKey = typeof NCMEC_RESERVED_CONFIG_KEYS[number];

const RESERVED = new Set<string>(NCMEC_RESERVED_CONFIG_KEYS);

export function isNcmecReservedConfigKey(key: string): boolean {
  return RESERVED.has(key);
}

/**
 * Keys 0097 seeds that are deliberately NOT reserved.
 *
 * `ncmec_safety_alert_email` cannot cause a filing, and reserving it would make
 * a routine operational edit need a bespoke endpoint. The two retry keys are
 * ordinary editable integers whose *combination* sets the retry horizon, so no
 * per-key bound can express the constraint; they carry min/max in the seed.
 *
 * **Their real protections do not exist yet, and this comment used to describe
 * them as though they did.** The generic route validates data type and min/max
 * and nothing else, so today an admin can write any nonempty string to
 * `ncmec_safety_alert_email` or move either retry key independently of the
 * other. The three checks that make these keys safe to leave unreserved —
 * refusing a write that would empty or invalidate the alert recipient while
 * production is live, and validating the *resulting* retry schedule rather than
 * each key alone — belong to the guarded write path (`POST /admin/safety/config`)
 * and land with it in phase 6, alongside the activation gate that is the other
 * half of the same guarantee.
 *
 * That deferral is safe rather than merely scheduled, and the reason is
 * structural: every one of those invariants is conditioned on production filing
 * being live, and `ncmec_submission_enabled` is reserved above and seeded
 * `false`. Until phase 6 ships the only writer that could turn it on, the
 * precondition is unreachable, so there is no window in which an unvalidated
 * write to these three keys can affect a filing.
 *
 * Phase 6 must not treat the reserved list as the whole of its config story:
 * these three keys need the cross-key and live-state checks above at the same
 * moment the master switch becomes writable. Tracked as a known gap on the PR.
 */
export const NCMEC_UNRESERVED_CONFIG_KEYS = [
  "ncmec_safety_alert_email",
  "async_job_ncmec_submit_max_attempts",
  "async_job_ncmec_submit_retry_delay_4_ms",
] as const;

/** Every key migration 0097 seeds, reserved or not. */
export const NCMEC_SEEDED_CONFIG_KEYS = [
  ...NCMEC_RESERVED_CONFIG_KEYS,
  ...NCMEC_UNRESERVED_CONFIG_KEYS,
] as const;

/** The refusal a reserved key gets from the generic route. */
export const NCMEC_RESERVED_KEY_REFUSAL =
  "This key controls NCMEC CyberTipline filing and cannot be written through the generic config route. Use the safety admin surface, which validates the resulting configuration before applying it.";

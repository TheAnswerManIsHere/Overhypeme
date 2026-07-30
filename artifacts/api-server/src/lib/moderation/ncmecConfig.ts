/**
 * The NCMEC `admin_config` keys, and which of them the generic config route
 * refuses to write.
 *
 * Migration 0095 seeds these keys into `admin_config`, and the pre-existing
 * generic `PATCH /admin/config/:key` route writes any key that exists there
 * after validating nothing but data type and min/max. Without the reserved list
 * below, the moment 0095 landed an admin could set
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
 * Keys 0095 seeds that are deliberately NOT reserved.
 *
 * `ncmec_safety_alert_email` cannot cause a filing, and reserving it would make
 * a routine operational edit need a bespoke endpoint. It is guarded somewhere
 * stronger instead: activation is refused unless a recipient resolves, and the
 * generic route refuses a write that would empty or invalidate it while
 * production is live.
 *
 * The two retry keys are ordinary editable integers whose *combination* sets
 * the retry horizon, so no per-key bound can express the constraint. They carry
 * min/max in the seed, and the guarded write path validates the resulting
 * schedule.
 */
export const NCMEC_UNRESERVED_CONFIG_KEYS = [
  "ncmec_safety_alert_email",
  "async_job_ncmec_submit_max_attempts",
  "async_job_ncmec_submit_retry_delay_4_ms",
] as const;

/** Every key migration 0095 seeds, reserved or not. */
export const NCMEC_SEEDED_CONFIG_KEYS = [
  ...NCMEC_RESERVED_CONFIG_KEYS,
  ...NCMEC_UNRESERVED_CONFIG_KEYS,
] as const;

/** The refusal a reserved key gets from the generic route. */
export const NCMEC_RESERVED_KEY_REFUSAL =
  "This key controls NCMEC CyberTipline filing and cannot be written through the generic config route. Use the safety admin surface, which validates the resulting configuration before applying it.";

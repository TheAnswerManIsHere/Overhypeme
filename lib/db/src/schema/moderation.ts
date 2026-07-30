import {
  bigint,
  bigserial,
  boolean,
  check,
  index,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  integer,
} from "drizzle-orm/pg-core";
import { isNull, sql } from "drizzle-orm";
import { usersTable } from "./auth";
import { memesTable } from "./memes";

/**
 * Quarantine ledger. Separated from `memes` so we can record holds that
 * happen *before* a meme row exists (failed Arachnid scan on upload, fal
 * safety trip during generation, classifier reject). Rows are soft-deleted
 * only — preservation rules are enforced via {@link ncmecReportsTable}.
 */
export const quarantinedMemesTable = pgTable("quarantined_memes", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  memeId: integer("meme_id").references(() => memesTable.id, { onDelete: "set null" }),
  userId: varchar("user_id").references(() => usersTable.id, { onDelete: "set null" }),
  /** Object-storage path under the `restricted/quarantine/...` prefix. Never publicly served. */
  evidenceObjectPath: text("evidence_object_path").notNull(),
  /** Which check produced the hit. */
  source: varchar("source", { length: 20 }).notNull(),
  /** Match precision when `source = 'arachnid'`. */
  matchType: varchar("match_type", { length: 10 }),
  /** Vendor classification label when applicable. */
  classification: varchar("classification", { length: 40 }),
  classifierScore: numeric("classifier_score", { precision: 6, scale: 4 }),
  classifierModel: text("classifier_model"),
  /** Full vendor payload for audit. */
  rawResponse: jsonb("raw_response"),
  /**
   * Where the imagery came from, frozen at quarantine time. Nullable — null
   * means genuinely unknown, and the report omits the annotation rather than
   * guessing. Keep in lockstep with the CHECK constraint in 0095.
   */
  contentOrigin: varchar("content_origin", { length: 16 }).$type<ContentOrigin>(),
  /**
   * The reportability decision as of quarantine time, frozen.
   *
   * Nullable, and **null is not false**: it means "pre-migration, intent
   * unknowable". Null intent splits by `source` — `arachnid` rows are still
   * recovered by the orphan sweep (that rule never depended on config), every
   * other source is skipped and surfaced to an operator instead.
   */
  reportIntent: boolean("report_intent"),
  /** Uploader identity as of quarantine time. Frozen here first, then copied to the report. */
  reporterSnapshot: jsonb("reporter_snapshot"),
  /** Request context captured at quarantine time, so a report can be rebuilt from this row alone. */
  requestMetadata: jsonb("request_metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  /** Soft-delete tombstone. Live rows have NULL. */
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (t) => [
  index("IDX_quarantined_user_created").on(t.userId, t.createdAt.desc()),
  index("IDX_quarantined_source_created").on(t.source, t.createdAt.desc()),
  index("IDX_quarantined_live").on(t.id).where(isNull(t.deletedAt)),
  // Mirrors 0095's raw CHECK — see the note on `ncmecReportsTable`'s indexes for
  // why an object that exists only in a numbered migration is not safe here.
  check(
    "quarantined_memes_content_origin_check",
    sql`${t.contentOrigin} IS NULL OR ${t.contentOrigin} IN ('generated','user_upload','stock','template','identity')`,
  ),
]);

export type QuarantinedMeme = typeof quarantinedMemesTable.$inferSelect;
export type InsertQuarantinedMeme = typeof quarantinedMemesTable.$inferInsert;

/**
 * NCMEC CyberTipline report ledger. Real submission is out-of-band (operator
 * task); this table stubs the interface so the future submission worker is
 * a drop-in. Rows hold the evidence path that legal preservation (US 18 USC
 * § 2258A) requires us to keep for ≥90 days.
 */
export const ncmecReportsTable = pgTable("ncmec_reports", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  /** Tipline report id once real submission lands. NULL while `pending`. */
  reportId: varchar("report_id", { length: 64 }),
  submittedAt: timestamp("submitted_at", { withTimezone: true }),
  /** Which signal triggered the report. `arachnid` matches are always reported; `classifier` reports are gated by config. */
  matchSource: varchar("match_source", { length: 16 }).notNull(),
  /** Path to preserved evidence in the restricted prefix. Must NOT be publicly readable. */
  evidenceUri: text("evidence_uri").notNull(),
  /** Earliest moment the evidence may be deleted (default now() + 90 days). */
  evidenceRetentionUntil: timestamp("evidence_retention_until", { withTimezone: true })
    .notNull()
    .default(sql`now() + interval '90 days'`),
  userId: varchar("user_id").references(() => usersTable.id, { onDelete: "set null" }),
  requestMetadata: jsonb("request_metadata"),
  submissionStatus: varchar("submission_status", { length: 16 })
    .notNull()
    .default("pending")
    .$type<NcmecSubmissionStatus>(),

  // ─── Submission lifecycle (0095) ──────────────────────────────────────────

  /** When `/finish` returned 0. */
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  /**
   * Stamped immediately BEFORE the `/finish` call and cleared once its outcome
   * is known. A `/finish` can outlive the lease that authorized it, so this is
   * what makes the in-flight count an issued filing rather than only an
   * unexpired lease.
   */
  finishStartedAt: timestamp("finish_started_at", { withTimezone: true }),
  /**
   * Submission attempts against NCMEC. Incremented in a fenced update
   * immediately before `/submit` — not at lease acquisition, which happens
   * before the retract-first resolution and would count attempts in which
   * nothing was ever submitted.
   */
  attemptCount: integer("attempt_count").notNull().default(0),
  lastError: text("last_error"),
  /** ISPWS response code. Classify by code, never by parsing `lastError`. */
  lastErrorCode: integer("last_error_code"),
  /** Which host received it: `test` or `production`. */
  submissionEnvironment: varchar("submission_environment", { length: 16 }),
  /** `[{ fileId, md5 }]` from `/upload`. */
  uploadedFiles: jsonb("uploaded_files"),
  retractedAt: timestamp("retracted_at", { withTimezone: true }),
  /** Fencing token for the submission window. Per-invocation, NOT a worker id. */
  submissionLeaseOwner: text("submission_lease_owner"),
  submissionLeaseUntil: timestamp("submission_lease_until", { withTimezone: true }),
  /** Filed by a human through the manual form. */
  manuallyFiledAt: timestamp("manually_filed_at", { withTimezone: true }),
  /** A test-environment submission, which is **not** a filing. */
  testSubmittedAt: timestamp("test_submitted_at", { withTimezone: true }),
  /** A `send-to-test` attempt is open. Set with a null `testReportId` means `exttest` may hold a submission whose id was lost. */
  testSubmissionStartedAt: timestamp("test_submission_started_at", { withTimezone: true }),
  /** The id `exttest` assigned, kept for debugging. */
  testReportId: varchar("test_report_id", { length: 64 }),
  /** Upstream linkage, so an orphaned quarantine row is findable by query rather than by inference. */
  quarantineId: bigint("quarantine_id", { mode: "number" })
    .references(() => quarantinedMemesTable.id, { onDelete: "set null" }),
  /**
   * When this row entered terminal `failed`, by the database clock. Written by
   * every path that finalizes a row `failed`, in the same transaction as the
   * status write. Also the generation marker `alertNotifiedAt` is bound to.
   */
  failedAt: timestamp("failed_at", { withTimezone: true }),
  /**
   * When an attempt last failed, terminal or not. `failedAt` covers only
   * terminal rows, so without this the admin surface cannot answer "is this row
   * failing right now?" for the retrying population — which during an outage is
   * most of the table.
   */
  lastAttemptFailedAt: timestamp("last_attempt_failed_at", { withTimezone: true }),
  /**
   * When this row's failure notification actually sent. Stamped only where
   * `(id, failedAt)` still matches, so it is never written onto a row whose
   * failure generation changed underneath the send, and cleared by every
   * transition out of `failed`. `submission_status = 'failed' AND
   * alert_notified_at IS NULL` is the durable "nobody has been told" predicate.
   */
  alertNotifiedAt: timestamp("alert_notified_at", { withTimezone: true }),
  /** Provenance, copied from the quarantine row. Keep in lockstep with 0095's CHECK. */
  contentOrigin: varchar("content_origin", { length: 16 }).$type<ContentOrigin>(),
  /** Uploader identity as of quarantine time, immutable. The single authoritative representation. */
  reporterSnapshot: jsonb("reporter_snapshot"),
  /** This row has been through the pre-activation backlog audit. */
  backlogAuditedAt: timestamp("backlog_audited_at", { withTimezone: true }),
  backlogAuditNote: text("backlog_audit_note"),
  /** An operator approved filing this legacy row with `<personOrUserReported>` omitted. Write-once. */
  identityOmissionApprovedAt: timestamp("identity_omission_approved_at", { withTimezone: true }),
  /**
   * The CyberTipline id an operator **typed** for a hand-filed report.
   *
   * Deliberately not `reportId`. `reportId` means "ISPWS returned this from our
   * own `/submit`", and the duplicate-filing guard retracts against it. An
   * operator-typed id in that column would be read as our own prior attempt: a
   * reopen would `/retract` against an id we never obtained, and if that id
   * identifies someone else's finished report the guard receives 5102,
   * concludes our attempt landed, and marks this row `submitted` — a report
   * that was never filed, made permanently final by a typo.
   */
  manualReportId: varchar("manual_report_id", { length: 64 }),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("IDX_ncmec_status_created").on(t.submissionStatus, t.createdAt),
  // The three below are declared here as well as in 0095's raw SQL, deliberately.
  // `drizzle-kit push --force` reconciles the database to THIS snapshot and
  // auto-approves data-loss statements, so an object that exists only in a
  // numbered migration can be dropped by a push — and the hash-based migrator
  // will not recreate it, because 0095 is already recorded as applied. For an
  // index that is a correctness constraint rather than a performance one, that
  // is the difference between one report per hit and two.
  index("IDX_ncmec_nonfinal")
    .on(t.submissionStatus, t.id)
    .where(sql`${t.submissionStatus} IN ('pending','in_progress')`),
  index("IDX_ncmec_failed_unalerted")
    .on(t.id)
    .where(sql`${t.submissionStatus} = 'failed' AND ${t.alertNotifiedAt} IS NULL`),
  uniqueIndex("UQ_ncmec_reports_quarantine")
    .on(t.quarantineId)
    .where(sql`${t.quarantineId} IS NOT NULL`),
  check(
    "ncmec_reports_submission_status_check",
    sql`${t.submissionStatus} IN ('pending','in_progress','submitted','filed_manually','failed','not_reportable')`,
  ),
  check(
    "ncmec_reports_content_origin_check",
    sql`${t.contentOrigin} IS NULL OR ${t.contentOrigin} IN ('generated','user_upload','stock','template','identity')`,
  ),
]);

export type NcmecReport = typeof ncmecReportsTable.$inferSelect;
export type InsertNcmecReport = typeof ncmecReportsTable.$inferInsert;

/** Legal moderation source values. Keep in lockstep with the SQL CHECK constraint in 0043. */
export const QUARANTINE_SOURCES = ["arachnid", "fal_safety", "classifier", "manual"] as const;
export type QuarantineSource = typeof QUARANTINE_SOURCES[number];

export const NCMEC_MATCH_SOURCES = ["arachnid", "classifier"] as const;
export type NcmecMatchSource = typeof NCMEC_MATCH_SOURCES[number];

/**
 * NCMEC report lifecycle. Keep in lockstep with the SQL CHECK constraint in
 * 0095 — `migrations.0095.test.ts` asserts the two agree, so the lockstep is
 * enforced rather than remembered.
 *
 * There is deliberately no `retracted` status: retraction is a step within an
 * attempt, not a place a report rests, and a status would create a non-final
 * state a crash could strand a row in, outside every reconciler repair.
 */
export const NCMEC_SUBMISSION_STATUSES = [
  "pending",
  "in_progress",
  "submitted",
  "filed_manually",
  "failed",
  "not_reportable",
] as const;
export type NcmecSubmissionStatus = typeof NCMEC_SUBMISSION_STATUSES[number];

/**
 * Statuses from which a report can never be enqueued again. A row in one of
 * these is resolved and nobody is waiting on anything.
 */
export const NCMEC_FINAL_STATUSES = [
  "submitted",
  "filed_manually",
  "failed",
  "not_reportable",
] as const satisfies readonly NcmecSubmissionStatus[];

/** The complement of {@link NCMEC_FINAL_STATUSES} — a human or a retry is still owed. */
export const NCMEC_NONFINAL_STATUSES = [
  "pending",
  "in_progress",
] as const satisfies readonly NcmecSubmissionStatus[];

/**
 * Where quarantined imagery came from. Drives the report's `<generativeAi>`
 * annotation, which is computed from this (`content_origin === 'generated'`)
 * rather than stored separately — two representations of one fact would be two
 * things that can disagree. Keep in lockstep with the CHECK constraints in 0095.
 */
export const CONTENT_ORIGINS = ["generated", "user_upload", "stock", "template", "identity"] as const;
export type ContentOrigin = typeof CONTENT_ORIGINS[number];

/**
 * Actions recordable on the safety admin surface. Every one of them alters
 * state with legal consequence, which is why the vocabulary is closed.
 */
export const NCMEC_AUDIT_ACTIONS = [
  "retry",
  "send_to_test_started",
  "send_to_test_completed",
  "backlog_audit",
  "approve_identity_omission",
  "mark_manually_filed",
  "correct_manual_filing",
  "reopen",
  "config_write",
] as const;
export type NcmecAuditAction = typeof NCMEC_AUDIT_ACTIONS[number];

/**
 * Append-only ledger of every mutation made through `/admin/safety`.
 *
 * Append-only is enforced by database triggers created in 0095, not by this
 * module declining to export a delete helper — a helper's absence constrains
 * nothing about a future route, migration, script, or raw Drizzle call, and
 * this table is the sole control over destructive admin actions.
 */
export const ncmecSafetyAuditLogTable = pgTable("ncmec_safety_audit_log", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  /** Null for config writes, which are not row-scoped. */
  reportId: bigint("report_id", { mode: "number" })
    .references(() => ncmecReportsTable.id, { onDelete: "set null" }),
  /**
   * Deliberately carries no foreign key. A FK would make the ledger's contents
   * depend on the users table — ON DELETE SET NULL would erase the
   * machine-readable half of the attribution when an account is deleted, and
   * any other action would block the delete or cascade into this table.
   */
  actorUserId: varchar("actor_user_id"),
  /**
   * Human-readable actor identity as of the action. NOT NULL is load-bearing:
   * `users.email` is nullable, an admin can clear it, and the soft-delete
   * lifecycle nulls it outright, so a nullable email snapshot would leave the
   * suppression of a federal report attributed only to a user id that becomes
   * an orphaned opaque string once the account is deleted. Built at write time
   * from the first available of email, display name, or `admin:<user_id>`; if
   * even that cannot be resolved the mutation is refused rather than recorded
   * anonymously.
   */
  actorLabel: text("actor_label").notNull(),
  action: varchar("action", { length: 40 }).notNull().$type<NcmecAuditAction>(),
  /** Operator-supplied. Required for the destructive actions. */
  reason: text("reason"),
  beforeState: jsonb("before_state"),
  afterState: jsonb("after_state"),
  /** Pairs the two events of one `send-to-test` attempt. */
  attemptId: uuid("attempt_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("IDX_ncmec_audit_report_created").on(t.reportId, t.createdAt.desc()),
  index("IDX_ncmec_audit_created").on(t.createdAt.desc()),
]);

export type NcmecSafetyAuditEntry = typeof ncmecSafetyAuditLogTable.$inferSelect;
export type InsertNcmecSafetyAuditEntry = typeof ncmecSafetyAuditLogTable.$inferInsert;

/** Meme moderation lifecycle. Mirrors the CHECK constraint in 0043. */
export const MEME_STATUSES = ["live", "quarantined", "rejected"] as const;
export type MemeStatus = typeof MEME_STATUSES[number];

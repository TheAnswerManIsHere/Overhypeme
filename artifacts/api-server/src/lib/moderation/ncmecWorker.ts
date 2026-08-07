/**
 * NCMEC submission eligibility and waiting-state classification — phase 3 of the
 * CyberTipline plan.
 *
 * Two pure functions, no persistence, no config reads, no callers yet. Phase 5 adds the
 * worker and reconciler to this module; phase 6 adds the admin surface that renders the
 * counts. Both functions are deliberately total over their stated domain and take every
 * input explicitly, because both are about to be shared by four call sites that must not
 * be allowed to drift:
 *
 *   `isSubmittable`         — the initial enqueue in `quarantine.ts`, the reconciler,
 *                             the admin retry endpoint, and the worker's own recheck
 *                             inside the lease transaction.
 *   `classifyWaitingState`  — the `/admin/safety` table, its global counts, and the
 *                             tests that assert those counts are exhaustive and disjoint.
 *
 * **Neither function reads config itself, and that is the point.** The worker's recheck
 * and the `/finish` recheck must both use *authoritative, uncached* config reads that
 * bypass `adminConfig.ts`'s 60-second process-local cache; the admin surface's counts may
 * use the cached path. Taking the tuple as a parameter keeps that decision at the call
 * site, where the caller knows which read it performed, instead of burying a cache policy
 * inside a predicate.
 *
 * The module also lands `NCMEC_SEQUENCE_DEADLINE_MS` and the test that guards its coupling
 * to the queue's reclaim cutoff, so phase 5 can only consume a constant whose safety
 * inequality is already enforced. That is the plan's known gap G11; G5 is discharged by
 * {@link NcmecRefusalClass}.
 */

import type { AsyncJobStatus, NcmecReport, NcmecSubmissionStatus } from "@workspace/db";
import { NCMEC_FINAL_STATUSES } from "@workspace/db";

import type { NcmecEnvironment } from "./ncmecClient.js";

// ─── The authoritative configuration tuple ──────────────────────────────────

/**
 * The configuration both functions judge a row against.
 *
 * `backlogAuditCutoff` is `null` until §7 step 2 sets it. That is not a missing value to
 * be defaulted — see {@link isUnauditedBacklog}.
 */
export interface NcmecEligibilityConfig {
  /** `ncmec_submission_enabled` — the master switch. */
  submissionEnabled: boolean;
  /** `ncmec_ispws_environment` — `test` reaches exttest, where nothing is really filed. */
  environment: NcmecEnvironment;
  /** `ncmec_backlog_audit_cutoff` — the audit scope boundary. Write-once, `null` until set. */
  backlogAuditCutoff: Date | null;
}

// ─── The ISPWS sequence deadline (known gap G11) ────────────────────────────

/**
 * How long the whole `/submit` → `/upload` → `/fileinfo` → `/finish` sequence may run
 * inside one job execution before the worker aborts it.
 *
 * **This is not derived from the queue's reclaim cutoff, and it must not be.** Three
 * minutes is an ISPWS-facing timeout, chosen for how long NCMEC's endpoints may reasonably
 * take; the queue's `RECOVER_STUCK_CUTOFF_MIN` is an unrelated backstop that happens to
 * bound it. Computing one from the other would make an NCMEC timeout move whenever the
 * queue is retuned, which is a worse coupling than the one G11 is about.
 *
 * What G11 requires is that the *inequality* stop being an unwritten assumption. The
 * deadline is only safe while it stays **strictly below** the reclaim cutoff: if the queue
 * could reclaim a row mid-sequence, two workers could run the same sequence and file the
 * same report twice. That cutoff has already moved once (10 → 30 by PR #283) and is slated
 * to stop being load-bearing when async-queue Phase 3a lands fenced finalizes, so a future
 * *lowering* is entirely plausible and nothing today would notice.
 *
 * `moderation.ncmecWorker.test.ts` therefore asserts the inequality against the imported
 * constant. Lowering `RECOVER_STUCK_CUTOFF_MIN` below this deadline fails CI with the
 * reason attached, which is what G11 asks for and what a comment alone could not do.
 */
export const NCMEC_SEQUENCE_DEADLINE_MS = 3 * 60_000;

// ─── isSubmittable ──────────────────────────────────────────────────────────

/**
 * Why a refusal matters, which is a different question from why it happened.
 *
 * - `reversible` — the row is **not** finalized. It keeps its place, keeps its
 *   waiting-state count, and resumes the moment the blocker clears. The worker returns
 *   success and makes no ISPWS call.
 * - `terminal` — the row is **already** in a final status. Nobody is waiting on anything
 *   and there is nothing to record.
 *
 * **A refusal never *makes* a row final, and that is the plan's known gap G5 discharged.**
 * An earlier form of this design classed the unaudited-backlog and unresolved-identity
 * refusals as terminal, which contradicted invariant 8: those rows are precisely the ones
 * being parked for a human, each with its own count on `/admin/safety`. A row enqueued
 * before the backlog cutoff was set would then have been finalized `failed` instead of
 * parked — the operator's pending decision destroyed by the machine, and an alert fired for
 * a report that was never in trouble. Both are now reversible: a per-row operator action
 * releases them exactly as a config flip releases the other two.
 *
 * So the two classes now answer one question cleanly — *does this row still have a future?*
 * `terminal` is reserved for rows whose future is already spent, which means **phase 5's
 * worker must treat a terminal refusal as "nothing to do", never as a failure to record.**
 * Genuine failure finalization belongs to the ISPWS error paths, which are the only things
 * that should ever write `failed`.
 */
export type NcmecRefusalClass = "reversible" | "terminal";

/** Stable machine identifiers for each refusal. Callers branch on these, never on prose. */
export type NcmecRefusalCode =
  | "submission_disabled"
  | "environment_not_production"
  | "already_submitted"
  | "filed_manually"
  | "not_reportable"
  | "already_failed"
  | "unaudited_backlog"
  | "identity_unresolved";

export interface NcmecRefusal {
  class: NcmecRefusalClass;
  code: NcmecRefusalCode;
  /** Operator-facing prose. The admin surface shows this; nothing branches on it. */
  reason: string;
}

export type NcmecSubmittability =
  | { submittable: true }
  | { submittable: false; refusal: NcmecRefusal };

function reversible(code: NcmecRefusalCode, reason: string): NcmecSubmittability {
  return { submittable: false, refusal: { class: "reversible", code, reason } };
}

type NcmecFinalStatus = (typeof NCMEC_FINAL_STATUSES)[number];

const FINAL_STATUSES = new Set<string>(NCMEC_FINAL_STATUSES);

function isFinalStatus(status: NcmecSubmissionStatus): status is NcmecFinalStatus {
  return FINAL_STATUSES.has(status);
}

/** The row fields eligibility is decided from. A real `NcmecReport` satisfies this. */
export type NcmecEligibilityRow = Pick<
  NcmecReport,
  | "submissionStatus"
  | "createdAt"
  | "backlogAuditedAt"
  | "reporterSnapshot"
  | "userId"
  | "identityOmissionApprovedAt"
>;

/**
 * One refusal per final status, keyed by the schema's own vocabulary so a status added
 * without a refusal is a compile error rather than a row that silently passes the gate.
 */
const FINAL_STATUS_REFUSALS: Record<
  (typeof NCMEC_FINAL_STATUSES)[number],
  { code: NcmecRefusalCode; reason: string }
> = {
  submitted: {
    code: "already_submitted",
    reason: "This report has already been filed with the CyberTipline.",
  },
  filed_manually: {
    code: "filed_manually",
    reason: "This report was filed by hand. Reopen it first if it needs to be filed again.",
  },
  not_reportable: {
    code: "not_reportable",
    reason:
      "An operator decided this row is not reportable. Reopen it first if that decision was wrong.",
  },
  failed: {
    code: "already_failed",
    reason:
      "This report is in a terminal failed state. Retrying it returns it to pending first; it is not submittable while still marked failed.",
  },
};

/**
 * Whether this row may be submitted right now, under this configuration.
 *
 * **The master switch belongs here rather than in each caller.** It does already live in
 * the reconciler's own query, which is exactly the duplication this extraction exists to
 * end — and leaving it to the callers opens a real hole during the rollout: between
 * setting the environment to `production` and re-enabling submission, a fresh hit would
 * otherwise pass, get a job, and contradict the design's claim that disabled rows have no
 * job at all.
 *
 * **No ordering here is load-bearing for safety, because no refusal finalizes a row.** The
 * order is chosen for legibility instead: it mirrors `classifyWaitingState`'s branches, so
 * a row refused as `unaudited_backlog` is the same row the admin table counts under
 * `unaudited_backlog`.
 *
 * A `failed` row is refused terminally, which is deliberate and constrains phase 6: the
 * admin retry endpoint must apply its reset to `pending` **before** evaluating this
 * function, inside the same transaction. Evaluating first and resetting second would make
 * retry impossible on exactly the rows it exists for. The reconciler, by contrast, relies
 * on this refusal — a `failed` row must never be re-submitted automatically; its repair
 * pass re-enqueues the *notification*, not the submission.
 */
export function isSubmittable(
  row: NcmecEligibilityRow,
  config: NcmecEligibilityConfig,
): NcmecSubmittability {
  // Already resolved — outside the waiting-state classifier's domain entirely.
  if (isFinalStatus(row.submissionStatus)) {
    const { code, reason } = FINAL_STATUS_REFUSALS[row.submissionStatus];
    return { submittable: false, refusal: { class: "terminal", code, reason } };
  }

  // The four reversible blockers, in the same order `classifyWaitingState` takes them, so
  // the refusal an operator reads on a retry and the waiting state they see in the table
  // are two views of one answer rather than two answers.
  if (isUnauditedBacklog(row, config)) {
    return reversible(
      "unaudited_backlog",
      "This row predates the backlog-audit cutoff and has not been audited. It keeps its place until an operator audits it.",
    );
  }

  if (isIdentityUnresolved(row)) {
    return reversible(
      "identity_unresolved",
      "This row has no uploader snapshot but does have an account attached. It keeps its place until an operator either resolves the identity or approves filing it with the uploader omitted.",
    );
  }

  if (!config.submissionEnabled) {
    return reversible(
      "submission_disabled",
      "CyberTipline submission is switched off. Nothing is filed while it stays off, and this row keeps its place.",
    );
  }

  if (config.environment !== "production") {
    return reversible(
      "environment_not_production",
      "The ISPWS environment is set to test. Reports are only filed from production; this row keeps its place until the environment is switched.",
    );
  }

  return { submittable: true };
}

// ─── The two shared row predicates ──────────────────────────────────────────

/**
 * `created_at < cutoff AND backlog_audited_at IS NULL`.
 *
 * **A `null` cutoff matches nothing, mirroring SQL's three-valued logic exactly.** In
 * Postgres `created_at < NULL` is unknown, so the reconciler's WHERE clause excludes the
 * row; a JavaScript comparison against `null` would coerce and could include it. The two
 * evaluations of this predicate — this one and the reconciler's SQL — must agree, or rows
 * appear in a count that the query that drains them cannot see.
 *
 * Before the cutoff is set, therefore, no row is unaudited backlog. That is safe rather
 * than lucky: submission is seeded off, and the activation gate refuses production until
 * the audit is both scoped and complete, so the window in which an unset cutoff could
 * matter is one in which nothing files.
 */
export function isUnauditedBacklog(
  row: Pick<NcmecEligibilityRow, "createdAt" | "backlogAuditedAt">,
  config: Pick<NcmecEligibilityConfig, "backlogAuditCutoff">,
): boolean {
  if (config.backlogAuditCutoff === null) return false;
  if (row.backlogAuditedAt !== null) return false;
  return row.createdAt.getTime() < config.backlogAuditCutoff.getTime();
}

/**
 * `reporter_snapshot IS NULL AND user_id IS NOT NULL AND identity_omission_approved_at IS NULL`.
 *
 * The stamp is what releases the row — a free-text audit note would leave this predicate
 * unchanged and the row ineligible forever, which is why the disposition needed its own
 * column.
 *
 * Note that this predicate says the snapshot is *absent*, not that the row is *legacy*. A
 * current row can satisfy it through a capture defect, and such a row is a bug to fix
 * rather than a row to file anonymously. The cutoff clause that draws that line lives on
 * the identity-omission endpoint (phase 6), which is where the operator action is; here
 * the row simply stays ineligible until somebody dispositions it.
 */
export function isIdentityUnresolved(
  row: Pick<NcmecEligibilityRow, "reporterSnapshot" | "userId" | "identityOmissionApprovedAt">,
): boolean {
  return (
    row.reporterSnapshot === null &&
    row.userId !== null &&
    row.identityOmissionApprovedAt === null
  );
}

// ─── classifyWaitingState ───────────────────────────────────────────────────

/**
 * The branches of one ordered classifier, in evaluation order.
 *
 * Branches 1–6 are things awaiting a person. Branch 7 is a short-lived transitional state
 * the reconciler drains. Branch 8 is not waiting on anybody at all — it is active work,
 * and `/admin/safety` renders it as such.
 */
export const NCMEC_WAITING_STATES = [
  "unaudited_backlog",
  "identity_unresolved",
  "test_attempt_uncertain",
  "submission_disabled",
  "test_mode_not_submitted",
  "test_mode_submitted",
  "awaiting_reconciliation",
  "in_flight",
] as const;

export type NcmecWaitingState = (typeof NCMEC_WAITING_STATES)[number];

/** The states in which the row is not progressing without somebody doing something. */
export const NCMEC_WAITING_ON_A_PERSON = [
  "unaudited_backlog",
  "identity_unresolved",
  "test_attempt_uncertain",
  "submission_disabled",
  "test_mode_not_submitted",
  "test_mode_submitted",
] as const satisfies readonly NcmecWaitingState[];

/** Async-job statuses from which a job may still run. Anything else has stopped. */
const NON_TERMINAL_JOB_STATUSES = new Set<AsyncJobStatus>(["pending", "processing"]);

/** The single field of the row's `ncmec_submit` job that the classification depends on. */
export interface NcmecSubmitJobState {
  status: AsyncJobStatus;
}

export type NcmecWaitingStateRow = NcmecEligibilityRow &
  Pick<NcmecReport, "testSubmissionStartedAt" | "testReportId" | "testSubmittedAt">;

/**
 * Which one thing a non-final report row is waiting on.
 *
 * **One function, returning exactly one label, taking the first matching branch.** A row
 * genuinely satisfies several conditions at once — a disabled deployment sits in the
 * default `test` environment, so every waiting row matches both "submission disabled" and
 * a test-mode branch, and an identity-unresolved legacy row is usually also unaudited.
 * Evaluating the conditions independently and counting each would double-count rows and
 * make "every non-final row appears in exactly one count" unsatisfiable. Three
 * implementations of six overlapping predicates would drift, and the drift would be
 * invisible: the counts would still add up to something.
 *
 * **The order runs from the most specific blocker the operator must personally resolve to
 * the most general state of the deployment.** The per-row blockers outrank the global
 * switches because turning submission on does not release them — telling an operator a row
 * is "waiting on activation" when it is really waiting on their own unmade decision is the
 * specific misdirection this ordering prevents. Branch 3 sits above both test-mode
 * branches for the same reason: a crashed `send-to-test` is waiting on portal inspection,
 * not on another `send-to-test`, and reporting it as the latter invites exactly the blind
 * re-submission the admin surface must not encourage.
 *
 * **`job` is a parameter because the row alone cannot distinguish branches 7 and 8.** The
 * tempting simplification — an `in_flight` fallback computed from the row — is total but
 * factually wrong: an eligible row whose job is missing (just released by an audit or an
 * identity approval and not yet swept, or stranded by queue loss) would be reported as
 * queued or running, which is precisely the condition the reconciler exists to detect,
 * displayed as though the system were already working on it. Pass the row's non-terminal
 * `ncmec_submit` job, or `null` if it has none; a terminal job is treated as no job.
 *
 * @throws if `row` is in a final status. Final rows are resolved and nobody is waiting on
 * anything, so they have no waiting state — the caller's query is expected to have
 * excluded them. Silently returning a sentinel would let a final row vanish from counts
 * that are supposed to be exhaustive, which is the failure mode that looks like success
 * from every surface.
 */
export function classifyWaitingState(
  row: NcmecWaitingStateRow,
  job: NcmecSubmitJobState | null,
  config: NcmecEligibilityConfig,
): NcmecWaitingState {
  if (isFinalStatus(row.submissionStatus)) {
    throw new Error(
      `classifyWaitingState received a final row (submissionStatus=${row.submissionStatus}); ` +
        "only pending and in_progress rows have a waiting state",
    );
  }

  // 1. Waiting on the pre-activation audit.
  if (isUnauditedBacklog(row, config)) return "unaudited_backlog";

  // 2. Waiting on an operator dispositioning a legacy row's missing uploader.
  if (isIdentityUnresolved(row)) return "identity_unresolved";

  // 3. Waiting on portal inspection: exttest may hold a submission whose id was lost.
  if (row.testSubmissionStartedAt !== null && row.testReportId === null) {
    return "test_attempt_uncertain";
  }

  // 4. Waiting on the operator turning submission on.
  if (!config.submissionEnabled) return "submission_disabled";

  // 5/6. Waiting on the production transition — a test submission is not a filing.
  if (config.environment !== "production") {
    return row.testSubmittedAt === null ? "test_mode_not_submitted" : "test_mode_submitted";
  }

  // 7/8. Eligible. Either the reconciler owes it a job, or one already exists.
  //
  // Reaching here means every branch above declined, which is exactly the complement of
  // `isSubmittable`'s refusals over a non-final row — so an eligible row can never be
  // reported as waiting on a person, and a row waiting on a person can never be counted as
  // active work. That correspondence is a property of this ordering, not a coincidence,
  // and the tests assert it rather than restating the branches.
  const jobIsLive = job !== null && NON_TERMINAL_JOB_STATUSES.has(job.status);
  return jobIsLive ? "in_flight" : "awaiting_reconciliation";
}


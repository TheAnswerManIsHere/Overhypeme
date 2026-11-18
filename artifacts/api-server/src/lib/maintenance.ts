/**
 * @purpose The daily maintenance run: every retention job the retention schedule names, run directly in one request from outside the app (launch Phase 14, increment 6, plan S-i), each job's outcome reported so a failure is visible rather than swallowed by a timer.
 * @subsystem data-lifecycle
 *
 * Why it exists: the deployment scales to zero after 15 idle minutes, and
 * every scheduler in `index.ts` is a timer inside that process, so a quiet
 * site runs no cleanup at all. One protected call a day (POST
 * /api/jobs/maintenance, from a Cloudflare scheduled trigger) runs each job
 * here directly — not by waking the process and hoping its timers fire.
 *
 * Every job here also runs on a timer inside the process while it is awake
 * (the session sweep and the retention windows since the 6a follow-up). The
 * timers stay: they are harmless beside this (every job is safe to run twice
 * at once) and keep a busy site tidier than once a day.
 *
 * Increment 7 adds the child-safety recovery and evidence purge to this list;
 * a later step records each run in the database (until then, the response and
 * the log line are the record).
 */
import { logger } from "./logger";

export interface MaintenanceJobOutcome {
  job: MaintenanceJobName;
  ok: boolean;
  ms: number;
  result?: unknown;
  error?: string;
}

export interface MaintenanceRun {
  ok: boolean;
  startedAt: string;
  finishedAt: string;
  jobs: MaintenanceJobOutcome[];
}

/**
 * The jobs, in run order. The retention schedule names a job by these ids,
 * and a test fails when it names one that is not here.
 */
export const MAINTENANCE_JOB_NAMES = [
  "expired-sessions",
  "expired-sign-in-states",
  "retention-windows",
  "finished-jobs",
  "transient-renders",
  "image-provenance",
  "rate-limit-counters",
  "content-purge",
  "account-deletion",
  "media-backup",
] as const;
export type MaintenanceJobName = (typeof MAINTENANCE_JOB_NAMES)[number];

type JobRunner = () => Promise<unknown>;

/**
 * A job's own judgement of its result: a plain reason when the work it was
 * due to do did not happen, or null when it did. Every job states one, so a
 * job added later has to say what its failure looks like.
 *
 * Why it exists: the cleanups were written for the hourly timers, where
 * catching a failed item and leaving it for the next run is right, so several
 * of them report failure in what they return rather than by throwing. A throw
 * is always a failure on top of this.
 *
 * Every judgement fails closed: an answer whose shape it does not recognise
 * (a field renamed, a count missing, a new message) is a failure, never a
 * good day, so a job reworded later cannot make its failures quiet again.
 */
type FailureJudge = (result: unknown) => string | null;

function unrecognised(result: unknown): string {
  let shown: string;
  try { shown = JSON.stringify(result) ?? String(result); } catch { shown = String(result); }
  return `an answer this run does not recognise: ${shown.slice(0, 200)}`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const isCount = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

/**
 * The answer is an object carrying each named count (a finite number, zero
 * or more) and each named flag (a boolean). Anything else is unrecognised.
 */
function hasShape(result: unknown, counts: readonly string[], flags: readonly string[] = []): result is Record<string, unknown> {
  return isRecord(result)
    && counts.every((k) => isCount(result[k]))
    && flags.every((k) => typeof result[k] === "boolean");
}

/** A job whose only failure is a throw, once its answer has the expected shape. */
const shapeOnly = (counts: readonly string[], flags: readonly string[] = []): FailureJudge =>
  (result) => (hasShape(result, counts, flags) ? null : unrecognised(result));

const PURGE_COUNTS = ["selected", "purged", "skipped", "failed"] as const;

/** The content purge: a row it could not purge, per kind (photos, generated images, memes). */
const contentPurgeFailure: FailureJudge = (result) => {
  const kinds = ["photos", "generated", "memes"] as const;
  if (!isRecord(result) || !kinds.every((k) => hasShape(result[k], PURGE_COUNTS))) return unrecognised(result);
  const failed = kinds
    .map((kind) => [kind, (result[kind] as { failed: number }).failed] as const)
    .filter(([, n]) => n > 0);
  return failed.length ? `could not purge ${failed.map(([k, n]) => `${n} ${k}`).join(", ")}` : null;
};

/** The account-deletion worker: a request it could not schedule or advance. A hold is not a failure. */
const accountDeletionFailure: FailureJudge = (result) => {
  if (!hasShape(result, ["opened", "selected", "advanced", "purged", "held", "failed"])) return unrecognised(result);
  const failed = result.failed as number;
  return failed > 0 ? `${failed} account deletion step(s) failed` : null;
};

/** The finished background jobs: a count of rows deleted per queue. */
const finishedJobsFailure: FailureJudge = (result) =>
  isRecord(result) && isRecord(result.deleted) && Object.values(result.deleted).every(isCount)
    ? null
    : unrecognised(result);

/**
 * The media backup, which this run calls only in the published deployment.
 * Success is a completed capture, another instance capturing, a recent pair
 * (someone else did the work), or not being the published deployment. An
 * incomplete capture fails; so do the two answers that there mean the backup
 * cannot run at all (the state in which every storage delete is also
 * refused); and so does any other answer.
 */
const mediaBackupFailure: FailureJudge = (result) => {
  if (result === "completed"
    || result === "skipped: another instance is capturing"
    || result === "skipped: not the published deployment"
    || (typeof result === "string" && /^skipped: pair \S+ is recent$/.test(result))) return null;
  if (result === "incomplete") return "the backup capture was incomplete";
  if (result === "skipped: the media backup is not configured" || result === "skipped: PRIVATE_OBJECT_DIR is not set") {
    return `the backup cannot run (${String(result).replace(/^skipped: /, "")})`;
  }
  return unrecognised(result);
};

interface MaintenanceJob {
  run: JobRunner;
  failure: FailureJudge;
}

const JOBS: Record<MaintenanceJobName, MaintenanceJob> = {
  "expired-sessions": {
    // A budget left over continues on the next hourly run.
    run: async () => (await import("./sessionSweep")).sweepExpiredSessions(),
    failure: shapeOnly(["deleted", "batches"], ["budgetExhausted"]),
  },
  "expired-sign-in-states": {
    // A Google or Apple sign-in's ten-minute state; the auth router also
    // sweeps it every five minutes while the process is up.
    run: async () => {
      const { db, oauthPendingStatesTable } = await import("@workspace/db");
      const { lt } = await import("drizzle-orm");
      const rows = await db.delete(oauthPendingStatesTable).where(lt(oauthPendingStatesTable.expiresAt, new Date())).returning({ state: oauthPendingStatesTable.state });
      return { deleted: rows.length };
    },
    failure: shapeOnly(["deleted"]),
  },
  "retention-windows": {
    run: async () => (await import("./dataLifecycle")).runRetentionWindowJobs(),
    failure: shapeOnly(["expiredEmailTokensDeleted", "expiredPasswordTokensDeleted", "oldSearchHistoryDeleted", "oldGenerationCostsDeleted", "oldWebhookAuditDeleted", "oldProcessedEventsDeleted"]),
  },
  "finished-jobs": {
    // Background jobs' finished rows past each queue's window (they carry
    // what the job was given: an email job its recipient). The worker's own
    // tick does the same while the process is up.
    run: async () => {
      const { db } = await import("@workspace/db");
      const { getRegisteredQueues, purgeTerminalJobs } = await import("./asyncJobs");
      const deleted: Record<string, number> = {};
      for (const queue of getRegisteredQueues()) deleted[queue] = await purgeTerminalJobs(db, queue);
      return { deleted };
    },
    failure: finishedJobsFailure,
  },
  "transient-renders": {
    run: async () => (await import("../jobs/transientRenderPurger")).runTransientRenderPurger(),
    failure: shapeOnly(["deleted", "retentionDays"]),
  },
  "image-provenance": {
    run: async () => (await import("../jobs/provenanceRetentionPurger")).runProvenanceRetentionPurge(),
    failure: shapeOnly(["retentionDays", "deletedRecords", "deletedRequests"]),
  },
  "rate-limit-counters": {
    // One run is budget-bounded; a daily call keeps going until the backlog
    // is drained or ten runs have passed, which the hourly timer's one-minute
    // follow-up does on a busy site. A budget left over continues tomorrow.
    run: async () => {
      const { runRateLimitCounterPurger } = await import("../jobs/rateLimitCounterPurger");
      let deleted = 0;
      let runs = 0;
      let budgetExhausted = true;
      while (budgetExhausted && runs < 10) {
        const r = await runRateLimitCounterPurger();
        deleted += r.deleted;
        budgetExhausted = r.budgetExhausted;
        runs += 1;
      }
      return { deleted, runs, budgetExhausted };
    },
    failure: shapeOnly(["deleted", "runs"], ["budgetExhausted"]),
  },
  "content-purge": {
    run: async () => (await import("../jobs/contentPurger")).runContentPurger(),
    failure: contentPurgeFailure,
  },
  "account-deletion": {
    run: async () => (await import("./accountDeletion")).runAccountDeletionWorker(),
    failure: accountDeletionFailure,
  },
  "media-backup": {
    // As its hourly scheduler does, only in the published deployment; the
    // capture runs the backup's expiry itself.
    run: async () => {
      if (process.env.REPLIT_DEPLOYMENT !== "1") return "skipped: not the published deployment";
      return (await import("../jobs/mediaBackupJob")).runScheduledMediaBackup();
    },
    failure: mediaBackupFailure,
  },
};

/** A job's judgement of a result: a plain reason it failed, or null. Exported for tests. */
export function judgeJobResult(job: MaintenanceJobName, result: unknown): string | null {
  return JOBS[job].failure(result);
}

/**
 * Runs every job in order. A job fails when it throws or when its own
 * judgement of its result says the work did not happen; either way its
 * outcome is recorded and the rest still run. The run is `ok` only when every
 * job was. `runners` replaces a job's runner (tests); its judgement still
 * applies.
 */
export async function runDailyMaintenance(
  runners: Partial<Record<MaintenanceJobName, JobRunner>> = {},
): Promise<MaintenanceRun> {
  const startedAt = new Date();
  const outcomes: MaintenanceJobOutcome[] = [];
  for (const job of MAINTENANCE_JOB_NAMES) {
    const run = runners[job] ?? JOBS[job].run;
    const t0 = Date.now();
    try {
      const result = await run();
      const reason = judgeJobResult(job, result);
      outcomes.push(reason ? { job, ok: false, ms: Date.now() - t0, result, error: reason } : { job, ok: true, ms: Date.now() - t0, result });
    } catch (err) {
      outcomes.push({ job, ok: false, ms: Date.now() - t0, error: err instanceof Error ? err.message.slice(0, 300) : String(err) });
    }
  }
  const out: MaintenanceRun = {
    ok: outcomes.every((o) => o.ok),
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    jobs: outcomes,
  };
  const failed = outcomes.filter((o) => !o.ok).map((o) => ({ job: o.job, error: o.error, result: o.result }));
  if (out.ok) logger.info({ jobs: outcomes.map((o) => ({ job: o.job, ms: o.ms })) }, "[maintenance] daily run completed");
  else logger.error({ failed }, "[maintenance] daily run had failures");
  return out;
}

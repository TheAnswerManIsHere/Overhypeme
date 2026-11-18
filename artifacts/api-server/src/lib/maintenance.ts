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
 * The hourly timers stay: they are harmless beside this (every job is safe to
 * run twice at once) and keep a busy site tidier than once a day.
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

const JOBS: Record<MaintenanceJobName, JobRunner> = {
  "expired-sessions": async () => (await import("./sessionSweep")).sweepExpiredSessions(),
  "expired-sign-in-states": async () => {
    // A Google or Apple sign-in's ten-minute state; the auth router also
    // sweeps it every five minutes while the process is up.
    const { db, oauthPendingStatesTable } = await import("@workspace/db");
    const { lt } = await import("drizzle-orm");
    const rows = await db.delete(oauthPendingStatesTable).where(lt(oauthPendingStatesTable.expiresAt, new Date())).returning({ state: oauthPendingStatesTable.state });
    return { deleted: rows.length };
  },
  "retention-windows": async () => (await import("./dataLifecycle")).runRetentionWindowJobs(),
  "finished-jobs": async () => {
    // Background jobs' finished rows past each queue's window (they carry
    // what the job was given: an email job its recipient). The worker's own
    // tick does the same while the process is up.
    const { db } = await import("@workspace/db");
    const { getRegisteredQueues, purgeTerminalJobs } = await import("./asyncJobs");
    const deleted: Record<string, number> = {};
    for (const queue of getRegisteredQueues()) deleted[queue] = await purgeTerminalJobs(db, queue);
    return { deleted };
  },
  "transient-renders": async () => (await import("../jobs/transientRenderPurger")).runTransientRenderPurger(),
  "image-provenance": async () => (await import("../jobs/provenanceRetentionPurger")).runProvenanceRetentionPurge(),
  "rate-limit-counters": async () => {
    // One run is budget-bounded; a daily call keeps going until the backlog
    // is drained or ten runs have passed, which the hourly timer's one-minute
    // follow-up does on a busy site.
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
  "content-purge": async () => (await import("../jobs/contentPurger")).runContentPurger(),
  "account-deletion": async () => (await import("./accountDeletion")).runAccountDeletionWorker(),
  "media-backup": async () => {
    // As its hourly scheduler does, only in the published deployment; the
    // capture runs the backup's expiry itself.
    if (process.env.REPLIT_DEPLOYMENT !== "1") return "skipped: not the published deployment";
    return (await import("../jobs/mediaBackupJob")).runScheduledMediaBackup();
  },
};

/**
 * Runs every job in order. One job's failure is recorded and the rest still
 * run; the run is `ok` only when every job was.
 */
export async function runDailyMaintenance(
  jobs: Partial<Record<MaintenanceJobName, JobRunner>> = {},
): Promise<MaintenanceRun> {
  const startedAt = new Date();
  const outcomes: MaintenanceJobOutcome[] = [];
  for (const job of MAINTENANCE_JOB_NAMES) {
    const run = jobs[job] ?? JOBS[job];
    const t0 = Date.now();
    try {
      const result = await run();
      outcomes.push({ job, ok: true, ms: Date.now() - t0, result });
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
  const failed = outcomes.filter((o) => !o.ok).map((o) => ({ job: o.job, error: o.error }));
  if (out.ok) logger.info({ jobs: outcomes.map((o) => ({ job: o.job, ms: o.ms })) }, "[maintenance] daily run completed");
  else logger.error({ failed }, "[maintenance] daily run had failures");
  return out;
}

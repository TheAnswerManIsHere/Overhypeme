/**
 * Backfill image prep through the durable `fact_pexels` queue.
 *
 * Enqueues one `fact_pexels` job per active fact that has no `pexels_images`
 * yet (or every active fact with --all), then polls each job to a terminal
 * state before exiting. The API server's async-jobs worker must be running
 * for enqueued jobs to actually process — this script only schedules the
 * work; it does not call OpenAI/Pexels itself.
 *
 * Run with the api-server worker live (so the jobs actually drain):
 *   npx tsx src/scripts/backfill-fact-pexels.ts [--all] [--limit N] [--dry-run]
 *
 * Options:
 *   --all       Also (re)enqueue facts that already have pexels_images.
 *   --limit N   Stop after enqueuing N facts (default: unlimited).
 *   --dry-run   Print what would be enqueued without writing/enqueuing anything.
 *
 * Dedupe: enqueueFactPexels keys on the fact id, so a fact with an in-flight
 * job is not double-queued — the script is safe to re-run.
 */

import { isNull, and, eq, asc } from "drizzle-orm";
import { db } from "@workspace/db";
import { factsTable } from "@workspace/db/schema";
import { enqueueFactPexels } from "../lib/factPexelsJobs";
import { pollJobsToTerminal, type PollableJob } from "../lib/cliJobPoller";
import { logger } from "../lib/logger";

const args = process.argv.slice(2);
const ALL = args.includes("--all");
const DRY_RUN = args.includes("--dry-run");
const limitIdx = args.indexOf("--limit");
const LIMIT = limitIdx >= 0 ? parseInt(args[limitIdx + 1] ?? "0", 10) : 0;

async function run(): Promise<void> {
  const baseWhere = ALL
    ? eq(factsTable.isActive, true)
    : and(eq(factsTable.isActive, true), isNull(factsTable.pexelsImages));

  const rows = await db
    .select({ id: factsTable.id, text: factsTable.text })
    .from(factsTable)
    .where(baseWhere)
    .orderBy(asc(factsTable.id));

  const toProcess = LIMIT > 0 ? rows.slice(0, LIMIT) : rows;

  logger.info(
    { mode: ALL ? "re-enqueue all" : "missing only", count: toProcess.length, dryRun: DRY_RUN },
    "[backfill-fact-pexels] starting",
  );
  if (toProcess.length === 0) {
    logger.info("[backfill-fact-pexels] nothing to enqueue");
    return;
  }

  if (DRY_RUN) {
    for (const fact of toProcess) {
      logger.info({ text: fact.text.slice(0, 60) }, "[backfill-fact-pexels] (dry run) would enqueue");
    }
    return;
  }

  const jobs: PollableJob[] = [];
  let deduped = 0;
  for (const fact of toProcess) {
    const result = await enqueueFactPexels(fact.id, { bulkBackfill: true });
    if (!result.inserted) deduped++;
    jobs.push({ jobId: result.jobId, label: fact.text.slice(0, 60) });
  }
  logger.info({ enqueued: jobs.length, deduped }, "[backfill-fact-pexels] enqueued — waiting for the async-jobs worker to drain the queue");

  const { succeeded, skipped, failed, unresolved } = await pollJobsToTerminal(jobs, {
    log: (msg) => logger.info(`[backfill-fact-pexels] ${msg}`),
  });

  logger.info(
    { succeeded, skipped, failed, unresolved: unresolved.length, total: toProcess.length },
    "[backfill-fact-pexels] done",
  );
  if (failed > 0 || unresolved.length > 0) process.exitCode = 1;
}

run()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    logger.error({ err }, "[backfill-fact-pexels] failed");
    process.exit(1);
  });

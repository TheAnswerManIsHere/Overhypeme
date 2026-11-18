/**
 * @purpose One verdict on the polled alert sources — job lanes, recurring tasks, stuck jobs and Stripe events the webhook has not processed — for the combined health address an uptime check calls, and the Operations page's detail.
 * @subsystem operations
 *
 * Launch Phase 16, increment 2 (Issue #1029; plan design A, "detector kind 1",
 * and amendment 1 on David's Q13: 2 — one uptime check calls one address).
 *
 * Each part is judged on its own, so one failing to read never hides another,
 * and **a part that cannot be judged is unhealthy**: a failure to judge is
 * itself the alert. The verdict is held for a few seconds and computed once
 * for concurrent callers, so the unauthenticated address cannot be used to
 * multiply database reads or Stripe calls.
 */
import { and, gte, inArray, lte, sql } from "drizzle-orm";
import type Stripe from "stripe";
import { db as defaultDb } from "@workspace/db";
import { asyncJobsTable, stripeProcessedEventsTable } from "@workspace/db/schema";
import { heldAlertMsOf, laneOfQueue, registeredQueues } from "./asyncJobs";
import { laneHealth, type LaneHealth } from "./queueHealth";
import { taskHealth, type TaskHealth } from "./recurringTasks";
import type { StripeApi } from "./stripeApi";
import { logger } from "./logger";

const MINUTE = 60_000;

// ─── Jobs: due and unclaimed, or claimed and held ────────────────────────────

/**
 * A due job is "unclaimed" once it has waited this long while nothing in its
 * queue was claimed over the same window, and its lane holds no live claims.
 * A queue that is draining a backlog claims steadily and never trips it; a
 * queue nobody serves does. A lane busy with a long batch claims only between
 * batches (a tick claims rows due when it started), so a waiting job behind
 * live work is not unserved; a claim that never ends is the held rule's to
 * report (PR #1046 round 1).
 */
export const UNCLAIMED_ALERT_MS = 30 * MINUTE;

export interface StuckJobs {
  /** Queues with a due job waiting past the window and no claim in it. */
  unclaimedQueues: string[];
  /** Claims held past their queue's `alertWhenHeldMs`. */
  held: Array<{ id: number; queue: string; heldForMs: number }>;
}

export async function stuckJobs(
  dbInstance: Pick<typeof defaultDb, "select"> = defaultDb,
  now: Date = new Date(),
  busyLanes?: ReadonlySet<string>,
): Promise<StuckJobs> {
  const queues = registeredQueues();
  const cutoff = new Date(now.getTime() - UNCLAIMED_ALERT_MS);
  let unclaimedQueues: string[] = [];
  if (queues.length > 0) {
    const waiting = await dbInstance
      .select({ queue: asyncJobsTable.queue })
      .from(asyncJobsTable)
      .where(and(
        inArray(asyncJobsTable.queue, queues),
        inArray(asyncJobsTable.status, ["pending", "recovering"]),
        lte(asyncJobsTable.nextAttemptAt, cutoff),
      ))
      .groupBy(asyncJobsTable.queue);
    const candidates = waiting.map((w) => w.queue);
    if (candidates.length > 0) {
      const claiming = await dbInstance
        .select({ queue: asyncJobsTable.queue })
        .from(asyncJobsTable)
        .where(and(inArray(asyncJobsTable.queue, candidates), gte(asyncJobsTable.claimedAt, cutoff)))
        .groupBy(asyncJobsTable.queue);
      const served = new Set(claiming.map((c) => c.queue));
      const busy = busyLanes ?? new Set((await laneHealth(dbInstance)).filter((l) => l.inFlightCount > 0).map((l) => l.lane));
      unclaimedQueues = candidates.filter((q) => !served.has(q) && !busy.has(laneOfQueue(q) ?? "bulk")).sort();
    }
  }

  const processing = await dbInstance
    .select({
      id: asyncJobsTable.id,
      queue: asyncJobsTable.queue,
      // A row claimed before leases existed carries no claim time; its claim
      // stamped `updated_at`.
      heldSince: sql<Date>`coalesce(${asyncJobsTable.claimedAt}, ${asyncJobsTable.updatedAt})`,
    })
    .from(asyncJobsTable)
    .where(sql`${asyncJobsTable.status} = 'processing'`)
    .limit(1000);
  const held = processing
    .map((r) => ({ id: r.id, queue: r.queue, heldForMs: now.getTime() - new Date(r.heldSince).getTime() }))
    .filter((r) => r.heldForMs > heldAlertMsOf(r.queue))
    .sort((a, b) => b.heldForMs - a.heldForMs);
  return { unclaimedQueues, held };
}

// ─── Payments: Stripe events the webhook should have processed ──────────────

/**
 * Events created before this are not judged: the comparison begins with the
 * release that introduced it. Earlier failures are outside its scope.
 */
export const STRIPE_MONITORING_BEGAN = new Date("2026-11-19T00:00:00Z");
/** An event younger than this is still in normal delivery. */
export const STRIPE_EVENT_THRESHOLD_MS = 15 * MINUTE;
/** How far back the comparison looks. Stripe keeps events for 30 days. */
export const STRIPE_LOOKBACK_MS = 7 * 24 * 60 * MINUTE;
const STRIPE_PAGE_SIZE = 100;
/** Pages read before the comparison gives up as incomplete (unhealthy). */
export const STRIPE_MAX_PAGES = 10;

export type StripeComparison =
  | { status: "ok"; expected: number; unprocessed: number; oldestUnprocessedAt: Date | null }
  | { status: "unjudgeable"; reason: "stripe_unavailable" | "incomplete" | "read_failed" };

export interface StripeComparisonDeps {
  stripe: () => Promise<Pick<StripeApi, "events">>;
  supportedTypes: () => Promise<readonly string[]>;
  db: Pick<typeof defaultDb, "select">;
  now: Date;
}

async function defaultStripeDeps(): Promise<Omit<StripeComparisonDeps, "now">> {
  const { getUncachableStripeClient, getStripeSync } = await import("./stripeClient");
  return {
    // The active mode's verified client: the monitored account, in the mode
    // the product is taking payments in.
    stripe: () => getUncachableStripeClient(),
    // The very list the managed webhook is registered with (stripeInit.ts:
    // findOrCreateManagedWebhook subscribes the endpoint to these).
    supportedTypes: async () => (await getStripeSync()).getSupportedEventTypes(),
    db: defaultDb,
  };
}

/**
 * Every event Stripe holds that the product should have processed — in the
 * active mode, of a type the endpoint is registered for, created after
 * monitoring began and older than the delivery threshold, within the lookback
 * — compared with what the webhook recorded. Not filtered by local customer:
 * a first purchase whose webhook never arrived has no local record, and the
 * webhook records every event it is sent, the other business's included.
 */
const NOTHING_EXPECTED: StripeComparison = { status: "ok", expected: 0, unprocessed: 0, oldestUnprocessedAt: null };

export async function compareStripeEvents(deps: Partial<StripeComparisonDeps> = {}): Promise<StripeComparison> {
  const complete = deps.stripe && deps.supportedTypes && deps.db;
  const d: StripeComparisonDeps = { ...(complete ? {} : await defaultStripeDeps()), now: new Date(), ...deps } as StripeComparisonDeps;
  const now = d.now;
  const since = Math.max(STRIPE_MONITORING_BEGAN.getTime(), now.getTime() - STRIPE_LOOKBACK_MS);
  const until = now.getTime() - STRIPE_EVENT_THRESHOLD_MS;
  if (since >= until) return NOTHING_EXPECTED;

  let stripe: Pick<StripeApi, "events">;
  let types: Set<string>;
  try {
    stripe = await d.stripe();
    types = new Set(await d.supportedTypes());
  } catch (err) {
    logger.warn({ err }, "[operationalHealth] Stripe is not available to compare events");
    return { status: "unjudgeable", reason: "stripe_unavailable" };
  }

  const expected: Stripe.Event[] = [];
  try {
    let startingAfter: string | undefined;
    let pages = 0;
    for (;;) {
      const page = await stripe.events.list({
        created: { gte: Math.floor(since / 1000), lte: Math.floor(until / 1000) },
        limit: STRIPE_PAGE_SIZE,
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      });
      pages += 1;
      for (const e of page.data) if (types.has(e.type)) expected.push(e);
      if (!page.has_more || page.data.length === 0) break;
      if (pages >= STRIPE_MAX_PAGES) return { status: "unjudgeable", reason: "incomplete" };
      startingAfter = page.data[page.data.length - 1]!.id;
    }
  } catch (err) {
    logger.warn({ err }, "[operationalHealth] Stripe events could not be listed");
    return { status: "unjudgeable", reason: "stripe_unavailable" };
  }

  if (expected.length === 0) return NOTHING_EXPECTED;
  let processed: Set<string>;
  try {
    const rows = await d.db
      .select({ eventId: stripeProcessedEventsTable.eventId })
      .from(stripeProcessedEventsTable)
      .where(inArray(stripeProcessedEventsTable.eventId, expected.map((e) => e.id)));
    processed = new Set(rows.map((r) => r.eventId));
  } catch (err) {
    logger.warn({ err }, "[operationalHealth] processed Stripe events could not be read");
    return { status: "unjudgeable", reason: "read_failed" };
  }
  const missing = expected.filter((e) => !processed.has(e.id));
  const oldest = missing.reduce<number | null>((m, e) => (m === null || e.created < m ? e.created : m), null);
  return {
    status: "ok",
    expected: expected.length,
    unprocessed: missing.length,
    oldestUnprocessedAt: oldest === null ? null : new Date(oldest * 1000),
  };
}

// ─── The combined verdict ───────────────────────────────────────────────────

export type Part<T> = { status: "ok"; healthy: boolean; detail: T } | { status: "unjudgeable" };

export interface OperationalHealth {
  checkedAt: Date;
  healthy: boolean;
  lanes: Part<LaneHealth[]>;
  tasks: Part<TaskHealth[]>;
  jobs: Part<StuckJobs>;
  payments: Part<Extract<StripeComparison, { status: "ok" }>> | { status: "unjudgeable"; reason: string };
}

export interface OperationalHealthDeps {
  lanes: () => Promise<LaneHealth[]>;
  tasks: () => Promise<TaskHealth[]>;
  jobs: () => Promise<StuckJobs>;
  payments: () => Promise<StripeComparison>;
}

/**
 * The Stripe comparison reads up to ten pages from Stripe, and an event is only
 * expected after fifteen minutes, so it is held longer than the whole verdict:
 * a good answer for two minutes, a failed one not at all.
 */
const PAYMENTS_CACHE_MS = 2 * 60_000;
let paymentsCached: { at: number; result: StripeComparison } | null = null;
async function paymentsCachedRead(): Promise<StripeComparison> {
  if (paymentsCached && Date.now() - paymentsCached.at < PAYMENTS_CACHE_MS) return paymentsCached.result;
  const result = await compareStripeEvents();
  paymentsCached = result.status === "ok" ? { at: Date.now(), result } : null;
  return result;
}

const realDeps: OperationalHealthDeps = {
  lanes: () => laneHealth(),
  tasks: () => taskHealth(),
  jobs: () => stuckJobs(),
  payments: paymentsCachedRead,
};
let deps = realDeps;
export function __setOperationalHealthDepsForTest(next: Partial<OperationalHealthDeps> | null): void {
  deps = next ? { ...realDeps, ...next } : realDeps;
  cached = null;
  inFlight = null;
  paymentsCached = null;
}

async function judge<T>(what: string, read: () => Promise<T>, healthy: (t: T) => boolean): Promise<Part<T>> {
  try {
    const detail = await read();
    return { status: "ok", healthy: healthy(detail), detail };
  } catch (err) {
    logger.error({ err, part: what }, "[operationalHealth] a part could not be judged");
    return { status: "unjudgeable" };
  }
}

export async function evaluateOperationalHealth(): Promise<OperationalHealth> {
  const [lanes, tasks, jobs, payments] = await Promise.all([
    judge("lanes", deps.lanes, (l) => l.every((x) => !x.stalled)),
    judge("tasks", deps.tasks, (t) => t.every((x) => !x.overdue)),
    judge("jobs", deps.jobs, (j) => j.unclaimedQueues.length === 0 && j.held.length === 0),
    deps.payments().then(
      (c): OperationalHealth["payments"] =>
        c.status === "ok" ? { status: "ok", healthy: c.unprocessed === 0, detail: c } : { status: "unjudgeable", reason: c.reason },
      (err: unknown): OperationalHealth["payments"] => {
        logger.error({ err, part: "payments" }, "[operationalHealth] a part could not be judged");
        return { status: "unjudgeable", reason: "read_failed" };
      },
    ),
  ]);
  const parts = [lanes, tasks, jobs, payments];
  return {
    checkedAt: new Date(),
    healthy: parts.every((p) => p.status === "ok" && p.healthy),
    lanes,
    tasks,
    jobs,
    payments,
  };
}

/** Long enough to absorb a burst of callers; short beside a once-a-minute uptime check. */
const VERDICT_CACHE_MS = 20_000;
let cached: { at: number; health: OperationalHealth } | null = null;
let inFlight: Promise<OperationalHealth> | null = null;

export async function operationalHealthCached(): Promise<OperationalHealth> {
  if (cached && Date.now() - cached.at < VERDICT_CACHE_MS) return cached.health;
  inFlight ??= evaluateOperationalHealth()
    .then((health) => {
      cached = { at: Date.now(), health };
      return health;
    })
    .finally(() => { inFlight = null; });
  return inFlight;
}

/** What the unauthenticated address may say: a status per part and counts, nothing else. */
export function publicSummary(h: OperationalHealth) {
  const state = (p: { status: string; healthy?: boolean }) =>
    p.status !== "ok" ? "unjudgeable" : p.healthy ? "ok" : "unhealthy";
  /** A count read from a judged part's detail; null when the part was not judged. */
  const count = <T>(p: Part<T> | { status: "unjudgeable" }, of: (detail: T) => number): number | null =>
    p.status === "ok" ? of(p.detail) : null;
  return {
    ok: h.healthy,
    ts: h.checkedAt.toISOString(),
    lanes: { state: state(h.lanes), stalled: count(h.lanes, (d) => d.filter((l) => l.stalled).length) },
    tasks: { state: state(h.tasks), overdue: count(h.tasks, (d) => d.filter((t) => t.overdue).length) },
    jobs: {
      state: state(h.jobs),
      unclaimedQueues: count(h.jobs, (d) => d.unclaimedQueues.length),
      held: count(h.jobs, (d) => d.held.length),
    },
    payments: { state: state(h.payments), unprocessed: count(h.payments, (d) => d.unprocessed) },
  };
}

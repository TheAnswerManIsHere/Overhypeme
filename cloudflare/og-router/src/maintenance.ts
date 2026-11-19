/**
 * @purpose The daily caller of the app's maintenance run (launch Phase 14, increment 6b, plan S-i): POSTs /api/jobs/maintenance with the cron secret once a day from this Worker's scheduled trigger, retries once on a cold start, and throws on anything but a clean run, so a missed or failed day shows as a failed invocation in the Worker's Cron Events and logs.
 * @subsystem worker
 *
 * Why it lives here: the app scales to zero after 15 idle minutes and its
 * schedulers are timers inside that process, so a quiet site runs no
 * cleanup. A Cloudflare scheduled trigger is outside the process and is
 * free on this account's plan; GitHub's scheduler was rejected in the plan
 * because it may drop runs and disables schedules on an inactive repository.
 *
 * Kept free of Worker-only globals and imports so `node --test` can run it
 * with a stubbed fetch (test/maintenance.test.ts).
 */

export interface MaintenanceEnv {
  /** The app's `CRON_SECRET`, set on this Worker as a secret. */
  CRON_SECRET?: string;
  /** Where the run is called; `wrangler.toml` [vars]. */
  MAINTENANCE_URL?: string;
}

export const DEFAULT_MAINTENANCE_URL = "https://overhype.me/api/jobs/maintenance";

/** How long to wait before the one retry: long enough for a cold start. */
export const RETRY_DELAY_MS = 30_000;

/** Answers that mean the app was starting or briefly unreachable, worth one retry. */
const RETRYABLE_STATUSES = new Set([502, 503, 504]);

interface JobOutcome {
  job: string;
  ok: boolean;
  ms?: number;
  error?: string;
}

export interface MaintenanceCallResult {
  status: number;
  attempts: number;
  jobs: JobOutcome[];
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function summarise(jobs: JobOutcome[]): JobOutcome[] {
  // Only names, outcomes and failure reasons are logged: a job's `result`
  // can hold counts and file names, which the Worker's log does not need.
  return jobs.map((j) => ({ job: j.job, ok: j.ok, ms: j.ms, ...(j.error ? { error: j.error } : {}) }));
}

function readJobs(body: unknown): JobOutcome[] | null {
  if (typeof body !== "object" || body === null) return null;
  const jobs = (body as { jobs?: unknown }).jobs;
  if (!Array.isArray(jobs)) return null;
  if (!jobs.every((j) => typeof j === "object" && j !== null && typeof (j as JobOutcome).job === "string" && typeof (j as JobOutcome).ok === "boolean")) return null;
  return jobs as JobOutcome[];
}

/**
 * Calls the maintenance run once, with one retry after `RETRY_DELAY_MS` when
 * the app answers 502/503/504 or cannot be reached. Resolves only on a 200
 * whose body says every job succeeded; every other outcome throws a plain
 * reason. A redirect is never followed: the canonical host answers a
 * refused country with a redirect to /unavailable, and following it would
 * turn "the call never reached the API" into a page that looks fine.
 */
export async function callDailyMaintenance(
  env: MaintenanceEnv,
  fetchImpl: FetchLike = fetch,
  sleep: (ms: number) => Promise<void> = realSleep,
): Promise<MaintenanceCallResult> {
  const secret = env.CRON_SECRET;
  if (!secret) throw new Error("CRON_SECRET is not set on the Worker, so the daily maintenance run was not called");
  const url = env.MAINTENANCE_URL || DEFAULT_MAINTENANCE_URL;

  let attempts = 0;
  let res: Response | undefined;
  let lastError = "";
  while (attempts < 2) {
    attempts += 1;
    try {
      res = await fetchImpl(url, {
        method: "POST",
        headers: { "x-cron-secret": secret, "user-agent": "overhype-og-router/daily-maintenance" },
        redirect: "manual",
      });
      if (!RETRYABLE_STATUSES.has(res.status)) break;
      lastError = `the app answered ${res.status}`;
    } catch (err) {
      res = undefined;
      lastError = `the app could not be reached (${err instanceof Error ? err.message : String(err)})`;
    }
    if (attempts < 2) await sleep(RETRY_DELAY_MS);
  }

  if (!res || RETRYABLE_STATUSES.has(res.status)) {
    throw new Error(`daily maintenance not run after ${attempts} attempts: ${lastError}`);
  }
  if (res.status >= 300 && res.status < 400) {
    throw new Error(`daily maintenance call was redirected (${res.status} to ${res.headers.get("location") ?? "no location"}), so it never reached the API`);
  }
  if (res.status === 403) {
    throw new Error("daily maintenance call was refused (403): the Worker's CRON_SECRET does not match the app's");
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new Error(`daily maintenance answered ${res.status} with a body that is not JSON, so the run's outcome is unknown`);
  }
  const jobs = readJobs(body);
  if (!jobs) throw new Error(`daily maintenance answered ${res.status} without a list of job outcomes`);

  const ok = (body as { ok?: unknown }).ok === true && res.status === 200 && jobs.every((j) => j.ok);
  if (!ok) {
    const failed = jobs.filter((j) => !j.ok).map((j) => `${j.job}${j.error ? ` (${j.error})` : ""}`);
    throw new Error(`daily maintenance had failures (${res.status}): ${failed.length ? failed.join("; ") : "no job named as failed"}`);
  }

  const result = { status: res.status, attempts, jobs: summarise(jobs) };
  console.log(JSON.stringify({ msg: "daily maintenance completed", ...result }));
  return result;
}

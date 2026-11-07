/**
 * The engine comparison's fal transport (launch Phase 8, increment 2b; plan
 * `docs/plans/PLAN_PHASE8_ENGINE_EVALUATION.md`, *Settled Decisions*, "Spend
 * is bounded before dispatch, by reservation").
 *
 * One permitted attempt is one priced call, so a comparison cell submits
 * exactly once. The installed `@fal-ai/client` retries queue submission
 * regardless of its configuration (the plan cites `src/queue.js:34` and
 * `src/request.js:59` in 1.9.5), so submission is a single POST of our own to
 * fal's queue; status and result keep the SDK's calls, which are reads and
 * cost nothing to repeat.
 */

import { fal, getFalApiKey } from "../falClient";

export interface ComparisonFal {
  /** Submit once; resolves to fal's request id. Never retried. */
  submit(endpointId: string, input: Record<string, unknown>): Promise<string>;
  /** fal's queue status for a submitted request. */
  status(endpointId: string, requestId: string): Promise<string>;
  /** The completed request's output. */
  result(endpointId: string, requestId: string): Promise<unknown>;
  /**
   * What fal billed for a request, in USD, or null while it has not reported
   * it. Read from fal's billing events by request id
   * (`GET https://api.fal.ai/v1/models/billing-events?request_id=…`,
   * `cost_total`); a key without billing permission throws, saying so.
   */
  billedUsd(requestId: string): Promise<number | null>;
}

const FAL_QUEUE_BASE = "https://queue.fal.run";
const FAL_BILLING_EVENTS = "https://api.fal.ai/v1/models/billing-events";

const liveFal: ComparisonFal = {
  async submit(endpointId, input) {
    // The one place a comparison can spend: refused in CI whatever called it.
    if (process.env["CI"]) throw new Error("paid comparison calls never run in CI");
    const key = getFalApiKey();
    if (!key) throw new Error("FAL_AI_API_KEY (or FAL_KEY) is not set, so no comparison call can be submitted");
    const res = await fetch(`${FAL_QUEUE_BASE}/${endpointId}`, {
      method: "POST",
      headers: { Authorization: `Key ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`fal submit to ${endpointId} returned ${res.status}: ${text.slice(0, 300)}`);
    const body = JSON.parse(text) as { request_id?: unknown };
    if (typeof body.request_id !== "string" || !body.request_id) throw new Error(`fal submit to ${endpointId} returned no request_id`);
    return body.request_id;
  },
  async status(endpointId, requestId) {
    const s = (await fal.queue.status(endpointId, { requestId, logs: false })) as { status?: unknown };
    return typeof s.status === "string" ? s.status : "UNKNOWN";
  },
  async result(endpointId, requestId) {
    const r = (await fal.queue.result(endpointId, { requestId })) as { data?: unknown };
    return r.data ?? r;
  },
  async billedUsd(requestId) {
    const key = getFalApiKey();
    if (!key) throw new Error("FAL_AI_API_KEY (or FAL_KEY) is not set, so no bill can be read");
    // The default window is the last 24 hours, which covers a run in progress.
    const res = await fetch(`${FAL_BILLING_EVENTS}?request_id=${encodeURIComponent(requestId)}`, { headers: { Authorization: `Key ${key}` } });
    if (res.status === 401 || res.status === 403) {
      throw new Error(`fal refused to report bills (${res.status}): the key needs billing permission`);
    }
    if (!res.ok) throw new Error(`fal's billing events returned ${res.status}`);
    const body = (await res.json()) as { billing_events?: Array<{ request_id?: string; cost_total?: unknown }> };
    const events = (body.billing_events ?? []).filter((e) => e.request_id === requestId && typeof e.cost_total === "number");
    return events.length ? events.reduce((sum, e) => sum + (e.cost_total as number), 0) : null;
  },
};

let override: ComparisonFal | null = null;

/** Test seam: replace the transport so no test reaches fal. */
export function __setComparisonFalForTest(impl: ComparisonFal | null): void {
  override = impl;
}

export function comparisonFal(): ComparisonFal {
  return override ?? liveFal;
}

/** fal's queue statuses that mean "not finished yet". */
const PENDING = new Set(["IN_QUEUE", "IN_PROGRESS"]);

interface PollOptions {
  intervalMs: number;
  timeoutMs: number;
  sleep?: (ms: number) => Promise<void>;
}

const sleepFor = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Poll a submitted request to completion and return its output. A status
 * that is neither pending nor COMPLETED, or the timeout, throws: the caller
 * treats the call as made and billed until shown otherwise.
 */
export async function awaitResult(endpointId: string, requestId: string, opts: PollOptions): Promise<unknown> {
  const transport = comparisonFal();
  const sleep = opts.sleep ?? sleepFor;
  const deadline = Date.now() + opts.timeoutMs;
  for (;;) {
    const status = await transport.status(endpointId, requestId);
    if (status === "COMPLETED") return transport.result(endpointId, requestId);
    if (!PENDING.has(status)) throw new Error(`fal request ${requestId} on ${endpointId} ended ${status}`);
    if (Date.now() >= deadline) throw new Error(`fal request ${requestId} on ${endpointId} did not complete within ${opts.timeoutMs} ms`);
    await sleep(opts.intervalMs);
  }
}

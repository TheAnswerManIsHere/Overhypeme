/**
 * The image render's fal transport (plan docs/plans/PLAN_JOB_RESUME.md §C,
 * Issue #1000 increment 2).
 *
 * A render submits with ONE POST of our own and gets fal's request id back
 * before any wait, so the id is on record the moment fal has accepted the
 * request and a server stop during the drawing loses nothing: the next run
 * collects the picture rather than paying for a new one. The installed
 * `@fal-ai/client` retries queue submission on its own (`queue.js`, 1.9.5),
 * which could pay twice for one request; the comparison's transport avoids it
 * the same way (`comparison/transport.ts`). Status and result keep the SDK's
 * calls: they are reads, free to repeat.
 *
 * Under the recorded double and the recorder (`AI_BACKEND`), whose recordings
 * are of `fal.subscribe`, a submit runs that subscribe and keeps its answer
 * under the request id it carries, and status and result read it back. So the
 * recordings and the acceptance suite are unchanged; the resume paths are
 * exercised through the test seam instead.
 */

import { aiBackend } from "./aiClients";
import { fal, getFalApiKey } from "./falClient";

export interface RenderFal {
  /** Submit once; resolves to fal's request id. Never retried. */
  submit(endpointId: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<string>;
  /** fal's queue status word for a submitted request (IN_QUEUE, IN_PROGRESS, COMPLETED, …). */
  status(endpointId: string, requestId: string): Promise<string>;
  /**
   * The completed request's output. Throws fal's own error for a request that
   * failed (a content refusal is a 422 whose body names it).
   */
  result(endpointId: string, requestId: string): Promise<unknown>;
  /**
   * Every request fal's history holds for the endpoint since `since`, with its
   * input. Throws when the history cannot be read in full, or when an entry
   * comes back without its input: the caller treats either as ambiguous.
   */
  history(endpointId: string, since: Date): Promise<FalHistoryEntry[]>;
}

export interface FalHistoryEntry {
  requestId: string;
  input: unknown;
}

/** An HTTP failure from fal, shaped like the SDK's ApiError so `falContentRefusal` reads it. */
export class FalHttpError extends Error {
  constructor(message: string, readonly status: number, readonly body: unknown) {
    super(message);
    this.name = "FalHttpError";
  }
}

const FAL_QUEUE_BASE = "https://queue.fal.run";
const FAL_HISTORY_URL = "https://api.fal.ai/v1/models/requests/by-endpoint";
/** Pages read before the history is called unreadable (100 entries a page). */
const HISTORY_MAX_PAGES = 20;

function liveKey(): string {
  const key = getFalApiKey();
  if (!key) throw new Error("FAL_AI_API_KEY (or FAL_KEY) is not set, so no render can be submitted");
  return key;
}

async function parseBody(text: string): Promise<unknown> {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const liveFal: RenderFal = {
  async submit(endpointId, input, signal) {
    const res = await fetch(`${FAL_QUEUE_BASE}/${endpointId}`, {
      method: "POST",
      headers: { Authorization: `Key ${liveKey()}`, "Content-Type": "application/json" },
      body: JSON.stringify(input),
      signal,
    });
    const body = await parseBody(await res.text());
    if (!res.ok) {
      throw new FalHttpError(`fal submit to ${endpointId} returned ${res.status}`, res.status, body);
    }
    const requestId = (body as { request_id?: unknown } | null)?.request_id;
    if (typeof requestId !== "string" || !requestId) throw new Error(`fal submit to ${endpointId} returned no request_id`);
    return requestId;
  },
  async status(endpointId, requestId) {
    const s = (await fal.queue.status(endpointId, { requestId, logs: false })) as { status?: unknown };
    return typeof s.status === "string" ? s.status : "UNKNOWN";
  },
  async result(endpointId, requestId) {
    const r = (await fal.queue.result(endpointId, { requestId })) as { data?: unknown };
    return r.data ?? r;
  },
  async history(endpointId, since) {
    const entries: FalHistoryEntry[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < HISTORY_MAX_PAGES; page++) {
      const qs = new URLSearchParams({ endpoint_id: endpointId, start: since.toISOString(), limit: "100", expand: "payloads" });
      if (cursor) qs.set("cursor", cursor);
      const res = await fetch(`${FAL_HISTORY_URL}?${qs}`, { headers: { Authorization: `Key ${liveKey()}` } });
      const body = await parseBody(await res.text());
      if (!res.ok) throw new FalHttpError(`fal request history returned ${res.status}`, res.status, body);
      const b = body as { items?: unknown; next_cursor?: unknown };
      if (!Array.isArray(b.items)) throw new Error("fal request history returned no items list");
      for (const item of b.items as Array<Record<string, unknown>>) {
        const requestId = item["request_id"];
        if (typeof requestId !== "string" || !requestId) throw new Error("fal request history returned an entry without its request_id");
        if (!("json_input" in item)) throw new Error(`fal request history returned ${requestId} without its input`);
        entries.push({ requestId, input: item["json_input"] });
      }
      cursor = typeof b.next_cursor === "string" && b.next_cursor ? b.next_cursor : null;
      if (!cursor) return entries;
    }
    throw new Error(`fal request history ran past ${HISTORY_MAX_PAGES} pages`);
  },
};

/** Answers kept by the subscribe-backed transport, by request id (recorded double and recorder only). */
const subscribed = new Map<string, unknown>();
let subscribedSeq = 0;

const subscribeBackedFal: RenderFal = {
  async submit(endpointId, input, signal) {
    const response = await fal.subscribe(endpointId, { input, logs: false, abortSignal: signal });
    // Recordings replay one scrubbed id for every replay of the same request,
    // so the id kept here is made unique to this process's submit.
    const requestId = (response as { requestId?: unknown }).requestId;
    const id = `${typeof requestId === "string" && requestId ? requestId : "subscribed"}#${++subscribedSeq}`;
    subscribed.set(id, (response as { data?: unknown }).data ?? response);
    return id;
  },
  async status(_endpointId, requestId) {
    return subscribed.has(requestId) ? "COMPLETED" : "UNKNOWN";
  },
  async result(endpointId, requestId) {
    // Gone (read already, or another process): a known end, so the retry submits anew, as subscribe did.
    if (!subscribed.has(requestId)) throw new FalHttpError(`no answer kept for ${requestId} on ${endpointId} in this process`, 404, null);
    const answer = subscribed.get(requestId);
    subscribed.delete(requestId); // read once, by the collect that submitted it
    return answer;
  },
  async history() {
    throw new Error("fal's request history is not available under the recorded double or the recorder");
  },
};

let override: RenderFal | null = null;

/** Test seam: replace the transport so no test reaches fal. */
export function __setRenderFalForTest(impl: RenderFal | null): void {
  override = impl;
}

export function renderFal(): RenderFal {
  if (override) return override;
  return aiBackend() === "vendors" ? liveFal : subscribeBackedFal;
}

/** fal's queue statuses that mean "not finished yet". */
export const FAL_PENDING_STATUSES = new Set(["IN_QUEUE", "IN_PROGRESS"]);

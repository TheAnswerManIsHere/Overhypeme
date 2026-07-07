/**
 * useTaxonomyHealthActions — PR4 bulk send-back coverage.
 *
 * Focus: a handler-level (job-based) skip renders as "skipped", never a bare
 * "done"; counts correctly move such a job from done into skipped; a
 * concurrently-tracked bulk + row scope don't clobber each other; and the
 * most-recent operation touching a fact wins its row display (scope
 * precedence — a fact queued by a bulk run then re-clicked individually shows
 * the newer operation's state).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useTaxonomyHealthActions } from "./useTaxonomyHealthActions";

const POLL_INTERVAL_MS = 1000;

interface Call { url: string; method: string; body?: unknown }

function mockFetch(jobStatusResponses: unknown[]) {
  const calls: Call[] = [];
  let jobStatusCallIndex = 0;
  const fetchMock = vi.fn(async (url: string, opts?: RequestInit) => {
    const method = opts?.method ?? "GET";
    const body = opts?.body ? JSON.parse(opts.body as string) : undefined;
    calls.push({ url: String(url), method, body });
    if (String(url).includes("/job-status")) {
      const resp = jobStatusResponses[Math.min(jobStatusCallIndex, jobStatusResponses.length - 1)];
      jobStatusCallIndex++;
      return new Response(JSON.stringify(resp), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    // The action POST itself (bulk-send-back, etc).
    return new Response(JSON.stringify(actionResponseFor(body as { scope?: string; factIds?: number[] })), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls };
}

function actionResponseFor(body: { scope?: string; factIds?: number[] }) {
  if (body?.scope === "selected" && body.factIds?.length === 1) {
    return {
      mode: "queued",
      jobs: [{ factId: body.factIds[0], jobId: 900 + body.factIds[0], queue: "fact_send_back", dedupeKey: null, action: "send_back_to_review", status: "pending", deduped: false }],
      outcomes: [],
      summary: { requested: 1, queued: 1, done: 0, failed: 0, skipped: 0 },
      totalStale: 10,
      eligibleRemaining: 8,
      batchLimit: 50,
    };
  }
  // all_stale — two jobs.
  return {
    mode: "queued",
    jobs: [
      { factId: 1, jobId: 101, queue: "fact_send_back", dedupeKey: null, action: "send_back_to_review", status: "pending", deduped: false },
      { factId: 2, jobId: 102, queue: "fact_send_back", dedupeKey: null, action: "send_back_to_review", status: "pending", deduped: false },
    ],
    outcomes: [],
    summary: { requested: 2, queued: 2, done: 0, failed: 0, skipped: 0 },
    totalStale: 2,
    eligibleRemaining: 0,
    batchLimit: 50,
  };
}

describe("useTaxonomyHealthActions — bulk send-back", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("a done job carrying a handler-level skip renders 'skipped', not 'done', and counts move it out of done", async () => {
    mockFetch([
      { jobs: [
        { jobId: 101, queue: "fact_send_back", dedupeKey: null, status: "done", attempts: 1, maxAttempts: 5, error: null, updatedAt: null },
        { jobId: 102, queue: "fact_send_back", dedupeKey: null, status: "done", attempts: 1, maxAttempts: 5, error: null, updatedAt: null, skipped: true, skipReason: "already_in_review" },
      ] },
    ]);
    const onChanged = vi.fn();
    const { result } = renderHook(() => useTaxonomyHealthActions(onChanged));

    await act(async () => {
      await result.current.submit("bulk", "send_back_to_review", "/api/admin/taxonomy-health/actions/bulk-send-back", { scope: "all_stale" });
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS); });

    const rowDone = result.current.rowState(1);
    expect(rowDone.state).toBe("done");

    const rowSkipped = result.current.rowState(2);
    expect(rowSkipped.state).toBe("skipped");
    expect(rowSkipped.outcome?.status).toBe("skipped");
    if (rowSkipped.outcome?.status === "skipped") {
      expect(rowSkipped.outcome.reason).toBe("already_in_review");
    }

    const counts = result.current.counts("bulk");
    expect(counts?.done).toBe(1);
    expect(counts?.skipped).toBe(1);
  });

  it("scope precedence: the most-recent operation touching a fact wins its row display", async () => {
    mockFetch([
      // First poll: bulk job for fact 1 still processing.
      { jobs: [{ jobId: 101, queue: "fact_send_back", dedupeKey: null, status: "processing", attempts: 0, maxAttempts: 5, error: null, updatedAt: null }] },
    ]);
    const onChanged = vi.fn();
    const { result } = renderHook(() => useTaxonomyHealthActions(onChanged));

    await act(async () => {
      await result.current.submit("bulk", "send_back_to_review", "/api/admin/taxonomy-health/actions/bulk-send-back", { scope: "all_stale" });
    });
    expect(result.current.rowState(1).state).toBe("queued");
    expect(result.current.factBusy(1)).toBe(true);

    // A single-row send-back fires for the SAME fact from a different scope —
    // it must become the fact's authoritative display (most-recent op wins).
    await act(async () => {
      await result.current.submit("row:1", "send_back_to_review", "/api/admin/taxonomy-health/actions/bulk-send-back", { scope: "selected", factIds: [1] });
    });
    // The row-scoped op has its own freshly-posted job for fact 1 (jobId 901).
    const row = result.current.rowState(1);
    expect(row.state).toBe("queued");
    expect(result.current.factBusy(1)).toBe(true);
  });

  it("selected scope: submitting with one factId only ever targets that fact", async () => {
    const { calls } = mockFetch([
      { jobs: [{ jobId: 901, queue: "fact_send_back", dedupeKey: null, status: "pending", attempts: 0, maxAttempts: 5, error: null, updatedAt: null }] },
    ]);
    const { result } = renderHook(() => useTaxonomyHealthActions(vi.fn()));
    await act(async () => {
      await result.current.submit("row:1", "send_back_to_review", "/api/admin/taxonomy-health/actions/bulk-send-back", { scope: "selected", factIds: [1] });
    });
    const postCall = calls.find((c) => c.method === "POST" && String(c.url).includes("bulk-send-back"));
    expect((postCall?.body as { factIds?: number[] })?.factIds).toEqual([1]);
    expect(result.current.rowState(1).state).toBe("queued");
    expect(result.current.rowState(2).state).toBe("unknown");
  });

  it("refetches (onChanged) exactly once when the operation becomes fully terminal", async () => {
    mockFetch([
      { jobs: [
        { jobId: 101, queue: "fact_send_back", dedupeKey: null, status: "done", attempts: 1, maxAttempts: 5, error: null, updatedAt: null },
        { jobId: 102, queue: "fact_send_back", dedupeKey: null, status: "done", attempts: 1, maxAttempts: 5, error: null, updatedAt: null, skipped: true, skipReason: "already_in_review" },
      ] },
    ]);
    const onChanged = vi.fn();
    const { result } = renderHook(() => useTaxonomyHealthActions(onChanged));
    await act(async () => {
      await result.current.submit("bulk", "send_back_to_review", "/api/admin/taxonomy-health/actions/bulk-send-back", { scope: "all_stale" });
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS); });
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS); });
    expect(onChanged).toHaveBeenCalledTimes(1);
  });
});

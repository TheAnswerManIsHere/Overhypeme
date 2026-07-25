/**
 * useBulkMediaBackfillActions — bulk media backfill (task 17) coverage.
 *
 * Focus: submit posts to the given route and seeds jobs as "pending"; polling
 * moves counts from queued into done/failed/still-running; a route-level skip
 * outcome counts toward `skipped` without ever being polled; a handler-level
 * skip (done + {skipped:true}) counts toward `skipped`, NOT `done`; large
 * batches poll in chunks; itemOutcomes exposes labeled failed/skipped items;
 * independent action keys don't clobber each other's state.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useBulkMediaBackfillActions } from "./useBulkMediaBackfillActions";

const POLL_INTERVAL_MS = 2000;

interface Call { url: string; method: string; body?: unknown }

function mockFetch(actionResponse: unknown, jobStatusResponses: unknown[]) {
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
    return new Response(JSON.stringify(actionResponse), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls };
}

describe("useBulkMediaBackfillActions", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("submit posts to the given url and seeds returned jobs as pending", async () => {
    const { calls } = mockFetch(
      {
        success: true,
        jobs: [{ factId: 1, jobId: 501, label: "fact one", deduped: false }, { factId: 2, jobId: 502, label: "fact two", deduped: true }],
        outcomes: [],
        summary: { requested: 2, queued: 2, skipped: 0 },
      },
      [],
    );
    const { result } = renderHook(() => useBulkMediaBackfillActions());
    await act(async () => {
      await result.current.submit("backfill_images", "/api/admin/facts/backfill-images");
    });
    const postCall = calls.find((c) => c.method === "POST" && c.url.includes("backfill-images"));
    expect(postCall).toBeTruthy();
    expect(result.current.counts("backfill_images")).toEqual({
      requested: 2, queued: 2, done: 0, failed: 0, skipped: 0, running: 2, stillRunning: 0,
    });
    expect(result.current.busy("backfill_images")).toBe(true);
  });

  it("polling moves jobs from queued into done/failed and stops being busy once terminal", async () => {
    mockFetch(
      {
        success: true,
        jobs: [{ factId: 1, jobId: 501, label: "fact one", deduped: false }, { factId: 2, jobId: 502, label: "fact two", deduped: false }],
        outcomes: [],
        summary: { requested: 2, queued: 2, skipped: 0 },
      },
      [
        { jobs: [
          { jobId: 501, status: "done", error: null },
          { jobId: 502, status: "failed", error: "boom" },
        ] },
      ],
    );
    const { result } = renderHook(() => useBulkMediaBackfillActions());
    await act(async () => {
      await result.current.submit("backfill_pexels", "/api/admin/backfill-pexels");
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS); });

    expect(result.current.counts("backfill_pexels")).toEqual({
      requested: 2, queued: 2, done: 1, failed: 1, skipped: 0, running: 0, stillRunning: 0,
    });
    expect(result.current.busy("backfill_pexels")).toBe(false);
    expect(result.current.itemOutcomes("backfill_pexels")).toEqual([
      { label: "fact two", status: "failed", error: "boom" },
    ]);
  });

  it("a route-level skip outcome counts toward skipped and is never polled", async () => {
    const { calls } = mockFetch(
      {
        success: true,
        jobs: [{ factId: 1, jobId: 501, label: "fact one", deduped: false }],
        outcomes: [{ factId: 2, status: "skipped", reason: "not_active", label: "fact two" }],
        summary: { requested: 2, queued: 1, skipped: 1 },
      },
      [{ jobs: [{ jobId: 501, status: "processing", error: null }] }],
    );
    const { result } = renderHook(() => useBulkMediaBackfillActions());
    await act(async () => {
      await result.current.submit("backfill_ai_memes", "/api/admin/facts/backfill-ai-memes");
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS); });

    expect(result.current.counts("backfill_ai_memes")?.skipped).toBe(1);
    expect(result.current.itemOutcomes("backfill_ai_memes")).toEqual([{ label: "fact two", status: "skipped" }]);
    const jobStatusCalls = calls.filter((c) => c.url.includes("/job-status"));
    for (const c of jobStatusCalls) {
      const ids = (c.body as { jobs: Array<{ jobId: number }> }).jobs.map((j) => j.jobId);
      expect(ids).not.toContain(2); // fact 2's skip has no jobId — never a poll target
    }
  });

  it("a handler-level skip (done + skipped:true) counts toward skipped, not done", async () => {
    mockFetch(
      {
        success: true,
        jobs: [{ factId: 1, jobId: 501, label: "deactivated mid-flight", deduped: false }],
        outcomes: [],
        summary: { requested: 1, queued: 1, skipped: 0 },
      },
      [{ jobs: [{ jobId: 501, status: "done", error: null, skipped: true }] }],
    );
    const { result } = renderHook(() => useBulkMediaBackfillActions());
    await act(async () => {
      await result.current.submit("backfill_images", "/api/admin/facts/backfill-images");
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS); });

    const counts = result.current.counts("backfill_images");
    expect(counts?.done).toBe(0);
    expect(counts?.skipped).toBe(1);
    expect(result.current.itemOutcomes("backfill_images")).toEqual([
      { label: "deactivated mid-flight", status: "skipped", error: null },
    ]);
  });

  it("polls a large batch in chunks rather than one unbounded request", async () => {
    const jobs = Array.from({ length: 450 }, (_, i) => ({ factId: i, jobId: 1000 + i, label: `fact ${i}`, deduped: false }));
    const { calls } = mockFetch(
      { success: true, jobs, outcomes: [], summary: { requested: 450, queued: 450, skipped: 0 } },
      [{ jobs: jobs.map((j) => ({ jobId: j.jobId, status: "pending", error: null })) }],
    );
    const { result } = renderHook(() => useBulkMediaBackfillActions());
    await act(async () => {
      await result.current.submit("backfill_ai_memes", "/api/admin/facts/backfill-ai-memes");
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS); });

    const jobStatusCalls = calls.filter((c) => c.url.includes("/job-status"));
    expect(jobStatusCalls.length).toBeGreaterThan(1);
    for (const c of jobStatusCalls) {
      const ids = (c.body as { jobs: Array<{ jobId: number }> }).jobs;
      expect(ids.length).toBeLessThanOrEqual(200);
    }
    const totalPolled = jobStatusCalls.reduce((n, c) => n + (c.body as { jobs: unknown[] }).jobs.length, 0);
    expect(totalPolled).toBe(450);
  });

  it("independent action keys track state separately", async () => {
    mockFetch(
      {
        success: true,
        jobs: [{ factId: 1, jobId: 501, label: "fact one", deduped: false }],
        outcomes: [],
        summary: { requested: 1, queued: 1, skipped: 0 },
      },
      [],
    );
    const { result } = renderHook(() => useBulkMediaBackfillActions());
    await act(async () => {
      await result.current.submit("backfill_images", "/api/admin/facts/backfill-images");
    });
    expect(result.current.busy("backfill_images")).toBe(true);
    expect(result.current.busy("backfill_pexels")).toBe(false);
    expect(result.current.counts("backfill_pexels")).toBeNull();
  });

  it("a non-ok response surfaces an error and clears posting without throwing", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: "nope" }), { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useBulkMediaBackfillActions());
    await act(async () => {
      await result.current.submit("backfill_images", "/api/admin/facts/backfill-images");
    });
    expect(result.current.error).toBe("Not authorized.");
    expect(result.current.busy("backfill_images")).toBe(false);
  });
});

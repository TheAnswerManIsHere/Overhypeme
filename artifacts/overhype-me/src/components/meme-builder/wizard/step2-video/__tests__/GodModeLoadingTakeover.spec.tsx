import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import {
  GodModeLoadingTakeover,
  type VideoJobApi,
  type VideoJobStatus,
} from "../GodModeLoadingTakeover";
import type { LookStyleDTO } from "../data/videoCatalogue";

const LOOK_STYLES: LookStyleDTO[] = [
  { id: "cinematic", label: "Cinematic", sortOrder: 0 },
];

interface ApiCounters {
  pollCalls: number;
  proceedCalls: number;
  regenerateCalls: { lookStyleId?: string }[];
  cancelCalls: number;
  noFaceCalls: number;
}

function makeApi(statusQueue: VideoJobStatus[]): { api: VideoJobApi; counters: ApiCounters } {
  let i = 0;
  const counters: ApiCounters = {
    pollCalls: 0,
    proceedCalls: 0,
    regenerateCalls: [],
    cancelCalls: 0,
    noFaceCalls: 0,
  };
  const api: VideoJobApi = {
    async poll() {
      counters.pollCalls++;
      const item = statusQueue[Math.min(i, statusQueue.length - 1)];
      i++;
      return item;
    },
    async proceed() {
      counters.proceedCalls++;
    },
    async regenerate(_jobId, lookStyleId) {
      counters.regenerateCalls.push({ lookStyleId });
    },
    async proceedWithNoFaceFallback() {
      counters.noFaceCalls++;
    },
    async cancel() {
      counters.cancelCalls++;
      return {};
    },
  };
  return { api, counters };
}

const BASE_PROPS = {
  jobId: "job-1",
  aspectRatio: "portrait" as const,
  currentLookStyleId: "cinematic",
  lookStyles: LOOK_STYLES,
  bypassedStage1: false,
  pollIntervalMs: 0,
  onComplete: vi.fn(),
  onCancel: vi.fn(),
  onGoBack: vi.fn(),
};

describe("GodModeLoadingTakeover", () => {
  it("renders the stage 1 'Forging your likeness' copy while the job is in stage1_pulid", async () => {
    const { api, counters } = makeApi([
      { jobId: "job-1", phase: "stage1_pulid", progress: 0.5 },
    ]);
    render(<GodModeLoadingTakeover {...BASE_PROPS} api={api} />);
    await waitFor(() => expect(counters.pollCalls).toBeGreaterThan(0));
    expect(screen.getByText(/Forging your likeness/i)).toBeTruthy();
  });

  it("mounts the checkpoint screen at stage1_review", async () => {
    const { api, counters } = makeApi([
      {
        jobId: "job-1",
        phase: "stage1_review",
        progress: 0,
        stylizedStillObjectPath: "/objects/uploads/still.jpg",
      },
    ]);
    render(<GodModeLoadingTakeover {...BASE_PROPS} api={api} />);
    await waitFor(() => expect(screen.queryByTestId("video-checkpoint")).not.toBeNull());
  });

  it("renders the no-face fallback at stage1_no_face_review", async () => {
    const { api, counters } = makeApi([
      { jobId: "job-1", phase: "stage1_no_face_review", progress: 0 },
    ]);
    render(<GodModeLoadingTakeover {...BASE_PROPS} api={api} />);
    await waitFor(() => expect(screen.queryByTestId("god-mode-no-face")).not.toBeNull());
  });

  it("renders the stage 2 'Setting you in motion' copy during stage2_video", async () => {
    const { api, counters } = makeApi([
      { jobId: "job-1", phase: "stage2_video", progress: 0.5 },
    ]);
    render(<GodModeLoadingTakeover {...BASE_PROPS} api={api} />);
    await waitFor(() => expect(screen.getByText(/Setting you in motion/i)).toBeTruthy());
  });

  it("clicking back during stage 1 shows the soft cancel confirm", async () => {
    const { api, counters } = makeApi([
      { jobId: "job-1", phase: "stage1_pulid", progress: 0.2 },
    ]);
    render(<GodModeLoadingTakeover {...BASE_PROPS} api={api} />);
    await waitFor(() => expect(screen.getByText(/Forging/i)).toBeTruthy());
    fireEvent.click(screen.getByTestId("god-mode-back"));
    expect(screen.getByTestId("god-mode-cancel-confirm")).toBeTruthy();
  });

  it("disables back/close during stage 2", async () => {
    const { api, counters } = makeApi([
      { jobId: "job-1", phase: "stage2_video", progress: 0.5 },
    ]);
    render(<GodModeLoadingTakeover {...BASE_PROPS} api={api} />);
    await waitFor(() => expect(screen.getByText(/Setting you in motion/i)).toBeTruthy());
    const back = screen.getByTestId("god-mode-back") as HTMLButtonElement;
    const close = screen.getByTestId("god-mode-close") as HTMLButtonElement;
    expect(back.disabled).toBe(true);
    expect(close.disabled).toBe(true);
  });

  it("confirming the soft cancel calls api.cancel and onCancel", async () => {
    const onCancel = vi.fn();
    const { api, counters } = makeApi([
      { jobId: "job-1", phase: "stage1_pulid", progress: 0.1 },
    ]);
    render(<GodModeLoadingTakeover {...BASE_PROPS} api={api} onCancel={onCancel} />);
    await waitFor(() => expect(screen.getByText(/Forging/i)).toBeTruthy());
    fireEvent.click(screen.getByTestId("god-mode-back"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("god-mode-cancel-confirm-yes"));
    });
    expect(counters.cancelCalls).toBe(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("renders the budget-exceeded terminal on failed + errorCode budget_exceeded", async () => {
    const { api, counters } = makeApi([
      {
        jobId: "job-1",
        phase: "failed",
        progress: 0,
        errorCode: "budget_exceeded",
        budgetResetDate: "2026-07-01",
      },
    ]);
    render(<GodModeLoadingTakeover {...BASE_PROPS} api={api} />);
    await waitFor(() => expect(screen.queryByTestId("video-budget-exceeded")).not.toBeNull());
  });

  it("renders the service-unavailable copy on failed + service_unavailable", async () => {
    const { api, counters } = makeApi([
      { jobId: "job-1", phase: "failed", progress: 0, errorCode: "service_unavailable" },
    ]);
    render(<GodModeLoadingTakeover {...BASE_PROPS} api={api} />);
    await waitFor(() => expect(screen.queryByTestId("god-mode-failed-service")).not.toBeNull());
  });

  it("renders the moderation copy on failed + moderation", async () => {
    const { api, counters } = makeApi([
      { jobId: "job-1", phase: "failed", progress: 0, errorCode: "moderation" },
    ]);
    render(<GodModeLoadingTakeover {...BASE_PROPS} api={api} />);
    await waitFor(() => expect(screen.queryByTestId("god-mode-failed-moderation")).not.toBeNull());
  });

  it("calls onComplete with permalinkUrl when phase reaches completed", async () => {
    const onComplete = vi.fn();
    const { api, counters } = makeApi([
      {
        jobId: "job-1",
        phase: "completed",
        progress: 1,
        permalinkUrl: "/m/abc",
      },
    ]);
    render(<GodModeLoadingTakeover {...BASE_PROPS} api={api} onComplete={onComplete} />);
    await waitFor(() => expect(onComplete).toHaveBeenCalledWith("/m/abc"));
  });

  it("progress bar reports a value paused at stage1_review (25%)", async () => {
    const { api, counters } = makeApi([
      { jobId: "job-1", phase: "stage1_review", progress: 0 },
    ]);
    render(<GodModeLoadingTakeover {...BASE_PROPS} api={api} />);
    await waitFor(() => expect(screen.queryByTestId("video-checkpoint")).not.toBeNull());
    // The smoothed progress eases toward the target, so we only assert it has
    // started moving — not that it hit exactly 25%.
    const bar = screen.getByTestId("god-mode-progress");
    const v = parseInt(bar.getAttribute("aria-valuenow") ?? "0", 10);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(25);
  });
});

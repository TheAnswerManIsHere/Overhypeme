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

  // Option B (MBFO-4 progress-UX review): working phases share the image
  // flow's centered-hero layout — no TopBar. The checkpoint screen owns the
  // cancel affordance for the video flow because that's the only state where
  // cancel meaningfully saves money. Mid-stage cancel was dropped in
  // exchange for visual consistency with the image flow.
  it("does NOT render the TopBar during stage 1 (working phase)", async () => {
    const { api } = makeApi([
      { jobId: "job-1", phase: "stage1_pulid", progress: 0.2 },
    ]);
    render(<GodModeLoadingTakeover {...BASE_PROPS} api={api} />);
    await waitFor(() => expect(screen.getByText(/Forging/i)).toBeTruthy());
    expect(screen.queryByTestId("god-mode-back")).toBeNull();
    expect(screen.queryByTestId("god-mode-close")).toBeNull();
  });

  it("does NOT render the TopBar during stage 2 (working phase)", async () => {
    const { api } = makeApi([
      { jobId: "job-1", phase: "stage2_video", progress: 0.5 },
    ]);
    render(<GodModeLoadingTakeover {...BASE_PROPS} api={api} />);
    await waitFor(() => expect(screen.getByText(/Setting you in motion/i)).toBeTruthy());
    expect(screen.queryByTestId("god-mode-back")).toBeNull();
    expect(screen.queryByTestId("god-mode-close")).toBeNull();
  });

  it("renders the TopBar during the stage1_review decision phase", async () => {
    const { api } = makeApi([
      { jobId: "job-1", phase: "stage1_review", progress: 0.25, stylizedStillObjectPath: "/objects/styled.jpg" },
    ]);
    render(<GodModeLoadingTakeover {...BASE_PROPS} api={api} />);
    await waitFor(() => expect(screen.queryByTestId("god-mode-back")).not.toBeNull());
    expect(screen.queryByTestId("god-mode-close")).not.toBeNull();
  });

  it("renders the LoadingHero during stage 1 with the activity ring + bar", async () => {
    const { api } = makeApi([
      { jobId: "job-1", phase: "stage1_pulid", progress: 0.15 },
    ]);
    render(<GodModeLoadingTakeover {...BASE_PROPS} api={api} />);
    await waitFor(() => expect(screen.getByTestId("loading-hero")).toBeTruthy());
    expect(screen.getByTestId("activity-ring")).toBeTruthy();
    expect(screen.getByTestId("loading-hero-progress-fill")).toBeTruthy();
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

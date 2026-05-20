import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { Step2Video } from "../Step2Video";
import type {
  LookStyleDTO,
  MotionPresetDTO,
  VideoEngineDTO,
} from "../data/videoCatalogue";
import type { WizardRuntimeState } from "../../state/useWizardState";
import type { ViewerContext } from "../../../types";

const LOOK_STYLES: LookStyleDTO[] = [
  { id: "cinematic", label: "Cinematic", sortOrder: 0 },
];
const MOTIONS: MotionPresetDTO[] = [
  { id: "slow-push", label: "Slow push", sortOrder: 0 },
];
const ENGINE: VideoEngineDTO = {
  id: "grok",
  label: "Grok",
  allowedDurationsSec: [6],
  defaultDurationSec: 6,
  allowedResolutions: ["480p"],
  defaultResolution: "480p",
  allowedAspectRatios: ["portrait"],
  defaultAspectRatio: "portrait",
  isDefault: true,
  sortOrder: 0,
};

const VIEWER: ViewerContext = {
  tier: "legendary",
  userId: "u-1",
  name: "Quinn",
  pronouns: "they/them",
};

const BLANK_STATE: WizardRuntimeState = {
  currentStep: 2,
  artifactType: "video",
  generation: { status: "idle" },
};

const WITH_SOURCE_STATE: WizardRuntimeState = {
  ...BLANK_STATE,
  source: {
    kind: "self-upload",
    image: { kind: "library", objectPath: "/objects/uploads/me.jpg" },
    stylizeWithAi: true,
  },
};

function defaultOverrides() {
  return {
    fetchLookStyles: vi.fn(async () => LOOK_STYLES),
    fetchMotionPresets: vi.fn(async () => MOTIONS),
    fetchVideoEngines: vi.fn(async () => [ENGINE]),
  };
}

function fetchMock(impl?: typeof fetch) {
  const mock = vi.fn(
    impl ??
      (async () =>
        new Response(JSON.stringify({ uploads: [], uploadCount: 0, maxUploads: 5, displayLimit: 24 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })),
  );
  vi.stubGlobal("fetch", mock);
  return mock;
}

describe("Step2Video", () => {
  beforeEach(() => {
    fetchMock();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders preview, source picker, advanced trigger, and primary action", async () => {
    const dispatch = vi.fn();
    render(
      <Step2Video
        factId="42"
        factText=""
        viewerContext={VIEWER}
        state={BLANK_STATE}
        dispatch={dispatch}
        onComplete={() => {}}
        onCancel={() => {}}
        catalogueOverrides={defaultOverrides()}
      />,
    );

    await waitFor(() => expect(screen.getByTestId("step2-video")).toBeTruthy());
    expect(screen.getByTestId("locked-video-preview")).toBeTruthy();
    expect(screen.getByTestId("video-source-panel")).toBeTruthy();
    expect(screen.getByTestId("step2-video-open-advanced")).toBeTruthy();
    expect(screen.getByTestId("step2-video-make-meme")).toBeTruthy();
  });

  it("disables the primary action until a source is selected", async () => {
    const dispatch = vi.fn();
    render(
      <Step2Video
        factId="42"
        factText=""
        viewerContext={VIEWER}
        state={BLANK_STATE}
        dispatch={dispatch}
        onComplete={() => {}}
        onCancel={() => {}}
        catalogueOverrides={defaultOverrides()}
      />,
    );

    await waitFor(() => expect(screen.getByTestId("step2-video-make-meme")).toBeTruthy());
    const btn = screen.getByTestId("step2-video-make-meme") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("enables the primary action once a source is selected", async () => {
    const dispatch = vi.fn();
    render(
      <Step2Video
        factId="42"
        factText=""
        viewerContext={VIEWER}
        state={WITH_SOURCE_STATE}
        dispatch={dispatch}
        onComplete={() => {}}
        onCancel={() => {}}
        catalogueOverrides={defaultOverrides()}
      />,
    );

    await waitFor(() => expect(screen.getByTestId("step2-video-make-meme")).toBeTruthy());
    const btn = screen.getByTestId("step2-video-make-meme") as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });

  it("renders the heading 'Build your meme' for the wizard header", async () => {
    const dispatch = vi.fn();
    render(
      <Step2Video
        factId="42"
        factText=""
        viewerContext={VIEWER}
        state={BLANK_STATE}
        dispatch={dispatch}
        onComplete={() => {}}
        onCancel={() => {}}
        catalogueOverrides={defaultOverrides()}
      />,
    );
    expect(
      await screen.findByRole("heading", { name: /build your meme/i }),
    ).toBeTruthy();
  });

  it("submits a job via POST /api/memes/video-jobs and mounts the takeover with the returned jobId", async () => {
    // Wrap fetch so we can intercept the POST.
    const realFetch = window.fetch;
    const fetchSpy = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = typeof url === "string" ? url : url.toString();
      if (u === "/api/memes/video-jobs" && init?.method === "POST") {
        return new Response(JSON.stringify({ jobId: "job-xyz" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (u.startsWith("/api/memes/video-jobs/")) {
        return new Response(
          JSON.stringify({ jobId: "job-xyz", phase: "queued", progress: 0 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      // Fall through to the default empty-uploads stub.
      return realFetch(url, init);
    });
    vi.stubGlobal("fetch", fetchSpy);

    const dispatch = vi.fn();
    render(
      <Step2Video
        factId="42"
        factText=""
        viewerContext={VIEWER}
        state={WITH_SOURCE_STATE}
        dispatch={dispatch}
        onComplete={() => {}}
        onCancel={() => {}}
        catalogueOverrides={defaultOverrides()}
      />,
    );

    await waitFor(() =>
      expect((screen.getByTestId("step2-video-make-meme") as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(screen.getByTestId("step2-video-make-meme"));

    await waitFor(() => expect(screen.queryByTestId("god-mode-loading")).not.toBeNull());
    expect(
      fetchSpy.mock.calls.some(
        ([url, init]) =>
          (typeof url === "string" ? url : url.toString()) === "/api/memes/video-jobs" &&
          init?.method === "POST",
      ),
    ).toBe(true);
  });
});

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { VideoCheckpointScreen } from "../VideoCheckpointScreen";
import type { LookStyleDTO } from "../data/videoCatalogue";

const LOOK_STYLES: LookStyleDTO[] = [
  { id: "cinematic", label: "Cinematic", sortOrder: 0 },
  { id: "anime", label: "Anime", sortOrder: 1 },
  { id: "noir", label: "Noir", sortOrder: 2 },
];

function renderCheckpoint(overrides: Partial<React.ComponentProps<typeof VideoCheckpointScreen>> = {}) {
  const onProceed = vi.fn();
  const onRegenerateSameStyle = vi.fn();
  const onRegenerateWithStyle = vi.fn();
  const onCancel = vi.fn();
  const utils = render(
    <VideoCheckpointScreen
      stillUrl="/some/image.jpg"
      aspectRatio="portrait"
      currentLookStyleId="cinematic"
      lookStyles={LOOK_STYLES}
      stage1Attempts={1}
      onProceed={onProceed}
      onRegenerateSameStyle={onRegenerateSameStyle}
      onRegenerateWithStyle={onRegenerateWithStyle}
      onCancel={onCancel}
      {...overrides}
    />,
  );
  return { ...utils, onProceed, onRegenerateSameStyle, onRegenerateWithStyle, onCancel };
}

describe("VideoCheckpointScreen", () => {
  it("calls onProceed when 'Animate it' is clicked", () => {
    const { onProceed } = renderCheckpoint();
    fireEvent.click(screen.getByTestId("video-checkpoint-proceed"));
    expect(onProceed).toHaveBeenCalledTimes(1);
  });

  it("calls onRegenerateSameStyle when 'Regenerate this style' is clicked", () => {
    const { onRegenerateSameStyle } = renderCheckpoint();
    fireEvent.click(screen.getByTestId("video-checkpoint-regenerate"));
    expect(onRegenerateSameStyle).toHaveBeenCalledTimes(1);
  });

  it("calls onCancel when 'Cancel' is clicked", () => {
    const { onCancel } = renderCheckpoint();
    fireEvent.click(screen.getByTestId("video-checkpoint-cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("'Try a different style' expands the picker and Use this style fires regenerate with the new id", () => {
    const { onRegenerateWithStyle } = renderCheckpoint();
    fireEvent.click(screen.getByTestId("video-checkpoint-try-different-style"));
    expect(screen.getByTestId("video-checkpoint-style-picker")).toBeTruthy();

    // Apply button is disabled until a different style is picked.
    const apply = screen.getByTestId("video-checkpoint-style-picker-apply") as HTMLButtonElement;
    expect(apply.disabled).toBe(true);

    fireEvent.click(screen.getByTestId("video-checkpoint-style-anime"));
    expect(apply.disabled).toBe(false);

    fireEvent.click(apply);
    expect(onRegenerateWithStyle).toHaveBeenCalledWith("anime");
  });

  it("shows the attempts counter when stage1Attempts >= 2", () => {
    renderCheckpoint({ stage1Attempts: 2 });
    expect(screen.getByTestId("video-checkpoint-attempts").textContent).toMatch(/2/);
  });

  it("hides the attempts counter at stage1Attempts === 1", () => {
    renderCheckpoint({ stage1Attempts: 1 });
    expect(screen.queryByTestId("video-checkpoint-attempts")).toBeNull();
  });

  it("shows the warning after 5 attempts", () => {
    renderCheckpoint({ stage1Attempts: 5 });
    expect(screen.getByTestId("video-checkpoint-warning")).toBeTruthy();
  });

  it("hides the warning at fewer than 5 attempts", () => {
    renderCheckpoint({ stage1Attempts: 4 });
    expect(screen.queryByTestId("video-checkpoint-warning")).toBeNull();
  });

  it("disables all buttons while busy", () => {
    renderCheckpoint({ busy: true });
    expect((screen.getByTestId("video-checkpoint-proceed") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("video-checkpoint-regenerate") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("video-checkpoint-cancel") as HTMLButtonElement).disabled).toBe(true);
  });

  it("renders the cost line when both pieces are provided", () => {
    renderCheckpoint({ nextStepCost: "$0.18", remainingBudget: "$4.21" });
    const line = screen.getByTestId("video-checkpoint-cost").textContent ?? "";
    expect(line).toMatch(/\$0\.18/);
    expect(line).toMatch(/\$4\.21/);
  });
});

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import {
  VideoAdvancedOptionsSheet,
  type VideoAdvancedOptionsValue,
} from "../VideoAdvancedOptionsSheet";
import type {
  LookStyleDTO,
  MotionPresetDTO,
  VideoEngineDTO,
} from "../data/videoCatalogue";

const LOOKS: LookStyleDTO[] = [
  { id: "cinematic", label: "Cinematic", sortOrder: 0 },
  { id: "anime", label: "Anime", sortOrder: 1 },
];
const MOTIONS: MotionPresetDTO[] = [
  { id: "slow-push", label: "Slow push", sortOrder: 0 },
];
const ENGINE_DEFAULT: VideoEngineDTO = {
  id: "grok",
  label: "Grok",
  allowedDurationsSec: [3, 6, 10],
  defaultDurationSec: 6,
  allowedResolutions: ["480p", "720p"],
  defaultResolution: "480p",
  allowedAspectRatios: ["landscape", "square", "portrait"],
  defaultAspectRatio: "portrait",
  isDefault: true,
  sortOrder: 0,
};
const ENGINE_WITH_MODES: VideoEngineDTO = {
  ...ENGINE_DEFAULT,
  id: "grok-modes",
  label: "Grok (with modes)",
  supportedModes: [
    { id: "normal", label: "Normal" },
    { id: "fun", label: "Fun" },
    { id: "custom", label: "Custom" },
  ],
  defaultMode: "normal",
};
const SECOND_ENGINE: VideoEngineDTO = {
  ...ENGINE_DEFAULT,
  id: "veo",
  label: "Veo",
  isDefault: false,
};

const BASE_VALUE: VideoAdvancedOptionsValue = {
  sourceMode: "stylize-then-video",
  lookStyleId: "cinematic",
  motionPresetId: null,
  lengthSeconds: 6,
  resolution: "480p",
  engineId: "grok",
  engineMode: "normal",
};

function renderSheet(
  overrides: Partial<React.ComponentProps<typeof VideoAdvancedOptionsSheet>> = {},
) {
  const onChange = vi.fn();
  const onOpenChange = vi.fn();
  const utils = render(
    <VideoAdvancedOptionsSheet
      open
      onOpenChange={onOpenChange}
      value={BASE_VALUE}
      onChange={onChange}
      lookStyles={LOOKS}
      motionPresets={MOTIONS}
      engines={[ENGINE_DEFAULT]}
      sourceKind={null}
      {...overrides}
    />,
  );
  return { ...utils, onChange, onOpenChange };
}

describe("VideoAdvancedOptionsSheet", () => {
  it("renders only the two relevant source-mode radios for a library source", () => {
    renderSheet({ sourceKind: "library" });
    expect(screen.getByTestId("source-mode-option-stylize-then-video")).toBeTruthy();
    expect(screen.getByTestId("source-mode-option-use-photo-as-is")).toBeTruthy();
    expect(screen.queryByTestId("source-mode-option-use-existing-ai-image")).toBeNull();
  });

  it("renders only the two relevant source-mode radios for a fresh (upload) source", () => {
    renderSheet({ sourceKind: "fresh" });
    expect(screen.getByTestId("source-mode-option-stylize-then-video")).toBeTruthy();
    expect(screen.getByTestId("source-mode-option-use-photo-as-is")).toBeTruthy();
    expect(screen.queryByTestId("source-mode-option-use-existing-ai-image")).toBeNull();
  });

  it("hides Source Mode section entirely for an ai-styling source", () => {
    renderSheet({ sourceKind: "ai-styling" });
    expect(screen.queryByTestId("advanced-source-mode")).toBeNull();
  });

  it("shows Source Mode section when sourceKind is null (no selection yet)", () => {
    renderSheet({ sourceKind: null });
    expect(screen.getByTestId("advanced-source-mode")).toBeTruthy();
  });

  it("fires onChange with sourceMode when a source-mode radio is clicked", () => {
    const { onChange } = renderSheet({ sourceKind: "library" });
    fireEvent.click(screen.getByTestId("source-mode-option-use-photo-as-is"));
    expect(onChange).toHaveBeenCalledWith({ sourceMode: "use-photo-as-is" });
  });

  it("Apply on look style is disabled until a different style is picked", () => {
    const { onChange } = renderSheet();
    const apply = screen.getByTestId("advanced-look-style-apply") as HTMLButtonElement;
    expect(apply.disabled).toBe(true);

    fireEvent.click(screen.getByTestId("look-style-anime"));
    expect(apply.disabled).toBe(false);

    fireEvent.click(apply);
    expect(onChange).toHaveBeenCalledWith({ lookStyleId: "anime" });
  });

  it("renders length options from the selected engine", () => {
    renderSheet({ engines: [ENGINE_DEFAULT] });
    expect(screen.getByTestId("length-option-3")).toBeTruthy();
    expect(screen.getByTestId("length-option-6")).toBeTruthy();
    expect(screen.getByTestId("length-option-10")).toBeTruthy();
  });

  it("renders resolution options from the selected engine", () => {
    renderSheet({ engines: [ENGINE_DEFAULT] });
    expect(screen.getByTestId("resolution-option-480p")).toBeTruthy();
    expect(screen.getByTestId("resolution-option-720p")).toBeTruthy();
  });

  it("hides the engine-mode section when the engine has no supportedModes", () => {
    renderSheet({ engines: [ENGINE_DEFAULT] });
    expect(screen.queryByTestId("advanced-engine-mode")).toBeNull();
  });

  it("renders engine-mode radios when the engine has supportedModes", () => {
    renderSheet({
      engines: [ENGINE_WITH_MODES],
      value: { ...BASE_VALUE, engineId: "grok-modes", engineMode: "normal" },
    });
    expect(screen.getByTestId("engine-mode-option-normal")).toBeTruthy();
    expect(screen.getByTestId("engine-mode-option-fun")).toBeTruthy();
    expect(screen.getByTestId("engine-mode-option-custom")).toBeTruthy();
  });

  it("reveals the custom prompt textarea when engineMode === 'custom'", () => {
    renderSheet({
      engines: [ENGINE_WITH_MODES],
      value: { ...BASE_VALUE, engineId: "grok-modes", engineMode: "custom" },
    });
    expect(screen.getByTestId("advanced-custom-mode-prompt")).toBeTruthy();
  });

  it("hides the engine selector when only one engine is returned", () => {
    renderSheet({ engines: [ENGINE_DEFAULT] });
    expect(screen.queryByTestId("advanced-engine-selector")).toBeNull();
  });

  it("shows the engine selector when more than one engine is returned", () => {
    renderSheet({ engines: [ENGINE_DEFAULT, SECOND_ENGINE] });
    expect(screen.getByTestId("advanced-engine-selector")).toBeTruthy();
    const select = screen.getByTestId("advanced-engine-select") as HTMLSelectElement;
    expect(select.options.length).toBe(2);
  });

  it("for ai-styling source, the override toggle gates look-style editability", () => {
    const { rerender, onChange } = renderSheet({
      value: { ...BASE_VALUE, sourceMode: "use-existing-ai-image" },
      sourceKind: "ai-styling",
    });
    // Style buttons should be disabled by default.
    const animeBtn = screen.getByTestId("look-style-anime") as HTMLButtonElement;
    expect(animeBtn.disabled).toBe(true);

    fireEvent.click(screen.getByTestId("advanced-override-look"));
    expect(onChange).toHaveBeenCalledWith({ overrideLookForSource: true });

    rerender(
      <VideoAdvancedOptionsSheet
        open
        onOpenChange={() => {}}
        value={{
          ...BASE_VALUE,
          sourceMode: "use-existing-ai-image",
          overrideLookForSource: true,
        }}
        onChange={onChange}
        lookStyles={LOOKS}
        motionPresets={MOTIONS}
        engines={[ENGINE_DEFAULT]}
        sourceKind="ai-styling"
      />,
    );
    expect((screen.getByTestId("look-style-anime") as HTMLButtonElement).disabled).toBe(false);
  });
});

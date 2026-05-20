/**
 * Single neutral source picker for the video flow.
 *
 * Unlike the image flow, there's no SourceSegmentedControl — videos always
 * start from a photo with the user's face (platform constraint). The copy is
 * explicit about that without saying "selfie".
 *
 * For source mode `use-existing-ai-image`, the picker auto-selects the AI
 * stylings tab so the user picks from prior PuLID renders.
 */

import type { MyImageSource } from "../../types";
import type { VideoSourceMode } from "../state/wizardStorage";
import { MyImagePicker } from "../../parts/MyImagePicker";

interface Props {
  factId: string;
  sourceMode: VideoSourceMode;
  selected: MyImageSource | null;
  onSelect: (next: MyImageSource) => void;
}

export function VideoSourcePanel({
  factId,
  sourceMode,
  selected,
  onSelect,
}: Props) {
  // For "use-existing-ai-image" we want the picker to default to the AI
  // stylings tab; the picker doesn't take an initial-tab prop so we lean on
  // showAiStylings + the copy below to nudge the user. The user can still
  // pick from My photos if they want to override.
  const showAiStylings = sourceMode !== "use-photo-as-is";

  return (
    <section className="space-y-3" data-testid="video-source-panel">
      <header className="space-y-1">
        <h2 className="font-display text-lg uppercase tracking-wide text-white">
          {sourceMode === "use-existing-ai-image"
            ? "Pick an existing AI styling"
            : "Upload a photo of yourself"}
        </h2>
        <p className="text-xs text-white/60">
          {sourceMode === "use-existing-ai-image"
            ? "We'll animate one of your saved stylings."
            : "We need to see a face — that's how Overhype works."}
        </p>
      </header>

      <MyImagePicker
        factId={factId}
        showAiStylings={showAiStylings}
        selected={selected}
        onSelect={onSelect}
      />
    </section>
  );
}

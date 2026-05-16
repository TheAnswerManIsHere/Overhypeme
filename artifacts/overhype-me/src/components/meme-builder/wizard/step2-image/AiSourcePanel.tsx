import { MyImagePicker } from "../../parts/MyImagePicker";
import type { MyImageSource } from "../../types";

interface Props {
  factId: string;
  primaryImageObjectPath?: string;
  selected: MyImageSource | null;
  onSelect: (next: MyImageSource) => void;
}

/**
 * "AI you" tab — legendary-only. Hosts the same MyImagePicker as the
 * self-upload tab, but with the AI stylings tab visible so the user can
 * re-use a previously generated PuLID derivative. The wizard reads this
 * selection plus `stylizeWithAi=true` to drive the PuLID job pipeline on
 * save (or, when re-using an existing AI styling, skip the job entirely).
 *
 * AI style presets are intentionally not exposed here — the spec lists
 * presets as a video-flow concern (MBFO-4).
 */
export function AiSourcePanel({
  factId,
  primaryImageObjectPath,
  selected,
  onSelect,
}: Props) {
  return (
    <MyImagePicker
      factId={factId}
      primaryImageObjectPath={primaryImageObjectPath}
      showAiStylings
      hideTabs={["library"]}
      selected={selected}
      onSelect={onSelect}
    />
  );
}

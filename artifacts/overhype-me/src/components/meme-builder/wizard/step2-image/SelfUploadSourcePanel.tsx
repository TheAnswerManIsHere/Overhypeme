import { MyImagePicker } from "../../parts/MyImagePicker";
import type { MyImageSource } from "../../types";

interface Props {
  factId: string;
  primaryImageObjectPath?: string;
  selected: MyImageSource | null;
  onSelect: (next: MyImageSource) => void;
}

/**
 * Self-upload tab. Hosts the existing MyImagePicker (Primary / My photos /
 * Upload new tabs). The AI-stylings tab is hidden here — AI derivatives only
 * appear when the user is on the "AI you" tab in the source segmented control.
 */
export function SelfUploadSourcePanel({
  factId,
  primaryImageObjectPath,
  selected,
  onSelect,
}: Props) {
  return (
    <MyImagePicker
      factId={factId}
      primaryImageObjectPath={primaryImageObjectPath}
      showAiStylings={false}
      selected={selected}
      onSelect={onSelect}
    />
  );
}

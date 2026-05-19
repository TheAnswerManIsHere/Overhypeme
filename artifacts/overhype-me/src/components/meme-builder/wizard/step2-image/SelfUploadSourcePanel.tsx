import { MyImagePicker } from "../../parts/MyImagePicker";
import type { MyImageSource } from "../../types";

interface Props {
  factId: string;
  selected: MyImageSource | null;
  onSelect: (next: MyImageSource) => void;
}

/**
 * Self-upload tab. Hosts the existing MyImagePicker (My photos / Upload new
 * tabs). The AI-stylings tab is hidden here — AI derivatives only appear when
 * the user is on the "AI you" tab in the source segmented control. The user's
 * profile photo is rendered as the first tile in "My photos" with a PROFILE
 * badge (task #507).
 */
export function SelfUploadSourcePanel({ factId, selected, onSelect }: Props) {
  return (
    <MyImagePicker
      factId={factId}
      showAiStylings={false}
      selected={selected}
      onSelect={onSelect}
    />
  );
}

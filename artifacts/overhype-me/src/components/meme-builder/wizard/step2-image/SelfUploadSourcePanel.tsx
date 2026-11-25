import { MyImagePicker } from "../../parts/MyImagePicker";
import type { MyImageSource } from "../../types";

interface Props {
  selected: MyImageSource | null;
  onSelect: (next: MyImageSource) => void;
  /** The picker's own default pick, as distinct from a tap. */
  onAutoSelect?: (next: MyImageSource) => void;
}

/**
 * Self-upload panel — the image step's only source. Hosts the existing
 * MyImagePicker (My photos / Upload new tabs). The user's profile photo is rendered as the first tile in "My photos"
 * with a PROFILE badge (task #507).
 */
export function SelfUploadSourcePanel({ selected, onSelect, onAutoSelect }: Props) {
  return <MyImagePicker selected={selected} onSelect={onSelect} onAutoSelect={onAutoSelect} />;
}

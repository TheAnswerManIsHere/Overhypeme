import { useMemo, useState } from "react";
import { DEFAULT_BOTTOM_Y, DEFAULT_TOP_Y, type MemeTextOptions } from "../../types";
import { SplitSlider } from "./sliders/SplitSlider";
import { VerticalPositionSlider } from "./sliders/VerticalPositionSlider";
import type { CaptionLayout } from "@workspace/api-zod";
import { sliderRange } from "../../captionLayout";
import { getWords, intelligentSplit } from "./sliders/splitLogic";

interface Props {
  factText: string;
  defaultSplitIndex: number | null;
  splitIndex: number;
  onSplitChange: (next: number) => void;
  textOptions: MemeTextOptions;
  onTextOptionsChange: (next: MemeTextOptions) => void;
  /**
   * Where the preview is drawing the caption (`useCaptionLayout`), or null
   * before its face has loaded. The position sliders take their limits and
   * their percentages from it (#1260).
   */
  captionLayout: CaptionLayout | null;
}

/**
 * Inline collapsible for the three text-positioning sliders.
 * Previously a bottom-drawer; now lives inside the scrollable controls
 * panel so it can never obscure the locked preview above.
 */
export function AdjustTextSheet({
  factText,
  defaultSplitIndex,
  splitIndex,
  onSplitChange,
  textOptions,
  onTextOptionsChange,
  captionLayout,
}: Props) {
  const [isOpen, setIsOpen] = useState(false);

  const words = useMemo(() => getWords(factText), [factText]);
  const fallbackSplit = useMemo(() => intelligentSplit(factText), [factText]);
  const effectiveSplit = splitIndex ?? defaultSplitIndex ?? fallbackSplit;

  // Each slider runs between the positions its block can really take: from
  // the picture's edge to the other block. With no layout yet (the caption
  // face still loading) the drawing still keeps the blocks inside the picture
  // and apart, whatever a slider says.
  const topBlock = captionLayout?.blocks.find((b) => b.role === "top");
  const bottomBlock = captionLayout?.blocks.find((b) => b.role === "bottom");
  const top = sliderRange(topBlock) ?? {
    min: 0, max: 100, value: textOptions.topY ?? DEFAULT_TOP_Y,
  };
  const bottom = sliderRange(bottomBlock) ?? {
    min: 0, max: 100, value: textOptions.bottomY ?? DEFAULT_BOTTOM_Y,
  };

  return (
    <div className="rounded-md border border-border">
      <button
        type="button"
        className="flex w-full items-center justify-between bg-white/5 px-4 py-3 text-left text-sm hover:bg-white/10 rounded-md"
        onClick={() => setIsOpen((v) => !v)}
        data-testid="adjust-text-trigger"
        aria-expanded={isOpen}
      >
        <span className="uppercase tracking-wider">Adjust the text</span>
        <span
          aria-hidden
          className={`text-muted-foreground transition-transform duration-200 ${isOpen ? "rotate-180" : ""}`}
        >
          ▾
        </span>
      </button>

      {isOpen && (
        <div className="space-y-5 border-t border-border px-4 pb-6 pt-4">
          <SplitSlider
            factText={factText}
            value={Math.min(Math.max(effectiveSplit, 1), Math.max(1, words.length - 1))}
            onChange={onSplitChange}
          />

          <VerticalPositionSlider
            label="Top position"
            value={top.value}
            min={top.min}
            max={top.max}
            // The other block is recorded where it is drawn, so the range this
            // slider was given (measured against that block) stays true.
            onChange={(v) => onTextOptionsChange({ ...textOptions, topY: v, bottomY: bottomBlock?.yPct ?? textOptions.bottomY })}
          />

          <VerticalPositionSlider
            label="Bottom position"
            value={bottom.value}
            min={bottom.min}
            max={bottom.max}
            onChange={(v) => onTextOptionsChange({ ...textOptions, bottomY: v, topY: topBlock?.yPct ?? textOptions.topY })}
          />
        </div>
      )}
    </div>
  );
}

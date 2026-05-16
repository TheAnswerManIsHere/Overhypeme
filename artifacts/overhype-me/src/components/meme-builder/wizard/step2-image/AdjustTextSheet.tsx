import { useMemo, useState } from "react";
import type { MemeTextOptions } from "../../types";
import { SplitSlider } from "./sliders/SplitSlider";
import { VerticalPositionSlider } from "./sliders/VerticalPositionSlider";
import {
  computeTextCollisionConstraints,
  getWords,
  intelligentSplit,
} from "./sliders/splitLogic";

interface Props {
  factText: string;
  defaultSplitIndex: number | null;
  splitIndex: number;
  onSplitChange: (next: number) => void;
  textOptions: MemeTextOptions;
  onTextOptionsChange: (next: MemeTextOptions) => void;
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
}: Props) {
  const [isOpen, setIsOpen] = useState(false);

  const words = useMemo(() => getWords(factText), [factText]);
  const fallbackSplit = useMemo(() => intelligentSplit(factText), [factText]);
  const effectiveSplit = splitIndex ?? defaultSplitIndex ?? fallbackSplit;

  const topLines = Math.max(1, Math.ceil(effectiveSplit / 8));
  const fontSize = textOptions.fontSize ?? 64;
  const canvasH = 720;
  const topY = textOptions.topY ?? 17;
  const bottomY = textOptions.bottomY ?? 88;
  const { maxTopY, minBottomY } = computeTextCollisionConstraints({
    topLines,
    fontSize,
    canvasH,
    topY,
    bottomY,
  });

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
            value={topY}
            min={0}
            max={maxTopY}
            onChange={(v) => onTextOptionsChange({ ...textOptions, topY: v })}
          />

          <VerticalPositionSlider
            label="Bottom position"
            value={bottomY}
            min={minBottomY}
            max={100}
            onChange={(v) => onTextOptionsChange({ ...textOptions, bottomY: v })}
          />
        </div>
      )}
    </div>
  );
}

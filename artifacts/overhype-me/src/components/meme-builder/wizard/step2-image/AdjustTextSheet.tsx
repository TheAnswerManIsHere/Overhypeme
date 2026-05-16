import { useMemo } from "react";
import {
  Drawer,
  DrawerContent,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer";
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
  /** Token-boundary default from `facts.split_token_index`; falls back to `intelligentSplit`. */
  defaultSplitIndex: number | null;
  /** Current split index, persisted on textOptions via the bottom/top text composition. */
  splitIndex: number;
  onSplitChange: (next: number) => void;
  textOptions: MemeTextOptions;
  onTextOptionsChange: (next: MemeTextOptions) => void;
}

/**
 * Bottom-drawer for the three text-positioning sliders. The split slider
 * picks where the fact text breaks; the top/bottom vertical sliders move each
 * half along the canvas Y axis with collision clamping.
 */
export function AdjustTextSheet({
  factText,
  defaultSplitIndex,
  splitIndex,
  onSplitChange,
  textOptions,
  onTextOptionsChange,
}: Props) {
  const words = useMemo(() => getWords(factText), [factText]);
  const fallbackSplit = useMemo(() => intelligentSplit(factText), [factText]);
  const effectiveSplit = splitIndex || defaultSplitIndex || fallbackSplit;

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
    <Drawer>
      <DrawerTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center justify-between rounded-md border border-border bg-white/5 px-4 py-3 text-left text-sm hover:bg-white/10"
          data-testid="adjust-text-trigger"
        >
          <span className="uppercase tracking-wider">Adjust the text</span>
          <span aria-hidden className="text-muted-foreground">▾</span>
        </button>
      </DrawerTrigger>
      <DrawerContent className="max-h-[60vh]">
        <div className="space-y-5 px-4 pb-6 pt-2">
          <DrawerTitle className="font-display text-lg uppercase">Adjust the text</DrawerTitle>

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
      </DrawerContent>
    </Drawer>
  );
}

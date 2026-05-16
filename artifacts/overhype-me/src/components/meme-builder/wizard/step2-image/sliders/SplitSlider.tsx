import { useEffect, useMemo, useRef, useState } from "react";
import { Slider } from "@/components/ui/slider";
import { getWords } from "./splitLogic";

interface Props {
  factText: string;
  value: number;
  onChange: (value: number) => void;
  /**
   * Inclusive minimum/maximum. Defaults to 1..words.length-1 so neither half
   * is empty. The word split only updates at integer boundaries; the thumb
   * moves continuously for a smooth drag feel.
   */
  min?: number;
  max?: number;
}

export function SplitSlider({ factText, value, onChange, min, max }: Props) {
  const words = useMemo(() => getWords(factText), [factText]);
  const lo = min ?? 1;
  const hi = max ?? Math.max(lo, words.length - 1);
  const safeValue = Math.min(Math.max(value, lo), hi);

  // visualValue is a float that tracks the raw drag position so the thumb
  // moves smoothly. lastCommitted tracks which integer we last fired onChange
  // for, so we only call it when crossing a word boundary.
  const [visualValue, setVisualValue] = useState<number>(safeValue);
  const isDragging = useRef(false);
  const lastCommitted = useRef(safeValue);

  // Sync from parent when not dragging (e.g. external reset or text change).
  useEffect(() => {
    if (!isDragging.current) {
      setVisualValue(safeValue);
      lastCommitted.current = safeValue;
    }
  }, [safeValue]);

  const ticks = useMemo(() => {
    const out: number[] = [];
    for (let i = lo; i <= hi; i++) out.push(i);
    return out;
  }, [lo, hi]);

  const committedInt = Math.round(visualValue);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-xs uppercase tracking-wider text-muted-foreground">
          Split position
        </span>
        <span className="text-xs tabular-nums text-muted-foreground">
          {committedInt} / {words.length}
        </span>
      </div>
      <div className="relative pt-1" style={{ touchAction: "none" }}>
        <Slider
          value={[visualValue]}
          min={lo}
          max={hi}
          step={0.001}
          onValueChange={(next) => {
            isDragging.current = true;
            const raw = next[0] ?? visualValue;
            setVisualValue(raw);
            const rounded = Math.round(raw);
            if (rounded !== lastCommitted.current) {
              lastCommitted.current = rounded;
              onChange(rounded);
            }
          }}
          onValueCommit={(next) => {
            isDragging.current = false;
            const raw = next[0] ?? visualValue;
            const rounded = Math.round(raw);
            setVisualValue(rounded);
            lastCommitted.current = rounded;
            onChange(rounded);
          }}
        />
        <div className="mt-1 flex items-center justify-between px-1">
          {ticks.map((i) => (
            <span
              key={i}
              aria-hidden
              className={`h-1 w-px ${i === committedInt ? "bg-[#ff6b35]" : "bg-muted-foreground/30"}`}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

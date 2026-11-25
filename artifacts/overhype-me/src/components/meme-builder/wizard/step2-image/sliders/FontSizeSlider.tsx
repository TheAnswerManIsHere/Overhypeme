import { Slider } from "@/components/ui/slider";

interface Props {
  value: number;
  onChange: (value: number) => void;
}

/**
 * The caption's font size, 32 to 120 px. It sits in Adjust the text, second
 * after the split, because the size decides how many lines each half wraps to
 * and so how far the position sliders below it can move (David, 2026-11-25).
 */
export function FontSizeSlider({ value, onChange }: Props) {
  return (
    <div className="space-y-2" data-testid="font-size-control">
      <div className="flex items-center justify-between">
        <span className="text-xs uppercase tracking-wider text-muted-foreground">Font size</span>
        <span className="text-xs tabular-nums text-muted-foreground">{value}px</span>
      </div>
      <Slider
        value={[value]}
        min={32}
        max={120}
        step={1}
        onValueChange={(next) => {
          const n = next[0];
          if (typeof n === "number") onChange(Math.round(n));
        }}
      />
    </div>
  );
}

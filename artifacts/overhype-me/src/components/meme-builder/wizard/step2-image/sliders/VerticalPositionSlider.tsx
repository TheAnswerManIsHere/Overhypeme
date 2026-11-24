import { Slider } from "@/components/ui/slider";

interface Props {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}

/**
 * A caption block's position: its midpoint as a percentage of the picture's
 * height. The parent takes `min`, `max` and `value` from the layout the
 * preview draws (`sliderRange`), so the track runs from the picture's edge to
 * the other block and the number is where the block is.
 */
export function VerticalPositionSlider({ label, value, min, max, onChange }: Props) {
  const clamped = Math.min(Math.max(value, min), max);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-xs uppercase tracking-wider text-muted-foreground">{label}</span>
        <span className="text-xs tabular-nums text-muted-foreground">{clamped}%</span>
      </div>
      <div style={{ touchAction: "none" }}>
        <Slider
          value={[clamped]}
          min={min}
          max={max}
          step={1}
          onValueChange={(next) => {
            const n = next[0];
            if (typeof n === "number") onChange(Math.round(n));
          }}
        />
      </div>
    </div>
  );
}

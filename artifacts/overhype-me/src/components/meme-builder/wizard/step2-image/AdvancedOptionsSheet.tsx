import {
  Drawer,
  DrawerContent,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import type { MemeTextOptions } from "../../types";

interface Props {
  value: MemeTextOptions;
  onChange: (next: MemeTextOptions) => void;
}

const FONT_OPTIONS: { id: string; label: string; family: string }[] = [
  { id: "bebas", label: "Bebas Neue", family: "'Bebas Neue', Impact, sans-serif" },
  { id: "anton", label: "Anton",      family: "'Anton', Impact, sans-serif" },
  { id: "dm",    label: "DM Sans",    family: "'DM Sans', system-ui, sans-serif" },
  { id: "mono",  label: "JetBrains Mono", family: "'JetBrains Mono', monospace" },
  { id: "impact", label: "Impact",    family: "Impact, sans-serif" },
];

const TEXT_COLORS = ["#ffffff", "#ff6b35", "#f5f5f5", "#facc15", "#111111"];
const OUTLINE_COLORS = ["#000000", "#111111", "#ff6b35", "#ffffff"];

export function AdvancedOptionsSheet({ value, onChange }: Props) {
  const set = <K extends keyof MemeTextOptions>(key: K, v: MemeTextOptions[K]) =>
    onChange({ ...value, [key]: v });

  const effect = value.textEffect ?? "outline";

  return (
    <Drawer>
      <DrawerTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center justify-between rounded-md border border-border bg-white/5 px-4 py-3 text-left text-sm hover:bg-white/10"
          data-testid="advanced-options-trigger"
        >
          <span className="uppercase tracking-wider">Advanced options</span>
          <span aria-hidden className="text-muted-foreground">▾</span>
        </button>
      </DrawerTrigger>
      <DrawerContent className="max-h-[60vh]">
        <div className="space-y-5 overflow-y-auto px-4 pb-6 pt-2">
          <DrawerTitle className="font-display text-lg uppercase">Advanced</DrawerTitle>

          <label className="block space-y-2">
            <span className="text-xs uppercase tracking-wider text-muted-foreground">Font</span>
            <select
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              value={value.fontFamily ?? FONT_OPTIONS[0]!.family}
              onChange={(e) => set("fontFamily", e.target.value)}
            >
              {FONT_OPTIONS.map((f) => (
                <option key={f.id} value={f.family}>{f.label}</option>
              ))}
            </select>
          </label>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs uppercase tracking-wider text-muted-foreground">Font size</span>
              <span className="text-xs tabular-nums text-muted-foreground">{value.fontSize ?? 64}px</span>
            </div>
            <Slider
              value={[value.fontSize ?? 64]}
              min={32}
              max={120}
              step={1}
              onValueChange={(next) => {
                const n = next[0];
                if (typeof n === "number") set("fontSize", Math.round(n));
              }}
            />
          </div>

          <div className="space-y-2">
            <span className="text-xs uppercase tracking-wider text-muted-foreground">Text color</span>
            <div className="flex gap-2">
              {TEXT_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-label={`Text color ${c}`}
                  onClick={() => set("textColor", c)}
                  className={`h-7 w-7 rounded-full border-2 ${value.textColor === c ? "border-[#ff6b35]" : "border-white/20"}`}
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <span className="text-xs uppercase tracking-wider text-muted-foreground">Outline color</span>
            <div className="flex gap-2">
              {OUTLINE_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-label={`Outline color ${c}`}
                  onClick={() => set("outlineColor", c)}
                  className={`h-7 w-7 rounded-full border-2 ${value.outlineColor === c ? "border-[#ff6b35]" : "border-white/20"}`}
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <span className="text-xs uppercase tracking-wider text-muted-foreground">Effect</span>
            <div className="flex gap-2">
              {(["outline", "shadow", "none"] as const).map((e) => (
                <button
                  key={e}
                  type="button"
                  onClick={() => set("textEffect", e)}
                  className={`flex-1 rounded-md px-3 py-2 text-xs uppercase tracking-wider ${
                    effect === e ? "bg-[#ff6b35] text-white" : "bg-white/5 text-white/70 hover:text-white"
                  }`}
                >
                  {e}
                </button>
              ))}
            </div>
          </div>

          <label className="flex items-center justify-between rounded-md bg-white/5 px-3 py-2">
            <span className="text-sm uppercase tracking-wider">All caps</span>
            <Switch
              checked={value.allCaps !== false}
              onCheckedChange={(v) => set("allCaps", v)}
            />
          </label>
        </div>
      </DrawerContent>
    </Drawer>
  );
}

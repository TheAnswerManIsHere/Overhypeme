/**
 * Video-flow advanced options drawer (Vaul).
 *
 * Sections, in order:
 *   1. Source mode (3 radios)
 *   2. Look style (catalogue picker, with Apply gate)
 *   3. Motion preset (catalogue picker, no Apply gate)
 *   4. Length (engine-aware radios)
 *   5. Quality / resolution (engine-aware radios)
 *   6. Engine mode (only when current engine has supportedModes)
 *   7. Engine selector (only when /api/engines returned > 1 engine)
 *
 * The sheet does NOT call any save API itself — it just edits the
 * orchestrator's local + persisted state. The "Apply" gate on look style
 * exists so the picker can later trigger a regenerate when a job is
 * in-flight; at Step 2 (pre-job) it just commits to wizard storage.
 */

import { useState, useEffect } from "react";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerDescription,
} from "@/components/ui/drawer";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/utils";
import type { VideoSourceMode } from "../state/wizardStorage";
import type {
  LookStyleDTO,
  MotionPresetDTO,
  VideoEngineDTO,
} from "./data/videoCatalogue";

export interface VideoAdvancedOptionsValue {
  sourceMode: VideoSourceMode;
  lookStyleId: string;
  motionPresetId: string | null;
  lengthSeconds: number;
  resolution: string;
  engineId: string;
  engineMode?: string;
  customModePrompt?: string;
  overrideLookForSource?: boolean;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: VideoAdvancedOptionsValue;
  onChange: (patch: Partial<VideoAdvancedOptionsValue>) => void;
  lookStyles: LookStyleDTO[];
  motionPresets: MotionPresetDTO[];
  engines: VideoEngineDTO[];
  /** When the picked source is already a pre-stylized AI image. */
  sourceIsAiStyling: boolean;
}

export function VideoAdvancedOptionsSheet({
  open,
  onOpenChange,
  value,
  onChange,
  lookStyles,
  motionPresets,
  engines,
  sourceIsAiStyling,
}: Props) {
  const engine = engines.find((e) => e.id === value.engineId) ?? engines[0];
  const hasEngineModes = !!(engine?.supportedModes && engine.supportedModes.length > 0);
  const showEngineSelector = engines.length > 1;

  // Uncommitted look style — committed by the Apply button.
  const [pendingLookStyleId, setPendingLookStyleId] = useState(value.lookStyleId);
  useEffect(() => {
    setPendingLookStyleId(value.lookStyleId);
  }, [value.lookStyleId, open]);
  const lookHasChanges = pendingLookStyleId !== value.lookStyleId;

  // For pre-stylized AI sources, the style is read-only unless the user
  // explicitly opts into a different style for the video.
  const lookEditable =
    value.sourceMode !== "use-existing-ai-image" ||
    !sourceIsAiStyling ||
    !!value.overrideLookForSource;

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent className="max-h-[88vh] bg-[#0c0c0c] text-white">
        <DrawerHeader>
          <DrawerTitle className="font-display uppercase tracking-wide">
            Advanced options
          </DrawerTitle>
          <DrawerDescription>
            Source mode, look, motion, length, quality, and engine.
          </DrawerDescription>
        </DrawerHeader>

        <div className="space-y-6 overflow-y-auto px-4 pb-8">
          {/* 1. Source mode */}
          <section data-testid="advanced-source-mode">
            <SectionLabel>Source mode</SectionLabel>
            <RadioRow
              name="source-mode"
              value={value.sourceMode}
              onChange={(v) => onChange({ sourceMode: v as VideoSourceMode })}
              options={[
                { value: "stylize-then-video", label: "Stylize then video" },
                { value: "use-photo-as-is", label: "Use photo as-is" },
                { value: "use-existing-ai-image", label: "Use existing AI image" },
              ]}
            />
          </section>

          {/* 2. Look style */}
          <section data-testid="advanced-look-style">
            <div className="flex items-baseline justify-between">
              <SectionLabel>Look style</SectionLabel>
              {value.sourceMode === "use-existing-ai-image" && sourceIsAiStyling && (
                <label className="flex items-center gap-2 text-xs text-white/70">
                  <input
                    type="checkbox"
                    checked={!!value.overrideLookForSource}
                    onChange={(e) =>
                      onChange({ overrideLookForSource: e.target.checked })
                    }
                    data-testid="advanced-override-look"
                  />
                  Use a different style for the video
                </label>
              )}
            </div>

            <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
              {lookStyles.map((s) => {
                const isSelected = pendingLookStyleId === s.id;
                return (
                  <button
                    key={s.id}
                    type="button"
                    disabled={!lookEditable}
                    onClick={() => setPendingLookStyleId(s.id)}
                    className={cn(
                      "rounded-md border px-3 py-2 text-left text-xs transition",
                      isSelected
                        ? "border-[#ff6b35] bg-[#ff6b35]/15"
                        : "border-white/15 text-white/70 hover:border-white/30",
                      !lookEditable && "opacity-50 cursor-not-allowed",
                    )}
                    data-testid={`look-style-${s.id}`}
                  >
                    <div className="font-mono text-[10px] uppercase tracking-widest text-white/60">
                      Style
                    </div>
                    <div className="font-display text-sm uppercase">{s.label}</div>
                    {s.description && (
                      <div className="mt-1 text-[11px] text-white/50">
                        {s.description}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>

            <Button
              type="button"
              disabled={!lookHasChanges || !lookEditable}
              onClick={() => onChange({ lookStyleId: pendingLookStyleId })}
              className="mt-3"
              data-testid="advanced-look-style-apply"
            >
              Apply
            </Button>
          </section>

          {/* 3. Motion preset */}
          <section data-testid="advanced-motion-preset">
            <SectionLabel>Motion preset</SectionLabel>
            <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
              <button
                type="button"
                onClick={() => onChange({ motionPresetId: null })}
                className={cn(
                  "rounded-md border px-3 py-2 text-left text-xs transition",
                  value.motionPresetId === null
                    ? "border-[#ff6b35] bg-[#ff6b35]/15"
                    : "border-white/15 text-white/70 hover:border-white/30",
                )}
                data-testid="motion-preset-default"
              >
                <div className="font-display text-sm uppercase">Default</div>
                <div className="mt-1 text-[11px] text-white/50">
                  Slow, generic motion.
                </div>
              </button>
              {motionPresets.map((p) => {
                const isSelected = value.motionPresetId === p.id;
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => onChange({ motionPresetId: p.id })}
                    className={cn(
                      "rounded-md border px-3 py-2 text-left text-xs transition",
                      isSelected
                        ? "border-[#ff6b35] bg-[#ff6b35]/15"
                        : "border-white/15 text-white/70 hover:border-white/30",
                    )}
                    data-testid={`motion-preset-${p.id}`}
                  >
                    <div className="font-display text-sm uppercase">{p.label}</div>
                    {p.description && (
                      <div className="mt-1 text-[11px] text-white/50">
                        {p.description}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          </section>

          {/* 4. Length */}
          {engine && (
            <section data-testid="advanced-length">
              <SectionLabel>Length</SectionLabel>
              <RadioRow
                name="length"
                value={String(value.lengthSeconds)}
                onChange={(v) => onChange({ lengthSeconds: parseInt(v, 10) })}
                options={engine.allowedDurationsSec.map((d) => ({
                  value: String(d),
                  label: `${d}s`,
                }))}
              />
            </section>
          )}

          {/* 5. Quality */}
          {engine && (
            <section data-testid="advanced-resolution">
              <SectionLabel>Quality</SectionLabel>
              <RadioRow
                name="resolution"
                value={value.resolution}
                onChange={(v) => onChange({ resolution: v })}
                options={engine.allowedResolutions.map((r) => ({
                  value: r,
                  label: r,
                }))}
              />
            </section>
          )}

          {/* 6. Engine mode */}
          {hasEngineModes && engine?.supportedModes && (
            <section data-testid="advanced-engine-mode">
              <SectionLabel>Mode</SectionLabel>
              <RadioRow
                name="engine-mode"
                value={value.engineMode ?? engine.defaultMode ?? engine.supportedModes[0].id}
                onChange={(v) => onChange({ engineMode: v })}
                options={engine.supportedModes.map((m) => ({
                  value: m.id,
                  label: m.label,
                }))}
              />
              {value.engineMode === "custom" && (
                <textarea
                  value={value.customModePrompt ?? ""}
                  onChange={(e) =>
                    onChange({ customModePrompt: e.target.value })
                  }
                  placeholder="Add your own direction (e.g. handheld camera, slow zoom, dust in the air)"
                  className="mt-2 w-full rounded-md border border-white/15 bg-black/40 p-2 text-sm text-white placeholder-white/30"
                  rows={3}
                  data-testid="advanced-custom-mode-prompt"
                />
              )}
            </section>
          )}

          {/* 7. Engine selector */}
          {showEngineSelector && (
            <section data-testid="advanced-engine-selector">
              <SectionLabel>Engine</SectionLabel>
              <select
                value={value.engineId}
                onChange={(e) => onChange({ engineId: e.target.value })}
                className="mt-2 w-full rounded-md border border-white/15 bg-black/40 p-2 text-sm text-white"
                data-testid="advanced-engine-select"
              >
                {engines.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.label}
                  </option>
                ))}
              </select>
              {engine?.description && (
                <p className="mt-1 text-xs text-white/50">{engine.description}</p>
              )}
            </section>
          )}
        </div>
      </DrawerContent>
    </Drawer>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="font-mono text-[10px] uppercase tracking-widest text-white/60">
      {children}
    </div>
  );
}

interface RadioRowProps {
  name: string;
  value: string;
  onChange: (next: string) => void;
  options: { value: string; label: string }[];
}

function RadioRow({ name, value, onChange, options }: RadioRowProps) {
  return (
    <div
      className="mt-2 flex flex-wrap gap-2"
      role="radiogroup"
      aria-label={name}
    >
      {options.map((opt) => {
        const isActive = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={isActive}
            onClick={() => onChange(opt.value)}
            className={cn(
              "rounded-md border px-3 py-2 text-xs transition",
              isActive
                ? "border-[#ff6b35] bg-[#ff6b35]/15 text-white"
                : "border-white/15 text-white/70 hover:border-white/30",
            )}
            data-testid={`${name}-option-${opt.value}`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

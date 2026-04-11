import { useEffect, useState, useCallback, createContext, useContext } from "react";
import {
  Clock, Check, AlertCircle, Loader2, Bug, X,
} from "lucide-react";
import { IMAGE_STYLES } from "@/config/imageStyles";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ConfigRow {
  key: string;
  value: string;
  valueLabel: string | null;
  debugValue: string | null;
  debugValueLabel: string | null;
  dataType: string;
  label: string;
  description: string | null;
  minValue: number | null;
  maxValue: number | null;
  isPublic: boolean;
  updatedAt: string;
}

export interface FieldState {
  value: string;
  label: string;
  saving: boolean;
  error: string | null;
  saved: boolean;
}

// ── Style options (used by AI page) ──────────────────────────────────────────

export const STYLE_OPTIONS = IMAGE_STYLES.filter((s) => s.id !== "none");

// ── Model / select option lists ───────────────────────────────────────────────

export const FAL_IMAGE_SIZES: { value: string; label: string }[] = [
  { value: "square_hd",     label: "Square HD (1024×1024)" },
  { value: "square",        label: "Square (512×512)" },
  { value: "portrait_4_3",  label: "Portrait 4:3 (768×1024)" },
  { value: "portrait_16_9", label: "Portrait 16:9 (576×1024)" },
  { value: "landscape_4_3", label: "Landscape 4:3 (1024×768)" },
  { value: "landscape_16_9",label: "Landscape 16:9 (1024×576)" },
];

export const FAL_IMAGE_MODELS_STANDARD: { value: string; label: string }[] = [
  { value: "fal-ai/flux-pro/v1.1",       label: "FLUX Pro 1.1" },
  { value: "fal-ai/flux-pro/v1.1-ultra", label: "FLUX Pro 1.1 Ultra" },
  { value: "fal-ai/flux-pro",            label: "FLUX Pro" },
  { value: "fal-ai/flux/dev",            label: "FLUX Dev" },
  { value: "fal-ai/flux/schnell",        label: "FLUX Schnell (fast)" },
  { value: "fal-ai/flux-2-pro",          label: "FLUX 2 Pro" },
  { value: "fal-ai/flux-2-max",          label: "FLUX 2 Max" },
];

export const FAL_IMAGE_MODELS_REFERENCE: { value: string; label: string }[] = [
  { value: "fal-ai/flux-pulid",              label: "FLUX PuLID (face-preserving)" },
  { value: "fal-ai/ip-adapter-face-id-plus", label: "IP-Adapter FaceID+" },
];

export const FAL_SAFETY_TOLERANCE: { value: string; label: string }[] = [
  { value: "1", label: "1 — Most strict" },
  { value: "2", label: "2 — Strict (default)" },
  { value: "3", label: "3 — Moderate" },
  { value: "4", label: "4 — Permissive" },
  { value: "5", label: "5 — Very permissive" },
  { value: "6", label: "6 — Most permissive" },
];

export const FAL_OUTPUT_FORMAT: { value: string; label: string }[] = [
  { value: "jpeg", label: "jpeg — smaller, faster (default)" },
  { value: "png",  label: "png — lossless, larger" },
];

export const FAL_ASPECT_RATIO: { value: string; label: string }[] = [
  { value: "1:1",  label: "1:1 — Square" },
  { value: "4:3",  label: "4:3 — Landscape standard" },
  { value: "3:4",  label: "3:4 — Portrait standard" },
  { value: "16:9", label: "16:9 — Wide" },
  { value: "9:16", label: "9:16 — Tall" },
  { value: "21:9", label: "21:9 — Ultrawide" },
  { value: "9:21", label: "9:21 — Ultra tall" },
  { value: "3:2",  label: "3:2 — Landscape photo" },
  { value: "2:3",  label: "2:3 — Portrait photo" },
];

export const FAL_RAW_MODE: { value: string; label: string }[] = [
  { value: "false", label: "false — processed output (default)" },
  { value: "true",  label: "true — natural, less processed" },
];

export const OPENAI_CHAT_MODELS: { value: string; label: string }[] = [
  { value: "gpt-4o",              label: "GPT-4o" },
  { value: "gpt-4o-mini",        label: "GPT-4o mini (default)" },
  { value: "gpt-4.1",            label: "GPT-4.1" },
  { value: "gpt-4.1-mini",       label: "GPT-4.1 mini" },
  { value: "gpt-4.1-nano",       label: "GPT-4.1 nano" },
  { value: "gpt-4-turbo",        label: "GPT-4 Turbo" },
  { value: "gpt-3.5-turbo",      label: "GPT-3.5 Turbo" },
  { value: "o4-mini",            label: "o4-mini" },
  { value: "o3-mini",            label: "o3-mini" },
];

export const FAL_VIDEO_MODELS: { value: string; label: string }[] = [
  // ── xAI Grok ─────────────────────────────────────────────────────────────
  { value: "xai/grok-imagine-video/image-to-video",              label: "Grok Imagine Video (xAI)" },
  // ── Kling (Kuaishou) ──────────────────────────────────────────────────────
  { value: "fal-ai/kling-video/v3/pro/image-to-video",           label: "Kling v3 Pro — 1080p, audio" },
  { value: "fal-ai/kling-video/v2.6/pro/image-to-video",         label: "Kling v2.6 Pro" },
  { value: "fal-ai/kling-video/v2.5-turbo/pro/image-to-video",   label: "Kling v2.5 Turbo Pro" },
  { value: "fal-ai/kling-video/v2.1/master/image-to-video",      label: "Kling v2.1 Master — 1080p" },
  { value: "fal-ai/kling-video/v2.1/pro/image-to-video",         label: "Kling v2.1 Pro — 1080p" },
  { value: "fal-ai/kling-video/v2.1/standard/image-to-video",    label: "Kling v2.1 Standard — default" },
  { value: "fal-ai/kling-video/v1.6/pro/image-to-video",         label: "Kling v1.6 Pro — 1080p" },
  { value: "fal-ai/kling-video/v1.6/standard/image-to-video",    label: "Kling v1.6 Standard — 720p" },
  // ── Seedance (ByteDance) ──────────────────────────────────────────────────
  { value: "bytedance/seedance-2.0/image-to-video",              label: "Seedance 2.0 (ByteDance) — native audio" },
  { value: "bytedance/seedance-2.0/fast/image-to-video",         label: "Seedance 2.0 Fast (ByteDance)" },
  { value: "fal-ai/bytedance/seedance/v1.5/pro/image-to-video",  label: "Seedance 1.5 Pro (ByteDance)" },
  // ── Google Veo ────────────────────────────────────────────────────────────
  { value: "fal-ai/veo3.1/image-to-video",                       label: "Veo 3.1 (Google) — top quality" },
  { value: "fal-ai/veo3.1/fast/image-to-video",                  label: "Veo 3.1 Fast (Google)" },
  { value: "fal-ai/veo3.1/lite/image-to-video",                  label: "Veo 3.1 Lite (Google)" },
  { value: "fal-ai/veo3/image-to-video",                         label: "Veo 3 (Google)" },
  { value: "fal-ai/veo2/image-to-video",                         label: "Veo 2 (Google) — 720p" },
  // ── OpenAI Sora ───────────────────────────────────────────────────────────
  { value: "fal-ai/sora-2/image-to-video",                       label: "Sora 2 (OpenAI)" },
  // ── Runway ────────────────────────────────────────────────────────────────
  { value: "fal-ai/runway/gen4-turbo/image-to-video",            label: "Runway Gen-4 Turbo — 1080p" },
  { value: "fal-ai/runway-gen3/turbo/image-to-video",            label: "Runway Gen-3 Alpha Turbo — 720p" },
  // ── Luma ──────────────────────────────────────────────────────────────────
  { value: "fal-ai/luma-dream-machine/ray-2/image-to-video",     label: "Luma Ray 2 (Dream Machine) — 720p" },
  { value: "fal-ai/luma-dream-machine/ray-flash-2/image-to-video", label: "Luma Ray Flash 2 — fast" },
  // ── MiniMax / Hailuo ──────────────────────────────────────────────────────
  { value: "fal-ai/minimax/hailuo-2.3-pro/image-to-video",       label: "Hailuo 2.3 Pro (MiniMax) — 1080p" },
  { value: "fal-ai/minimax/hailuo-2.3/image-to-video",           label: "Hailuo 2.3 Standard (MiniMax) — 768p" },
  { value: "fal-ai/minimax/hailuo-02/standard/image-to-video",   label: "Hailuo 02 Standard (MiniMax)" },
  { value: "fal-ai/minimax/video-01-live/image-to-video",        label: "MiniMax Video-01 Live" },
  { value: "fal-ai/minimax/video-01/image-to-video",             label: "MiniMax Video-01" },
  // ── PixVerse ──────────────────────────────────────────────────────────────
  { value: "fal-ai/pixverse/v6/image-to-video",                  label: "PixVerse v6 — 1080p" },
  { value: "fal-ai/pixverse/v5.5/image-to-video",                label: "PixVerse v5.5" },
  { value: "fal-ai/pixverse/v5/image-to-video",                  label: "PixVerse v5" },
  { value: "fal-ai/pixverse/v4.5/image-to-video",                label: "PixVerse v4.5 — 720p" },
  // ── WAN ───────────────────────────────────────────────────────────────────
  { value: "fal-ai/wan/v2.7/image-to-video",                     label: "WAN 2.7 — latest" },
  { value: "fal-ai/wan/v2.2-a14b/image-to-video",                label: "WAN 2.2 (A14B)" },
  { value: "fal-ai/wan/v2.2/image-to-video",                     label: "WAN 2.2" },
  { value: "fal-ai/wan-pro/image-to-video",                      label: "WAN 2.1 Pro — 1080p" },
  { value: "fal-ai/wan-i2v",                                     label: "WAN 2.1" },
  // ── LTX ───────────────────────────────────────────────────────────────────
  { value: "fal-ai/ltx-2-19b/image-to-video",                    label: "LTX-2 19B" },
  { value: "fal-ai/ltx-video-13b-distilled/image-to-video",      label: "LTX-Video 13B Distilled" },
  // ── Open source / other ───────────────────────────────────────────────────
  { value: "fal-ai/hunyuan-video/image-to-video",                label: "HunyuanVideo (Tencent)" },
  { value: "fal-ai/cogvideox-5b/image-to-video",                 label: "CogVideoX-5B (Zhipu) — open source" },
  { value: "fal-ai/stable-video",                                label: "Stable Video Diffusion — lightweight" },
];

export const FAL_VIDEO_DURATION: { value: string; label: string }[] = [
  { value: "auto", label: "auto — model decides (Seedance 2.0 default)" },
  { value: "1",  label: "1 second" },
  { value: "2",  label: "2 seconds" },
  { value: "3",  label: "3 seconds" },
  { value: "4",  label: "4 seconds" },
  { value: "5",  label: "5 seconds" },
  { value: "6",  label: "6 seconds (Grok default)" },
  { value: "7",  label: "7 seconds" },
  { value: "8",  label: "8 seconds" },
  { value: "9",  label: "9 seconds" },
  { value: "10", label: "10 seconds" },
  { value: "11", label: "11 seconds" },
  { value: "12", label: "12 seconds" },
  { value: "13", label: "13 seconds" },
  { value: "14", label: "14 seconds" },
  { value: "15", label: "15 seconds (Grok max)" },
];

export const FAL_VIDEO_ASPECT_RATIO: { value: string; label: string }[] = [
  { value: "auto", label: "auto — model decides (Grok & Seedance 2.0 default)" },
  { value: "16:9", label: "16:9 — Widescreen" },
  { value: "9:16", label: "9:16 — Vertical / Portrait" },
  { value: "4:3",  label: "4:3 — Landscape standard" },
  { value: "3:4",  label: "3:4 — Portrait standard" },
  { value: "3:2",  label: "3:2 — Landscape photo (Grok only)" },
  { value: "2:3",  label: "2:3 — Portrait photo (Grok only)" },
  { value: "21:9", label: "21:9 — Ultrawide cinematic (Seedance 2.0 only)" },
  { value: "1:1",  label: "1:1 — Square" },
];

export const FAL_VIDEO_RESOLUTION: { value: string; label: string }[] = [
  { value: "720p",  label: "720p — HD (Grok default)" },
  { value: "480p",  label: "480p — SD, faster" },
];

export const FLOAT_TEXT_CONFIGS = new Set([
  "ai_scene_prompt_temperature",
]);

export const SELECT_CONFIGS: Record<string, { value: string; label: string }[]> = {
  ai_image_size:             FAL_IMAGE_SIZES,
  ai_image_model_standard:   FAL_IMAGE_MODELS_STANDARD,
  ai_image_model_reference:  FAL_IMAGE_MODELS_REFERENCE,
  ai_std_safety_tolerance:   FAL_SAFETY_TOLERANCE,
  ai_std_output_format:      FAL_OUTPUT_FORMAT,
  ai_std_aspect_ratio:       FAL_ASPECT_RATIO,
  ai_std_ultra_raw:          FAL_RAW_MODE,
  ai_scene_prompt_model:     OPENAI_CHAT_MODELS,
  video_model:               FAL_VIDEO_MODELS,
  video_duration:            FAL_VIDEO_DURATION,
  video_aspect_ratio:        FAL_VIDEO_ASPECT_RATIO,
  video_resolution:          FAL_VIDEO_RESOLUTION,
};

export const MODEL_CONFIG_KEYS = new Set([
  "ai_image_model_standard", "ai_image_model_reference", "ai_image_size",
  "ai_std_num_inference_steps", "ai_std_guidance_scale", "ai_std_safety_tolerance",
  "ai_std_seed", "ai_std_output_format", "ai_std_aspect_ratio", "ai_std_ultra_raw",
  "ai_ref_pulid_id_scale", "ai_ref_pulid_guidance_scale", "ai_ref_pulid_num_inference_steps",
  "ai_ref_pulid_true_cfg_scale", "ai_ref_pulid_start_step", "ai_pulid_composition_suffix",
  "ai_pulid_id_scale_pct",
  "ai_scene_prompt_model", "ai_scene_prompt_max_tokens", "ai_scene_prompt_temperature",
  "video_model", "video_duration", "video_aspect_ratio", "video_resolution", "video_prompt_system_prompt",
]);

// ── Shared context ────────────────────────────────────────────────────────────

export interface ConfigPageCtx {
  rows: ConfigRow[];
  stdEdits: Record<string, FieldState>;
  dbgEdits: Record<string, FieldState>;
  debugActive: boolean;
  setStdEdits: React.Dispatch<React.SetStateAction<Record<string, FieldState>>>;
  setDbgEdits: React.Dispatch<React.SetStateAction<Record<string, FieldState>>>;
  saveStd: (key: string) => void;
  saveDbg: (key: string) => void;
  stdDirty: (key: string) => boolean;
  dbgDirty: (key: string) => boolean;
}

export const ConfigPageContext = createContext<ConfigPageCtx | null>(null);

export function useConfigCtx(): ConfigPageCtx {
  const ctx = useContext(ConfigPageContext);
  if (!ctx) throw new Error("useConfigCtx must be used within ConfigPageContext.Provider");
  return ctx;
}

// ── Shared data-loading hook ──────────────────────────────────────────────────

export function useConfigPageState() {
  const [rows, setRows] = useState<ConfigRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [stdEdits, setStdEdits] = useState<Record<string, FieldState>>({});
  const [dbgEdits, setDbgEdits] = useState<Record<string, FieldState>>({});
  const [debugActive, setDebugActive] = useState(false);
  const [debugToggling, setDebugToggling] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    fetch("/api/admin/config", { credentials: "include" })
      .then((r) => r.json())
      .then((data: unknown) => {
        if (!Array.isArray(data)) return;
        const fetched = data as ConfigRow[];
        setRows(fetched);
        const std: Record<string, FieldState> = {};
        const dbg: Record<string, FieldState> = {};
        for (const row of fetched) {
          if (row.key === "debug_mode_active") {
            setDebugActive(row.value === "true");
            continue;
          }
          const selectOpts = SELECT_CONFIGS[row.key];
          const stdLabel = row.valueLabel ?? (selectOpts?.find((o) => o.value === row.value)?.label ?? row.value);
          const dbgVal = row.debugValue ?? "";
          const dbgLabel = row.debugValueLabel ?? (selectOpts?.find((o) => o.value === dbgVal)?.label ?? dbgVal);
          std[row.key] = { value: row.value, label: stdLabel, saving: false, error: null, saved: false };
          dbg[row.key] = { value: dbgVal, label: dbgLabel, saving: false, error: null, saved: false };
        }
        setStdEdits(std);
        setDbgEdits(dbg);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  async function toggleDebugMode() {
    setDebugToggling(true);
    const next = !debugActive;
    try {
      const res = await fetch("/api/admin/config/debug_mode_active", {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: next ? "true" : "false" }),
      });
      if (res.ok) setDebugActive(next);
    } catch { /* ignore */ }
    finally { setDebugToggling(false); }
  }

  const saveStd = useCallback(async (key: string) => {
    setStdEdits((prev) => {
      const edit = prev[key];
      const row = rows.find((r) => r.key === key);
      if (!edit || !row || edit.value === row.value) return prev;
      return { ...prev, [key]: { ...edit, saving: true, error: null, saved: false } };
    });
    const edit = stdEdits[key];
    const row = rows.find((r) => r.key === key);
    if (!edit || !row || edit.value === row.value) return;
    try {
      const isSelect = !!SELECT_CONFIGS[key];
      const res = await fetch(`/api/admin/config/${key}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: edit.value, ...(isSelect ? { valueLabel: edit.label } : {}) }),
      });
      const data = (await res.json()) as { error?: string; value?: string; valueLabel?: string | null };
      if (!res.ok) {
        setStdEdits((p) => ({ ...p, [key]: { ...p[key]!, saving: false, error: data.error ?? "Save failed" } }));
      } else {
        setStdEdits((p) => ({ ...p, [key]: { ...p[key]!, saving: false, saved: true } }));
        setRows((p) => p.map((r) => r.key === key ? { ...r, value: data.value ?? edit.value, valueLabel: data.valueLabel ?? edit.label, updatedAt: new Date().toISOString() } : r));
        setTimeout(() => setStdEdits((p) => ({ ...p, [key]: { ...p[key]!, saved: false } })), 2500);
      }
    } catch {
      setStdEdits((p) => ({ ...p, [key]: { ...p[key]!, saving: false, error: "Network error" } }));
    }
  }, [stdEdits, rows]);

  const saveDbg = useCallback(async (key: string) => {
    const edit = dbgEdits[key];
    const row = rows.find((r) => r.key === key);
    if (!edit || !row) return;
    const currentDbg = row.debugValue ?? "";
    if (edit.value === currentDbg) return;
    setDbgEdits((p) => ({ ...p, [key]: { ...p[key]!, saving: true, error: null, saved: false } }));
    try {
      const isSelect = !!SELECT_CONFIGS[key];
      const res = await fetch(`/api/admin/config/${key}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ debugValue: edit.value || null, ...(isSelect ? { debugValueLabel: edit.label || null } : {}) }),
      });
      const data = (await res.json()) as { error?: string; debugValue?: string | null; debugValueLabel?: string | null };
      if (!res.ok) {
        setDbgEdits((p) => ({ ...p, [key]: { ...p[key]!, saving: false, error: data.error ?? "Save failed" } }));
      } else {
        setDbgEdits((p) => ({ ...p, [key]: { ...p[key]!, saving: false, saved: true } }));
        setRows((p) => p.map((r) => r.key === key ? { ...r, debugValue: data.debugValue ?? null, debugValueLabel: data.debugValueLabel ?? null, updatedAt: new Date().toISOString() } : r));
        setTimeout(() => setDbgEdits((p) => ({ ...p, [key]: { ...p[key]!, saved: false } })), 2500);
      }
    } catch {
      setDbgEdits((p) => ({ ...p, [key]: { ...p[key]!, saving: false, error: "Network error" } }));
    }
  }, [dbgEdits, rows]);

  const stdDirty = useCallback((key: string) => {
    const row = rows.find((r) => r.key === key);
    return row ? stdEdits[key]?.value !== row.value : false;
  }, [rows, stdEdits]);

  const dbgDirty = useCallback((key: string) => {
    const row = rows.find((r) => r.key === key);
    return row ? (dbgEdits[key]?.value ?? "") !== (row.debugValue ?? "") : false;
  }, [rows, dbgEdits]);

  return {
    rows, setRows, loading,
    stdEdits, dbgEdits, setStdEdits, setDbgEdits,
    debugActive, setDebugActive, debugToggling,
    toggleDebugMode, saveStd, saveDbg, stdDirty, dbgDirty, load,
  };
}

// ── Shared sub-components ─────────────────────────────────────────────────────

export function SaveButton({
  dirty, saving, saved, onClick,
}: { dirty: boolean; saving: boolean; saved: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      disabled={saving || !dirty}
      className="px-3 py-1.5 rounded text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center gap-1.5"
    >
      {saving ? (
        <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Saving…</>
      ) : saved ? (
        <><Check className="w-3.5 h-3.5" /> Saved</>
      ) : (
        "Save"
      )}
    </button>
  );
}

export function ConfigInput({
  configKey, kind, rows: textRows,
}: { configKey: string; kind: "std" | "dbg"; rows?: number }) {
  const { rows, stdEdits, dbgEdits, debugActive, setStdEdits, setDbgEdits, saveStd, saveDbg, stdDirty, dbgDirty } = useConfigCtx();
  const row = rows.find((r) => r.key === configKey);
  if (!row) return null;
  const state = kind === "std" ? stdEdits[configKey] : dbgEdits[configKey];
  if (!state) return null;
  const isLong = row.dataType === "text" && !FLOAT_TEXT_CONFIGS.has(configKey);
  const dirty = kind === "std" ? stdDirty(configKey) : dbgDirty(configKey);
  const placeholder = kind === "dbg" ? (row.debugValue ?? "Same as standard (no override)") : undefined;
  const isDbgActive = debugActive && kind === "dbg";
  const borderClass = isDbgActive ? "border-amber-500/60 ring-1 ring-amber-500/30" : "border-border";

  const onChange = (val: string) => {
    const opts = SELECT_CONFIGS[configKey];
    const selectedLabel = opts?.find((o) => o.value === val)?.label ?? val;
    if (kind === "std") setStdEdits((p) => ({ ...p, [configKey]: { ...p[configKey]!, value: val, label: selectedLabel, error: null, saved: false } }));
    else setDbgEdits((p) => ({ ...p, [configKey]: { ...p[configKey]!, value: val, label: selectedLabel, error: null, saved: false } }));
  };
  const onSave = () => kind === "std" ? saveStd(configKey) : saveDbg(configKey);
  const selectOptions = SELECT_CONFIGS[configKey];

  if (selectOptions) {
    return (
      <div className="space-y-1.5">
        <div className="flex items-center gap-3">
          <select
            value={state.value}
            onChange={(e) => onChange(e.target.value)}
            className={`flex-1 bg-background border rounded px-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary ${borderClass}`}
          >
            {selectOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
          <SaveButton dirty={dirty} saving={state.saving} saved={state.saved} onClick={onSave} />
          {state.error && <p className="text-destructive text-xs flex items-center gap-1"><AlertCircle className="w-3 h-3" />{state.error}</p>}
        </div>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="shrink-0">API value:</span>
          <code className="bg-muted px-1.5 py-0.5 rounded text-xs font-mono text-foreground/80 select-all">{state.value}</code>
        </div>
      </div>
    );
  }

  return (
    <div className={isLong ? "space-y-2" : "flex items-center gap-3"}>
      {isLong ? (
        <>
          <textarea
            rows={textRows ?? 3}
            value={state.value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            className={`w-full bg-background border rounded px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary resize-y ${borderClass} placeholder:text-muted-foreground/40`}
          />
          <div className="flex items-center gap-3">
            <SaveButton dirty={dirty} saving={state.saving} saved={state.saved} onClick={onSave} />
            {state.error && <p className="text-destructive text-xs flex items-center gap-1"><AlertCircle className="w-3 h-3" />{state.error}</p>}
          </div>
        </>
      ) : (
        <>
          <input
            type={row.dataType === "integer" || row.dataType === "float" || FLOAT_TEXT_CONFIGS.has(configKey) ? "number" : "text"}
            step={row.dataType === "float" || FLOAT_TEXT_CONFIGS.has(configKey) ? "0.01" : undefined}
            min={row.minValue ?? undefined}
            max={row.maxValue ?? undefined}
            value={state.value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            onKeyDown={(e) => { if (e.key === "Enter" && dirty) onSave(); }}
            className={`w-36 bg-background border rounded px-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary ${borderClass} placeholder:text-muted-foreground/40`}
          />
          {row.minValue !== null && row.maxValue !== null && (
            <span className="text-xs text-muted-foreground">{row.minValue}–{row.maxValue}</span>
          )}
          <SaveButton dirty={dirty} saving={state.saving} saved={state.saved} onClick={onSave} />
          {state.error && <p className="text-destructive text-xs flex items-center gap-1"><AlertCircle className="w-3 h-3" />{state.error}</p>}
        </>
      )}
    </div>
  );
}

export function ConfigCard({ row }: { row: ConfigRow }) {
  const { stdEdits, dbgEdits, debugActive, setDbgEdits, saveDbg, dbgDirty } = useConfigCtx();
  const stdState = stdEdits[row.key];
  const dbgState = dbgEdits[row.key];
  if (!stdState) return null;

  const dbgSelectOptions = SELECT_CONFIGS[row.key];
  const dbgBorderClass = debugActive ? "border-amber-500/40" : "border-border";

  const onDbgChange = (val: string) => {
    const selectedLabel = dbgSelectOptions?.find((o) => o.value === val)?.label ?? val;
    setDbgEdits((p) => ({ ...p, [row.key]: { ...p[row.key]!, value: val, label: selectedLabel, error: null, saved: false } }));
  };

  return (
    <div className="bg-card border border-border rounded-lg p-5 space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="font-semibold text-foreground">{row.label}</h3>
            {row.isPublic && (
              <span className="text-xs px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400 border border-blue-500/20">public</span>
            )}
            {row.debugValue != null && row.debugValue !== "" && (
              <span className="text-xs px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20 flex items-center gap-1">
                <Bug className="w-3 h-3" /> has debug value
              </span>
            )}
          </div>
          {row.description && (
            <p className="text-sm text-muted-foreground mt-0.5">{row.description}</p>
          )}
          <div className="flex items-center gap-1 mt-1 text-xs text-muted-foreground">
            <Clock className="w-3 h-3" />
            <span>Last updated {new Date(row.updatedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</span>
          </div>
        </div>
        <code className="text-xs text-muted-foreground bg-muted px-2 py-1 rounded shrink-0">{row.key}</code>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className={`rounded-lg border p-3 space-y-2 ${!debugActive ? "border-primary/40 bg-primary/5" : "border-border"}`}>
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Standard</span>
            {!debugActive && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-primary/15 text-primary font-medium">Active</span>}
          </div>
          <ConfigInput configKey={row.key} kind="std" rows={4} />
        </div>

        <div className={`rounded-lg border p-3 space-y-2 ${debugActive ? "border-amber-500/50 bg-amber-500/5" : "border-border"}`}>
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1">
              <Bug className="w-3 h-3" /> Debug
            </span>
            {debugActive && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-400 font-medium">Active</span>}
          </div>
          {dbgState && (
            dbgSelectOptions ? (
              <div className="space-y-1.5">
                <div className="flex items-center gap-3">
                  <select
                    value={dbgState.value}
                    onChange={(e) => onDbgChange(e.target.value)}
                    className={`flex-1 bg-background border rounded px-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-amber-500/50 ${dbgBorderClass}`}
                  >
                    {dbgSelectOptions.map((opt) => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                  <SaveButton dirty={dbgDirty(row.key)} saving={dbgState.saving} saved={dbgState.saved} onClick={() => saveDbg(row.key)} />
                  {dbgState.error && <p className="text-destructive text-xs flex items-center gap-1"><AlertCircle className="w-3 h-3" />{dbgState.error}</p>}
                </div>
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span className="shrink-0">API value:</span>
                  <code className="bg-muted px-1.5 py-0.5 rounded text-xs font-mono text-foreground/80 select-all">{dbgState.value}</code>
                </div>
              </div>
            ) : row.dataType === "text" ? (
              <>
                <textarea
                  rows={4}
                  value={dbgState.value}
                  onChange={(e) => onDbgChange(e.target.value)}
                  placeholder={row.debugValue ?? "Same as standard (no override)"}
                  className={`w-full bg-background border rounded px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-amber-500/50 resize-y placeholder:text-muted-foreground/40 ${dbgBorderClass}`}
                />
                <div className="flex items-center gap-3">
                  <SaveButton dirty={dbgDirty(row.key)} saving={dbgState.saving} saved={dbgState.saved} onClick={() => saveDbg(row.key)} />
                  {dbgState.value !== "" && (
                    <button
                      onClick={() => onDbgChange("")}
                      className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
                      title="Clear debug value (fall back to standard)"
                    >
                      <X className="w-3 h-3" /> Clear
                    </button>
                  )}
                  {dbgState.error && <p className="text-destructive text-xs flex items-center gap-1"><AlertCircle className="w-3 h-3" />{dbgState.error}</p>}
                </div>
              </>
            ) : (
              <div className="flex items-center gap-3">
                <input
                  type={row.dataType === "integer" || row.dataType === "float" ? "number" : "text"}
                  step={row.dataType === "float" ? "0.01" : undefined}
                  min={row.minValue ?? undefined}
                  max={row.maxValue ?? undefined}
                  value={dbgState.value}
                  onChange={(e) => onDbgChange(e.target.value)}
                  placeholder="— standard"
                  onKeyDown={(e) => { if (e.key === "Enter" && dbgDirty(row.key)) saveDbg(row.key); }}
                  className={`w-36 bg-background border rounded px-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-amber-500/50 placeholder:text-muted-foreground/40 ${dbgBorderClass}`}
                />
                {row.minValue !== null && row.maxValue !== null && (
                  <span className="text-xs text-muted-foreground">{row.minValue}–{row.maxValue}</span>
                )}
                <SaveButton dirty={dbgDirty(row.key)} saving={dbgState.saving} saved={dbgState.saved} onClick={() => saveDbg(row.key)} />
                {dbgState.error && <p className="text-destructive text-xs flex items-center gap-1"><AlertCircle className="w-3 h-3" />{dbgState.error}</p>}
              </div>
            )
          )}
        </div>
      </div>
    </div>
  );
}

export function ModelParamRow({ paramKey }: { paramKey: string }) {
  const { rows, debugActive } = useConfigCtx();
  const row = rows.find((r) => r.key === paramKey);
  if (!row) return null;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <span className="text-sm font-medium text-foreground">{row.label}</span>
          {row.description && <p className="text-xs text-muted-foreground mt-0.5">{row.description}</p>}
        </div>
        <code className="text-xs text-muted-foreground bg-muted px-2 py-1 rounded shrink-0">{row.key}</code>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className={`rounded-lg border p-3 space-y-2 ${!debugActive ? "border-primary/40 bg-primary/5" : "border-border"}`}>
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Standard</span>
            {!debugActive && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-primary/15 text-primary font-medium">Active</span>}
          </div>
          <ConfigInput configKey={paramKey} kind="std" />
        </div>
        <div className={`rounded-lg border p-3 space-y-2 ${debugActive ? "border-amber-500/50 bg-amber-500/5" : "border-border"}`}>
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1">
              <Bug className="w-3 h-3" /> Debug
            </span>
            {debugActive && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-400 font-medium">Active</span>}
          </div>
          <ConfigInput configKey={paramKey} kind="dbg" />
        </div>
      </div>
    </div>
  );
}

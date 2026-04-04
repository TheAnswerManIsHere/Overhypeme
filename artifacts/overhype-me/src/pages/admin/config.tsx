import { useEffect, useState, useCallback } from "react";
import { AdminLayout } from "@/components/admin/AdminLayout";
import {
  Settings, Clock, Check, AlertCircle, Loader2, Palette, Bug, X, Bot,
} from "lucide-react";
import { IMAGE_STYLES } from "@/config/imageStyles";

interface ConfigRow {
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

interface FieldState {
  value: string;
  label: string;
  saving: boolean;
  error: string | null;
  saved: boolean;
}

const STYLE_OPTIONS = IMAGE_STYLES.filter((s) => s.id !== "none");

const FAL_IMAGE_SIZES: { value: string; label: string }[] = [
  { value: "square_hd",     label: "Square HD (1024×1024)" },
  { value: "square",        label: "Square (512×512)" },
  { value: "portrait_4_3",  label: "Portrait 4:3 (768×1024)" },
  { value: "portrait_16_9", label: "Portrait 16:9 (576×1024)" },
  { value: "landscape_4_3", label: "Landscape 4:3 (1024×768)" },
  { value: "landscape_16_9",label: "Landscape 16:9 (1024×576)" },
];

const FAL_IMAGE_MODELS_STANDARD: { value: string; label: string }[] = [
  { value: "fal-ai/flux-pro/v1.1",       label: "fal-ai/flux-pro/v1.1" },
  { value: "fal-ai/flux-pro/v1.1-ultra", label: "fal-ai/flux-pro/v1.1-ultra" },
  { value: "fal-ai/flux-pro",            label: "fal-ai/flux-pro" },
  { value: "fal-ai/flux/dev",            label: "fal-ai/flux/dev" },
  { value: "fal-ai/flux/schnell",        label: "fal-ai/flux/schnell" },
  { value: "fal-ai/flux-2-pro",          label: "fal-ai/flux-2-pro" },
  { value: "fal-ai/flux-2-max",          label: "fal-ai/flux-2-max" },
];

const FAL_IMAGE_MODELS_REFERENCE: { value: string; label: string }[] = [
  { value: "fal-ai/flux-pulid",              label: "fal-ai/flux-pulid" },
  { value: "fal-ai/ip-adapter-face-id-plus", label: "fal-ai/ip-adapter-face-id-plus" },
];

const FAL_SAFETY_TOLERANCE: { value: string; label: string }[] = [
  { value: "1", label: "1 — Most strict" },
  { value: "2", label: "2 — Strict (default)" },
  { value: "3", label: "3 — Moderate" },
  { value: "4", label: "4 — Permissive" },
  { value: "5", label: "5 — Very permissive" },
  { value: "6", label: "6 — Most permissive" },
];

const FAL_OUTPUT_FORMAT: { value: string; label: string }[] = [
  { value: "jpeg", label: "jpeg — smaller, faster (default)" },
  { value: "png",  label: "png — lossless, larger" },
];

const FAL_ASPECT_RATIO: { value: string; label: string }[] = [
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

const FAL_RAW_MODE: { value: string; label: string }[] = [
  { value: "false", label: "false — processed output (default)" },
  { value: "true",  label: "true — natural, less processed" },
];

const SELECT_CONFIGS: Record<string, { value: string; label: string }[]> = {
  ai_image_size:             FAL_IMAGE_SIZES,
  ai_image_model_standard:   FAL_IMAGE_MODELS_STANDARD,
  ai_image_model_reference:  FAL_IMAGE_MODELS_REFERENCE,
  ai_std_safety_tolerance:   FAL_SAFETY_TOLERANCE,
  ai_std_output_format:      FAL_OUTPUT_FORMAT,
  ai_std_aspect_ratio:       FAL_ASPECT_RATIO,
  ai_std_ultra_raw:          FAL_RAW_MODE,
};

// Which config keys belong to each model (shown contextually below the model dropdown)
interface ParamDef { key: string }
const MODEL_PARAMS: Record<string, ParamDef[]> = {
  "fal-ai/flux-pro/v1.1": [
    { key: "ai_std_num_inference_steps" },
    { key: "ai_std_guidance_scale" },
    { key: "ai_std_safety_tolerance" },
    { key: "ai_std_output_format" },
    { key: "ai_std_seed" },
  ],
  "fal-ai/flux-pro": [
    { key: "ai_std_num_inference_steps" },
    { key: "ai_std_guidance_scale" },
    { key: "ai_std_safety_tolerance" },
    { key: "ai_std_output_format" },
    { key: "ai_std_seed" },
  ],
  "fal-ai/flux/dev": [
    { key: "ai_std_num_inference_steps" },
    { key: "ai_std_guidance_scale" },
    { key: "ai_std_output_format" },
    { key: "ai_std_seed" },
  ],
  "fal-ai/flux/schnell": [
    { key: "ai_std_num_inference_steps" },
    { key: "ai_std_output_format" },
    { key: "ai_std_seed" },
  ],
  "fal-ai/flux-pro/v1.1-ultra": [
    { key: "ai_std_aspect_ratio" },
    { key: "ai_std_ultra_raw" },
    { key: "ai_std_safety_tolerance" },
    { key: "ai_std_output_format" },
    { key: "ai_std_seed" },
  ],
  "fal-ai/flux-2-pro": [
    { key: "ai_std_aspect_ratio" },
    { key: "ai_std_output_format" },
  ],
  "fal-ai/flux-2-max": [
    { key: "ai_std_aspect_ratio" },
    { key: "ai_std_output_format" },
  ],
  "fal-ai/flux-pulid": [
    { key: "ai_ref_pulid_id_scale" },
    { key: "ai_ref_pulid_guidance_scale" },
    { key: "ai_ref_pulid_num_inference_steps" },
    { key: "ai_ref_pulid_true_cfg_scale" },
    { key: "ai_ref_pulid_start_step" },
    { key: "ai_pulid_composition_suffix" },
  ],
  "fal-ai/ip-adapter-face-id-plus": [
    { key: "ai_std_num_inference_steps" },
    { key: "ai_std_guidance_scale" },
    { key: "ai_std_output_format" },
    { key: "ai_std_seed" },
  ],
};

// Keys managed by the AI Image Generation panel — excluded from the generic row list
const MODEL_CONFIG_KEYS = new Set([
  "ai_image_model_standard", "ai_image_model_reference", "ai_image_size",
  "ai_std_num_inference_steps", "ai_std_guidance_scale", "ai_std_safety_tolerance",
  "ai_std_seed", "ai_std_output_format", "ai_std_aspect_ratio", "ai_std_ultra_raw",
  "ai_ref_pulid_id_scale", "ai_ref_pulid_guidance_scale", "ai_ref_pulid_num_inference_steps",
  "ai_ref_pulid_true_cfg_scale", "ai_ref_pulid_start_step", "ai_pulid_composition_suffix",
  "ai_pulid_id_scale_pct",
]);

function SaveButton({
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

export default function AdminConfig() {
  const [rows, setRows] = useState<ConfigRow[]>([]);
  const [loading, setLoading] = useState(true);

  // Standard value edit state
  const [stdEdits, setStdEdits] = useState<Record<string, FieldState>>({});
  // Debug value edit state (string | null — null means "no debug override")
  const [dbgEdits, setDbgEdits] = useState<Record<string, FieldState>>({});

  // Debug mode global state
  const [debugActive, setDebugActive] = useState(false);
  const [debugToggling, setDebugToggling] = useState(false);

  // Image style suffix picker
  const [selectedStyleId, setSelectedStyleId] = useState<string>(STYLE_OPTIONS[0]?.id ?? "");

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

  // Toggle debug mode globally
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

  // Save standard value
  async function saveStd(key: string) {
    const edit = stdEdits[key];
    if (!edit) return;
    const row = rows.find((r) => r.key === key);
    if (!row || edit.value === row.value) return;

    setStdEdits((p) => ({ ...p, [key]: { ...p[key]!, saving: true, error: null, saved: false } }));
    try {
      const isSelect = !!SELECT_CONFIGS[key];
      const res = await fetch(`/api/admin/config/${key}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          value: edit.value,
          ...(isSelect ? { valueLabel: edit.label } : {}),
        }),
      });
      const data = (await res.json()) as { error?: string; value?: string; valueLabel?: string | null; debugValue?: string | null };
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
  }

  // Save debug value
  async function saveDbg(key: string) {
    const edit = dbgEdits[key];
    if (!edit) return;
    const row = rows.find((r) => r.key === key);
    if (!row) return;
    const currentDbg = row.debugValue ?? "";
    if (edit.value === currentDbg) return;

    setDbgEdits((p) => ({ ...p, [key]: { ...p[key]!, saving: true, error: null, saved: false } }));
    try {
      const isSelect = !!SELECT_CONFIGS[key];
      const res = await fetch(`/api/admin/config/${key}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          debugValue: edit.value || null,
          ...(isSelect ? { debugValueLabel: edit.label || null } : {}),
        }),
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
  }

  function stdDirty(key: string) {
    const row = rows.find((r) => r.key === key);
    return row ? stdEdits[key]?.value !== row.value : false;
  }
  function dbgDirty(key: string) {
    const row = rows.find((r) => r.key === key);
    return row ? (dbgEdits[key]?.value ?? "") !== (row.debugValue ?? "") : false;
  }

  // Split style_suffix rows from generic rows, exclude debug_mode_active and model config keys
  const genericRows = rows.filter((r) =>
    !r.key.startsWith("style_suffix_") &&
    r.key !== "debug_mode_active" &&
    !MODEL_CONFIG_KEYS.has(r.key)
  );
  const standardKey = `style_suffix_${selectedStyleId}`;
  const referenceKey = `style_suffix_ref_${selectedStyleId}`;
  const selectedStyleDef = STYLE_OPTIONS.find((s) => s.id === selectedStyleId);

  function ConfigInput({
    configKey, kind, rows: textRows,
  }: { configKey: string; kind: "std" | "dbg"; rows?: number }) {
    const row = rows.find((r) => r.key === configKey);
    if (!row) return null;
    const state = kind === "std" ? stdEdits[configKey] : dbgEdits[configKey];
    if (!state) return null;
    const isLong = row.dataType === "text";
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
    const onSave = () => kind === "std" ? void saveStd(configKey) : void saveDbg(configKey);

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
              type={row.dataType === "integer" ? "number" : "text"}
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

  function SuffixPair({ stdKey, dbgKey }: { stdKey: string; dbgKey?: string }) {
    const activeKey = dbgKey ? (debugActive ? dbgKey : stdKey) : stdKey;
    return (
      <div className="grid grid-cols-2 gap-3">
        {/* Standard */}
        <div className={`space-y-2 rounded-lg border p-3 ${!debugActive ? "border-primary/40 bg-primary/5" : "border-border"}`}>
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Standard</span>
            {!debugActive && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-primary/15 text-primary font-medium">Active</span>}
          </div>
          <ConfigInput configKey={stdKey} kind="std" />
        </div>
        {/* Debug */}
        {dbgKey && (
          <div className={`space-y-2 rounded-lg border p-3 ${debugActive ? "border-amber-500/50 bg-amber-500/5" : "border-border"}`}>
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Debug</span>
              {debugActive && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-400 font-medium">Active</span>}
            </div>
            <ConfigInput configKey={dbgKey} kind="dbg" />
          </div>
        )}
      </div>
    );
  }

  function ConfigCard({ row }: { row: ConfigRow }) {
    const stdState = stdEdits[row.key];
    const dbgState = dbgEdits[row.key];
    if (!stdState) return null;

    return (
      <div className="bg-card border border-border rounded-lg p-5 space-y-4">
        {/* Header */}
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

        {/* Dual value columns */}
        <div className="grid grid-cols-2 gap-3">
          {/* Standard */}
          <div className={`rounded-lg border p-3 space-y-2 ${!debugActive ? "border-primary/40 bg-primary/5" : "border-border"}`}>
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Standard</span>
              {!debugActive && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-primary/15 text-primary font-medium">Active</span>}
            </div>
            <ConfigInput configKey={row.key} kind="std" rows={4} />
          </div>

          {/* Debug */}
          <div className={`rounded-lg border p-3 space-y-2 ${debugActive ? "border-amber-500/50 bg-amber-500/5" : "border-border"}`}>
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1">
                <Bug className="w-3 h-3" /> Debug
              </span>
              {debugActive && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-400 font-medium">Active</span>}
            </div>
            {dbgState && (() => {
              const dbgSelectOptions = SELECT_CONFIGS[row.key];
              const dbgBorderClass = debugActive ? "border-amber-500/40" : "border-border";
              const onDbgChange = (val: string) => {
                const selectedLabel = dbgSelectOptions?.find((o) => o.value === val)?.label ?? val;
                setDbgEdits((p) => ({ ...p, [row.key]: { ...p[row.key]!, value: val, label: selectedLabel, error: null, saved: false } }));
              };

              if (dbgSelectOptions) {
                return (
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
                      <SaveButton dirty={dbgDirty(row.key)} saving={dbgState.saving} saved={dbgState.saved} onClick={() => void saveDbg(row.key)} />
                      {dbgState.error && <p className="text-destructive text-xs flex items-center gap-1"><AlertCircle className="w-3 h-3" />{dbgState.error}</p>}
                    </div>
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <span className="shrink-0">API value:</span>
                      <code className="bg-muted px-1.5 py-0.5 rounded text-xs font-mono text-foreground/80 select-all">{dbgState.value}</code>
                    </div>
                  </div>
                );
              }

              return (
                <div className={row.dataType === "text" ? "space-y-2" : "flex items-center gap-3"}>
                  {row.dataType === "text" ? (
                    <>
                      <textarea
                        rows={4}
                        value={dbgState.value}
                        onChange={(e) => onDbgChange(e.target.value)}
                        placeholder="Leave empty to use standard value"
                        className={`w-full bg-background border rounded px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-amber-500/50 resize-y placeholder:text-muted-foreground/40 ${dbgBorderClass}`}
                      />
                      <div className="flex items-center gap-3">
                        <SaveButton dirty={dbgDirty(row.key)} saving={dbgState.saving} saved={dbgState.saved} onClick={() => void saveDbg(row.key)} />
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
                    <>
                      <input
                        type={row.dataType === "integer" ? "number" : "text"}
                        min={row.minValue ?? undefined}
                        max={row.maxValue ?? undefined}
                        value={dbgState.value}
                        onChange={(e) => onDbgChange(e.target.value)}
                        placeholder="— standard"
                        onKeyDown={(e) => { if (e.key === "Enter" && dbgDirty(row.key)) void saveDbg(row.key); }}
                        className={`w-36 bg-background border rounded px-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-amber-500/50 placeholder:text-muted-foreground/40 ${dbgBorderClass}`}
                      />
                      {row.minValue !== null && row.maxValue !== null && (
                        <span className="text-xs text-muted-foreground">{row.minValue}–{row.maxValue}</span>
                      )}
                      <SaveButton dirty={dbgDirty(row.key)} saving={dbgState.saving} saved={dbgState.saved} onClick={() => void saveDbg(row.key)} />
                      {dbgState.error && <p className="text-destructive text-xs flex items-center gap-1"><AlertCircle className="w-3 h-3" />{dbgState.error}</p>}
                    </>
                  )}
                </div>
              );
            })()}
          </div>
        </div>
      </div>
    );
  }

  // ── Per-param row (label + std/debug columns) ──────────────────────────────
  function ModelParamRow({ paramKey }: { paramKey: string }) {
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

  // ── Model selector + contextual parameters ─────────────────────────────────
  function ModelConfigSection({ title, subtitle, modelKey }: {
    title: string; subtitle: string;
    modelKey: "ai_image_model_standard" | "ai_image_model_reference";
  }) {
    const selectedModel = stdEdits[modelKey]?.value ?? rows.find((r) => r.key === modelKey)?.value ?? "";
    const params = MODEL_PARAMS[selectedModel] ?? [];
    return (
      <div className="space-y-3">
        <div>
          <p className="text-sm font-semibold text-foreground">{title}</p>
          <p className="text-xs text-muted-foreground">{subtitle}</p>
        </div>
        <ModelParamRow paramKey={modelKey} />
        {params.length > 0 && (
          <div className="border-l-2 border-muted/60 pl-4 space-y-4">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              Parameters — <span className="font-mono normal-case">{selectedModel}</span>
            </p>
            {params.map((p) => <ModelParamRow key={p.key} paramKey={p.key} />)}
          </div>
        )}
      </div>
    );
  }

  return (
    <AdminLayout title="Configuration">
      <div className="max-w-5xl space-y-4">

        {/* ── Debug Mode Toggle ───────────────────────────────────────────── */}
        <div className={`rounded-xl border-2 p-5 transition-colors ${debugActive ? "border-amber-500/60 bg-amber-500/5" : "border-border bg-card"}`}>
          <div className="flex items-center justify-between gap-6">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <Bug className={`w-5 h-5 ${debugActive ? "text-amber-400" : "text-muted-foreground"}`} />
                <h2 className={`font-semibold text-lg ${debugActive ? "text-amber-400" : "text-foreground"}`}>
                  Debug Mode {debugActive ? "ON" : "OFF"}
                </h2>
              </div>
              <p className="text-sm text-muted-foreground mt-1">
                {debugActive
                  ? "All configs are using their Debug values (where set). The system is in debug mode — not suitable for regular users."
                  : "All configs are using their Standard values. Enable debug mode to switch the entire system to the Debug set of values."}
              </p>
            </div>
            <button
              onClick={() => void toggleDebugMode()}
              disabled={debugToggling}
              className={`shrink-0 px-6 py-2.5 rounded-lg font-semibold text-sm transition-colors flex items-center gap-2 ${
                debugActive
                  ? "bg-amber-500 hover:bg-amber-400 text-black"
                  : "bg-muted hover:bg-muted/80 text-foreground border border-border"
              } disabled:opacity-50 disabled:cursor-not-allowed`}
            >
              {debugToggling && <Loader2 className="w-4 h-4 animate-spin" />}
              {debugActive ? "Switch to Standard" : "Switch to Debug"}
            </button>
          </div>
        </div>

        {debugActive && (
          <div className="flex items-center gap-2 text-amber-400 text-sm font-medium">
            <Bug className="w-4 h-4" />
            <span>Debug mode is active — the system is using Debug values for all configured keys.</span>
          </div>
        )}

        <div className="flex items-center gap-2 text-muted-foreground text-sm">
          <Settings className="w-4 h-4" />
          <span>Changes take effect within 60 seconds — no restart required.</span>
        </div>

        {loading ? (
          <div className="flex items-center gap-2 text-muted-foreground py-8">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span>Loading configuration…</span>
          </div>
        ) : (
          <div className="space-y-3">

            {/* ── Image Style Suffixes ──────────────────────────────────────── */}
            <div className="bg-card border border-border rounded-lg p-5 space-y-4">
              <div className="flex items-center gap-2">
                <Palette className="w-4 h-4 text-muted-foreground" />
                <h3 className="font-semibold text-foreground">Image Style Suffixes</h3>
              </div>
              <p className="text-sm text-muted-foreground -mt-2">
                Text appended to the scene prompt when a style is selected. Each style has a Standard and a Debug value pair.
              </p>

              <div>
                <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide block mb-1.5">Style</label>
                <select
                  value={selectedStyleId}
                  onChange={(e) => setSelectedStyleId(e.target.value)}
                  className="w-full bg-background border border-border rounded px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                >
                  {STYLE_OPTIONS.map((s) => (
                    <option key={s.id} value={s.id}>{s.label}</option>
                  ))}
                </select>
              </div>

              {selectedStyleDef && (
                <div className="space-y-4">
                  {/* Standard Suffix */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Standard suffix</label>
                      <code className="text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded">{standardKey}</code>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className={`rounded-lg border p-3 space-y-2 ${!debugActive ? "border-primary/40 bg-primary/5" : "border-border"}`}>
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Standard</span>
                          {!debugActive && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-primary/15 text-primary font-medium">Active</span>}
                        </div>
                        <ConfigInput configKey={standardKey} kind="std" rows={3} />
                      </div>
                      <div className={`rounded-lg border p-3 space-y-2 ${debugActive ? "border-amber-500/50 bg-amber-500/5" : "border-border"}`}>
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1"><Bug className="w-3 h-3" /> Debug</span>
                          {debugActive && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-400 font-medium">Active</span>}
                        </div>
                        <ConfigInput configKey={standardKey} kind="dbg" rows={3} />
                      </div>
                    </div>
                  </div>

                  {/* Reference Suffix */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Reference photo suffix</label>
                      <code className="text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded">{referenceKey}</code>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className={`rounded-lg border p-3 space-y-2 ${!debugActive ? "border-primary/40 bg-primary/5" : "border-border"}`}>
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Standard</span>
                          {!debugActive && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-primary/15 text-primary font-medium">Active</span>}
                        </div>
                        <ConfigInput configKey={referenceKey} kind="std" rows={3} />
                      </div>
                      <div className={`rounded-lg border p-3 space-y-2 ${debugActive ? "border-amber-500/50 bg-amber-500/5" : "border-border"}`}>
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1"><Bug className="w-3 h-3" /> Debug</span>
                          {debugActive && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-400 font-medium">Active</span>}
                        </div>
                        <ConfigInput configKey={referenceKey} kind="dbg" rows={3} />
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* ── AI Image Generation ──────────────────────────────────────── */}
            <div className="bg-card border border-border rounded-lg p-5 space-y-5">
              <div className="flex items-center gap-2">
                <Bot className="w-4 h-4 text-muted-foreground" />
                <h3 className="font-semibold text-foreground">AI Image Generation</h3>
              </div>
              <p className="text-sm text-muted-foreground -mt-2">
                fal.ai model selection and per-model tuning parameters. Select a model from the dropdown to reveal its configurable parameters below.
              </p>

              {/* Shared: image size */}
              <div className="space-y-3">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Shared Settings</p>
                <ModelParamRow paramKey="ai_image_size" />
              </div>

              <div className="border-t border-border" />

              <ModelConfigSection
                title="Standard Model"
                subtitle="Text-to-image generation without a reference photo"
                modelKey="ai_image_model_standard"
              />

              <div className="border-t border-border" />

              <ModelConfigSection
                title="Reference Photo Model"
                subtitle="Face-preserving generation from an uploaded reference photo"
                modelKey="ai_image_model_reference"
              />
            </div>

            {/* ── Generic config rows ───────────────────────────────────────── */}
            {genericRows.map((row) => <ConfigCard key={row.key} row={row} />)}
          </div>
        )}
      </div>
    </AdminLayout>
  );
}

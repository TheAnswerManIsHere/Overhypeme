import { useEffect, useRef, useState, useCallback, createContext, useContext } from "react";
import {
  Clock, Check, AlertCircle, Loader2, Bug, X, RotateCcw,
} from "lucide-react";
import { IMAGE_STYLES } from "@/config/imageStyles";

// ── Delay-ms unit helpers ──────────────────────────────────────────────────────

type DelayUnit = "ms" | "s" | "min" | "hr";

const UNIT_OPTIONS: { value: DelayUnit; label: string; factor: number }[] = [
  { value: "ms",  label: "ms",      factor: 1 },
  { value: "s",   label: "sec",     factor: 1_000 },
  { value: "min", label: "min",     factor: 60_000 },
  { value: "hr",  label: "hr",      factor: 3_600_000 },
];

function bestUnit(ms: number): DelayUnit {
  if (!isFinite(ms) || ms < 1000) return "ms";
  if (ms < 60_000) return "s";
  if (ms < 3_600_000) return "min";
  return "hr";
}

function msToFriendly(ms: number, unit: DelayUnit): string {
  const factor = UNIT_OPTIONS.find((u) => u.value === unit)!.factor;
  const v = ms / factor;
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 1000) / 1000);
}

export function DelayMsInput({
  msValue,
  onChange,
  placeholder,
  borderClass,
  focusRingClass,
  minMs,
  maxMs,
}: {
  msValue: string;
  onChange: (msString: string) => void;
  placeholder?: string;
  borderClass?: string;
  focusRingClass?: string;
  minMs?: number | null;
  maxMs?: number | null;
}) {
  const parsedMs = msValue !== "" ? Number(msValue) : NaN;
  const initialUnit = isFinite(parsedMs) ? bestUnit(parsedMs) : "min";

  const [unit, setUnit] = useState<DelayUnit>(initialUnit);
  const [friendlyValue, setFriendlyValue] = useState<string>(
    isFinite(parsedMs) ? msToFriendly(parsedMs, initialUnit) : ""
  );

  // Track the last ms value we emitted ourselves so the effect below can
  // distinguish between an external reset (e.g. after a successful save that
  // round-trips through the API) and a local edit we triggered.
  const internalMsRef = useRef<string>(msValue);

  useEffect(() => {
    if (msValue === internalMsRef.current) return;
    internalMsRef.current = msValue;
    const ms = msValue !== "" ? Number(msValue) : NaN;
    if (!isFinite(ms)) {
      setFriendlyValue("");
      return;
    }
    const newUnit = bestUnit(ms);
    setUnit(newUnit);
    setFriendlyValue(msToFriendly(ms, newUnit));
  }, [msValue]);

  const handleValueChange = (raw: string) => {
    setFriendlyValue(raw);
    const num = parseFloat(raw);
    if (raw === "" || !isFinite(num)) {
      internalMsRef.current = "";
      onChange("");
      return;
    }
    const factor = UNIT_OPTIONS.find((u2) => u2.value === unit)!.factor;
    const ms = String(Math.round(num * factor));
    internalMsRef.current = ms;
    onChange(ms);
  };

  const handleUnitChange = (newUnit: DelayUnit) => {
    setUnit(newUnit);
    const ms = msValue !== "" ? Number(msValue) : NaN;
    if (isFinite(ms)) {
      setFriendlyValue(msToFriendly(ms, newUnit));
    }
  };

  const rawMs = msValue !== "" && isFinite(Number(msValue)) ? Number(msValue) : null;
  const border = borderClass ?? "border-border";
  const focusRing = focusRingClass ?? "focus:ring-primary";
  const outOfRange = rawMs !== null && (
    (minMs != null && rawMs < minMs) || (maxMs != null && rawMs > maxMs)
  );

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5">
        <input
          type="number"
          min={0}
          step="any"
          value={friendlyValue}
          onChange={(e) => handleValueChange(e.target.value)}
          placeholder={placeholder}
          className={`w-28 bg-background border rounded px-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 ${focusRing} ${border} placeholder:text-muted-foreground/40`}
        />
        <select
          value={unit}
          onChange={(e) => handleUnitChange(e.target.value as DelayUnit)}
          className={`bg-background border rounded px-2 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 ${focusRing} ${border}`}
        >
          {UNIT_OPTIONS.map((u) => (
            <option key={u.value} value={u.value}>{u.label}</option>
          ))}
        </select>
      </div>
      {rawMs !== null && (
        <p className="text-xs text-muted-foreground">
          Raw ms: <code className="bg-muted px-1 py-0.5 rounded font-mono">{rawMs.toLocaleString()}</code>
          {minMs != null && maxMs != null && (
            <span className="ml-1.5">({minMs.toLocaleString()}–{maxMs.toLocaleString()} ms allowed)</span>
          )}
        </p>
      )}
      {outOfRange && (
        <p className="text-xs text-destructive flex items-center gap-1">
          <AlertCircle className="w-3 h-3" />
          Value is outside the allowed range
        </p>
      )}
    </div>
  );
}

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

// Phase 6: the FAL_IMAGE_*, FAL_SAFETY_TOLERANCE, FAL_OUTPUT_FORMAT,
// FAL_ASPECT_RATIO, FAL_RAW_MODE, OPENAI_CHAT_MODELS, FAL_VIDEO_*
// dropdown option lists were retired alongside their backing admin_config
// keys. The wizard video flow now reads engine metadata from the engines
// table (see lib/engines/* + /admin/engines), and the AI meme pipeline
// uses baked-in defaults.

export const FLOAT_TEXT_CONFIGS = new Set<string>([]);

export const RETRY_DELAY_MS_KEYS = [
  "email_retry_delay_1_ms",
  "email_retry_delay_2_ms",
  "email_retry_delay_3_ms",
  "email_retry_delay_4_ms",
] as const;

export const DELAY_MS_KEYS: Set<string> = new Set(RETRY_DELAY_MS_KEYS);

export function msToHuman(ms: number): string {
  if (!isFinite(ms) || ms < 0) return "";
  if (ms === 0) return "0 ms";
  if (ms < 1000) return `${ms} ms`;
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) return `≈ ${Math.round(totalSeconds)} second${Math.round(totalSeconds) === 1 ? "" : "s"}`;
  const totalMinutes = totalSeconds / 60;
  if (totalMinutes < 60) {
    const rounded = Math.round(totalMinutes * 10) / 10;
    return `≈ ${rounded} minute${rounded === 1 ? "" : "s"}`;
  }
  const totalHours = totalMinutes / 60;
  const rounded = Math.round(totalHours * 10) / 10;
  return `≈ ${rounded} hour${rounded === 1 ? "" : "s"}`;
}

// OpenAI chat models offered for the image scene + video motion prompts.
// Both families are supported: the GPT-4o / 4.1 chat models (max_tokens +
// temperature) and the GPT-5 reasoning models (max_completion_tokens +
// reasoning_effort, no temperature). The server picks the right call shape per
// model via chatModelTuningParams (lib/openaiChatParams.ts), so any value here
// works. GPT-5 models also honor the "Reasoning Effort" lever below.
export const OPENAI_CHAT_MODEL_OPTIONS: { value: string; label: string }[] = [
  { value: "gpt-4o-mini",  label: "GPT-4o mini (fast, cheap — default)" },
  { value: "gpt-4o",       label: "GPT-4o" },
  { value: "gpt-4.1-nano", label: "GPT-4.1 nano (fastest, cheapest)" },
  { value: "gpt-4.1-mini", label: "GPT-4.1 mini" },
  { value: "gpt-4.1",      label: "GPT-4.1" },
  { value: "gpt-5.1",      label: "GPT-5.1 (reasoning — value)" },
  { value: "gpt-5.2",      label: "GPT-5.2 (reasoning)" },
  { value: "gpt-5.4-mini", label: "GPT-5.4 mini (reasoning — cheap)" },
  { value: "gpt-5.5",      label: "GPT-5.5 (reasoning — frontier)" },
];

// Reasoning effort for GPT-5 / o-series models. Ignored by GPT-4.x models.
export const REASONING_EFFORT_OPTIONS: { value: string; label: string }[] = [
  { value: "none",   label: "None (fastest, cheapest)" },
  { value: "low",    label: "Low (default)" },
  { value: "medium", label: "Medium" },
  { value: "high",   label: "High" },
  { value: "xhigh",  label: "Extra high (most capable, priciest)" },
];

// Model + sampling + reasoning effort for all LLM calls now live on the shared
// General Intelligence engine (/admin/engines), so no scene/video config key is
// a dropdown anymore. OPENAI_CHAT_MODEL_OPTIONS / REASONING_EFFORT_OPTIONS are
// still exported for the engine editor on the engines page.
export const SELECT_CONFIGS: Record<string, { value: string; label: string }[]> = {};

// Image scene-prompt system prompt (model/sampling live on the engine now).
export const SCENE_PROMPT_KEYS = new Set<string>([
  "scene_prompt_system",
]);

// Video motion-prompt system prompt (model/sampling live on the engine now).
export const VIDEO_DIRECTION_KEYS = new Set<string>([
  "video_direction_system",
]);

// Keys that are surfaced through dedicated sections elsewhere on the
// admin config page (so they don't appear in the catch-all generic list).
// Phase 6: previously included the now-retired ai_*/video_* per-model
// tuning keys; today this is just `ai_gallery_display_limit`, which is
// rendered in the AI Settings group below.
export const MODEL_CONFIG_KEYS = new Set<string>([
  "ai_gallery_display_limit",
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
  /** Refetch all config rows (used after out-of-band writes like prompt reset). */
  load: () => void;
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
  const isDelayMs = DELAY_MS_KEYS.has(configKey);
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
          {isDelayMs ? (
            <DelayMsInput
              msValue={state.value}
              onChange={(ms) => onChange(ms)}
              placeholder={placeholder}
              borderClass={borderClass}
              focusRingClass={isDbgActive ? "focus:ring-amber-500/50" : "focus:ring-primary"}
              minMs={row.minValue}
              maxMs={row.maxValue}
            />
          ) : (
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
          )}
          {!isDelayMs && row.minValue !== null && row.maxValue !== null && (
            <span className="text-xs text-muted-foreground">{row.minValue}–{row.maxValue}</span>
          )}
          <SaveButton dirty={dirty} saving={state.saving} saved={state.saved} onClick={onSave} />
          {state.error && <p className="text-destructive text-xs flex items-center gap-1"><AlertCircle className="w-3 h-3" />{state.error}</p>}
        </>
      )}
    </div>
  );
}

const FACT_ENRICHMENT_SYSTEM_KEY = "fact_enrichment_system";

/**
 * Destructive admin action: replace the stored fact-enrichment system prompt
 * with the current code default and clear the debug override. Confirms first,
 * showing current effective source + hash vs the code-default hash so the
 * admin sees exactly what is being replaced (the whole point: DB-backed config
 * can silently diverge from the code default).
 */
function ResetEnrichmentPromptButton() {
  const { load } = useConfigCtx();
  const [busy, setBusy] = useState(false);

  async function onReset() {
    setBusy(true);
    try {
      let detail = "";
      try {
        const provRes = await fetch(
          `/api/admin/config/${FACT_ENRICHMENT_SYSTEM_KEY}/provenance`,
          { credentials: "include" },
        );
        if (provRes.ok) {
          const p = (await provRes.json()) as {
            source: string; hash: string; codeDefaultHash: string; matchesCodeDefault: boolean;
          };
          detail =
            `\n\nCurrent effective prompt source: ${p.source}` +
            `\nCurrent hash: ${p.hash}` +
            `\nCode default hash: ${p.codeDefaultHash}` +
            `\n${p.matchesCodeDefault ? "(already matches code default)" : "(differs from code default)"}`;
        }
      } catch { /* best-effort; confirm still proceeds */ }

      const ok = window.confirm(
        "This will replace the stored fact-enrichment system prompt with the current code default and clear the debug override. Continue?" +
          detail,
      );
      if (!ok) return;

      const res = await fetch(
        `/api/admin/config/${FACT_ENRICHMENT_SYSTEM_KEY}/reset-to-default`,
        { method: "POST", credentials: "include" },
      );
      const data = (await res.json()) as { ok?: boolean; hash?: string; error?: string };
      if (res.ok && data.ok) {
        load();
        window.alert(`Fact enrichment prompt reset to code default. New hash: ${data.hash ?? "(unknown)"}.`);
      } else {
        window.alert(`Reset failed: ${data.error ?? "unknown error"}`);
      }
    } catch {
      window.alert("Reset failed: network error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      onClick={onReset}
      disabled={busy}
      data-testid="reset-enrichment-prompt"
      className="text-xs px-2 py-1 rounded border border-border text-muted-foreground hover:text-foreground hover:border-foreground/30 flex items-center gap-1 disabled:opacity-50 shrink-0"
      title="Replace the stored prompt with the current code default and clear the debug override"
    >
      {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCcw className="w-3 h-3" />}
      Reset to code default
    </button>
  );
}

export function ConfigCard({ row, textareaRows = 4 }: { row: ConfigRow; textareaRows?: number }) {
  const { stdEdits, dbgEdits, debugActive, setDbgEdits, saveDbg, dbgDirty } = useConfigCtx();
  const stdState = stdEdits[row.key];
  const dbgState = dbgEdits[row.key];
  if (!stdState) return null;

  const dbgSelectOptions = SELECT_CONFIGS[row.key];
  const dbgBorderClass = debugActive ? "border-amber-500/40" : "border-border";
  const isDelayMs = DELAY_MS_KEYS.has(row.key);

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
        <div className="flex items-center gap-2 shrink-0">
          {row.key === FACT_ENRICHMENT_SYSTEM_KEY && <ResetEnrichmentPromptButton />}
          <code className="text-xs text-muted-foreground bg-muted px-2 py-1 rounded">{row.key}</code>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className={`rounded-lg border p-3 space-y-2 ${!debugActive ? "border-primary/40 bg-primary/5" : "border-border"}`}>
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Standard</span>
            {!debugActive && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-primary/15 text-primary font-medium">Active</span>}
          </div>
          <ConfigInput configKey={row.key} kind="std" rows={textareaRows} />
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
                    <option value="">— Same as standard (no override) —</option>
                    {dbgSelectOptions.map((opt) => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                  <SaveButton dirty={dbgDirty(row.key)} saving={dbgState.saving} saved={dbgState.saved} onClick={() => saveDbg(row.key)} />
                  {dbgState.error && <p className="text-destructive text-xs flex items-center gap-1"><AlertCircle className="w-3 h-3" />{dbgState.error}</p>}
                </div>
                {dbgState.value !== "" && (
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <span className="shrink-0">API value:</span>
                    <code className="bg-muted px-1.5 py-0.5 rounded text-xs font-mono text-foreground/80 select-all">{dbgState.value}</code>
                  </div>
                )}
              </div>
            ) : row.dataType === "text" ? (
              <>
                <textarea
                  rows={textareaRows}
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
            ) : isDelayMs ? (
              <div className="space-y-2">
                <DelayMsInput
                  msValue={dbgState.value}
                  onChange={onDbgChange}
                  placeholder="— standard"
                  borderClass={dbgBorderClass}
                  focusRingClass="focus:ring-amber-500/50"
                  minMs={row.minValue}
                  maxMs={row.maxValue}
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
              </div>
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
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
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

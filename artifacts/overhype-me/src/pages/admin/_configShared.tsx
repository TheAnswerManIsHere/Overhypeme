import { useEffect, useRef, useState, useCallback, createContext, useContext } from "react";
import {
  Clock, Check, AlertCircle, Loader2, RotateCcw,
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
// keys. Engine metadata lives in the engines table (see lib/engines/* +
// /admin/engines), and the AI meme pipeline uses baked-in defaults.

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

// OpenAI chat models offered for the image scene prompts.
// Both families are supported: the legacy GPT-4o / 4.1 chat models (max_tokens +
// temperature) and the GPT-5 reasoning models (max_completion_tokens +
// reasoning_effort, no temperature), including GPT-6. The server picks the right call shape per
// model via chatModelTuningParams (lib/openaiChatParams.ts), so any value here
// works. GPT-5 models also honor the "Reasoning Effort" lever below.
export const OPENAI_CHAT_MODEL_OPTIONS: { value: string; label: string }[] = [
  { value: "gpt-6-luna",   label: "GPT-6 Luna (fast, cheap — default; temperature applies at effort None)" },
  { value: "gpt-4o-mini",  label: "GPT-4o mini (legacy)" },
  { value: "gpt-4o",       label: "GPT-4o" },
  { value: "gpt-4.1-nano", label: "GPT-4.1 nano (fastest, cheapest)" },
  { value: "gpt-4.1-mini", label: "GPT-4.1 mini" },
  { value: "gpt-4.1",      label: "GPT-4.1" },
  { value: "gpt-5.1",      label: "GPT-5.1 (reasoning — value)" },
  { value: "gpt-5.2",      label: "GPT-5.2 (reasoning)" },
  { value: "gpt-5.4-mini", label: "GPT-5.4 mini (reasoning — cheap)" },
  { value: "gpt-5.5",      label: "GPT-5.5 (reasoning — frontier)" },
];

// Reasoning effort for GPT-5 / GPT-6 / o-series models. Ignored by GPT-4.x models.
// For GPT-6 models, "None" also restores the temperature lever.
export const REASONING_EFFORT_OPTIONS: { value: string; label: string }[] = [
  { value: "none",   label: "None (fastest, cheapest; GPT-6 honors temperature)" },
  { value: "low",    label: "Low (default)" },
  { value: "medium", label: "Medium" },
  { value: "high",   label: "High" },
  { value: "xhigh",  label: "Extra high (most capable, priciest)" },
];

// Model + sampling + reasoning effort for all LLM calls now live on the shared
// General Intelligence engine (/admin/engines), so no scene-prompt config key is
// a dropdown anymore. OPENAI_CHAT_MODEL_OPTIONS / REASONING_EFFORT_OPTIONS are
// still exported for the engine editor on the engines page.
export const SELECT_CONFIGS: Record<string, { value: string; label: string }[]> = {};

// Image scene-prompt system prompt (model/sampling live on the engine now).
export const SCENE_PROMPT_KEYS = new Set<string>([
  "scene_prompt_system",
]);

// ── Shared context ────────────────────────────────────────────────────────────

export interface ConfigPageCtx {
  rows: ConfigRow[];
  stdEdits: Record<string, FieldState>;
  setStdEdits: React.Dispatch<React.SetStateAction<Record<string, FieldState>>>;
  saveStd: (key: string) => void;
  stdDirty: (key: string) => boolean;
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

  const load = useCallback(() => {
    setLoading(true);
    fetch("/api/admin/config", { credentials: "include" })
      .then((r) => r.json())
      .then((data: unknown) => {
        if (!Array.isArray(data)) return;
        const fetched = data as ConfigRow[];
        setRows(fetched);
        const std: Record<string, FieldState> = {};
        for (const row of fetched) {
          const selectOpts = SELECT_CONFIGS[row.key];
          const stdLabel = row.valueLabel ?? (selectOpts?.find((o) => o.value === row.value)?.label ?? row.value);
          std[row.key] = { value: row.value, label: stdLabel, saving: false, error: null, saved: false };
        }
        setStdEdits(std);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

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

  const stdDirty = useCallback((key: string) => {
    const row = rows.find((r) => r.key === key);
    return row ? stdEdits[key]?.value !== row.value : false;
  }, [rows, stdEdits]);

  return {
    rows, setRows, loading,
    stdEdits, setStdEdits,
    saveStd, stdDirty, load,
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
  configKey, rows: textRows,
}: { configKey: string; rows?: number }) {
  const { rows, stdEdits, setStdEdits, saveStd, stdDirty } = useConfigCtx();
  const row = rows.find((r) => r.key === configKey);
  if (!row) return null;
  const state = stdEdits[configKey];
  if (!state) return null;
  const isLong = row.dataType === "text" && !FLOAT_TEXT_CONFIGS.has(configKey);
  const dirty = stdDirty(configKey);
  const isDelayMs = DELAY_MS_KEYS.has(configKey);
  const borderClass = "border-border";

  const onChange = (val: string) => {
    const opts = SELECT_CONFIGS[configKey];
    const selectedLabel = opts?.find((o) => o.value === val)?.label ?? val;
    setStdEdits((p) => ({ ...p, [configKey]: { ...p[configKey]!, value: val, label: selectedLabel, error: null, saved: false } }));
  };
  const onSave = () => saveStd(configKey);
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
              borderClass={borderClass}
              focusRingClass="focus:ring-primary"
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
 * with the current code default. Confirms first,
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
        "This will replace the stored fact-enrichment system prompt with the current code default. Continue?" +
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
      title="Replace the stored prompt with the current code default"
    >
      {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCcw className="w-3 h-3" />}
      Reset to code default
    </button>
  );
}

export function ConfigCard({ row, textareaRows = 4 }: { row: ConfigRow; textareaRows?: number }) {
  const { stdEdits } = useConfigCtx();
  if (!stdEdits[row.key]) return null;

  return (
    <div className="bg-card border border-border rounded-lg p-5 space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="font-semibold text-foreground">{row.label}</h3>
            {row.isPublic && (
              <span className="text-xs px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400 border border-blue-500/20">public</span>
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

      <ConfigInput configKey={row.key} rows={textareaRows} />
    </div>
  );
}

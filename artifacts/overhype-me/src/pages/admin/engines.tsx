import { useEffect, useMemo, useState } from "react";
import { AdminLayout } from "@/components/admin/AdminLayout";
import {
  Boxes,
  Star,
  Eye,
  EyeOff,
  Trash2,
  Undo2,
  Save,
  ChevronDown,
  ChevronUp,
  Beaker,
  Loader2,
} from "lucide-react";

interface EngineRow {
  id: string;
  provider: string;
  endpointId: string;
  label: string;
  description: string;
  kind: "image" | "video" | "utility" | string;
  tierRequirement: string;
  isDefault: boolean;
  isActive: boolean;
  sortOrder: number;
  allowedDurationsSec: number[] | null;
  defaultDurationSec: number | null;
  allowedResolutions: string[] | null;
  defaultResolution: string | null;
  allowedAspectRatios: string[] | null;
  defaultAspectRatio: string | null;
  supportedModes: string[] | null;
  defaultMode: string | null;
  audioHandling: string;
  paramSchema: unknown;
  estimatedCostUsdPerCall: string | number | null;
  estimatedCostUsdPerSecond: string | number | null;
  expectedRunMs: number;
  featureFlagRequired: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

interface ListResponse {
  engines: EngineRow[];
  editableFields: string[];
}

// Fields the backend's PATCH endpoint accepts. Kept in sync with
// ADMIN_EDITABLE_FIELDS in artifacts/api-server/src/routes/adminEngines.ts.
const EDITABLE_FIELDS = [
  "isActive",
  "isDefault",
  "sortOrder",
  "tierRequirement",
  "featureFlagRequired",
  "defaultDurationSec",
  "defaultResolution",
  "defaultAspectRatio",
  "defaultMode",
  "expectedRunMs",
  "estimatedCostUsdPerCall",
  "estimatedCostUsdPerSecond",
] as const;

const KIND_LABELS: Record<string, string> = {
  video: "Video engines",
  image: "Image engines",
  utility: "Utility engines",
};

function msToHuman(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s - m * 60);
  return `${m}m ${rem}s`;
}

function fmtCost(v: string | number | null): string {
  if (v === null || v === undefined) return "—";
  const n = typeof v === "string" ? Number(v) : v;
  if (!Number.isFinite(n)) return String(v);
  return `$${n.toFixed(4)}`;
}

function safeJson(v: unknown): string {
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}

function ReadOnlyField({ label, value }: { label: string; value: string | number | null }) {
  return (
    <div>
      <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">{label}</p>
      <p className="text-xs font-mono text-foreground break-all">{value === null || value === "" ? "—" : String(value)}</p>
    </div>
  );
}

// ─── Test workbench ──────────────────────────────────────────────────────────
//
// Built as a tuning sandbox, not just a "did fal accept this" smoke check.
// Admins can edit every meaningful param (prompt, dialogue, duration, aspect,
// resolution, mode, engine-specific knobs) and re-run until the output matches
// the desired behavior. Once the right settings are found, they can be locked
// into the engine's row defaults via the EngineEditor below.

// Default prompts used when no override is supplied. Kept in sync with the
// server's TEST_MOTION_PROMPT / TEST_DIALOGUE_TEXT — these are the fallbacks
// the admin starts from when opening the panel for a fresh engine.
const DEFAULT_TEST_MOTION_PROMPT =
  "Subject slowly turns their head 45 degrees to the left over 2 seconds, " +
  "then returns to center while making eye contact with the camera. " +
  "Slow dolly push-in throughout. Soft window light from the left.";

const DEFAULT_TEST_DIALOGUE_FULL =
  "This is a synthetic engine test. The quick brown fox jumps over the lazy dog.";

// Short dialogue used by Experiment B (padding detector). About half the
// length of the full phrase so audio engines that invent extra dialogue
// to fill clip silence (Grok quirk) reveal themselves.
const DEFAULT_TEST_DIALOGUE_SHORT = "This is a synthetic engine test.";

// Universal pipeline keys handled by named form fields below. Anything in the
// engine's paramSchema with a `from` key NOT in this set gets surfaced as an
// engine-specific input.
const UNIVERSAL_FROM_KEYS = new Set([
  "imageUrl",
  "referenceImageUrl",
  "videoUrl",
  "motionPrompt",
  "imagePrompt",
  "durationSec",
  "aspectRatio",
  "resolution",
  "mode",
  "generateAudio",
  "endUserId",
  "dialogueText",
]);

interface ParamSchemaEntryLike {
  name?: string;
  from?: string;
  type?: string;
  default?: unknown;
  enum?: unknown[];
  range?: { min?: number; max?: number };
}

type ExperimentMode = "A" | "B" | "C" | "custom";

function EngineTestPanel({ engine }: { engine: EngineRow }) {
  // ── Form state ────────────────────────────────────────────────────────────
  const [experiment, setExperiment] = useState<ExperimentMode>("A");
  const [sampleUrl, setSampleUrl] = useState("");
  const [motionPrompt, setMotionPrompt] = useState(DEFAULT_TEST_MOTION_PROMPT);
  const [dialogueEnabled, setDialogueEnabled] = useState(engine.audioHandling !== "none");
  const [dialogueText, setDialogueText] = useState(DEFAULT_TEST_DIALOGUE_FULL);
  const [durationSec, setDurationSec] = useState<string>(
    engine.defaultDurationSec !== null ? String(engine.defaultDurationSec) : "",
  );
  const [aspectRatio, setAspectRatio] = useState<string>(engine.defaultAspectRatio ?? "");
  const [resolution, setResolution] = useState<string>(engine.defaultResolution ?? "");
  const [mode, setMode] = useState<string>(engine.defaultMode ?? "");
  const [generateAudio, setGenerateAudio] = useState(engine.audioHandling !== "none");

  // Engine-specific params discovered from paramSchema.
  const engineParams = useMemo(() => {
    const schema = engine.paramSchema as { params?: ParamSchemaEntryLike[] } | null;
    const params = schema?.params ?? [];
    return params.filter(
      (p) => typeof p.from === "string" && !UNIVERSAL_FROM_KEYS.has(p.from),
    );
  }, [engine.paramSchema]);

  // Map of from-key → current value (string for inputs; coerced at send time).
  const [extraParams, setExtraParams] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const p of engineParams) {
      if (p.from && p.default !== undefined && p.default !== null) {
        init[p.from] = String(p.default);
      }
    }
    return init;
  });

  // ── Experiment radio → auto-fill dialogue ───────────────────────────────
  const applyExperiment = (next: ExperimentMode) => {
    setExperiment(next);
    if (next === "A") {
      setDialogueEnabled(engine.audioHandling !== "none");
      setDialogueText(DEFAULT_TEST_DIALOGUE_FULL);
    } else if (next === "B") {
      setDialogueEnabled(engine.audioHandling !== "none");
      setDialogueText(DEFAULT_TEST_DIALOGUE_SHORT);
    } else if (next === "C") {
      setDialogueEnabled(false);
      setDialogueText("");
    }
    // "custom" leaves the form alone — set when admin edits something manually.
  };

  const [running, setRunning] = useState(false);
  const [pollPhase, setPollPhase] = useState<"queued" | "in_progress" | null>(null);
  const [result, setResult] = useState<{
    ok?: boolean;
    falInput?: unknown;
    falResult?: unknown;
    error?: { message?: string; body?: unknown; status?: unknown };
    durationMs?: number;
    testFixtures?: {
      motionPrompt?: string;
      dialogueText?: string | null;
    };
  } | null>(null);
  const [httpError, setHttpError] = useState<string | null>(null);

  // Coerce engine-param string inputs back to the type the schema declared
  // so the server sees proper types (boolean true vs "true", number 0.5 vs "0.5").
  function coerceExtraValue(entry: ParamSchemaEntryLike, raw: string): unknown {
    if (raw === "") return undefined;
    switch (entry.type) {
      case "boolean":
        return raw === "true" || raw === "1";
      case "int":
        return Math.round(Number(raw));
      case "stringInt":
        return String(Math.round(Number(raw)));
      case "float":
        return Number(raw);
      default:
        return raw;
    }
  }

  const handleRun = async () => {
    setRunning(true);
    setHttpError(null);
    setResult(null);
    setPollPhase(null);
    try {
      const body: Record<string, unknown> = {};
      if (sampleUrl.trim()) body.sampleImageUrl = sampleUrl.trim();
      if (motionPrompt.trim() && motionPrompt !== DEFAULT_TEST_MOTION_PROMPT) {
        body.motionPrompt = motionPrompt;
      }
      // dialogueText: null = explicit silence, string = override, undefined = default
      if (!dialogueEnabled) {
        body.dialogueText = null;
      } else if (dialogueText.trim() && dialogueText !== DEFAULT_TEST_DIALOGUE_FULL) {
        body.dialogueText = dialogueText;
      }
      if (durationSec && Number(durationSec) > 0) body.durationSec = Number(durationSec);
      if (aspectRatio) body.aspectRatio = aspectRatio;
      if (resolution) body.resolution = resolution;
      if (mode) body.mode = mode;
      if (generateAudio !== (engine.audioHandling !== "none")) {
        body.generateAudio = generateAudio;
      }
      if (engineParams.length > 0) {
        const extras: Record<string, unknown> = {};
        for (const p of engineParams) {
          if (!p.from) continue;
          const raw = extraParams[p.from] ?? "";
          const coerced = coerceExtraValue(p, raw);
          if (coerced !== undefined) extras[p.from] = coerced;
        }
        if (Object.keys(extras).length > 0) body.extraParams = extras;
      }

      const r = await fetch(`/api/admin/engines/${engine.id}/test`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await r.json().catch(() => null);
      if (!r.ok) {
        setHttpError(json?.message || json?.error || `HTTP ${r.status}`);
        return;
      }

      // Submit failed synchronously (e.g. invalid input before fal call)
      if (json?.ok === false) {
        setResult(json);
        return;
      }

      // 202 — fal job submitted; poll for result
      if (json?.status === "submitted" && json?.requestId) {
        const { requestId, falInput, testFixtures } = json as {
          requestId: string;
          falInput: unknown;
          testFixtures: { motionPrompt?: string; dialogueText?: string | null };
        };
        // Show the fal input immediately so the admin can inspect the payload shape
        setResult({ falInput, testFixtures });
        setPollPhase("queued");

        // Poll until fal reports done
        while (true) {
          await new Promise<void>((resolve) => setTimeout(resolve, 3000));
          let pr: Response;
          try {
            pr = await fetch(`/api/admin/engines/${engine.id}/test/poll/${requestId}`, {
              credentials: "include",
            });
          } catch (fetchErr) {
            setHttpError(`Poll fetch failed: ${String(fetchErr)}`);
            return;
          }
          const pjson = await pr.json().catch(() => null);
          if (!pr.ok || !pjson) {
            setHttpError(`Poll failed: HTTP ${pr.status}`);
            return;
          }
          if (pjson.done) {
            setResult({
              ok: pjson.ok,
              falInput,
              falResult: pjson.falResult,
              error: pjson.error,
              durationMs: pjson.durationMs,
              testFixtures,
            });
            return;
          }
          setPollPhase(pjson.phase === "IN_QUEUE" ? "queued" : "in_progress");
        }
      }

      // Fallback: synchronous-looking result (shouldn't normally happen)
      setResult(json);
    } catch (e) {
      setHttpError(String(e));
    } finally {
      setRunning(false);
      setPollPhase(null);
    }
  };

  const resetToDefaults = () => {
    setSampleUrl("");
    setMotionPrompt(DEFAULT_TEST_MOTION_PROMPT);
    setDialogueEnabled(engine.audioHandling !== "none");
    setDialogueText(DEFAULT_TEST_DIALOGUE_FULL);
    setDurationSec(engine.defaultDurationSec !== null ? String(engine.defaultDurationSec) : "");
    setAspectRatio(engine.defaultAspectRatio ?? "");
    setResolution(engine.defaultResolution ?? "");
    setMode(engine.defaultMode ?? "");
    setGenerateAudio(engine.audioHandling !== "none");
    const reset: Record<string, string> = {};
    for (const p of engineParams) {
      if (p.from && p.default !== undefined && p.default !== null) {
        reset[p.from] = String(p.default);
      }
    }
    setExtraParams(reset);
    setExperiment("A");
  };

  const inputCls =
    "w-full px-2 py-1.5 text-xs font-mono bg-muted/30 border border-border rounded-sm focus:outline-none focus:border-primary";
  const selectCls =
    "w-full px-2 py-1.5 text-xs bg-muted/30 border border-border rounded-sm focus:outline-none focus:border-primary";
  const labelCls = "block text-[10px] font-semibold text-muted-foreground mb-1 uppercase tracking-wide";

  return (
    <div className="mt-4 border-t border-border pt-4 space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Beaker className="w-4 h-4 text-primary" />
          <h4 className="text-xs font-bold text-foreground uppercase tracking-wide">Synthetic test workbench</h4>
        </div>
        <button
          type="button"
          onClick={resetToDefaults}
          className="text-[10px] text-muted-foreground hover:text-foreground underline"
        >
          Reset to defaults
        </button>
      </div>

      {/* ── Experiment selector ─────────────────────────────────────── */}
      <div>
        <label className={labelCls}>Experiment shape</label>
        <div className="flex gap-2 flex-wrap">
          {([
            { value: "A", label: "A · Baseline (full dialogue)" },
            { value: "B", label: "B · Short dialogue (padding test)" },
            { value: "C", label: "C · No dialogue (silence test)" },
          ] as const).map((opt) => (
            <label key={opt.value} className="flex items-center gap-1.5 text-xs cursor-pointer">
              <input
                type="radio"
                name={`exp-${engine.id}`}
                value={opt.value}
                checked={experiment === opt.value}
                onChange={() => applyExperiment(opt.value)}
                className="accent-primary"
              />
              <span>{opt.label}</span>
            </label>
          ))}
        </div>
        <p className="text-[10px] text-muted-foreground mt-1">
          A baseline = does the engine cleanly speak/narrate the dialogue?
          B = does it invent extra dialogue when there&apos;s clip time left after the cue?
          C = does it produce uninvited speech when given none?
        </p>
      </div>

      {/* ── Sample image ─────────────────────────────────────────────── */}
      <div>
        <label className={labelCls}>
          Sample image URL (optional — defaults to bundled face)
        </label>
        <input
          value={sampleUrl}
          onChange={(e) => setSampleUrl(e.target.value)}
          placeholder="https://…/face.jpg"
          className={inputCls}
        />
      </div>

      {/* ── Motion prompt ────────────────────────────────────────────── */}
      <div>
        <label className={labelCls}>Motion prompt</label>
        <textarea
          value={motionPrompt}
          onChange={(e) => { setMotionPrompt(e.target.value); setExperiment("custom"); }}
          rows={4}
          className={`${inputCls} font-sans`}
        />
      </div>

      {/* ── Dialogue ─────────────────────────────────────────────────── */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <label className={labelCls + " mb-0"}>Dialogue cue</label>
          <label className="flex items-center gap-1 text-[10px] text-muted-foreground cursor-pointer">
            <input
              type="checkbox"
              checked={dialogueEnabled}
              onChange={(e) => { setDialogueEnabled(e.target.checked); setExperiment("custom"); }}
              className="accent-primary"
            />
            <span>Send dialogue</span>
          </label>
        </div>
        <textarea
          value={dialogueText}
          onChange={(e) => { setDialogueText(e.target.value); setExperiment("custom"); }}
          rows={2}
          disabled={!dialogueEnabled}
          placeholder={dialogueEnabled ? DEFAULT_TEST_DIALOGUE_FULL : "(silence)"}
          className={`${inputCls} font-sans ${!dialogueEnabled ? "opacity-50" : ""}`}
        />
      </div>

      {/* ── Universal option grid ────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-3">
        {engine.allowedDurationsSec && engine.allowedDurationsSec.length > 0 ? (
          <div>
            <label className={labelCls}>Duration (sec)</label>
            <select
              value={durationSec}
              onChange={(e) => { setDurationSec(e.target.value); setExperiment("custom"); }}
              className={selectCls}
            >
              {engine.allowedDurationsSec.map((d) => (
                <option key={d} value={d}>{d}s</option>
              ))}
            </select>
          </div>
        ) : null}

        {engine.allowedResolutions && engine.allowedResolutions.length > 0 ? (
          <div>
            <label className={labelCls}>Resolution</label>
            <select
              value={resolution}
              onChange={(e) => { setResolution(e.target.value); setExperiment("custom"); }}
              className={selectCls}
            >
              {engine.allowedResolutions.map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
          </div>
        ) : null}

        {engine.allowedAspectRatios && engine.allowedAspectRatios.length > 0 ? (
          <div>
            <label className={labelCls}>Aspect ratio</label>
            <select
              value={aspectRatio}
              onChange={(e) => { setAspectRatio(e.target.value); setExperiment("custom"); }}
              className={selectCls}
            >
              {engine.allowedAspectRatios.map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
          </div>
        ) : null}

        {engine.supportedModes && engine.supportedModes.length > 0 ? (
          <div>
            <label className={labelCls}>Mode</label>
            <select
              value={mode}
              onChange={(e) => { setMode(e.target.value); setExperiment("custom"); }}
              className={selectCls}
            >
              {engine.supportedModes.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </div>
        ) : null}

        {engine.audioHandling !== "none" && (
          <label className="flex items-center gap-1.5 text-xs cursor-pointer pt-5">
            <input
              type="checkbox"
              checked={generateAudio}
              onChange={(e) => { setGenerateAudio(e.target.checked); setExperiment("custom"); }}
              className="accent-primary"
            />
            <span>generate_audio</span>
          </label>
        )}
      </div>

      {/* ── Engine-specific params ───────────────────────────────────── */}
      {engineParams.length > 0 && (
        <div className="space-y-2 rounded-sm border border-amber-500/30 bg-amber-500/5 p-2">
          <p className="text-[10px] font-semibold text-amber-500 uppercase tracking-wider">
            {engine.label} — engine-specific params
          </p>
          <div className="grid grid-cols-2 gap-2">
            {engineParams.map((p) => {
              const key = p.from!;
              const value = extraParams[key] ?? "";
              const setValue = (v: string) => {
                setExtraParams((prev) => ({ ...prev, [key]: v }));
                setExperiment("custom");
              };
              if (p.type === "boolean") {
                return (
                  <label key={key} className="flex items-center gap-1.5 text-xs cursor-pointer pt-4">
                    <input
                      type="checkbox"
                      checked={value === "true" || value === "1"}
                      onChange={(e) => setValue(e.target.checked ? "true" : "false")}
                      className="accent-primary"
                    />
                    <span className="font-mono">{key}</span>
                  </label>
                );
              }
              if (p.enum && p.enum.length > 0) {
                return (
                  <div key={key}>
                    <label className={labelCls}>{key}</label>
                    <select value={value} onChange={(e) => setValue(e.target.value)} className={selectCls}>
                      <option value="">(default)</option>
                      {p.enum.map((v) => (
                        <option key={String(v)} value={String(v)}>{String(v)}</option>
                      ))}
                    </select>
                  </div>
                );
              }
              const isNumber = p.type === "int" || p.type === "stringInt" || p.type === "float";
              return (
                <div key={key} className={isNumber ? "" : "col-span-2"}>
                  <label className={labelCls}>{key}</label>
                  <input
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    type={isNumber ? "number" : "text"}
                    step={p.type === "float" ? "0.01" : "1"}
                    min={p.range?.min}
                    max={p.range?.max}
                    placeholder={p.default !== undefined ? String(p.default) : ""}
                    className={inputCls}
                  />
                </div>
              );
            })}
          </div>
        </div>
      )}

      <button
        onClick={handleRun}
        disabled={running}
        className="flex items-center gap-1.5 min-h-[40px] px-3 py-1.5 text-xs font-bold uppercase tracking-wide bg-primary text-primary-foreground rounded-sm hover:bg-primary/90 disabled:opacity-50 transition-colors"
      >
        {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Beaker className="w-3.5 h-3.5" />}
        {running
          ? pollPhase === "queued" ? "In queue…"
          : pollPhase === "in_progress" ? "Running…"
          : "Submitting…"
          : "Run test"}
      </button>

      {running && pollPhase && (
        <p className="text-[11px] text-muted-foreground">
          {pollPhase === "queued" ? "Job is queued — polling every 3s…" : "Job is running — polling every 3s…"}
        </p>
      )}

      {httpError && <p className="text-xs text-destructive">{httpError}</p>}

      {result && (
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-xs">
            <span className={`px-1.5 py-0.5 rounded font-bold ${result.ok ? "bg-green-500/10 text-green-400" : "bg-destructive/10 text-destructive"}`}>
              {result.ok ? "OK" : "FAIL"}
            </span>
            {result.durationMs !== undefined && <span className="text-muted-foreground">{msToHuman(result.durationMs)}</span>}
          </div>

          {result.testFixtures && (
            <div className="space-y-2 rounded-sm border border-amber-500/30 bg-amber-500/5 p-2">
              <p className="text-[10px] font-semibold text-amber-500 uppercase tracking-wider">Spot-check against these</p>
              <div className="space-y-1.5 text-[11px]">
                <div>
                  <span className="text-muted-foreground">Expected motion: </span>
                  <span className="text-foreground">{result.testFixtures.motionPrompt}</span>
                </div>
                {result.testFixtures.dialogueText && (
                  <div>
                    <span className="text-muted-foreground">Expected audio (should say): </span>
                    <span className="text-foreground italic">&ldquo;{result.testFixtures.dialogueText}&rdquo;</span>
                  </div>
                )}
                {result.testFixtures.dialogueText === null && (
                  <div className="text-muted-foreground italic">
                    Utility engine — no audio path; output video has no spoken content.
                  </div>
                )}
              </div>
            </div>
          )}

          <div>
            <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1">fal input (sent)</p>
            <pre className="text-[11px] font-mono bg-muted/30 border border-border rounded-sm p-2 overflow-x-auto whitespace-pre-wrap break-all">
              {safeJson(result.falInput)}
            </pre>
          </div>

          {result.ok ? (
            <div>
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1">fal result</p>
              <pre className="text-[11px] font-mono bg-muted/30 border border-border rounded-sm p-2 overflow-x-auto whitespace-pre-wrap break-all">
                {safeJson(result.falResult)}
              </pre>
            </div>
          ) : (
            <div>
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1">Error</p>
              <pre className="text-[11px] font-mono bg-destructive/5 border border-destructive/30 rounded-sm p-2 overflow-x-auto whitespace-pre-wrap break-all">
                {safeJson(result.error)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function EngineEditor({ engine, onSaved }: { engine: EngineRow; onSaved: (e: EngineRow) => void }) {
  const [form, setForm] = useState({
    isActive: engine.isActive,
    isDefault: engine.isDefault,
    sortOrder: String(engine.sortOrder),
    tierRequirement: engine.tierRequirement,
    featureFlagRequired: engine.featureFlagRequired ?? "",
    defaultDurationSec: engine.defaultDurationSec === null ? "" : String(engine.defaultDurationSec),
    defaultResolution: engine.defaultResolution ?? "",
    defaultAspectRatio: engine.defaultAspectRatio ?? "",
    defaultMode: engine.defaultMode ?? "",
    expectedRunMs: String(engine.expectedRunMs),
    estimatedCostUsdPerCall: engine.estimatedCostUsdPerCall === null ? "" : String(engine.estimatedCostUsdPerCall),
    estimatedCostUsdPerSecond: engine.estimatedCostUsdPerSecond === null ? "" : String(engine.estimatedCostUsdPerSecond),
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const set = <K extends keyof typeof form>(k: K, v: typeof form[K]) => setForm((f) => ({ ...f, [k]: v }));

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const patch: Record<string, unknown> = {
        isActive: form.isActive,
        isDefault: form.isDefault,
        sortOrder: Number.parseInt(form.sortOrder, 10) || 0,
        tierRequirement: form.tierRequirement,
        featureFlagRequired: form.featureFlagRequired.trim() === "" ? null : form.featureFlagRequired.trim(),
        defaultDurationSec: form.defaultDurationSec === "" ? null : Number.parseInt(form.defaultDurationSec, 10),
        defaultResolution: form.defaultResolution === "" ? null : form.defaultResolution,
        defaultAspectRatio: form.defaultAspectRatio === "" ? null : form.defaultAspectRatio,
        defaultMode: form.defaultMode === "" ? null : form.defaultMode,
        expectedRunMs: Number.parseInt(form.expectedRunMs, 10) || 0,
        estimatedCostUsdPerCall: form.estimatedCostUsdPerCall === "" ? null : Number(form.estimatedCostUsdPerCall),
        estimatedCostUsdPerSecond: form.estimatedCostUsdPerSecond === "" ? null : Number(form.estimatedCostUsdPerSecond),
      };
      const r = await fetch(`/api/admin/engines/${engine.id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      const updated: EngineRow = await r.json();
      onSaved(updated);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const resolutionOpts = engine.allowedResolutions ?? [];
  const aspectOpts = engine.allowedAspectRatios ?? [];
  const modeOpts = engine.supportedModes ?? [];
  const durationOpts = engine.allowedDurationsSec ?? [];

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 pt-4 border-t border-border">
      {/* ── Admin-editable column ────────────────────────────────────────── */}
      <div className="space-y-3">
        <h4 className="text-xs font-bold text-foreground uppercase tracking-wide">Admin-editable</h4>

        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => set("isActive", !form.isActive)}
            className={`flex items-center gap-1.5 min-h-[40px] px-3 py-1.5 text-xs font-bold rounded-sm border transition-colors ${
              form.isActive ? "bg-green-500/10 border-green-500/40 text-green-400" : "bg-muted/30 border-border text-muted-foreground"
            }`}
          >
            {form.isActive ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
            {form.isActive ? "Active" : "Inactive"}
          </button>
          <button
            onClick={() => set("isDefault", !form.isDefault)}
            className={`flex items-center gap-1.5 min-h-[40px] px-3 py-1.5 text-xs font-bold rounded-sm border transition-colors ${
              form.isDefault ? "bg-amber-500/10 border-amber-500/40 text-amber-400" : "bg-muted/30 border-border text-muted-foreground"
            }`}
          >
            <Star className="w-3.5 h-3.5" />
            {form.isDefault ? "Default for kind" : "Not default"}
          </button>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-[10px] font-semibold text-muted-foreground mb-1 uppercase tracking-wide">Sort order</label>
            <input
              type="number"
              value={form.sortOrder}
              onChange={(e) => set("sortOrder", e.target.value)}
              className="w-full min-h-[40px] px-2 py-1 text-xs bg-muted/30 border border-border rounded-sm focus:outline-none focus:border-primary"
            />
          </div>
          <div>
            <label className="block text-[10px] font-semibold text-muted-foreground mb-1 uppercase tracking-wide">Tier requirement</label>
            <select
              value={form.tierRequirement}
              onChange={(e) => set("tierRequirement", e.target.value)}
              className="w-full min-h-[40px] px-2 py-1 text-xs bg-muted/30 border border-border rounded-sm focus:outline-none focus:border-primary"
            >
              <option value="unregistered">unregistered</option>
              <option value="registered">registered</option>
              <option value="legendary">legendary</option>
            </select>
          </div>
        </div>

        <div>
          <label className="block text-[10px] font-semibold text-muted-foreground mb-1 uppercase tracking-wide">Feature flag required (empty = none)</label>
          <input
            value={form.featureFlagRequired}
            onChange={(e) => set("featureFlagRequired", e.target.value)}
            placeholder="engine_experiments"
            className="w-full min-h-[40px] px-2 py-1 text-xs font-mono bg-muted/30 border border-border rounded-sm focus:outline-none focus:border-primary"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-[10px] font-semibold text-muted-foreground mb-1 uppercase tracking-wide">
              Default duration (sec) {durationOpts.length > 0 && <span className="font-normal normal-case">— allowed: {durationOpts.join(", ")}</span>}
            </label>
            <input
              type="number"
              value={form.defaultDurationSec}
              onChange={(e) => set("defaultDurationSec", e.target.value)}
              className="w-full min-h-[40px] px-2 py-1 text-xs bg-muted/30 border border-border rounded-sm focus:outline-none focus:border-primary"
            />
          </div>
          <div>
            <label className="block text-[10px] font-semibold text-muted-foreground mb-1 uppercase tracking-wide">Default resolution</label>
            <select
              value={form.defaultResolution}
              onChange={(e) => set("defaultResolution", e.target.value)}
              className="w-full min-h-[40px] px-2 py-1 text-xs bg-muted/30 border border-border rounded-sm focus:outline-none focus:border-primary"
            >
              <option value="">— none —</option>
              {resolutionOpts.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-[10px] font-semibold text-muted-foreground mb-1 uppercase tracking-wide">Default aspect ratio</label>
            <select
              value={form.defaultAspectRatio}
              onChange={(e) => set("defaultAspectRatio", e.target.value)}
              className="w-full min-h-[40px] px-2 py-1 text-xs bg-muted/30 border border-border rounded-sm focus:outline-none focus:border-primary"
            >
              <option value="">— none —</option>
              {aspectOpts.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-[10px] font-semibold text-muted-foreground mb-1 uppercase tracking-wide">Default mode</label>
            <select
              value={form.defaultMode}
              onChange={(e) => set("defaultMode", e.target.value)}
              className="w-full min-h-[40px] px-2 py-1 text-xs bg-muted/30 border border-border rounded-sm focus:outline-none focus:border-primary"
            >
              <option value="">— none —</option>
              {modeOpts.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="block text-[10px] font-semibold text-muted-foreground mb-1 uppercase tracking-wide">
              Expected run (ms) — <span className="font-normal">{msToHuman(Number.parseInt(form.expectedRunMs, 10) || 0)}</span>
            </label>
            <input
              type="number"
              value={form.expectedRunMs}
              onChange={(e) => set("expectedRunMs", e.target.value)}
              className="w-full min-h-[40px] px-2 py-1 text-xs bg-muted/30 border border-border rounded-sm focus:outline-none focus:border-primary"
            />
          </div>
          <div>
            <label className="block text-[10px] font-semibold text-muted-foreground mb-1 uppercase tracking-wide">$ per call</label>
            <input
              type="number"
              step="0.0001"
              value={form.estimatedCostUsdPerCall}
              onChange={(e) => set("estimatedCostUsdPerCall", e.target.value)}
              placeholder="(null)"
              className="w-full min-h-[40px] px-2 py-1 text-xs bg-muted/30 border border-border rounded-sm focus:outline-none focus:border-primary"
            />
          </div>
          <div>
            <label className="block text-[10px] font-semibold text-muted-foreground mb-1 uppercase tracking-wide">$ per second</label>
            <input
              type="number"
              step="0.0001"
              value={form.estimatedCostUsdPerSecond}
              onChange={(e) => set("estimatedCostUsdPerSecond", e.target.value)}
              placeholder="(null)"
              className="w-full min-h-[40px] px-2 py-1 text-xs bg-muted/30 border border-border rounded-sm focus:outline-none focus:border-primary"
            />
          </div>
        </div>

        {error && <p className="text-xs text-destructive">{error}</p>}

        <button
          onClick={handleSave}
          disabled={saving}
          className="flex items-center gap-1.5 min-h-[40px] px-4 py-1.5 text-xs font-bold uppercase tracking-wide bg-primary text-primary-foreground rounded-sm hover:bg-primary/90 disabled:opacity-50 transition-colors"
        >
          <Save className="w-3.5 h-3.5" />
          {saving ? "Saving…" : saved ? "Saved!" : "Save changes"}
        </button>
      </div>

      {/* ── Read-only metadata ──────────────────────────────────────────── */}
      <div className="space-y-3">
        <h4 className="text-xs font-bold text-foreground uppercase tracking-wide">Read-only metadata (code-owned)</h4>
        <div className="grid grid-cols-2 gap-3">
          <ReadOnlyField label="id" value={engine.id} />
          <ReadOnlyField label="provider" value={engine.provider} />
          <ReadOnlyField label="kind" value={engine.kind} />
          <ReadOnlyField label="audio handling" value={engine.audioHandling} />
        </div>
        <ReadOnlyField label="endpoint" value={engine.endpointId} />
        <div className="grid grid-cols-2 gap-3">
          <ReadOnlyField label="allowed durations" value={engine.allowedDurationsSec?.join(", ") ?? null} />
          <ReadOnlyField label="allowed resolutions" value={engine.allowedResolutions?.join(", ") ?? null} />
          <ReadOnlyField label="allowed aspect ratios" value={engine.allowedAspectRatios?.join(", ") ?? null} />
          <ReadOnlyField label="supported modes" value={engine.supportedModes?.join(", ") ?? null} />
        </div>
        <div>
          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1">paramSchema</p>
          <pre className="text-[11px] font-mono bg-muted/30 border border-border rounded-sm p-2 overflow-x-auto max-h-64 whitespace-pre-wrap break-all">
            {safeJson(engine.paramSchema)}
          </pre>
        </div>
      </div>
    </div>
  );
}

function EngineCard({
  engine,
  archived,
  onChanged,
}: {
  engine: EngineRow;
  archived: boolean;
  onChanged: (e: EngineRow) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [testOpen, setTestOpen] = useState(false);
  const [busy, setBusy] = useState<null | string>(null);

  const archive = async () => {
    if (!confirm(`Archive engine "${engine.label}"? It will be hidden from the wizard and interpreter but kept for video-job lineage.`)) return;
    setBusy("archive");
    try {
      const r = await fetch(`/api/admin/engines/${engine.id}`, { method: "DELETE", credentials: "include" });
      if (!r.ok) throw new Error(await r.text());
      onChanged(await r.json());
    } finally { setBusy(null); }
  };

  const restore = async () => {
    setBusy("restore");
    try {
      const r = await fetch(`/api/admin/engines/${engine.id}/restore`, { method: "POST", credentials: "include" });
      if (!r.ok) throw new Error(await r.text());
      onChanged(await r.json());
    } finally { setBusy(null); }
  };

  const setDefault = async () => {
    setBusy("setDefault");
    try {
      const r = await fetch(`/api/admin/engines/${engine.id}/set-default`, { method: "POST", credentials: "include" });
      if (!r.ok) throw new Error(await r.text());
      onChanged(await r.json());
    } finally { setBusy(null); }
  };

  return (
    <div className={`bg-card border rounded-sm overflow-hidden ${!engine.isActive || archived ? "opacity-70" : "border-border"}`}>
      <div className="p-4 flex items-start gap-3">
        <button onClick={() => setExpanded((v) => !v)} className="flex items-start gap-3 flex-1 min-w-0 text-left">
          <div className={`mt-1 w-2 h-2 rounded-full shrink-0 ${engine.isActive && !archived ? "bg-green-400" : "bg-muted-foreground/40"}`} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-bold text-foreground">{engine.label}</span>
              <span className="text-[10px] font-mono text-muted-foreground bg-muted/50 px-1.5 py-0.5 rounded">{engine.id}</span>
              <span className="text-[10px] font-bold text-muted-foreground bg-muted/30 px-1.5 py-0.5 rounded uppercase">{engine.provider}</span>
              {engine.isDefault && (
                <span className="flex items-center gap-0.5 text-[10px] font-bold text-amber-400 bg-amber-500/10 px-1.5 py-0.5 rounded">
                  <Star className="w-2.5 h-2.5" /> default
                </span>
              )}
              {engine.featureFlagRequired && (
                <span className="text-[10px] font-mono text-purple-300 bg-purple-500/10 px-1.5 py-0.5 rounded">flag:{engine.featureFlagRequired}</span>
              )}
              {!engine.isActive && <span className="text-[10px] font-bold text-muted-foreground bg-muted px-1.5 py-0.5 rounded">INACTIVE</span>}
              {archived && <span className="text-[10px] font-bold text-destructive bg-destructive/10 px-1.5 py-0.5 rounded">ARCHIVED</span>}
            </div>
            <p className="text-[11px] text-muted-foreground font-mono mt-0.5 truncate">{engine.endpointId}</p>
            <p className="text-xs text-muted-foreground mt-1">{engine.description}</p>
          </div>
        </button>

        <div className="flex flex-col sm:flex-row gap-1 shrink-0">
          {!archived && (
            <>
              <button
                onClick={() => setTestOpen((v) => !v)}
                className="min-h-[36px] px-2 py-1 text-[11px] font-bold border border-border rounded-sm hover:border-primary/50 text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1"
                title="Run synthetic test"
              >
                <Beaker className="w-3 h-3" /> Test
              </button>
              {!engine.isDefault && (
                <button
                  onClick={setDefault}
                  disabled={busy === "setDefault"}
                  className="min-h-[36px] px-2 py-1 text-[11px] font-bold border border-amber-500/40 rounded-sm hover:bg-amber-500/10 text-amber-400 transition-colors flex items-center gap-1"
                  title="Set as default for this kind"
                >
                  <Star className="w-3 h-3" /> Default
                </button>
              )}
              <button
                onClick={archive}
                disabled={busy === "archive"}
                className="min-h-[36px] px-2 py-1 text-[11px] font-bold border border-destructive/30 rounded-sm hover:bg-destructive/10 text-destructive transition-colors flex items-center gap-1"
              >
                <Trash2 className="w-3 h-3" /> Archive
              </button>
            </>
          )}
          {archived && (
            <button
              onClick={restore}
              disabled={busy === "restore"}
              className="min-h-[36px] px-2 py-1 text-[11px] font-bold border border-border rounded-sm hover:border-primary/50 text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1"
            >
              <Undo2 className="w-3 h-3" /> Restore
            </button>
          )}
          <button
            onClick={() => setExpanded((v) => !v)}
            className="min-h-[36px] px-2 py-1 text-[11px] font-bold border border-border rounded-sm hover:border-primary/50 text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1"
          >
            {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            {expanded ? "Hide" : "Edit"}
          </button>
        </div>
      </div>

      {testOpen && !archived && (
        <div className="px-4 pb-4">
          <EngineTestPanel engine={engine} />
        </div>
      )}

      {expanded && (
        <div className="px-4 pb-4">
          <EngineEditor engine={engine} onSaved={onChanged} />
          <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-3 pt-3 border-t border-border">
            <ReadOnlyField label="created" value={new Date(engine.createdAt).toLocaleString()} />
            <ReadOnlyField label="updated" value={new Date(engine.updatedAt).toLocaleString()} />
            <ReadOnlyField label="cost/call" value={fmtCost(engine.estimatedCostUsdPerCall)} />
            <ReadOnlyField label="cost/sec" value={fmtCost(engine.estimatedCostUsdPerSecond)} />
          </div>
        </div>
      )}
    </div>
  );
}

type Tab = "live" | "archived";

export default function AdminEngines() {
  const [engines, setEngines] = useState<EngineRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("live");

  useEffect(() => {
    fetch("/api/admin/engines", { credentials: "include" })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data: ListResponse = await r.json();
        setEngines(data.engines);
      })
      .catch((e) => setError(String(e)));
  }, []);

  const handleChanged = (updated: EngineRow) => {
    setEngines((prev) => (prev ? prev.map((e) => (e.id === updated.id ? updated : e)) : prev));
  };

  const grouped = useMemo(() => {
    if (!engines) return null;
    const filtered = engines.filter((e) => (tab === "archived" ? e.deletedAt !== null : e.deletedAt === null));
    const map = new Map<string, EngineRow[]>();
    for (const e of filtered) {
      if (!map.has(e.kind)) map.set(e.kind, []);
      map.get(e.kind)!.push(e);
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));
    }
    const order = ["video", "image", "utility"];
    return [...map.entries()].sort(([a], [b]) => {
      const ia = order.indexOf(a);
      const ib = order.indexOf(b);
      if (ia === -1 && ib === -1) return a.localeCompare(b);
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    });
  }, [engines, tab]);

  return (
    <AdminLayout title="Engines">
      <div className="max-w-5xl space-y-4">
        <div className="flex items-center gap-2">
          <Boxes className="w-5 h-5 text-primary" />
          <p className="text-sm text-muted-foreground">
            Manage the generative engines the video / image / utility pipelines call. Code-owned fields (paramSchema, endpoint, kind) are read-only; only the {EDITABLE_FIELDS.length} runtime knobs below are editable.
          </p>
        </div>

        <div className="flex items-center gap-1 border-b border-border">
          {(["live", "archived"] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`min-h-[36px] px-3 py-1.5 text-xs font-bold uppercase tracking-wide border-b-2 transition-colors ${
                tab === t ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {t === "live" ? "Live engines" : "Archived"}
            </button>
          ))}
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        {engines === null && !error && <p className="text-muted-foreground text-sm">Loading…</p>}

        {grouped !== null && grouped.length === 0 && (
          <p className="text-sm text-muted-foreground">
            {tab === "archived" ? "No archived engines." : "No live engines configured."}
          </p>
        )}

        {grouped !== null && grouped.map(([kind, rows]) => (
          <div key={kind} className="space-y-2">
            <h3 className="text-xs font-bold text-muted-foreground uppercase tracking-widest pt-2">
              {KIND_LABELS[kind] ?? kind} <span className="font-normal text-muted-foreground/60">({rows.length})</span>
            </h3>
            <div className="space-y-2">
              {rows.map((engine) => (
                <EngineCard
                  key={engine.id}
                  engine={engine}
                  archived={tab === "archived"}
                  onChanged={handleChanged}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </AdminLayout>
  );
}

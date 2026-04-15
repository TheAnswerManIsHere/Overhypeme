import { useState } from "react";
import { AdminLayout } from "@/components/admin/AdminLayout";
import { CollapsibleSection } from "@/components/CollapsibleSection";
import { Settings, Loader2, Palette, Bug, Bot, Film, Sliders } from "lucide-react";
import {
  ConfigPageContext,
  ConfigPageCtx,
  ConfigCard,
  ModelParamRow,
  ConfigInput,
  MODEL_CONFIG_KEYS,
  STYLE_OPTIONS,
  useConfigCtx,
  useConfigPageState,
} from "./_configShared";

// ── Per-model parameter definitions ──────────────────────────────────────────

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

// ── ModelConfigSection ────────────────────────────────────────────────────────

function ModelConfigSection({ title, subtitle, modelKey }: {
  title: string; subtitle: string;
  modelKey: "ai_image_model_standard" | "ai_image_model_reference";
}) {
  const { stdEdits, rows } = useConfigCtx();
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

// ── AI Settings group (nested inside Configuration) ───────────────────────────

function AISettingsGroup() {
  const [selectedStyleId, setSelectedStyleId] = useState<string>(STYLE_OPTIONS[0]?.id ?? "");
  const standardKey = `style_suffix_${selectedStyleId}`;
  const referenceKey = `style_suffix_ref_${selectedStyleId}`;
  const selectedStyleDef = STYLE_OPTIONS.find((s) => s.id === selectedStyleId);
  const { debugActive } = useConfigCtx();

  return (
    <div className="space-y-3">

      {/* AI Image Generation */}
      <CollapsibleSection
        title="AI Image Generation"
        icon={<Bot className="w-4 h-4 text-muted-foreground" />}
        description="fal.ai model selection and per-model tuning parameters."
        storageKey="admin_section_config_ai_image"
      >
        <p className="text-sm text-muted-foreground -mt-3">
          fal.ai model selection and per-model tuning parameters. Select a model from the dropdown to reveal its configurable parameters below.
        </p>

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
      </CollapsibleSection>

      {/* AI Scene Prompt */}
      <CollapsibleSection
        title="AI Scene Prompt"
        icon={<Bot className="w-4 h-4 text-muted-foreground" />}
        description="OpenAI model and sampling parameters for cinematic scene descriptions."
        storageKey="admin_section_config_ai_scene"
      >
        <p className="text-sm text-muted-foreground -mt-3">
          OpenAI model and sampling parameters used when generating cinematic scene descriptions for meme backgrounds.
        </p>

        <div className="space-y-4">
          <ModelParamRow paramKey="ai_scene_prompt_model" />
          <ModelParamRow paramKey="ai_scene_prompt_max_tokens" />
          <ModelParamRow paramKey="ai_scene_prompt_temperature" />
          <ModelParamRow paramKey="ai_scene_prompt_system" />
        </div>
      </CollapsibleSection>

      {/* AI Generation Limits */}
      <CollapsibleSection
        title="AI Generation Limits"
        icon={<Sliders className="w-4 h-4 text-muted-foreground" />}
        description="Gallery display limit and per-fact image caps."
        storageKey="admin_section_config_ai_gen_limits"
      >
        <div className="space-y-4">
          <ModelParamRow paramKey="ai_gallery_display_limit" />
          <ModelParamRow paramKey="ai_max_images_per_fact_per_gender" />
        </div>
      </CollapsibleSection>

      {/* Image Style Suffixes */}
      <CollapsibleSection
        title="Image Style Suffixes"
        icon={<Palette className="w-4 h-4 text-muted-foreground" />}
        description="Text appended to the scene prompt when a style is selected."
        storageKey="admin_section_config_image_styles"
      >
        <p className="text-sm text-muted-foreground -mt-3">
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
      </CollapsibleSection>

      {/* Video Generation */}
      <CollapsibleSection
        title="Video Generation"
        icon={<Film className="w-4 h-4 text-muted-foreground" />}
        description="fal.ai / xAI model and generation parameters for video creation."
        storageKey="admin_section_config_video"
      >
        <p className="text-sm text-muted-foreground -mt-3">
          Defaults for all video generation requests. Grok Imagine: duration 1–15 s, 8 aspect ratios, 480p/720p. Seedance 2.0: duration auto/4–15 s, 7 aspect ratios (incl. 21:9 ultrawide), 480p/720p, native audio. Other models may clamp or ignore values they don't support.
        </p>

        <div className="space-y-4">
          <ModelParamRow paramKey="video_model" />
          <ModelParamRow paramKey="video_duration" />
          <ModelParamRow paramKey="video_aspect_ratio" />
          <ModelParamRow paramKey="video_resolution" />
          <ModelParamRow paramKey="video_prompt_system_prompt" />
        </div>
      </CollapsibleSection>

    </div>
  );
}

// ── Main page component ───────────────────────────────────────────────────────

export default function AdminConfig() {
  const state = useConfigPageState();
  const {
    rows, loading,
    stdEdits, dbgEdits, setStdEdits, setDbgEdits,
    debugActive, debugToggling, toggleDebugMode,
    saveStd, saveDbg, stdDirty, dbgDirty,
  } = state;

  const genericRows = rows.filter((r) =>
    !r.key.startsWith("style_suffix_") &&
    r.key !== "debug_mode_active" &&
    !MODEL_CONFIG_KEYS.has(r.key)
  );

  const ctxValue: ConfigPageCtx = {
    rows, stdEdits, dbgEdits, debugActive,
    setStdEdits, setDbgEdits,
    saveStd, saveDbg, stdDirty, dbgDirty,
  };

  return (
    <AdminLayout title="Configuration">
      <ConfigPageContext.Provider value={ctxValue}>
        <div className="max-w-5xl space-y-4">

          {/* ── Debug Mode ── always visible at the top ── */}
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
                    ? "All configurations are using their Debug values (where set). Not suitable for regular users."
                    : "All configurations are using their Standard values. Enable debug mode to switch to the Debug set of values."}
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
              <span>Debug mode is active — the system is using Debug values for all configurations.</span>
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

              {/* Generic (non-AI) config rows */}
              {genericRows.map((row) => <ConfigCard key={row.key} row={row} />)}

              {/* AI Settings — collapsible group */}
              <CollapsibleSection
                title="AI Settings"
                icon={<Bot className="w-4 h-4 text-muted-foreground" />}
                description="Models, parameters, style suffixes, and video generation."
                storageKey="admin_section_config_ai_group"
              >
                <AISettingsGroup />
              </CollapsibleSection>

            </div>
          )}
        </div>
      </ConfigPageContext.Provider>
    </AdminLayout>
  );
}

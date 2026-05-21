import { useState } from "react";
import { AdminLayout } from "@/components/admin/AdminLayout";
import { CollapsibleSection } from "@/components/CollapsibleSection";
import { Settings, Loader2, Palette, Bug, Sliders, Zap } from "lucide-react";
import {
  ConfigPageContext,
  ConfigPageCtx,
  ModelParamRow,
  ConfigInput,
  STYLE_OPTIONS,
  useConfigPageState,
} from "./_configShared";

// Phase 6: the legacy per-model parameter UI (MODEL_PARAMS + ModelConfigSection),
// the AI Image Generation, AI Scene Prompt, and Video Generation sections were
// all removed when the ad-hoc ai_*/video_* admin_config keys were retired.
// AI engine configuration now lives in the engines table and is edited via
// /admin/engines.

// ── Main page component ───────────────────────────────────────────────────────

export default function AdminAI() {
  const state = useConfigPageState();
  const {
    rows, loading,
    stdEdits, dbgEdits, setStdEdits, setDbgEdits,
    debugActive, debugToggling, toggleDebugMode,
    saveStd, saveDbg, stdDirty, dbgDirty,
  } = state;

  const [selectedStyleId, setSelectedStyleId] = useState<string>(STYLE_OPTIONS[0]?.id ?? "");

  const standardKey = `style_suffix_${selectedStyleId}`;
  const referenceKey = `style_suffix_ref_${selectedStyleId}`;
  const selectedStyleDef = STYLE_OPTIONS.find((s) => s.id === selectedStyleId);

  const ctxValue: ConfigPageCtx = {
    rows, stdEdits, dbgEdits, debugActive,
    setStdEdits, setDbgEdits,
    saveStd, saveDbg, stdDirty, dbgDirty,
  };

  return (
    <AdminLayout title="AI Settings">
      <ConfigPageContext.Provider value={ctxValue}>
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
                    ? "All AI configs are using their Debug values (where set). Not suitable for regular users."
                    : "All AI configs are using their Standard values. Enable debug mode to switch to the Debug set of values."}
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
              <span>Debug mode is active — the system is using Debug values for all configured AI keys.</span>
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

              {/* AI Engine configuration callout */}
              <div className="rounded-lg border border-border bg-muted/40 p-4 flex items-start gap-3">
                <Zap className="w-5 h-5 text-primary shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <p className="text-sm font-semibold text-foreground">
                    AI engine configuration has moved
                  </p>
                  <p className="text-sm text-muted-foreground">
                    Per-engine settings (model id, allowed durations, resolutions, aspect
                    ratios, audio handling, parameter schemas) now live in the{" "}
                    <a href="/admin/engines" className="text-primary underline hover:text-primary/80">
                      /admin/engines
                    </a>{" "}
                    panel. The legacy ad-hoc admin_config keys for image, scene-prompt,
                    and video generation were retired in Phase 6.
                  </p>
                </div>
              </div>

              {/* ── AI Generation Limits ──────────────────────────────────────── */}
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

              {/* ── Image Style Suffixes ──────────────────────────────────────── */}
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

            </div>
          )}
        </div>
      </ConfigPageContext.Provider>
    </AdminLayout>
  );
}

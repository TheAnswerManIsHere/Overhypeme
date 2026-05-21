import { AdminLayout } from "@/components/admin/AdminLayout";
import { CollapsibleSection } from "@/components/CollapsibleSection";
import { Settings, Loader2, Bug, Sliders, Zap, Palette } from "lucide-react";
import {
  ConfigPageContext,
  ConfigPageCtx,
  ModelParamRow,
  useConfigPageState,
} from "./_configShared";

// Phase 6 + admin-panel cleanup: every per-model parameter UI (MODEL_PARAMS,
// ModelConfigSection, AI Image Generation, AI Scene Prompt, Video Generation
// sections) was removed when the ad-hoc ai_*/video_* admin_config keys were
// retired. AI engine configuration now lives in the engines table and is
// edited via /admin/engines. The Image Style Suffixes section was also
// dropped — look-style prompt text now lives on the `look_styles` DB table
// (look_styles.promptSuffix / promptSuffixReference) and is seeded from
// migration 0057. A dedicated /admin/look-styles editor is a follow-up;
// surfacing the now-detached `style_suffix_*` admin_config keys here is
// confusing because nothing reads them at runtime anymore.

export default function AdminAI() {
  const state = useConfigPageState();
  const {
    rows, loading,
    stdEdits, dbgEdits, setStdEdits, setDbgEdits,
    debugActive, debugToggling, toggleDebugMode,
    saveStd, saveDbg, stdDirty, dbgDirty,
  } = state;

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
                    Per-engine settings (model id, allowed durations,
                    resolutions, aspect ratios, audio handling, parameter
                    schemas) now live in the{" "}
                    <a href="/admin/engines" className="text-primary underline hover:text-primary/80">
                      /admin/engines
                    </a>{" "}
                    panel. The legacy ad-hoc admin_config keys for image,
                    scene-prompt, and video generation were retired in
                    Phase 6.
                  </p>
                </div>
              </div>

              {/* Look style suffixes callout */}
              <div className="rounded-lg border border-border bg-muted/40 p-4 flex items-start gap-3">
                <Palette className="w-5 h-5 text-primary shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <p className="text-sm font-semibold text-foreground">
                    Image style suffixes moved to look_styles
                  </p>
                  <p className="text-sm text-muted-foreground">
                    Style prompt content (the text appended to the scene
                    prompt for each visual style) now lives on the{" "}
                    <code className="text-xs bg-muted px-1 py-0.5 rounded">look_styles</code>{" "}
                    DB table (<code className="text-xs bg-muted px-1 py-0.5 rounded">promptSuffix</code>{" "}
                    + <code className="text-xs bg-muted px-1 py-0.5 rounded">promptSuffixReference</code>).
                    A dedicated <code className="text-xs bg-muted px-1 py-0.5 rounded">/admin/look-styles</code>{" "}
                    editor is a follow-up; until it lands, edits happen
                    through the typed engine catalogue and migrations.
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

            </div>
          )}
        </div>
      </ConfigPageContext.Provider>
    </AdminLayout>
  );
}

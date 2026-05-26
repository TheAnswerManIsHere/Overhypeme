import { AdminLayout } from "@/components/admin/AdminLayout";
import { CollapsibleSection } from "@/components/CollapsibleSection";
import { Settings, Loader2, Bug, Bot, Sliders, DollarSign, Shield, Mail, ShoppingBag, Clock, Wand2 } from "lucide-react";
import {
  ConfigPageContext,
  ConfigPageCtx,
  ConfigCard,
  ModelParamRow,
  MODEL_CONFIG_KEYS,
  RETRY_DELAY_MS_KEYS,
  SCENE_PROMPT_KEYS,
  useConfigCtx,
  useConfigPageState,
  msToHuman,
} from "./_configShared";

// Keys that belong to named sections — excluded from the catch-all generic list
const BUDGET_KEYS = new Set([
  "budget_limit_registered_usd",
  "budget_limit_legendary_usd",
  "budget_period",
]);

const LIMIT_KEYS = new Set([
  "ai_max_images_per_gender",
  "max_memes_per_fact",
  "pexels_photos_per_gender",
  "user_max_images",
  "bg_display_limit_stock",
  "bg_display_limit_gradient",
  "bg_display_limit_upload",
]);

const EMAIL_KEYS = new Set([
  "email_from_address",
  "email_reply_to",
  "email_max_attempts",
  "email_retry_delay_1_ms",
  "email_retry_delay_2_ms",
  "email_retry_delay_3_ms",
  "email_retry_delay_4_ms",
  "email_outbox_retention_days",
]);

const ZAZZLE_KEYS = new Set([
  "zazzle_at",
  "zazzle_rf",
  "zazzle_ax",
  "zazzle_sr",
  "zazzle_cg",
  "zazzle_ed",
  "zazzle_tc",
]);

// Keys that belong elsewhere (Billing tab) or are removed from this page
const BILLING_ONLY_KEYS = new Set([
  "stripe_live_mode",
  "fal_active_endpoints",
  "pricing_refresh_interval_ms",
]);

// Phase 6: the legacy per-model parameter definitions (MODEL_PARAMS) and the
// ModelConfigSection component were removed when the ad-hoc ai_*/video_*
// admin_config keys were retired. AI engine configuration now lives in the
// engines table and is edited via /admin/engines.

// ── RetryTimelinePanel ────────────────────────────────────────────────────────

function RetryTimelinePanel() {
  const { stdEdits, dbgEdits, debugActive, stdDirty, dbgDirty } = useConfigCtx();

  const isDebug = debugActive;

  const resolved = RETRY_DELAY_MS_KEYS.map((key) => {
    const dbgRaw = dbgEdits[key]?.value;
    const dbgHasValue = dbgRaw !== undefined && dbgRaw !== "";
    const useDbg = isDebug && dbgHasValue;
    const raw = useDbg ? dbgRaw : stdEdits[key]?.value;
    const ms = raw !== undefined && raw !== "" ? Number(raw) : NaN;
    return {
      ms: isFinite(ms) && ms >= 0 ? ms : null,
      fromDbg: useDbg,
    };
  });

  const hasAnyDelay = resolved.some((r) => r.ms !== null);
  if (!hasAnyDelay) return null;

  const cumulative: (number | null)[] = [];
  let running = 0;
  for (const r of resolved) {
    if (r.ms === null) {
      cumulative.push(null);
    } else {
      running += r.ms;
      cumulative.push(running);
    }
  }

  const dirtyFlags = RETRY_DELAY_MS_KEYS.map((key, i) => {
    if (!isDebug) return stdDirty(key);
    if (resolved[i].fromDbg) return dbgDirty(key);
    return dbgDirty(key) || stdDirty(key);
  });
  const anyUnsaved = dirtyFlags.some(Boolean);

  return (
    <div className={`rounded-lg border p-4 space-y-3 ${isDebug ? "border-amber-500/40 bg-amber-500/5" : "border-border bg-muted/40"}`}>
      <div className="flex items-center gap-2">
        <Clock className={`w-4 h-4 shrink-0 ${isDebug ? "text-amber-400" : "text-muted-foreground"}`} />
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
          Predicted retry timeline
        </p>
        {isDebug ? (
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-400 font-medium flex items-center gap-1">
            <Bug className="w-3 h-3" /> Debug schedule
          </span>
        ) : (
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-primary/15 text-primary font-medium">
            Standard schedule
          </span>
        )}
        {anyUnsaved && (
          <span className="text-xs text-amber-400 italic ml-auto">preview — unsaved changes</span>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Cumulative offsets from the moment of the first failure:
      </p>
      <ol className="space-y-1.5">
        {cumulative.map((total, i) => {
          const key = RETRY_DELAY_MS_KEYS[i];
          const directlyUnsaved = dirtyFlags[i];
          const cumulativelyAffected = !directlyUnsaved && dirtyFlags.slice(0, i).some(Boolean);
          const highlight = directlyUnsaved || cumulativelyAffected;
          return (
            <li key={key} className="flex items-center gap-2 text-sm">
              <span className="w-16 shrink-0 text-xs text-muted-foreground">Retry {i + 1}</span>
              {total === null ? (
                <span className="text-muted-foreground/60 italic text-xs">not set</span>
              ) : (
                <span className={`font-mono ${highlight ? "text-amber-400" : "text-foreground"}`}>
                  +{msToHuman(total)}
                </span>
              )}
              {directlyUnsaved && (
                <span className="text-[10px] text-amber-400/80 italic">unsaved</span>
              )}
              {cumulativelyAffected && total !== null && (
                <span className="text-[10px] text-amber-400/60 italic">affected</span>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

// ── AI Settings group (nested inside Configuration) ───────────────────────────
//
// Hosts the scene-prompt generation levers (system prompt, composition suffix,
// OpenAI model, temperature, max tokens — see lib/scenePromptConfig.ts) and the
// AI gallery display limit. Image-engine / video config lives at /admin/engines;
// look-style prompt text lives on the `look_styles` DB table.

function AISettingsGroup() {
  const { rows } = useConfigCtx();

  // Ordered scene-prompt levers (system prompt → framing suffix → model knobs).
  const scenePromptRows = [...SCENE_PROMPT_KEYS]
    .map((key) => rows.find((r) => r.key === key))
    .filter((r): r is NonNullable<typeof r> => r !== undefined);

  return (
    <div className="space-y-3">

      {/* Scene Prompt — OpenAI scene-prompt generation levers */}
      {scenePromptRows.length > 0 && (
        <CollapsibleSection
          title="Scene Prompt"
          icon={<Wand2 className="w-4 h-4 text-muted-foreground" />}
          description="How OpenAI turns a fact template into the scene prompts used for AI image generation: the system prompt, the image-to-image framing suffix, and the model / sampling knobs."
          storageKey="admin_section_config_scene_prompt"
        >
          <div className="space-y-3">
            {scenePromptRows.map((row) => (
              <ConfigCard
                key={row.key}
                row={row}
                textareaRows={row.key === "scene_prompt_system" ? 16 : 4}
              />
            ))}
          </div>
        </CollapsibleSection>
      )}

      {/* AI Generation Limits */}
      <CollapsibleSection
        title="AI Generation Limits"
        icon={<Sliders className="w-4 h-4 text-muted-foreground" />}
        description="How many AI-generated backgrounds are shown in the Meme Builder gallery."
        storageKey="admin_section_config_ai_gen_limits"
      >
        <div className="space-y-4">
          <ModelParamRow paramKey="ai_gallery_display_limit" />
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

  const budgetRows  = rows.filter((r) => BUDGET_KEYS.has(r.key));
  const limitRows   = rows.filter((r) => LIMIT_KEYS.has(r.key));
  const emailRows   = rows.filter((r) => EMAIL_KEYS.has(r.key));
  const zazzleRows  = rows.filter((r) => ZAZZLE_KEYS.has(r.key));
  const genericRows = rows.filter((r) =>
    !r.key.startsWith("style_suffix_") &&
    r.key !== "debug_mode_active" &&
    !MODEL_CONFIG_KEYS.has(r.key) &&
    !SCENE_PROMPT_KEYS.has(r.key) &&
    !BUDGET_KEYS.has(r.key) &&
    !LIMIT_KEYS.has(r.key) &&
    !EMAIL_KEYS.has(r.key) &&
    !ZAZZLE_KEYS.has(r.key) &&
    !BILLING_ONLY_KEYS.has(r.key)
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
            <div className="flex items-center justify-between gap-4 flex-wrap">
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
                className={`shrink-0 min-h-[44px] px-6 py-2.5 rounded-lg font-semibold text-sm transition-colors flex items-center gap-2 ${
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

              {/* Generic (non-AI, non-budget, non-limits) config rows */}
              {genericRows.map((row) => <ConfigCard key={row.key} row={row} />)}

              {/* Budget — collapsible section */}
              {budgetRows.length > 0 && (
                <CollapsibleSection
                  title="Budget"
                  icon={<DollarSign className="w-4 h-4 text-muted-foreground" />}
                  description="Per-tier AI generation spending caps and the reset cadence."
                  storageKey="admin_section_config_budget"
                >
                  <div className="space-y-3">
                    {budgetRows.map((row) => <ConfigCard key={row.key} row={row} />)}
                  </div>
                </CollapsibleSection>
              )}

              {/* Limits — collapsible section */}
              {limitRows.length > 0 && (
                <CollapsibleSection
                  title="Limits"
                  icon={<Shield className="w-4 h-4 text-muted-foreground" />}
                  description="Image storage, meme, and gallery caps applied per user or per fact."
                  storageKey="admin_section_config_limits"
                >
                  <div className="space-y-3">
                    {limitRows.map((row) => <ConfigCard key={row.key} row={row} />)}
                  </div>
                </CollapsibleSection>
              )}

              {/* Email — collapsible section */}
              {emailRows.length > 0 && (
                <CollapsibleSection
                  title="Email"
                  icon={<Mail className="w-4 h-4 text-muted-foreground" />}
                  description="Sender addresses and retry schedule for all outgoing transactional emails."
                  storageKey="admin_section_config_email"
                >
                  <div className="space-y-3">
                    {emailRows.map((row) => <ConfigCard key={row.key} row={row} />)}
                    <RetryTimelinePanel />
                  </div>
                </CollapsibleSection>
              )}

              {/* Zazzle — collapsible section */}
              {zazzleRows.length > 0 && (
                <CollapsibleSection
                  title="Zazzle"
                  icon={<ShoppingBag className="w-4 h-4 text-muted-foreground" />}
                  description="Zazzle Create-a-Product API parameters used when building merch links."
                  storageKey="admin_section_config_zazzle"
                >
                  <div className="space-y-3">
                    {zazzleRows.map((row) => <ConfigCard key={row.key} row={row} />)}
                  </div>
                </CollapsibleSection>
              )}

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

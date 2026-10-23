import { AdminLayout } from "@/components/admin/AdminLayout";
import { CollapsibleSection } from "@/components/CollapsibleSection";
import { Settings, Loader2, Bot, Sliders, DollarSign, Shield, Mail, Clock, Wand2, ClipboardList } from "lucide-react";
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
  "user_max_images",
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

const MODERATION_KEYS = new Set([
  "review_duplicate_threshold",
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
  const { stdEdits, stdDirty } = useConfigCtx();

  const resolved = RETRY_DELAY_MS_KEYS.map((key) => {
    const raw = stdEdits[key]?.value;
    const ms = raw !== undefined && raw !== "" ? Number(raw) : NaN;
    return { ms: isFinite(ms) && ms >= 0 ? ms : null };
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

  const dirtyFlags = RETRY_DELAY_MS_KEYS.map((key) => stdDirty(key));
  const anyUnsaved = dirtyFlags.some(Boolean);

  return (
    <div className="rounded-lg border p-4 space-y-3 border-border bg-muted/40">
      <div className="flex items-center gap-2">
        <Clock className="w-4 h-4 shrink-0 text-muted-foreground" />
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
          Predicted retry timeline
        </p>
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
// Hosts the editable AI Image Style Prompt plus the AI gallery display limit.
// The model + sampling (temperature, max tokens, reasoning effort) for these
// calls come from the shared General Intelligence engine (/admin/engines).
// Image-engine config also lives at /admin/engines; look-style prompt text
// lives on `look_styles`.

function AISettingsGroup() {
  const { rows } = useConfigCtx();

  const imageStyleRows = [...SCENE_PROMPT_KEYS]
    .map((key) => rows.find((r) => r.key === key))
    .filter((r): r is NonNullable<typeof r> => r !== undefined);

  return (
    <div className="space-y-3">

      {/* AI Style Prompt Configuration */}
      {imageStyleRows.length > 0 && (
        <CollapsibleSection
          title="AI Style Prompt Configuration"
          icon={<Wand2 className="w-4 h-4 text-muted-foreground" />}
          description="The system prompt that turns a fact into the image style prompt sent to fal.ai (text → scene, per fact). The model + sampling come from the General Intelligence engine (/admin/engines)."
          storageKey="admin_section_config_ai_style_prompts"
        >
          <div className="space-y-5">
            {imageStyleRows.length > 0 && (
              <div className="space-y-3">
                <h4 className="text-xs font-bold uppercase tracking-wide text-muted-foreground">AI Image Style Prompt</h4>
                {imageStyleRows.map((row) => (
                  <ConfigCard
                    key={row.key}
                    row={row}
                    textareaRows={row.key === "scene_prompt_system" ? 16 : 4}
                  />
                ))}
              </div>
            )}

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
    stdEdits, setStdEdits,
    saveStd, stdDirty, load,
  } = state;

  const budgetRows  = rows.filter((r) => BUDGET_KEYS.has(r.key));
  const limitRows   = rows.filter((r) => LIMIT_KEYS.has(r.key));
  const emailRows   = rows.filter((r) => EMAIL_KEYS.has(r.key));
  const moderationRows = rows.filter((r) => MODERATION_KEYS.has(r.key));
  const genericRows = rows.filter((r) =>
    !r.key.startsWith("style_suffix_") &&
    !MODEL_CONFIG_KEYS.has(r.key) &&
    !SCENE_PROMPT_KEYS.has(r.key) &&
    !BUDGET_KEYS.has(r.key) &&
    !LIMIT_KEYS.has(r.key) &&
    !EMAIL_KEYS.has(r.key) &&
    !MODERATION_KEYS.has(r.key) &&
    !BILLING_ONLY_KEYS.has(r.key)
  );

  const ctxValue: ConfigPageCtx = {
    rows, stdEdits, setStdEdits,
    saveStd, stdDirty, load,
  };

  return (
    <AdminLayout title="Configuration">
      <ConfigPageContext.Provider value={ctxValue}>
        <div className="max-w-5xl space-y-4">

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

              {/* Moderation — collapsible section */}
              {moderationRows.length > 0 && (
                <CollapsibleSection
                  title="Moderation"
                  icon={<ClipboardList className="w-4 h-4 text-muted-foreground" />}
                  description="Controls for the fact review and duplicate-flagging workflow."
                  storageKey="admin_section_config_moderation"
                >
                  <div className="space-y-3">
                    {moderationRows.map((row) => <ConfigCard key={row.key} row={row} />)}
                  </div>
                </CollapsibleSection>
              )}

              {/* AI Settings — collapsible group */}
              <CollapsibleSection
                title="AI Settings"
                icon={<Bot className="w-4 h-4 text-muted-foreground" />}
                description="Models, parameters and style suffixes."
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

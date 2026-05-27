import { pgTable, varchar, text, integer, boolean, jsonb, timestamp, numeric, index } from "drizzle-orm/pg-core";

/**
 * Generative engines (image, video, utility) the platform can call via fal.ai.
 *
 * Replaces the scattered admin_config strings + hardcoded `buildFalInput`
 * switch the legacy video route used. Each row carries:
 *   - identity (id, endpoint, provider)
 *   - capability metadata (kind, allowed options, supported modes)
 *   - audio handling strategy (per the engine's actual interface)
 *   - parameter mapping schema (interpreter walks this JSONB to translate
 *     pipeline-level params into the model's actual input shape)
 *
 * Adding a new engine = one row insert. Adding an engine with a never-before-
 * seen parameter shape may still require teaching the interpreter a new
 * mapping primitive, but the four engines that matter for v1 (Veo Lite,
 * Veo Fast, Kling v3, Seedance 2.0 Fast) plus Grok cover all current shapes.
 */
export const enginesTable = pgTable("engines", {
  /** Stable id (kebab-case). Examples: "veo-3.1-lite", "kling-v3-standard". */
  id: varchar("id", { length: 64 }).primaryKey(),
  /** Provider key for admin filters. Examples: "google", "bytedance", "xai", "kuaishou", "fal". */
  provider: varchar("provider", { length: 32 }).notNull(),
  /** Endpoint string the fal client will be called with. */
  endpointId: varchar("endpoint_id", { length: 128 }).notNull(),
  /** Human-readable label for admin UI and the engine selector. */
  label: varchar("label", { length: 128 }).notNull(),
  /** Short blurb shown to power users in the engine selector. */
  description: text("description").notNull().default(""),
  /** "image" = stylization (PuLID family). "video" = image-to-video. "utility" = subtitle, classifier, etc. */
  kind: varchar("kind", { length: 16 }).notNull(),
  /** Tier required to USE this engine in the wizard. "legendary" gates the entire video flow today; "free"/"registered" reserved for future. */
  tierRequirement: varchar("tier_requirement", { length: 32 }).notNull().default("legendary"),
  /** When true this engine is the wizard default for its kind. Exactly one default per kind is enforced at the application layer. */
  isDefault: boolean("is_default").notNull().default(false),
  /** When false the engine is hidden from the wizard, admin selector, and any default-resolution lookups. */
  isActive: boolean("is_active").notNull().default(true),
  /** Sort order for selectors. Lower = first. */
  sortOrder: integer("sort_order").notNull().default(0),
  /**
   * Allowed video lengths in seconds. JSONB int[]. Example: [4, 6, 8] for Veo Lite,
   * [3, 5, 8, 10, 15] for Kling. Null/empty for non-video engines.
   */
  allowedDurationsSec: jsonb("allowed_durations_sec"),
  /** Default duration in seconds (must appear in allowed_durations_sec when present). */
  defaultDurationSec: integer("default_duration_sec"),
  /** Allowed resolutions, JSONB string[]. Example: ["720p"] for Veo Lite, ["720p", "1080p"] for Veo Fast. */
  allowedResolutions: jsonb("allowed_resolutions"),
  /** Default resolution. */
  defaultResolution: varchar("default_resolution", { length: 16 }),
  /** Allowed aspect ratios as the model's own strings. Example: ["16:9", "1:1", "9:16"]. */
  allowedAspectRatios: jsonb("allowed_aspect_ratios"),
  /** Default aspect ratio. */
  defaultAspectRatio: varchar("default_aspect_ratio", { length: 16 }),
  /**
   * Engine-specific modes (Grok: ["normal", "fun", "custom"]). Empty/null hides the mode selector
   * in the advanced sheet for this engine. "spicy" reserved for future NSFW rollout — never seeded.
   */
  supportedModes: jsonb("supported_modes"),
  /** Default mode (must be in supported_modes when present). */
  defaultMode: varchar("default_mode", { length: 32 }),
  /**
   * How this engine surfaces voiceover/dialogue:
   *   - "native_lipsync"        — engine generates audio + lipsync natively (Veo). Pass dialogue as a dedicated param.
   *   - "prompt_cue"            — append `Voiceover should say, "X"` to the motion prompt (Grok).
   *   - "voice_control"         — engine has an explicit voice-control field (Kling v3).
   *   - "native_audio_boolean"  — engine takes a `generate_audio` boolean and improvises (Seedance).
   *   - "none"                  — engine cannot produce audio (PuLID, utility, etc.).
   */
  audioHandling: varchar("audio_handling", { length: 32 }).notNull().default("none"),
  /**
   * Parameter-mapping schema for the interpreter. JSONB shape:
   *   {
   *     params: [
   *       { name: "image_url",     from: "imageUrl",   type: "string", required: true },
   *       { name: "prompt",        from: "motionPrompt", type: "string", required: true },
   *       { name: "duration",      from: "durationSec",  type: "int",    default: 6 },
   *       { name: "aspect_ratio",  from: "aspectRatio",  type: "string", map: { landscape: "16:9", square: "1:1", portrait: "9:16" } },
   *       { name: "resolution",    from: "resolution",   type: "string", default: "720p" },
   *       { name: "mode",          from: "mode",         type: "string", default: "normal", omitIfDefault: false },
   *       { name: "end_user_id",   from: "endUserId",    type: "string", required: true }  // Seedance ToS
   *     ],
   *     // Optional: static params always included
   *     static: { generate_audio: true }
   *   }
   * Adding a new engine with a new parameter shape may require extending the
   * interpreter's primitive set (e.g. adding a new `type`). The four v1 engines
   * are all covered by string/int/map/static.
   */
  paramSchema: jsonb("param_schema").notNull(),
  /**
   * Cost-estimation hints used by the pre-flight budget gate. The runtime still
   * consults the fal pricing cache for authoritative costs; this is fallback
   * for newly-added engines whose pricing hasn't been observed yet.
   */
  estimatedCostUsdPerCall: numeric("estimated_cost_usd_per_call", { precision: 10, scale: 6 }),
  /** When non-null, multiplied by duration seconds. Used for variable-length engines. */
  estimatedCostUsdPerSecond: numeric("estimated_cost_usd_per_second", { precision: 10, scale: 6 }),
  /** EMA seed for the loading bar's expected run time. Default 30000ms; updated after each successful run. */
  expectedRunMs: integer("expected_run_ms").notNull().default(30000),
  /**
   * Default sampling temperature for LLM ("llm" kind / provider "openai")
   * engines. Null for media engines. Admin-editable; call sites may override.
   */
  defaultTemperature: numeric("default_temperature", { precision: 4, scale: 2 }),
  /**
   * Default max output tokens for LLM engines. Null for media engines.
   * Admin-editable; call sites may override.
   */
  defaultMaxTokens: integer("default_max_tokens"),
  /**
   * Default reasoning effort ("low" | "medium" | "high") for reasoning LLM
   * models (gpt-5 / o-series). Ignored by gpt-4.x. Null for media engines.
   */
  defaultReasoningEffort: varchar("default_reasoning_effort", { length: 16 }),
  /**
   * Power-user feature flag gate. When non-null, the engine is only visible in
   * the wizard's engine selector to users who have this feature flag enabled.
   * Today this is just "engine_experiments" for all non-default video engines.
   */
  featureFlagRequired: varchar("feature_flag_required", { length: 64 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  /**
   * Soft-delete tombstone. NULL = live; non-NULL = archived. The admin UI
   * keeps archived engines visible under a separate "Archived" tab so we
   * preserve `video_jobs.video_engine_id` FK lineage without losing the
   * row entirely. Code-side reconciliation respects the tombstone — an
   * engine you've archived stays archived even if its definition still
   * exists in code.
   */
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (table) => [
  index("IDX_engines_kind_active").on(table.kind, table.isActive),
  index("IDX_engines_kind_default").on(table.kind, table.isDefault),
]);

export type Engine = typeof enginesTable.$inferSelect;
export type InsertEngine = typeof enginesTable.$inferInsert;

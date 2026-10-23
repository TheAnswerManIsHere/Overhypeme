import { pgTable, varchar, text, integer, boolean, jsonb, timestamp, numeric, index } from "drizzle-orm/pg-core";

/**
 * Generative engines (image, utility, llm) the platform can call. (The video
 * kind went with video in launch Phase 4, and its duration, mode, audio and
 * per-second cost columns with removal 11, migration 0110.)
 *
 * Replaces the scattered admin_config strings + a hardcoded `buildFalInput`
 * switch. Each row carries:
 *   - identity (id, endpoint, provider)
 *   - capability metadata (kind, allowed options)
 *   - parameter mapping schema (interpreter walks this JSONB to translate
 *     pipeline-level params into the model's actual input shape)
 *
 * Adding a new engine = one row insert. Adding an engine with a never-before-
 * seen parameter shape may still require teaching the interpreter a new
 * mapping primitive.
 */
export const enginesTable = pgTable("engines", {
  /** Stable id (kebab-case). Examples: "nano-banana-2", "flux-2-pro". */
  id: varchar("id", { length: 64 }).primaryKey(),
  /** Provider key for admin filters. Examples: "fal", "google", "openai". */
  provider: varchar("provider", { length: 32 }).notNull(),
  /** Endpoint string the fal client will be called with. */
  endpointId: varchar("endpoint_id", { length: 128 }).notNull(),
  /** Human-readable label for admin UI and the engine selector. */
  label: varchar("label", { length: 128 }).notNull(),
  /** Short blurb shown to power users in the engine selector. */
  description: text("description").notNull().default(""),
  /** "image" = generation/stylization. "utility" = classifier, etc. "llm" = text. */
  kind: varchar("kind", { length: 16 }).notNull(),
  /** Tier required to USE this engine in the wizard. "legendary" is the default; "free"/"registered" reserved for future. */
  tierRequirement: varchar("tier_requirement", { length: 32 }).notNull().default("legendary"),
  /** When true this engine is the wizard default for its kind. Exactly one default per kind is enforced at the application layer. */
  isDefault: boolean("is_default").notNull().default(false),
  /** When false the engine is hidden from the wizard, admin selector, and any default-resolution lookups. */
  isActive: boolean("is_active").notNull().default(true),
  /** Sort order for selectors. Lower = first. */
  sortOrder: integer("sort_order").notNull().default(0),
  /** Allowed resolutions, JSONB string[], as the engine itself speaks them. */
  allowedResolutions: jsonb("allowed_resolutions"),
  /** Default resolution. */
  defaultResolution: varchar("default_resolution", { length: 16 }),
  /** Allowed aspect ratios as the model's own strings. Example: ["16:9", "1:1", "9:16"]. */
  allowedAspectRatios: jsonb("allowed_aspect_ratios"),
  /** Default aspect ratio. */
  defaultAspectRatio: varchar("default_aspect_ratio", { length: 16 }),
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
   * It was "engine_experiments" for the non-default video engines, which went
   * with video; no catalogue engine sets it today.
   */
  featureFlagRequired: varchar("feature_flag_required", { length: 64 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  /**
   * Soft-delete tombstone. NULL = live; non-NULL = archived. The admin UI
   * keeps archived engines visible under a separate "Archived" tab so
   * historical references to an engine id keep resolving without losing the
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

import { pgTable, varchar, text, integer, boolean, timestamp } from "drizzle-orm/pg-core";

/**
 * Motion presets for the video flow. Renamed from `videoStylesTable` in
 * MBFO-4 — the table was always motion-oriented (motion prompts + camera
 * direction), not visual-look oriented. Visual look now lives in
 * `look_styles`. The two tables compose: a video meme uses one look style
 * (applied to the source still) and one motion preset (applied to the video
 * model's prompt + structured camera fields).
 *
 * Adapter-friendly: prompt-only engines (Grok, Veo, Sora) consume
 * `motionPrompt`; engines with explicit camera primitives (Luma, Pika) read
 * the optional structured fields (`cameraMotion`, `motionIntensity`).
 */
export const motionPresetsTable = pgTable("motion_presets", {
  id: varchar("id", { length: 64 }).primaryKey(),
  label: varchar("label", { length: 128 }).notNull(),
  description: text("description").notNull().default(""),
  /** Natural-language motion + camera direction string. Sent to prompt-only video engines. */
  motionPrompt: text("motion_prompt").notNull().default(""),
  /**
   * Optional structured camera primitive for engines that support it (Luma's
   * `camera_motions`, Pika's `camera_motion`). Examples: "static", "dolly_in",
   * "dolly_out", "pan_left", "pan_right", "tilt_up", "tilt_down", "zoom_in",
   * "zoom_out", "orbit_left", "orbit_right", "crane_up", "crane_down".
   */
  cameraMotion: varchar("camera_motion", { length: 32 }),
  /**
   * Optional 1-5 motion intensity hint for engines with a numeric knob
   * (Pika's `motion`, Runway's intensity). Higher = more motion. Null for
   * "use engine default."
   */
  motionIntensity: integer("motion_intensity"),
  /** Hex string for the gradient placeholder card shown before preview gif loads. */
  gradientFrom: varchar("gradient_from", { length: 32 }).notNull().default("#000000"),
  gradientTo: varchar("gradient_to", { length: 32 }).notNull().default("#333333"),
  /** Object-storage path to a short preview gif/mp4 illustrating the motion. */
  previewGifPath: text("preview_gif_path"),
  sortOrder: integer("sort_order").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type MotionPreset = typeof motionPresetsTable.$inferSelect;
export type InsertMotionPreset = typeof motionPresetsTable.$inferInsert;

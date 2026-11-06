-- Launch Phase 8, increment 1 (plan docs/plans/PLAN_PHASE8_ENGINE_EVALUATION.md,
-- "Data Model and Migration Impact", items 1, 2, 2b, 4 and 5): the image engine
-- becomes a parameter, and every attempt records the engine that drew it.
--
-- EXPAND, NOT CONTRACT (migrations-and-backfills.md, *Expand, then contract*).
-- Every step leaves the previous release working:
--
-- 1. engines gains five code-owned columns, reconciled from the catalogue at
--    boot: image_mode ('t2i' | 'i2i' | null), family, price_model,
--    size_vocabulary (nullable), and retired (NOT NULL DEFAULT false, so an
--    insert by the previous release's reconciler, which names none of them,
--    gets false). Nothing marks a row retired here; increment 4 does.
-- 2. image_prompt_attempts gains actual_image_engine_id and request_settings,
--    both nullable. The plan asked for actual_image_engine_id NOT NULL in this
--    migration; that is a contract step, because the previous release inserts
--    attempts without the column during a publish, so it waits for its own
--    migration once this release is the published one. The backfill below
--    covers every row that exists when it runs; a row the previous release
--    writes afterwards is one more row state, read correctly by this release
--    (a null means the release that wrote it could only route by mode, to
--    nano-banana-2 or nano-banana-2-edit), and converted by the contract
--    migration's own idempotent pass before it sets NOT NULL.
-- 3. admin_config gains image_engine_t2i and image_engine_i2i, seeded to the
--    engines the worker has always used, so rendering is unchanged until an
--    admin changes them. The previous release never reads them.
-- 4. look_styles gains 3d-cartoon and caricature (the Phase 8 stylisation
--    round's two new styles), each suffix within the compiler's 180-character
--    RENDER STYLE bound. No preview image yet: Phase 7's picker owns previews.
--
-- Row states for the backfill: an attempt with a null engine and generation
-- mode 'i2i' becomes nano-banana-2-edit; any other null becomes nano-banana-2
-- (the only two engines history can hold: imagePromptJobs.ts chose them by
-- string until this release). A row already set is untouched. A second run
-- updates nothing. Counts are reported.
ALTER TABLE "engines" ADD COLUMN IF NOT EXISTS "image_mode" varchar(4);--> statement-breakpoint
ALTER TABLE "engines" ADD COLUMN IF NOT EXISTS "family" varchar(64);--> statement-breakpoint
ALTER TABLE "engines" ADD COLUMN IF NOT EXISTS "price_model" jsonb;--> statement-breakpoint
ALTER TABLE "engines" ADD COLUMN IF NOT EXISTS "size_vocabulary" jsonb;--> statement-breakpoint
ALTER TABLE "engines" ADD COLUMN IF NOT EXISTS "retired" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "image_prompt_attempts" ADD COLUMN IF NOT EXISTS "actual_image_engine_id" varchar(64);--> statement-breakpoint
ALTER TABLE "image_prompt_attempts" ADD COLUMN IF NOT EXISTS "request_settings" jsonb;--> statement-breakpoint
DO $$
DECLARE
  v_i2i bigint;
  v_t2i bigint;
BEGIN
  UPDATE image_prompt_attempts SET actual_image_engine_id = 'nano-banana-2-edit'
   WHERE actual_image_engine_id IS NULL AND generation_mode = 'i2i';
  GET DIAGNOSTICS v_i2i = ROW_COUNT;
  UPDATE image_prompt_attempts SET actual_image_engine_id = 'nano-banana-2'
   WHERE actual_image_engine_id IS NULL;
  GET DIAGNOSTICS v_t2i = ROW_COUNT;
  RAISE NOTICE '[0123] attempts backfilled: % to nano-banana-2-edit, % to nano-banana-2', v_i2i, v_t2i;
END $$;--> statement-breakpoint
INSERT INTO admin_config (key, value, data_type, label, description, is_public)
VALUES
  ('image_engine_t2i', 'nano-banana-2', 'text',
   'Image engine: text-to-image',
   'The engine that draws every text-to-image render: hero renders, the free background, moderation''s generic scenario. Must name an active image engine whose mode is text-to-image; the admin engines screen''s "Set default" writes it. Default: nano-banana-2.',
   false),
  ('image_engine_i2i', 'nano-banana-2-edit', 'text',
   'Image engine: reference-photo editing',
   'The engine that draws every render with a reference photo: a member''s face in the scene, and moderation''s reference scenarios. Must name an active image engine whose mode is editing; the admin engines screen''s "Set default" writes it. Default: nano-banana-2-edit.',
   false)
ON CONFLICT (key) DO NOTHING;--> statement-breakpoint
INSERT INTO "look_styles" ("id", "label", "description", "prompt_suffix", "prompt_suffix_reference", "sort_order", "is_active")
VALUES
  ('3d-cartoon', '3D Cartoon', 'A still from a 3D animated feature film.',
   'Rendered as a 3D animated feature-film still: stylized cartoon proportions, soft rounded forms, smooth subsurface-lit materials, and bright global illumination.',
   'Reimagine this person/scene as a 3D animated feature-film still: stylized cartoon proportions, soft rounded forms, smooth subsurface-lit materials, and bright global illumination.',
   20, true),
  ('caricature', 'Caricature', 'A classic hand-drawn caricature.',
   'Drawn as a classic caricature illustration: exaggerated signature features on an oversized head, a small body, expressive linework, and bold painted color.',
   'Transform this person into a classic caricature illustration: exaggerated signature features on an oversized head, a small body, expressive linework, and bold painted color.',
   21, true)
ON CONFLICT ("id") DO NOTHING;

-- The gag generator on GPT-6 Astra with a per-fact humor note (plan
-- docs/plans/PLAN_GAG_GENERATOR.md, approved by David 2026-11-13). Expand only.
--
-- facts.humor_note: why the fact is funny and what a picture must preserve,
--   approved by a moderator (confirm or correction of a generated joke read).
--   Null on every existing fact; nothing backfills it, and nothing but a
--   moderator's action writes it.
-- facts.humor_note_approved_by / _approved_at: who approved it and when.
-- admin_config fact_visual_concepts_engine_id: repointed to the new
--   openai-gag-writer engine whatever it held (a custom value would otherwise
--   keep drafting gags on another model, against David's choice of Astra).
--   The previous value is kept in admin_config
--   fact_visual_concepts_engine_id_before_0137 for recovery. The engine row
--   itself is upserted from code at boot (engines/catalogue.ts); the setting
--   names it before it exists only until the first boot after this migration,
--   and generation refuses a missing engine rather than falling back.
-- Rollback: a code rollback, then restore the recorded value. The three
--   nullable columns stay, so no human note is destroyed.
ALTER TABLE "facts" ADD COLUMN IF NOT EXISTS "humor_note" text;--> statement-breakpoint
ALTER TABLE "facts" ADD COLUMN IF NOT EXISTS "humor_note_approved_by" varchar REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "facts" ADD COLUMN IF NOT EXISTS "humor_note_approved_at" timestamp with time zone;--> statement-breakpoint
DO $$
DECLARE
  v_prev text;
  v_changed integer := 0;
BEGIN
  SELECT value INTO v_prev FROM admin_config WHERE key = 'fact_visual_concepts_engine_id';
  IF v_prev IS DISTINCT FROM 'openai-gag-writer' THEN
    INSERT INTO admin_config (key, value, data_type, label, description, is_public)
    VALUES ('fact_visual_concepts_engine_id_before_0137', COALESCE(v_prev, ''), 'string',
            'Visual Concepts — Engine before migration 0137',
            'The value fact_visual_concepts_engine_id held before migration 0137 pointed it at openai-gag-writer. Kept for recovery; nothing reads it.',
            false)
    ON CONFLICT (key) DO NOTHING;
    INSERT INTO admin_config (key, value, data_type, label, description, is_public)
    VALUES ('fact_visual_concepts_engine_id', 'openai-gag-writer', 'string',
            'Visual Concepts — Engine',
            'Engine id for the LLM that drafts each fact''s joke read and three candidate visual gags. Default: openai-gag-writer (GPT-6 Astra). There is no fallback: an unusable engine fails generation.',
            false)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
    v_changed := 1;
  END IF;
  RAISE NOTICE '[0137] gag engine setting: previous %, changed %', COALESCE(v_prev, '(none)'), v_changed;
END $$;

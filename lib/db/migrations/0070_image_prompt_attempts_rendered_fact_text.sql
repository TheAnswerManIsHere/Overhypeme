-- Phase 2 render-prompt fidelity: freeze the RENDERED (subject/pronoun-resolved)
-- fact text on each image_prompt_attempts row, instead of re-rendering the
-- {NAME}/{SUBJ} template at job time. Snapshotting it here makes a render
-- reproducible (the generator saw exactly this text) and removes the last
-- code path that could leak unresolved template tokens into a production prompt.
-- Nullable: rows inserted before this migration have no frozen text; the job
-- handler renders those on the fly (or fails with a clear legacy error).

ALTER TABLE "image_prompt_attempts" ADD COLUMN IF NOT EXISTS "rendered_fact_text" text;

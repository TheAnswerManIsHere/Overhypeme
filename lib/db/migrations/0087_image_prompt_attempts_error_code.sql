-- PR-A (NB2 prompt restructure, rev 7 plan §12): add a typed, durable failure
-- code to image_prompt_attempts. A DETERMINISTIC (terminal) prompt-generation
-- failure now records BOTH the safe human `error` message AND a typed
-- `error_code` (e.g. `invalid_persisted_enrichment`, `style_snapshot_invalid`,
-- `required_budget_overflow`), so the render-poll payload can classify failures
-- by code instead of parsing a "code: message" string. Nullable: a success or a
-- transient/legacy failure carries no code. Both columns are cleared when a
-- later attempt succeeds.
ALTER TABLE "image_prompt_attempts" ADD COLUMN IF NOT EXISTS "error_code" varchar(64);

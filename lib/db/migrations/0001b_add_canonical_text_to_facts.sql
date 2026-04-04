-- Migration: Add canonical_text and is_active columns to facts table

-- canonical_text stores the canonical plain-English rendering of a tokenized
-- fact template (e.g. {NAME} → "Alex", {SUBJ} → "they", {doesn't|don't} → "don't").
-- Embeddings are computed from this canonical text rather than the raw template,
-- which eliminates token-syntax noise in duplicate detection.
ALTER TABLE facts ADD COLUMN IF NOT EXISTS canonical_text text;

-- is_active soft-delete flag (default true)
ALTER TABLE facts ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;

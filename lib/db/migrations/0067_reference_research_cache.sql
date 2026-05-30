-- Reference research cache (admin "Research Reference" tool).
--
-- The admin enrichment editor's Cultural / Insider References editor has a
-- per-row "Research Reference" button. Clicking it calls the OpenAI Responses
-- API with the web_search_preview tool to look up the cultural reference + its
-- visual implication, then returns a structured ReferenceResearchResult.
--
-- These results are admin-facing and cost real API spend (OpenAI Responses
-- API with web_search_preview is ~3× a plain chat call). To avoid burning
-- spend re-researching the same reference across admin sessions, we cache
-- by a SHA-256 hash of (referenceType + canonicalReference + sourcePhrase +
-- factText) — chosen because the same canonical reference applied to a
-- different fact may need a different visualImplication, but the same
-- reference + same fact should always produce the same result.
--
-- Lifecycle:
--   1. Admin clicks Research → service computes cache_key.
--   2. If a row exists AND (expires_at IS NULL OR expires_at > NOW()),
--      return the cached result with fromCache=true.
--   3. Otherwise call OpenAI, validate, upsert, return.
--   4. `forceRefresh` request body field bypasses cache and replaces the row.
--
-- No retention sweep in v1 — low volume during initial rollout.

CREATE TABLE reference_research_cache (
  cache_key VARCHAR(128) PRIMARY KEY,
  input JSONB NOT NULL,
  result JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ
);

CREATE INDEX IDX_reference_research_cache_created_at
  ON reference_research_cache(created_at DESC);

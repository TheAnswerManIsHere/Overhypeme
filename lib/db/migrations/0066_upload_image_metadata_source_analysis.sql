-- Phase 2 — source-image analysis cache on upload_image_metadata.
--
-- The source-image analyzer (Tier-1 fal detector + Tier-2 heuristics + optional
-- Tier-3 AI vision fallback) costs real money per call. Cache the analysis
-- result on the upload row, keyed by `arachnid_sha256_hex` (already populated
-- per upload). On subsequent renders of the same image, the analyzer reads
-- the cached SourceImageAnalysis directly when `source_image_analysis_version`
-- matches the current SOURCE_IMAGE_ANALYZER_VERSION constant.
--
-- Both columns nullable: not all uploads will be analyzed (admin runs, legacy
-- rows, derivatives). Version bump in code invalidates the cache implicitly.

ALTER TABLE upload_image_metadata
  ADD COLUMN source_image_analysis JSONB,
  ADD COLUMN source_image_analysis_version VARCHAR(16);

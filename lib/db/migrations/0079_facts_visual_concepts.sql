-- Candidate Visual concepts (Slice 2A): the frontier planner auto-drafts 3
-- distinct "describe the picture" concepts during prep; the moderator picks /
-- edits / ignores. These two columns are TRANSIENT, latest-only prep metadata
-- mirroring pexels_status / enrichment_status — regenerate overwrites, they are
-- NOT provenance, a promoted artifact, or rollback history.
--
--   visual_concept_candidates jsonb  — the stored blob: 3 candidates + token
--                                      validity + provenance + reviewId /
--                                      candidateVersionId / source / inputHash.
--   visual_concept_status varchar(16) — lifecycle: "pending" | "ok" | "failed".
--                                       Null on facts that never ran concept gen.
--
-- Idempotent (IF NOT EXISTS) per repo migration discipline; the hash-based
-- runner (migrate.ts) treats already-exists DDL as pre-applied. Source of truth:
-- lib/db/src/schema/facts.ts.

ALTER TABLE "facts" ADD COLUMN IF NOT EXISTS "visual_concept_candidates" jsonb;
--> statement-breakpoint
ALTER TABLE "facts" ADD COLUMN IF NOT EXISTS "visual_concept_status" varchar(16);

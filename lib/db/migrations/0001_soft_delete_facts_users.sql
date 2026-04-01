-- Migration: Add isActive (soft-delete flag) to facts and users tables
-- This migration adds a boolean `is_active` column (NOT NULL DEFAULT true) to both
-- the `facts` and `users` tables, enabling soft-delete behavior.

ALTER TABLE "facts" ADD COLUMN IF NOT EXISTS "is_active" boolean NOT NULL DEFAULT true;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "is_active" boolean NOT NULL DEFAULT true;

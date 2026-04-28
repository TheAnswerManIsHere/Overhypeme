-- Add 'lame' value to review_reason enum.
-- ALTER TYPE ... ADD VALUE cannot run inside a transaction in Postgres, so we
-- drop the enum and recreate it with all four values instead, converting the
-- column via a temporary text cast.

ALTER TABLE "pending_reviews"
  ALTER COLUMN "reason" TYPE text
  USING "reason"::text;

DROP TYPE IF EXISTS "public"."review_reason";

CREATE TYPE "public"."review_reason" AS ENUM('duplicate', 'spam', 'offensive', 'lame');

ALTER TABLE "pending_reviews"
  ALTER COLUMN "reason" TYPE "public"."review_reason"
  USING CASE
    WHEN "reason" = 'duplicate' THEN 'duplicate'::"public"."review_reason"
    WHEN "reason" = 'spam'      THEN 'spam'::"public"."review_reason"
    WHEN "reason" = 'offensive' THEN 'offensive'::"public"."review_reason"
    WHEN "reason" = 'lame'      THEN 'lame'::"public"."review_reason"
    ELSE NULL
  END;

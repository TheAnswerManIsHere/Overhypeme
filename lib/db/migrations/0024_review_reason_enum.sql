CREATE TYPE "public"."review_reason" AS ENUM('duplicate');

ALTER TABLE "pending_reviews"
  ALTER COLUMN "reason" TYPE "public"."review_reason"
  USING CASE
    WHEN "reason" = 'duplicate' THEN 'duplicate'::"public"."review_reason"
    ELSE NULL
  END;

ALTER TYPE "public"."review_reason" ADD VALUE IF NOT EXISTS 'spam';
ALTER TYPE "public"."review_reason" ADD VALUE IF NOT EXISTS 'offensive';

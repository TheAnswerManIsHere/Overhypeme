ALTER TABLE "users" ADD COLUMN "google_linked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "apple_linked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'oauth_provider'
  ) THEN
    UPDATE "users" SET "google_linked" = true WHERE "oauth_provider" = 'google';
    UPDATE "users" SET "apple_linked" = true WHERE "oauth_provider" = 'apple';
  END IF;
END $$;

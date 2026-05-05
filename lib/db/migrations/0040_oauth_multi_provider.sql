ALTER TABLE "users" ADD COLUMN "google_linked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "apple_linked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "users" SET "google_linked" = true WHERE "oauth_provider" = 'google';--> statement-breakpoint
UPDATE "users" SET "apple_linked" = true WHERE "oauth_provider" = 'apple';

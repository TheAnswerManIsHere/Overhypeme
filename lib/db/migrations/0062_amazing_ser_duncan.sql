ALTER TABLE "facts" ADD COLUMN "enrichment" jsonb;--> statement-breakpoint
ALTER TABLE "facts" ADD COLUMN "primary_archetype" varchar(64);--> statement-breakpoint
ALTER TABLE "facts" ADD COLUMN "subtype" varchar(64);--> statement-breakpoint
ALTER TABLE "facts" ADD COLUMN "overhype_fit" varchar(16);--> statement-breakpoint
ALTER TABLE "facts" ADD COLUMN "adult_suitability" varchar(24);--> statement-breakpoint
ALTER TABLE "pending_reviews" ADD COLUMN "enrichment" jsonb;--> statement-breakpoint
ALTER TABLE "pending_reviews" ADD COLUMN "enrichment_status" varchar(16);--> statement-breakpoint
CREATE INDEX "facts_primary_archetype_idx" ON "facts" USING btree ("primary_archetype");--> statement-breakpoint
CREATE INDEX "facts_adult_suitability_idx" ON "facts" USING btree ("adult_suitability");
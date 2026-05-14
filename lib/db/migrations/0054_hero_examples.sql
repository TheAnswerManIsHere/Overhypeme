-- MBFO-2: hero_examples — curated demo assets shown on the wizard's Step 1.
--
-- Each row is one demo. Image rows point at a still; video rows point at an
-- MP4 plus an optional poster frame. The wizard fetches the active set per
-- artifact_type and picks one at random per visit.
--
-- Population: empty at launch. MBFO-2 ships with a fallback placeholder
-- when the set is empty. Admin tooling to curate the set lands in a
-- follow-up.
--
-- Soft-delete is implemented as `active = false` so analytics joins against
-- past selections remain valid. Never hard-delete.

CREATE TABLE "hero_examples" (
	"id" serial PRIMARY KEY NOT NULL,
	"artifact_type" varchar(8) NOT NULL CHECK ("artifact_type" IN ('image', 'video')),
	"asset_url" text NOT NULL,
	"poster_url" text,
	"caption_label" text DEFAULT '' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_hero_examples_type_active_sort" ON "hero_examples" USING btree ("artifact_type","active","sort_order");

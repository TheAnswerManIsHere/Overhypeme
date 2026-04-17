CREATE TABLE IF NOT EXISTS "route_visit_stats" (
	"route_key" varchar(50) PRIMARY KEY NOT NULL,
	"visit_count" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

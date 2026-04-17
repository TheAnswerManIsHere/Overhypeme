CREATE TABLE "route_stat_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"route_key" varchar(50) NOT NULL,
	"delta" integer DEFAULT 1 NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);

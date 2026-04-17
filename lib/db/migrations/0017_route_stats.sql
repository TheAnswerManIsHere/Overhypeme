CREATE TABLE IF NOT EXISTS "route_stats" (
  "route_key" varchar(50) PRIMARY KEY NOT NULL,
  "visit_count" integer NOT NULL DEFAULT 0,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

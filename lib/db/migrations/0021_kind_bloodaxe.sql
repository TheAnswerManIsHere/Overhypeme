ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "dispute_notifications" boolean DEFAULT true NOT NULL;

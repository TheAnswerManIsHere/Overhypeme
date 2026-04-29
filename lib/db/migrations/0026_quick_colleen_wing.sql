ALTER TABLE "membership_history" ADD COLUMN IF NOT EXISTS "performed_by_admin_id" varchar;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'membership_history_performed_by_admin_id_users_id_fk'
  ) THEN
    ALTER TABLE "membership_history" ADD CONSTRAINT "membership_history_performed_by_admin_id_users_id_fk" FOREIGN KEY ("performed_by_admin_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;

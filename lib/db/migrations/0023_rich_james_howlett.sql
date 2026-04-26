ALTER TABLE "lifetime_entitlements" ADD COLUMN IF NOT EXISTS "granted_by_admin_id" varchar;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'lifetime_entitlements_granted_by_admin_id_users_id_fk'
      AND table_name = 'lifetime_entitlements'
  ) THEN
    ALTER TABLE "lifetime_entitlements"
      ADD CONSTRAINT "lifetime_entitlements_granted_by_admin_id_users_id_fk"
      FOREIGN KEY ("granted_by_admin_id") REFERENCES "public"."users"("id")
      ON DELETE no action ON UPDATE no action;
  END IF;
END $$;

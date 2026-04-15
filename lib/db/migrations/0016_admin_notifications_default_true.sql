DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'admin_notifications'
  ) THEN
    ALTER TABLE "users" ALTER COLUMN "admin_notifications" SET DEFAULT true;
    UPDATE "users" SET "admin_notifications" = true WHERE "is_admin" = true AND "admin_notifications" = false;
  ELSE
    ALTER TABLE "users" ADD COLUMN "admin_notifications" boolean DEFAULT true NOT NULL;
  END IF;
END $$;

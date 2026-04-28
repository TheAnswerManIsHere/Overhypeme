ALTER TABLE "membership_history" ADD COLUMN "performed_by_admin_id" varchar;--> statement-breakpoint
ALTER TABLE "membership_history" ADD CONSTRAINT "membership_history_performed_by_admin_id_users_id_fk" FOREIGN KEY ("performed_by_admin_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;

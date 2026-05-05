ALTER TABLE "oauth_pending_states" ADD COLUMN "link_user_id" varchar;--> statement-breakpoint
ALTER TABLE "oauth_pending_states" ADD CONSTRAINT "oauth_pending_states_link_user_id_users_id_fk" FOREIGN KEY ("link_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;

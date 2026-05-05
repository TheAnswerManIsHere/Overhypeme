-- Allows an OAuth callback to link a provider to an existing user account
-- rather than creating / logging into a new one. The link_user_id column
-- carries the authenticated user's ID into the pending state; the callback
-- handler checks for it and updates the user's oauth_provider instead of
-- doing the full upsert-and-login flow.
ALTER TABLE "oauth_pending_states" ADD COLUMN "link_user_id" varchar;

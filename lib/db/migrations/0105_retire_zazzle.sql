-- Launch Phase 4, removal 4: merch and Zazzle are deleted (#744; plan
-- docs/plans/PLAN_PHASE4_CUT_AND_PRUNE.md, approved by David 2026-10-22).
--
-- The meme page's wear action, the /wear page, the fact page's merch buttons,
-- the Zazzle export and redirect routes, the affiliate click and stats routes
-- and the admin Affiliate screen are gone from the code in the same PR, with
-- the boot seed that inserted the Zazzle settings. This removes the rows only
-- they used. Data only: no schema changes. Forward-only and idempotent: the
-- delete is keyed, so a re-run is a no-op.
--
-- ADMIN-CURATED ROWS for the cut feature are deleted: the seven zazzle_*
-- settings (associate, referral, request type, store, category, editing and
-- tracking cookie). Nothing else reads them.
--
-- KEPT, as the plan's scope draws it (removal 4 changes no schema): the
-- affiliate_clicks table and its two enums. They lose their writer here and
-- are a removal-11 orphan candidate. Exported meme images under meme-exports/
-- in object storage are not touched by a migration.
DO $$
DECLARE
  v_config integer := 0;
BEGIN
  WITH gone AS (
    DELETE FROM admin_config
      WHERE key IN ('zazzle_at', 'zazzle_rf', 'zazzle_ax', 'zazzle_sr', 'zazzle_cg', 'zazzle_ed', 'zazzle_tc')
      RETURNING 1
  )
  SELECT count(*)::integer INTO v_config FROM gone;

  RAISE NOTICE '[0105] Zazzle config rows deleted: %', v_config;
END $$;

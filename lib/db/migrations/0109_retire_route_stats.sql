-- Launch Phase 4, removal 9: the route-visit counters are deleted (#744; plan
-- docs/plans/PLAN_PHASE4_CUT_AND_PRUNE.md, approved by David 2026-10-22).
--
-- The browser's per-visit and per-session posts to /api/route-stats, the
-- public top-routes read the app used to choose which pages to prefetch, the
-- admin dashboard's Top Pages table and its /api/admin/route-stats read are
-- gone from the code in the same PR. The app now prefetches from this
-- browser's own visit counts (localStorage) or its defaults.
--
-- NOT CAPTURED, by design (the rule from 0105 covers admin-curated rows): both
-- tables are anonymous telemetry the browsers wrote, nothing an admin entered,
-- and nothing reads them. Their row counts are logged.
--
-- ORDERING: runs after the old processes are stopped (the stop-first cutover),
-- because the old server writes both tables on every page view. Forward-only
-- and idempotent: the counts read each table only if it exists, and the drops
-- are IF EXISTS.
DO $$
DECLARE
  v_counters integer := 0;
  v_events integer := 0;
BEGIN
  IF to_regclass('route_stats') IS NOT NULL THEN
    EXECUTE 'SELECT count(*)::integer FROM route_stats' INTO v_counters;
  END IF;
  IF to_regclass('route_stat_events') IS NOT NULL THEN
    EXECUTE 'SELECT count(*)::integer FROM route_stat_events' INTO v_events;
  END IF;
  RAISE NOTICE '[0109] route_stats rows dropped: %, route_stat_events rows dropped: %', v_counters, v_events;
END $$;
--> statement-breakpoint

DROP TABLE IF EXISTS route_stat_events;
--> statement-breakpoint
DROP TABLE IF EXISTS route_stats;

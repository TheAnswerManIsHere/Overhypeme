-- Phase 1 of the async-queue hardening plan: worker liveness telemetry.
--
-- Nothing in the system currently records whether the async-jobs worker is
-- still ticking. This table is that record, keyed by (instance_id, lane)
-- rather than by lane alone because `.replit` sets
-- deploymentTarget = "autoscale" and index.ts starts the worker in EVERY
-- instance with no leader election — one row per lane would let N instances
-- overwrite each other, so a wedged worker could hide behind a healthy peer.
--
-- Purely additive: new table, new index, one new admin_config row. No existing
-- row is read or rewritten, so there is no row-state matrix to reason about
-- and no backfill.

CREATE TABLE IF NOT EXISTS "worker_lane_heartbeats" (
  "instance_id" varchar(64) NOT NULL,
  "lane" varchar(32) NOT NULL,
  "worker_protocol_version" integer NOT NULL,
  "last_scheduled_at" timestamp with time zone NOT NULL DEFAULT now(),
  "last_tick_completed_at" timestamp with time zone,
  "in_flight_count" integer NOT NULL DEFAULT 0,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "worker_lane_heartbeats_instance_id_lane_pk"
    PRIMARY KEY ("instance_id", "lane")
);

-- The prune sweep and every liveness query filter on last_scheduled_at.
CREATE INDEX IF NOT EXISTS "worker_lane_heartbeats_last_scheduled_idx"
  ON "worker_lane_heartbeats" ("last_scheduled_at");

-- How long a heartbeat row may go unwritten before its instance is treated as
-- departed: excluded from liveness evaluation, then deleted.
--
-- The trade-off cuts both ways, which is why it is admin-config rather than a
-- constant: prune eagerly and a briefly-paused instance is forgotten, prune
-- lazily and a routine autoscale scale-down reads as a stalled lane. Bounds are
-- supplied deliberately — PATCH /admin/config/:key only enforces a range when
-- the row carries one, so a seed without min/max would accept a negative TTL.
INSERT INTO "admin_config" ("key", "value", "data_type", "label", "description", "min_value", "max_value")
VALUES (
  'instance_heartbeat_ttl_minutes',
  '15',
  'integer',
  'Worker instance heartbeat TTL (minutes)',
  'How long a worker instance may go without writing a lane heartbeat before it is treated as departed and pruned. Too low and a briefly-paused instance is forgotten; too high and an autoscale scale-down looks like a stalled lane.',
  1,
  1440
)
ON CONFLICT ("key") DO NOTHING;

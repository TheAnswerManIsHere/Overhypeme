-- What fal billed for a render's request (Issue #1304, increment B; plan
-- docs/plans/PLAN_RENDER_HISTORY.md D5). EXPAND only: two nullable columns.
-- Nothing the previous release reads or writes changes.
--
--   billed_usd          what fal's Billing Events API reports for this
--                       request (cost_total, summed over its events), once
--                       fal has posted it. Null until then, or when no bill
--                       was found.
--   billing_checked_at  when a lookup last succeeded whose window covered this
--                       request. Null means "not checked yet"; set with
--                       billed_usd still null means "checked, no bill found
--                       yet". A failed lookup touches neither (Astra C5).
--
-- Filled by an hourly task (api-server lib/renderBilling.ts) with the
-- existing billing-read key (FAL_BILLING_API_KEY); viewing a render's history
-- makes no fal call.
--
-- Row-state matrix: every existing row starts null / null ("not checked
-- yet"); the task fills them over its hourly runs. No backfill here.
-- Rollback: drop the two columns; nothing else reads them.

ALTER TABLE image_generation_requests ADD COLUMN IF NOT EXISTS billed_usd numeric(10, 4);
ALTER TABLE image_generation_requests ADD COLUMN IF NOT EXISTS billing_checked_at timestamptz;

-- The task's work list: requests that reached fal and have no bill yet,
-- least recently checked first.
CREATE INDEX IF NOT EXISTS "IDX_igr_billing_unfilled"
  ON image_generation_requests (billing_checked_at NULLS FIRST, created_at)
  WHERE billed_usd IS NULL AND vendor_request_id IS NOT NULL;

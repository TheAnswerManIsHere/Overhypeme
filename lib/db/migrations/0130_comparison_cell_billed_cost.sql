-- Launch Phase 8: what fal actually charged for each comparison picture
-- (David, 2026-11-11: "Please backfill all the generations with the actual
-- costs. I want to know for real what GPT Image is costing."). Expand only.
--
-- comparison_cells.billed_usd: the `cost_total` of this cell's fal request,
--   read from fal's Billing Events API by `fal_request_id`. Null until fal
--   has billed the request and the app has read it; 0 for a request fal did
--   not charge (a refusal). Cleared by the one re-run a failed cell is allowed.
ALTER TABLE "comparison_cells" ADD COLUMN IF NOT EXISTS "billed_usd" numeric(12, 6);

-- Lower the visual planner's default reasoning effort from xhigh to high in
-- EXISTING environments. PR #158 changed the code-catalogue seed, but
-- `default_reasoning_effort` is admin-editable, so reconcileEngines() preserves
-- the persisted value on every boot — only fresh databases picked up the new
-- default. This applies the intended latency/cost reduction to rows still on
-- the old seed value.
--
-- DML-only, idempotent: gated on the row still holding 'xhigh', so an admin
-- who has already tuned the effort (high, medium, ...) is left alone, and the
-- admin panel remains free to raise it back to xhigh afterwards.
UPDATE "engines"
SET "default_reasoning_effort" = 'high', "updated_at" = now()
WHERE "id" = 'openai-visual-planner'
  AND "default_reasoning_effort" = 'xhigh';

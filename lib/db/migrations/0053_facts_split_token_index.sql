-- MBFO-1: facts.split_token_index — token-boundary index where the rendered
-- fact splits into top/bottom captions for the meme canvas.
--
-- Nullable on purpose: the column is added empty in this session. A separate
-- session wires the gpt-4o-mini population step into the fact-creation flow
-- (routes/import.ts and routes/facts.ts). Until then, render-fact.ts retains
-- its midpoint heuristic and treats NULL as "fall back to the heuristic".
--
-- No index. This is a per-row payload, not a query predicate.

ALTER TABLE "facts" ADD COLUMN "split_token_index" integer;

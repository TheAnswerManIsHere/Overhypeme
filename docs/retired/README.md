# Retired features

The ledger of every feature the launch programme deletes (launch Phase 4,
#744). The rule is [`decisions.md`](../ai-context/decisions.md), *2026-10-21 ·
A cut feature's record is a ledger row, plus a lessons page only where a
rebuild needs one*.

**How to get a retired feature back.** Its code and its docs as they stood are
one checkout away: `git checkout pre-cut/<feature>`. The tag sits on the last
`main` commit that carried the feature (the first parent of the deleting PR's
squash commit). The paths in a row are paths *at that tag*; most no longer
exist on `main`. Why it was cut lives in the decision the row names, which
stays on `main`.

**Lessons pages** (`docs/retired/<feature>.md`) exist only where a rebuild
would otherwise rediscover something the docs at the tag do not hold. A row
with no lessons page means the tag's docs are the whole record.

| Feature | Removed | Decision | Tag | Deleting PR | Docs at the tag | Lessons |
|---|---|---|---|---|---|---|
| Legacy meme studio (`MemeStudio.tsx`, the legacy `MemeBuilder.tsx`, `AiBgPicker`, `SourceImageConfirmModal`, `MemeStudioVideoTab`, `MemeMagicVideo`, `VideoBuilder`, `PostCreateShareScreen`; the `VITE_MBFO_WIZARD` flag; the routes only it called) | 2026-10-22 | `decisions.md` 2026-10-17 (*Verification work tied to the legacy meme studio is killed*) and 2026-10-22 | `pre-cut/legacy-meme-studio` | removal 1 of #744 | `docs/ai-context/meme-and-video-studio.md` (*Frontend entry points*, legacy branch); `docs/manual/6-meme-and-video-studio.md`; UAT: `PR223_RENDER_REPRODUCIBILITY_UAT.md`, `PR224_NB2_PROMPT_HARDENING_UAT.md`, `PR256_VARIANT_INDEPENDENCE_UAT.md`, `PR288_QUEUE_HEALTH_SURFACE_UAT.md`, `PR425_ADMIN_PERMISSIONS_CORE_UAT.md`, `PR443_BUDGET_GATE_FAIL_CLOSED_UAT.md` | none |

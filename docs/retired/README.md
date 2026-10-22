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
| Legacy meme studio (`MemeStudio.tsx`, the legacy `MemeBuilder.tsx`, `AiBgPicker`, `SourceImageConfirmModal`, `MemeStudioVideoTab`, `MemeMagicVideo`, `VideoBuilder`, `PostCreateShareScreen`; the `VITE_MBFO_WIZARD` flag; the routes only it called) | 2026-10-22 | `decisions.md` 2026-10-17 (*Verification work tied to the legacy meme studio is killed*) and 2026-10-22 | `pre-cut/legacy-meme-studio` | #748 | `docs/ai-context/meme-and-video-studio.md` (*Frontend entry points*, legacy branch); `docs/manual/6-meme-and-video-studio.md`; UAT: `PR223_RENDER_REPRODUCIBILITY_UAT.md`, `PR224_NB2_PROMPT_HARDENING_UAT.md`, `PR256_VARIANT_INDEPENDENCE_UAT.md`, `PR288_QUEUE_HEALTH_SURFACE_UAT.md`, `PR425_ADMIN_PERMISSIONS_CORE_UAT.md`, `PR443_BUDGET_GATE_FAIL_CLOSED_UAT.md` | none |
| Video (the async pipeline and the legacy one-shot route, the wizard's video step and its image-or-video first step, the video engines and the caption utility, motion presets and the Video Styles admin screen, video hero examples, `/video/:id`, the fact page's video gallery, the `video_generation` feature, the `video_jobs`, `motion_presets` and `video_styles` tables and the memes video columns) | 2026-10-22 | `decisions.md` 2026-10-05 (*Launch scope: video deferred*) | `pre-cut/video` | #752 | `docs/ai-context/meme-and-video-studio.md` (*AI video memes*, *Tier gates*, *Where media actually lives*); `docs/manual/6-meme-and-video-studio.md`; UAT: `PR218_ADMIN_INPUT_VALIDATION_UAT.md`, `PR308_GLOBAL_RATE_LIMITER_UAT.md`, `PR402_PRIVATE_MEME_VISIBILITY_UAT.md`, `PR425_ADMIN_PERMISSIONS_CORE_UAT.md`, `PR443_BUDGET_GATE_FAIL_CLOSED_UAT.md` | [`video.md`](video.md) |
| PuLID (the wizard's "AI you" source with its loading takeover and no-face fallback, the PuLID job routes, the user generate route and the meme page's stylise toggle and "Try AI mode" upsell, the `pulid-flux` engine and its run-time estimate, the reference-photo half of the AI meme pipeline, the wizard's AI style presets, the `meme_pulid_stylize` and `meme_ai_background` features, the AI-styling filters on `/users/me/uploads`, the meme page's Legendary/PuLID own-meme split and the face-in-scene upsell copy; data retired by migration 0104) | 2026-10-22 | `decisions.md` 2026-10-05 (*Launch scope*); `launch-feature-inventory.md` D17, D18 | `pre-cut/pulid` | #TBD | `docs/ai-context/meme-and-video-studio.md` (*AI image memes*, *Tier gates*); `docs/manual/6-meme-and-video-studio.md`; UAT: `PR223_RENDER_REPRODUCIBILITY_UAT.md`, `PR287_PAYMENTS_ENTITLEMENT_MODEL_UAT.md`, `PR308_GLOBAL_RATE_LIMITER_UAT.md`, `PR425_ADMIN_PERMISSIONS_CORE_UAT.md`, `PR443_BUDGET_GATE_FAIL_CLOSED_UAT.md` | [`pulid.md`](pulid.md) |

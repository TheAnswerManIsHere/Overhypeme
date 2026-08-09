# PR #256 — Variant independence — UAT

Your in-app acceptance test, David. This is the fix for the rule you stated:
*"the only thing that we should be doing with variants is tracking them as
having a parent-child relationship to the master fact… I don't want them to
be dependent upon their parents for any metadata."* A variant now has its own
memes, its own visual taxonomy/enrichment, its own Visual Concept, its own
stock/AI images — none of it borrowed from or blocked by its root anymore.

Companion engineering checklist:
the transient engineering checklist (deleted after execution) and the
[checklist handoff](./CLAUDE_CHECKLIST_HANDOFF_2026-08-09.md).

## What to expect

### 1. A variant with no images of its own now shows none — not the root's
- Find (or create) a variant of a fact that has Pexels/AI-meme images, where
  the **variant itself** has never generated its own.
- ✅ The variant's fact page / meme builder shows **no stock/AI images** for
  it, instead of silently displaying the root's. This is the correct,
  intended behavior now — it means the variant hasn't been backfilled yet
  (see item 4), not that something is broken.

### 2. A variant can generate its own images and AI memes
- Open a **variant** (not a root) in the admin Facts editor.
- ✅ The "Pexels Image Pipeline" panel is now visible and usable for a
  variant — it used to be hidden entirely, root-only.
- Click "Refresh images" on a variant. ✅ It succeeds and generates the
  variant's **own** stock images, independent of its root's.
- As a legendary user, try generating an AI meme background for a variant
  fact. ✅ It's accepted and generates — previously rejected with "AI meme
  generation only supported on root facts."

### 3. Editing a root's text no longer touches its variants
- Edit a root fact's text (with the confirmation phrase) while one of its
  variants has an unresolved review or an active enrichment job in flight.
- ✅ The root edit goes through immediately — it's no longer blocked waiting
  on the variant.
- ✅ The variant's own enrichment/`stale_for_reprocess` state is **untouched**
  by the root edit (previously, a confirmed root edit would mark every child
  variant stale, forcing them to re-enrich for no reason).

### 4. Bulk Media Backfill — new admin panel (Taxonomy Health page)
- Go to Admin → Taxonomy Health. ✅ A new **"Bulk Media Backfill"** section
  appears near the top, with three buttons: **Backfill images**, **Backfill
  Pexels**, **Backfill AI memes**. It's visible regardless of which health
  card filter is selected.
- Click **Backfill images**. ✅ A confirmation dialog appears; confirming
  enqueues durable jobs for every active fact (root or variant) missing
  images, and a live status line shows "N of M done" as jobs complete.
- ✅ Re-clicking the same button while jobs are still running is safe —
  already-queued facts dedupe onto their existing job rather than
  double-running.
- Try **Backfill AI memes** the same way. ✅ Same confirm → enqueue → live
  status pattern (this one calls paid OpenAI/fal.ai APIs, so the confirmation
  message says so).

### 5. Bulk send-back now reaches roots with active variants
- Find a root fact that's **stale for reprocess** (Taxonomy Health → "Stale
  for reprocess" card) **and** has an active variant.
- Previously: "Send back to review" on that root would fail with "This fact
  has active variants. Refresh the variants individually instead of the
  root."
- ✅ Now it succeeds — sending a root back to review no longer requires
  touching its variants first, since the root's refresh can no longer
  invalidate them.
- ✅ "Send next 50 stale" (the corpus-wide bulk button) now picks up roots
  with active variants too, instead of silently skipping them forever.

### 6. Repeated-failure protection (only observable if a fact genuinely keeps
failing send-back — most testers won't hit this naturally)
- If a fact's send-back has failed 3 times in a row, ✅ its Taxonomy Health
  row shows a **"3 failed attempts"** badge next to the send-back button, and
  it's no longer picked up by "Send next 50 stale" automatically.
- ✅ You can still deliberately retry it: check its row's box and use "Send
  selected" — that's the only way to clear the flag, and it works normally
  (no special rejection).
- ✅ If a "Send next 50 stale" run leaves any facts excluded this way, the
  status line calls it out explicitly ("N fact(s) excluded after repeated
  failures — investigate before considering the migration complete") so it's
  never silently missed.

## Regression smoke table

| Area | Expected |
|---|---|
| Root fact images, memes, enrichment | Unchanged — still works exactly as before |
| Public fact feed / detail for root facts | Unchanged |
| Send-back to review for a root with NO variants | Unchanged |
| Single-fact "Refresh images" on a root | Unchanged |
| Facts editor for a root fact | Unchanged |

## Known non-bugs / limitations

- **A variant may show no images until you (or a bulk backfill) explicitly
  generate them.** This is the correct, intended change — a variant no
  longer silently borrows its root's images. Run "Backfill images" /
  "Backfill Pexels" from the new Bulk Media Backfill panel to catch existing
  variants up.
- **The v6→v7 enrichment prompt-version bump** means every fact — root or
  variant — is now "stale for reprocess" until it's sent back through
  moderation again (send-back → promote). This is expected and is exactly
  what "Send next 50 stale" is for; run it repeatedly until `queued: 0`,
  `failed: 0`, `eligibleRemaining: 0`, **and** `repeatedFailureCount: 0` (or
  every flagged fact has been manually investigated via "Send selected") —
  all four together, not just the first three.
- **`factActivation.ts`'s reparenting guard is unchanged** — you still can't
  reparent a fact that itself has active children without deactivating them
  first. That's a structural rule (don't strand grandchildren), not part of
  this fix.

## Bug report template

> **Where:** (page / admin panel)
> **Did:** (steps)
> **Expected:** (what should happen per above)
> **Got:** (what actually happened)
> **Fact id (if any):**

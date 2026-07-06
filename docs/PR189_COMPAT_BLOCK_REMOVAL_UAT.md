# PR189 — Remove the compatibility render block · UAT (click-through)

> **For David.** In-app acceptance test confirming that a "poor"
> subject/fact-compatibility rating no longer blocks a render. Companion
> engineering checklist: `docs/PR189_COMPAT_BLOCK_REMOVAL_TEST_RUN.md`.
>
> **What changed:** the frontier planner rates how well a subject/fact
> pairing will render (strong/workable/risky/poor). It used to hard-block on
> "poor" — Generic (t2i) showed a **Blocked** tile and never spent a paid
> generation. Per your call ("drop the guard entirely… if it does something a
> bit wonky, that's fine — AI images are not meant to be ground truth"), that
> rating no longer blocks anything, in any mode. It still renders — the
> rating stays visible as an FYI, it just doesn't stop the image.

---

## Where to go

Admin → Moderation → open the review for the finger-countdown fact ("When
{NAME} gives you the finger…", Review #6810 if it's still there — otherwise
any fact you've previously seen show a **Blocked / `subject_fact_compatibility_poor`**
tile) → Step 3, **Test Renders**.

## The main fix: Generic (t2i) now renders

| # | Do this | Expect |
|---|---------|--------|
| 1 | Check **Generic (t2i)** and click **Run selected**. | It renders. **No "Blocked" tile.** You'll get an image (a bar scene, or whatever the current scene concept describes) — it may interpret the fact a little loosely; that's expected and fine. |
| 2 | Check **Male (i2i)** and **Female (i2i)** and run those too. | Both still render as before — this change doesn't touch i2i, which was never blocked. |
| 3 | Open the rendered tile's **Scenario diagnostics** (if you expand it). | You can still see the compatibility rating/reason if the planner drew one — it's just informational now, not a gate. |

If you happen to rerun the exact same fact multiple times, you might
occasionally see the planner rate it something other than "poor" (it's a
non-deterministic AI call) — that's normal and doesn't affect this test. The
point being verified is: **whatever the rating comes back as, the render
proceeds.**

## Regression smoke

| Area | Check |
|------|-------|
| Any other fact's Test Renders panel | Run a normal fact you'd expect to render cleanly (no history of blocking) — still works exactly as before. |
| Non-human (i2i) scenario | Still renders as before if you have a non-human reference set up for the review. |
| Moderator manual RATE (1–5) / FAILURE (Concept/Compiler) controls | Unaffected — those are your own scoring controls, separate from this rating. |

## Known non-bug limitations

- **A "poor"-rated render can still look off.** That's the accepted trade-off
  — instead of nothing, you now always get *something*, and it may
  occasionally miss the mark on a genuinely hard-to-visualize fact. This is
  the intended behavior change, not a bug to report.
- **The rating is not deterministic.** The same fact can draw a different
  rating on different attempts (the planner is a nonzero-temperature AI
  call). You may not always be able to reproduce a specific "poor" case on
  demand — that's expected, not evidence the fix isn't working.
- **Historical facts that already show a "Blocked" tile from before this PR
  keep showing it** until you rerun that scenario. Old blocked attempts are
  not retroactively re-rendered by this change.

## If something's off, report it like this

> **Fact / Review:** which fact, which review ID
> **Scenario:** Generic (t2i) / Male (i2i) / Female (i2i) / Non-human (i2i)
> **Expected:** it should render (possibly imperfectly), never show "Blocked"
> **Got:** what actually happened (still blocked? errored instead? something else?)

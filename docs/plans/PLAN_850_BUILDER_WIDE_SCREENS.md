# Plan — Issue #850: the meme builder uses the full screen on iPad and desktop

Short plan (one increment, one PR). Product code, production phase, product tier.

```plan-oracle
# Scope — Issue #850: the meme builder uses the full screen on iPad and desktop

## Direction served
Launch backlog wave 2 (Issue #628, approved by David 2026-11-21): the before-launch should-haves. #850 is in the launch plan at David's request (2026-11-03: "Make sure 850 is included as part of our 'get to launch' plan.").

## Product intent (David, verbatim, Issue #850, 2026-11-03)
> we should really allow the meme builder to use the full screen when on an iPad or desktop. Constraining it to mobile device scale on a big screen is really annoying and a bad UX.

What he saw: on an iPad in landscape, the builder keeps a phone-width layout. The preview sits in a narrow band at the top, the controls (photo, caption split, style, font size, colours, effect) are a narrow scrolling list beneath it, and most of the screen is empty on both sides.

## This increment
On a wide screen (iPad in landscape, a laptop, a desktop), the builder uses the space. The preview and the controls sit side by side. The preview is as large as the screen allows, so a caption can be judged, and the controls scroll in their own column beside it. The "Make my meme" action stays in reach without scrolling. On a phone, and on any screen too narrow for two columns, today's layout is unchanged.

The builder is one component (`MemeBuilderWizard` → `Step2Image`), mounted only from the fact page. The remix flow opens the same builder, so it gets the same treatment with no separate work.

## Must not change
- The phone layout: preview locked at the top, controls scrolling beneath, the action bar fixed at the bottom.
- Everything the builder does: photo upload, framing drag, caption split, styles, aspect ratio, visibility, saving, signed-out panel, the read-only pause on saving.
- The preview's rendering. It is the same canvas that produces the saved meme, only shown larger.
- The existing browser tests of the builder, which run at desktop and phone sizes. They keep passing, or move with the layout and are not dropped.

## Settled decisions
- The builder is a full-screen takeover with a top bar (MBFO). It stays one.
- Video and stock photos are cut (launch Phase 4), so the controls are the image ones only.

## Now / next / never
- Now: the builder's wide-screen layout, for the fact-page builder and the remix entry that shares it.
- Next (not this increment): other pages' wide-screen layouts; resizing the preview by dragging on a wide screen, beyond what exists today.
- Never here: new controls or new builder behaviour.

## Ceremony tier
Feature mode, production phase, product tier. Short plan, Astra review, David's approval, Codex code review on the PR. A UAT step for David on an iPad and on a desktop, since whether it feels right is a judgement.
```

## What this increment makes true

**Two layouts, chosen by the space on screen, not by device type.** The wide
layout applies whenever the viewport is at least 1024 px wide, in either
orientation. That covers an iPad in landscape, a laptop, a desktop browser
window (a tall one too) and a 12.9-inch iPad in portrait. Everything
narrower keeps today's stacked layout: a phone, an ordinary iPad in portrait
(820–834 px), and a narrow desktop window. At 820 px a ~420 px controls
column would leave the preview narrower than it is stacked, which is why
the line sits at 1024. The choice follows the space, not the
input device: `useDesktopModality` deliberately calls a touch tablet
"mobile", so it is not used here.

**The wide layout:**
- **The preview fills the left side.** It is fitted to the space beside the
  controls column and below the top bar (and the read-only notice, when
  shown), in proportion, for each of the three aspect ratios. It is centred,
  never cropped, and never larger than that space. Dragging the photo to
  frame it works as today.
- **The controls have their own column on the right**, about 420 px wide.
  It holds, in today's order, the aspect ratio, the photo (or the signed-out
  panel), the caption split, Advanced options, the caption-font status and
  any save error. The column scrolls on its own; the preview never scrolls.
- **"Make my meme" and the visibility choice sit at the foot of the controls
  column**, always in view. They no longer span the whole screen, so they
  never cover the preview, and the last control is never trapped under them,
  whichever visibility state is shown.

**One builder, two arrangements.** Turning an iPad or resizing a window
switches layout without losing anything: the photo, the framing, the
caption split, the style and the visibility choice all carry over, because
the same builder stays mounted and only its arrangement changes.

**Unchanged:** the phone and narrow layout, the canvas that draws the
preview and the saved meme (only its displayed size changes), saving, the
signed-out panel and the read-only pause.

## The resize handle (Q25, for David)

Today a handle under the preview drags it taller or shorter. The chosen
height is remembered, capped at 52% of the screen so the controls fit
underneath. In the wide layout the controls are beside the preview, not
under it, so that cap stops making sense.

My recommendation (Astra's too): in the wide layout the preview always fills
its space and has no handle. In the stacked layout the handle and its
remembered height stay as they are. The wide layout ignores the remembered
height but does not erase it. What is lost is a handle that only made sense
when the controls were underneath.

## What bounds it

- **Code touched:** the image step's arrangement, the preview's sizing in the
  wide layout, and the action bar's placement in the wide layout.
- **Not touched:** no new controls, no backend, no change to how anything
  saves.
- **Not here (next, if ever):** wide layouts for other pages; a resize
  handle on wide screens.

## How completion is recognised

- **ci, browser tests at 1180×820 (iPad landscape), 1440×900 (desktop) and
  1280×1600 (a tall desktop window):**
  - the preview is left of the controls column;
  - for square, portrait and landscape ratios, the preview keeps its
    proportions, stays inside its area, and reaches either the area's full
    width or its full height, allowing only for deliberate spacing and the
    drag hint, so no space it could use is left empty;
  - the controls column scrolls while the preview stays put;
  - with Advanced options open and Private selected, the last control can
    be scrolled clear of "Make my meme", and "Make my meme" is visible
    without scrolling.
- **ci, at 390×844 (phone) and 820×1180 (iPad portrait):** the stacked
  layout as today, resize handle included. The existing builder tests pass
  unchanged.
- **ci, a layout switch:** set a caption split and a style at 1180×820,
  resize to 820×1180 and back, and the choices are still there.
- **ci, the remembered preview height** (under Q25's recommendation): with a
  small height saved in the stacked layout, the wide layout ignores it, and
  switching back to stacked restores it, so it was never erased.
- **ci, the tests run in CI:** any new browser spec is added to the
  `e2e:screens` list in `artifacts/overhype-me/package.json`, which names its
  suites one by one.
- **judgement (David, UAT), on his iPad in landscape and on a desktop
  browser:** the builder uses the screen well, the caption can be judged at
  the preview's size, and the arrangement is comfortable.

## Questions for David

- **Q25: the resize handle on wide screens.**
  1. Wide layout: the preview always fills its space and has no handle;
     the stacked layout keeps the handle (recommended, Astra agrees).
  2. Keep a handle on wide screens too. This adds a second sizing rule for
     the wide layout and some work, for a preview that already fills the
     space.

## Amendment 1 — the biggest picture wins (David, 2026-11-24, approved as Q31: 1)

**Why:** in UAT T1, on a 12.9-inch iPad held upright (1024 px wide), the
fixed 1024 px rule chose side by side, and a landscape-shaped meme showed
small in a narrow column above empty space. David: *"I'm sure there's some type of algorithm we can define where you check to see what would make the image appear larger to a viewer. If it appears larger when side by side, it should use that layout, if it appears larger on top, use that."*

**The rule, replacing "at least 1024 px wide":**
- Whenever the viewport size or the picture shape changes, the builder
  computes the displayed picture size in each arrangement, for the current
  shape:
  - **side by side:** fitted to the area left of the 420 px controls column,
    below the top bar;
  - **stacked:** fitted to the screen's width, with its height capped at the
    stacked preview's height (the remembered handle height, or 38% of the
    screen by default).
- **The arrangement with the larger picture is used.**
- It switches away from the current arrangement only when the other is at
  least 10% larger, so near-ties do not flicker.
- **Q31: 1:** this includes a change of picture shape, so on an upright big
  iPad, tapping a different shape can move the controls between the side
  and the bottom.
- **Below 1024 px wide the rule does not run:** today's stacked layout and
  sizing stay, so a phone held either way never changes (Astra C6). At 1024 px
  and above, the stacked preview is no longer capped at about 450 px wide.
- The layout choice and the stacked preview use one effective height (the
  remembered height clamped to the current screen), so they never disagree
  after a resize (Astra C7).

**Completion, added:**
- **ci:** the decision is a pure function, unit-tested on a table of screens
  and shapes, phone to desktop, near-tie behaviour included.
- **ci:** a browser test at 1024×1366 shows a landscape-shaped picture stacked
  and wider than 900 px, and a portrait-shaped one side by side.
- **ci:** the existing wide-layout tests run at sizes and shapes where side by
  side still wins.
- **ci:** a phone held either way (390×844, 844×390) stays stacked for every
  shape; a large remembered height behaves the same in the choice and the
  preview across a resize.
- **judgement (David):** T1 on his upright iPad.

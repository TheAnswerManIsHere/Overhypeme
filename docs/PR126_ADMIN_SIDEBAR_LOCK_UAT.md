# Lock admin sidebar — user acceptance testing

Paired with **`docs/PR126_ADMIN_SIDEBAR_LOCK_TEST_RUN.md`** (the engineering
checklist). This is the click-through test for David.

## What you're verifying

In the admin panel, the **left menu used to scroll along with the content on the
right** — scroll down a long page and the nav drifted off too. Now the left menu
(and the top header) are **locked**: only the content on the right scrolls. If
your window is too short to show every menu item, the **sidebar gets its own
scrollbar** so you can still reach the rest — but it never moves just because the
content on the right moved.

**Nothing to switch on** — it's live. No new screen.

## Where to look

Any admin page with enough content to scroll — the **Facts** page is a good one.

## 1. The left menu stays put while content scrolls

1. Open **Admin → Facts** (or any long admin page).
2. Scroll the right-hand content all the way down.
   - **Expect:** the left menu and the top bar (page title · View Site · Sign
     Out) **stay exactly where they are**. Only the content moves.
   - **Expect NOT:** the menu sliding up/away as you scroll.

## 2. The sidebar scrolls on its own when the window is short

1. Make the browser window **short** (drag the bottom up, or zoom the page in to
   ~150%) until the list of admin menu items is taller than the window.
   - **Expect:** the **sidebar** gets its own scrollbar — you can scroll just the
     menu to reach the items at the bottom (e.g. the lower nav entries), while the
     content on the right keeps its own separate scroll.
   - **Expect NOT:** menu items becoming unreachable, or the menu only moving when
     you scroll the content.

## 3. Collapsed sidebar behaves the same

1. Click the collapse chevron (top of the sidebar) to shrink it to icons.
2. Repeat checks 1–2.
   - **Expect:** same behavior — icons stay fixed; the icon column scrolls on its
     own if the window is too short.

## 4. Mobile drawer still works

1. Narrow the window to a phone width (or open on mobile).
2. Tap the hamburger (☰) to open the menu drawer.
   - **Expect:** the drawer slides over the screen, its menu scrolls if long, and
     tapping a link or the backdrop closes it — exactly as before.

## 5. Overlay / dropdown smoke check

1. Open a page with **dropdowns or dialogs** inside the content — e.g. a fact's
   editor (Subject Realization / policy `<select>` menus), or the Runtime Prompt
   Preview controls.
2. Open a dropdown/select and a dialog near the bottom of the content.
   - **Expect:** the menu/dialog opens normally and isn't cut off by the
     content's scroll area; keyboard/Tab navigation still reaches controls below
     the fold.
   - If anything looks clipped, note it (see bug template) — this is the one area
     most likely to be affected by the change.

## Regression smoke

| Check | Expect |
| --- | --- |
| Right-hand content scroll | Smooth; only the content moves |
| Two scrollbars on the whole page | **None** — only the content pane (and the sidebar when short) scroll |
| Horizontal scrollbar | None appears from the sidebar width or content |
| Switching admin pages | Each page loads scrolled to top; sidebar stays put |

## Known non-bugs

- On a very short window the sidebar showing its **own** scrollbar is correct —
  that's the "scroll to reach the rest of the menu" behavior.
- The top header staying fixed (not scrolling away) is intentional.

## Bug report template

```
Page: [admin page]
Window size / zoom: […]
What I did: [scrolled content / shrank window / opened dropdown …]
Expected: […]
Saw: […]
```

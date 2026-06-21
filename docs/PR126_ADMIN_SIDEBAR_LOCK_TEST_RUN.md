# Lock admin sidebar (viewport-bounded shell) — automated test run

Paired with **`docs/PR126_ADMIN_SIDEBAR_LOCK_UAT.md`** (the click-through for
David). This is a **pure CSS layout** change — there is no unit/automated surface
for viewport-scroll semantics, so the safety net is a typecheck + manual checks.

## What changed (one file)

`artifacts/overhype-me/src/components/admin/AdminLayout.tsx` — three className
edits:

| Element | Before | After |
| --- | --- | --- |
| Outer shell (`<div>`, line 177) | `min-h-screen bg-background flex` | `h-screen bg-background flex overflow-hidden` |
| Sidebar `<nav>` (`renderNav`, line 131) | `flex-1 p-2 space-y-1 ${forMobile ? "overflow-y-auto" : ""}` | `flex-1 min-h-0 overflow-y-auto p-2 space-y-1` |
| Content pane (`<div>`, line 272) | `flex-1 p-3 sm:p-6 overflow-auto` | `flex-1 min-h-0 p-3 sm:p-6 overflow-auto` |

**Why:** `min-h-screen` let the shell grow with content, so the document
scrolled and the sidebar rode along. Bounding the shell to the viewport
(`h-screen` + `overflow-hidden`) makes the content pane's existing `overflow-auto`
the real scroll region. `min-h-0` lets the `flex-1` nav and content panes shrink
and scroll inside their flex columns (flex items default to `min-height:auto`,
which otherwise blocks shrinking). The desktop nav gets its own `overflow-y-auto`
so it scrolls independently when the viewport is too short for all items.

## Typecheck

```bash
pnpm --filter @workspace/overhype-me typecheck
```

**Expected:** the workspace currently reports **48 pre-existing errors** —
`TS6305` build-order errors for unbuilt sibling `lib/api-client-react/dist`, plus
implicit-`any` in unrelated page files (`Home.tsx`, `Library.tsx`, `Search.tsx`,
`TopFacts.tsx`, `Hashtags.tsx`, …). This was verified by running typecheck with
and without the change — **identical 48 both ways**, and **none reference
`AdminLayout.tsx`**. This change adds zero new errors. (Run
`pnpm --filter @workspace/overhype-me typecheck 2>&1 | grep -i AdminLayout` →
no output.)

## Manual checks (see UAT for the full click-through)

1. Desktop: scroll the right content — left menu + top header stay fixed.
2. Short viewport: the sidebar nav gets its own scrollbar and scrolls to the
   remaining items, independent of the content scroll.
3. Collapsed sidebar: repeat (1)–(2).
4. Mobile: hamburger drawer overlay still covers the screen and its nav scrolls.
5. No shell double-scrollbars; no unexpected horizontal scrollbar.
6. Overlay/dropdown smoke: a `<select>`/dialog/popover inside the content pane
   still opens and isn't clipped by the new scroll container.

## Deliberately not shipped

- No backend, schema, migration, or data change.
- No dynamic-viewport units (`h-dvh`) — `h-screen` is fine for the desktop-heavy
  admin; the mobile drawer is `fixed` and unaffected. Revisit only if mobile
  browser-chrome clipping is observed in UAT.
- No broader admin-layout refactor — scoped to the three-class fix.

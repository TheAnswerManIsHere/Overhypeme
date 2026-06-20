# Facts list variant hierarchy (PR #118) — user acceptance testing

Paired with **`docs/PR118_FACTS_LIST_VARIANT_HIERARCHY_TEST_RUN.md`**. Click-through
for David.

## What you're verifying

In the admin **Facts** list, a fact's **variants now appear indented and
collapsible under their parent**, instead of mixed in flat by date. The list
paginates by parent fact, so a parent and its variants always stay together.

## Where to look

Admin → **Facts** (the left-hand fact list).

## 1. Hierarchy while browsing

1. Open the Facts list (no search).
2. Find a fact that has variants — it shows a **chevron** (▶) and a small
   **variant count** (e.g. a branch icon + "2") next to its ID.
3. Click the chevron → its variants appear **indented** right below it, each
   tagged "variant". Click again → they collapse.
4. Confirm variants **no longer appear as separate top-level rows** elsewhere in
   the list, and a parent + its variants are always on the same page.
5. Page counts reflect **parent facts** (variants don't consume page slots).

## 2. Selecting + editing still works

1. Click a parent row → the edit panel opens as before (with its variants section).
2. Click an indented variant row → it selects the variant for editing.
3. Add a variant (in the edit panel) → the list refreshes and the new variant
   shows nested under its parent (parent auto-expands). Delete a variant → it
   drops out of the nested list.

## 3. Search stays grouped under parents

1. Search for text that appears in a **variant** (not its parent).
2. Confirm the **parent** row still shows (for context) with the **matching
   variant** nested under it, and roots with matches **auto-expand** so you can
   see them without clicking.
3. Search for a parent's text → the parent shows; its matching variants (if any)
   are nested.

## Regression smoke table

| Action | Expect |
|---|---|
| Browse list | parents with variants show chevron + count; expand → indented variants |
| Browse list | no variant appears as a top-level row; parent+variants on same page |
| Click parent / variant | selects for editing as before |
| Add / delete variant | list refreshes; hierarchy updates |
| Search variant text | parent surfaced for context, matching variant nested, auto-expanded |
| Show inactive toggle | still works; inactive rows dimmed |

## Known non-bugs

- Pages are counted by **parent fact**, so the "Page X of Y" total changed (it no
  longer counts variants as their own entries) — expected.
- While searching, a parent shows only the variants that matched (not all of its
  variants) — that's the "show matches grouped under parent" behavior.

## Bug report template

```
Where: admin Facts list
Action: <browse / expand / search "…" / add/delete variant>
Expected (per this doc): …
Saw: …
```

# Subject-name semantic-entity leak — user acceptance testing

Paired with **`docs/SEMANTIC_ENTITY_SUBJECT_LEAK_TEST_RUN.md`** (the automated
checklist). This is the click-through test for David.

## What you're verifying

In the fact-enrichment editor you saw the subject's name **"Alex"** listed as a
**Semantic Entity** (Entity kind `named_entity`, Visual referent "a person",
"Materially affects visual prompt" ✓), next to a legitimate one ("Firearms").

"Alex" is the canonical stand-in for whoever the meme is personalized to — it's
the **subject**, handled by the identity/rendering layer. It should **never** be
a semantic entity (those are for non-subject referents like Earth-vs-earth or
cultural references). When it leaks in, it pollutes the image prompt and even
forces the renderer to draw "a person" labelled Alex.

This fix removes the subject from semantic entities four ways: new enrichments
store clean, the renderer ignores any that slipped through, the model is told not
to extract it, and a backfill scrubs already-saved facts.

## 1. New / re-enriched facts are clean (the core fix)

1. Open any fact and **re-enrich** it (the enrichment editor's regenerate /
   re-classify action), or submit a new fact and let it enrich.
2. In the **Semantic Entities** list, confirm the subject name (**"Alex"**, or a
   bare `{NAME}`-style token) is **not** present.
3. Legitimate entities still appear — e.g. "Firearms", "Earth" — unchanged.

## 2. The fact from your screenshot, after the backfill

1. Replit runs the backfill (see the test-run doc): dry run first, then
   `-- --apply`.
2. Re-open that fact's enrichment editor. The **"Alex"** entity is **gone**;
   **"Firearms"** (and any other real entity) remains.
3. No re-enrichment was needed — the backfill edited the stored data in place.

## 3. The image prompt no longer echoes the subject as a referent

1. On a fact that used to carry the "Alex" entity, open the **Runtime Compiled
   Prompt Preview** and **Generate**.
2. In the compiled prompt's **STRICT CONSTRAINTS**, confirm there is **no**
   `"Alex" means a person` interpretation line, and the subject is not listed
   under `semanticEntitiesUsed`.
3. A control fact with a real entity (e.g. "Earth") still shows its referent
   correctly — the fix removes only the subject, nothing else.

## Regression smoke table

| Surface | Action | Expect |
|---|---|---|
| Enrichment editor | re-enrich a fact about the subject | no "Alex" / `{NAME}` semantic entity |
| Enrichment editor | a fact with a real entity (Earth, a brand) | that entity still listed |
| Backfill (Replit) | dry run | reports the rows it *would* change, writes nothing |
| Backfill (Replit) | `--apply`, then re-run | first run removes "Alex"; second reports 0 |
| Compiled prompt preview | previously-polluted fact | no `"Alex" means a person`, subject not in `semanticEntitiesUsed` |

## Known non-bugs / limitations

- **"Alex Honnold" (or any multi-word name containing "Alex") is preserved** —
  only the bare subject name is removed (exact match). A real person named in the
  fact is a legitimate entity.
- The guard keys off the **canonical placeholder** the renderer injects
  ("Alex"), not arbitrary real user names — by design, so it can't accidentally
  strip a genuine referent.
- This does not change anything about how the subject is drawn; it only removes
  the erroneous "subject as a semantic entity" record.

## Bug report template

```
Fact: <text>
Where: <enrichment editor / compiled prompt preview>
What I expected (per this doc): …
What I saw: …
Semantic Entities listed (paste): …
Compiled STRICT CONSTRAINTS / semanticEntitiesUsed (paste, if relevant): …
```

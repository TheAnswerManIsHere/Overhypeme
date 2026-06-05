# Redundant-mechanism taxonomy fix — user acceptance testing

You're the admin. The engine was misreading one class of joke: a fact that
states a result and *then* mentions the normal mechanism. The flagship case:

> David once threw a grenade and killed 50 people — then it exploded.

The engine used to call this **temporal causality inversion** and tried to stage
an explosion happening *before* the throw. That's the wrong joke. The real joke:
David's throw is so impossibly powerful that the grenade's explosion is
*redundant* — it still goes off later, but it didn't matter. This change teaches
the engine that read, and stages the image as the impossible throw (intact
grenade, shockwave) instead of a time paradox.

Engineering checklist: [`REDUNDANT_MECHANISM_TEST_RUN.md`](./REDUNDANT_MECHANISM_TEST_RUN.md)
(Replit owns it) — you don't need to read it.

---

## Heads-up before you start: everything looks "stale"

This change bumps the taxonomy classifier version (**v3 → v4**), because the
classifier now understands a new pattern. As designed, that flips **every**
previously-enriched fact to **stale enrichment** on the Taxonomy Health page.
That's expected, not a bug — it's the same staleness badge you already know,
telling you those facts were classified before this fix. Nothing re-enriches on
its own; you choose what to re-enrich.

For this UAT you only need to re-enrich **one** fact: the grenade.

## 1. Re-classify the grenade fact

1. Open **Admin → Facts**, find **"David once threw a grenade and killed 50
   people — then it exploded."**
2. Re-enrich it (single-fact re-enrich, or the Taxonomy Health **Re-enrich**
   action on that row).
3. Open its **Visual Taxonomy Enrichment** panel and confirm:
   - **Primary archetype:** `superhuman_physical_feat` (a physical feat — *not*
     "Temporal / causality inversion").
   - **Subtype:** a force/strength-style subtype (e.g. `force_scaled_action`).
   - **Modifiers** include **`normal_function_rendered_unnecessary`** (shown as a
     recognized chip, not a "new modifier" warning). You'll often also see
     `projectile_impact_power` and `avoid_gore`.

If it still says "Temporal / causality inversion", that's the bug — report it.

## 2. Check the Runtime Compiled Prompt Preview

Generate / open the **Runtime Compiled Prompt Preview** for the grenade fact.

**Expect to see** the joke read as an impossible *throw*:

- David in a powerful throwing follow-through pose.
- An **intact / unexploded** grenade in flight (a meteor-like trajectory,
  shockwave, motion trail, crater/debris).
- The explosion treated as redundant / secondary / not yet happened.

**Should NOT appear** anywhere in the intent, staging, or compiled prompt:

- "explosion occurring before the grenade is thrown" / "explosion before the
  throw"
- "impossible timing of the explosion"
- "show the impossibility of time and causality" / "time paradox"
- bodies, blood, gore, visible casualties, or readable casualty numbers (the
  scene proves scale through environmental impact only, even though the fact text
  says "killed").

## 3. Confirm real temporal jokes still work

Pick a genuinely time-bending fact, e.g. **"When David was born, he drove his mom
home from the hospital."** Re-enrich it and confirm it still classifies as
**Temporal / causality inversion**. We fixed the over-eager temporal reads — we
didn't break the legitimate ones.

## Regression smoke

| Area | Expect |
|---|---|
| Grenade fact, re-enriched | `superhuman_physical_feat` + `normal_function_rendered_unnecessary`; never temporal |
| Grenade compiled prompt | Impossible throw, intact grenade, shockwave; no "explosion before throw", no time paradox, no gore |
| A real temporal fact (baby drives mom home) | Still `temporal_causality_inversion` |
| New modifier chip in the enrichment editor | `normal_function_rendered_unnecessary` appears in the known-modifier suggestions and renders as a recognized chip |
| Every other fact | Shows the amber "stale (v3→v4)" badge until you choose to re-enrich it — expected |

## Known non-bug limitations

- **The whole catalog shows stale.** The version bump intentionally flags all
  prior enrichments. Re-enrich on your own schedule — there's no forced backfill,
  and admin-edited facts stay protected by the existing Re-enrich guard.
- **Redundant mechanism is a modifier, not a new category.** You won't find a new
  primary archetype in the dropdown — these jokes live under "Superhuman physical
  feat" with the new modifier. That's intentional.
- **"killed" stays in the fact text.** The taxonomy understands the joke; the
  image is kept non-graphic at the render layer, so the prompt talks about force
  and environmental impact rather than depicting harm.

---

## Bug report template

```
Section/step:
What I did:
What I expected:
What I saw:
Fact ID / screenshot:
```

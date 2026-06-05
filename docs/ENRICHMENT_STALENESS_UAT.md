# Enrichment staleness (version discrepancy) — user acceptance testing

You're the admin. You wanted to *see* when a fact's taxonomy enrichment is stale
— i.e. produced under an older taxonomy version than the one we run now — both on
the fact itself and on the Taxonomy Health page. Before this, the version lived
nowhere in the UI. Now it's on both.

Engineering checklist: [`ENRICHMENT_STALENESS_TEST_RUN.md`](./ENRICHMENT_STALENESS_TEST_RUN.md)
(Replit owns it) — you don't need to read it.

---

## 1. On the fact itself

Open **Facts** (admin) → pick any fact → find the **Visual Taxonomy
Enrichment** panel.

Top-right of that panel you'll now see a version badge:

- **Up to date** — green check, "Enrichment up to date (taxonomy vN)". The
  stored enrichment was produced under the current version.
- **Stale** — amber warning, "Enrichment is stale — re-enrich to refresh", with
  the exact discrepancy under it, e.g. `Taxonomy enrichment: v2 → v3`. If the
  fact also has a visual plan on an old version you'll see `Visual plan: v0 → v1`
  too. A pre-versioned blob reads `unversioned → v3`.

The badge is informational — re-enriching is done the usual way (the Taxonomy
Health page, or the fact's enrichment controls).

## 2. On the Taxonomy Health page

Open **Admin → Taxonomy Health**.

- **Header** now shows the baseline: "Current versions — taxonomy `v3` · visual
  plan `v1` · strategy `v2`". This is what everything is compared against.
- Select the **Stale enrichment** card (or **Stale visual plan**). Each
  version-stale row now shows a compact diff in its Health column, e.g.
  `enrich v2→v3` / `plan v0→v1`, right above the existing explanation line.

So you can scan the list and see *which version* each stale fact is on, not just
that it's stale.

## Regression smoke

| Area | Expect |
|---|---|
| A fact enriched under the current version | Green "up to date" badge; no diff row on the health page |
| A fact with no enrichment at all | Health page still shows "missing enrichment"; no confusing version diff on that row |
| Re-enrich a stale fact, then refresh | Badge flips to green; the row drops out of the "Stale enrichment" card |
| Existing Taxonomy Health cards / bulk actions | Unchanged — same counts, same buttons |

## Known non-bug limitations

- The "Visual strategy `v2`" shown in the header isn't stamped per-fact today, so
  it's shown as context only — staleness is driven by the taxonomy-enrichment and
  visual-plan versions.
- The badge tells you a fact is stale; it doesn't re-enrich on its own. Use the
  Taxonomy Health "Re-enrich" action (admin-edited facts are protected there).

---

## Bug report template

```
Section/step:
What I did:
What I expected:
What I saw:
Fact ID / screenshot:
```

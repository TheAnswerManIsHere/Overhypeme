# Facts list variant hierarchy (PR #118) — automated test run

Paired with **`docs/PR118_FACTS_LIST_VARIANT_HIERARCHY_UAT.md`**. Engineering
safety net for Replit. **Replit owns the database connection.** No schema change /
no migration — list-query + UI only.

## TL;DR

```
# whole repo
pnpm typecheck                                                          # clean

# api-server (from artifacts/api-server) — DB suite needs the env
DATABASE_URL=postgres://… CRON_SECRET=test \
  node --import tsx/esm --test src/__tests__/routes.adminFactsEnrichment.test.ts   # 16 pass
```

## What changed

The admin Facts list was flat (root facts + variants mixed by `createdAt`,
50/page), so a variant could land far from its parent or on another page. Now it
**paginates by root fact** and **nests each root's variants**.

### Backend — `GET /admin/facts` (`routes/admin.ts`)
- Paginates by ROOT fact (`parentId IS NULL`). `total` counts roots.
- A root is included when its own text matches OR it has a (visible) variant whose
  text matches — so searching by a variant's text still surfaces its parent.
- Each page-root's variants are fetched and attached as a nested `variants[]` on
  the row; when searching, only the matching variants are attached.
- Shared `FACT_LIST_COLUMNS` projection for both the root and variant selects.

### Frontend — `pages/admin/facts.tsx`
- New reusable `FactListRow` renders both roots and indented variants.
- Roots with variants show a chevron + variant count and expand/collapse to
  reveal indented variant rows. Variant rows carry a "variant" tag, are indented,
  and have no chevron.
- While searching, roots with matching variants auto-expand (matches visible
  without a click); while browsing, variants start collapsed.
- Adding/deleting a variant bumps a refresh nonce so the list re-fetches and the
  hierarchy updates.

## Test coverage (`routes.adminFactsEnrichment.test.ts`)
- **Nesting + root pagination + search grouping:** a root with two variants,
  searched by a shared marker → `facts` has only the root (top-level), `total === 1`,
  both variants nested under it, and neither variant appears as a top-level row.
- **Parent surfaced via variant match:** when only a variant's text matches, the
  parent root is returned (context) with just the matching variant nested.

## Not changed
- No DB schema / migration. The per-fact variants editor (selecting a root) is
  untouched. `nanoBanana2.ts` and the render pipeline are untouched.

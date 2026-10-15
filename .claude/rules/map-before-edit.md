---
paths:
  - "__complete-during-adoption__/**"
---

<!-- Seeded once by the AI-Handbook sync and owned by this repository from then on. At adoption, replace the path above with the globs of sets.indexed.include in .agents/map/config.json, so this rule loads whenever an agent touches an indexed file. -->

# Query the structure before you change it

This applies only while `.agents/map/config.json` says `"adopted": true` and `"enabled": true`. If either is false, ignore this file.

- **Before editing a file here**, run `node scripts/map.mjs deps <file>` and `node scripts/map.mjs dependents <file>`. For a change to an exported declaration, also run `node scripts/map.mjs dependents <file>#<name>`: it finds users behind barrels and aliases that grep misses.
- **At a class sweep** whose class is a TypeScript declaration, `dependents <file>#<name>` is the mechanical oracle, beside `git grep`.
- **Every answer has an `unresolved` section.** Those sites are yours to read by hand; an empty `resolved` section is not a clean answer while `unresolved` lists anything.
- **A query that refuses because the index is stale** is answered with `node scripts/map.mjs build`, then the query again.

The fleet rule this enacts is in `.agents/core/agents-core.md`, *Query the structure before you change it*; the tool's contract is `docs/ai-context/agent-legible-codebase.md`.

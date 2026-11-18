# Legal documents

The source of the four public legal pages (launch Phase 14, Issue #1030; plan `docs/plans/PLAN_PHASE14_COMPLIANCE.md`, S-a).

- `terms.md`, `privacy.md`, `copyright.md`, `guidelines.md` are rendered at `/terms`, `/privacy`, `/copyright` and `/guidelines` by `artifacts/overhype-me/scripts/generate-legal-content.ts`.
- **Changing a document's text means changing its `version`** in the front matter (a date, with `.2`, `.3` for a second change on one day). `versions.lock.json` records the text published under each document's current version, and CI fails a text change that keeps the old version: an acceptance stores only the version, so a version must name exactly one text.
- After editing, run `pnpm --filter @workspace/overhype-me run generate:legal` and commit the generated files with the change.
- Plain Markdown only: no HTML. Links are site paths, `https://` or `mailto:`.
- Every page says it awaits counsel's review until a firm signs it off. A text promises only what the product does on the day it is published.

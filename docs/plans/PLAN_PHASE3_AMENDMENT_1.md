# Plan amendment 1 — Launch Phase 3, increment 8: what the production reset carries, and prompts in code

Amends `docs/plans/PLAN_PHASE3_DATA_ENVIRONMENTS.md` (sha256 `fb1fd6b31475fa4bc07f885709f4d276cb48c416333d00627121fdebcc4a8e56`), §5, §7 (production) and Implementation Step 8. Workstream: Issue #770.

```plan-oracle
# Oracle — Launch Phase 3, amendment 1 (increment 8): what the production reset carries, and prompts in code

Agreed with David 2026-10-29 ("Option 1", replying to the banner that offered:
"I draft one plan amendment that (a) carries production's child-safety records
through the reset and (b) moves the six prompts into code — first reading the
in-use versions from production's and dev's backups and showing you any that
differ from the code, so you choose which wording becomes the code; the admin
screen then shows them read-only, or drops them. Astra reviews it; you approve
before anything is built."). Parent plan: docs/plans/PLAN_PHASE3_DATA_ENVIRONMENTS.md
(sha256 fb1fd6b31475fa4bc07f885709f4d276cb48c416333d00627121fdebcc4a8e56), §5,
§7 and Implementation Step 8, which say steps 2–6 of the production reset
"return to David as an amendment if the facts change them".

## Direction (unchanged from the parent plan)

Production can be built from code alone, upgraded, and restored. Seed opens on
a fresh production database before any real user contributes.

## Product intent of this amendment

1. The production reset loses nothing that must be kept: every child-safety
   record keeps a verified home with its relationships and supporting bytes,
   and the obligation each one carries (a pending NCMEC report) is not dropped
   or duplicated.
2. The six AI system prompts (fact enrichment, source classifier, visual
   concepts, image prompt, scene prompt, reference research) live in code as
   the single source of truth: a rebuild, a reset or a restore can never lose
   or silently change them, every change is versioned and reviewed, and tests
   exercise the prompts production runs.
3. Before the prompts move, the wording David wants is settled: where the
   in-use text differs from the code, David chooses which becomes the code.

## Must not change

- Child-safety records are never assumed synthetic; there is never an admin
  viewer for quarantined evidence (`legal-safety-moderation.md`).
- Production is not touched before the reset moment; publishing stays David's.
- `drizzle-kit push` never runs.
- Existing migrations keep their numbers and behaviour.
- Every other admin-owned setting keeps its current ownership and editability.

## Settled decisions

- The parent plan's settled decisions, and David's answers of 2026-10-28.
- One Stripe account; the $145 payment is not this app's (PR #784 now reports
  it as such and it no longer blocks).
- Prompts move into code (David, 2026-10-29: "I'm not going to be changing them
  very often and so I don't really need a GUI for changing them").

## Ceremony tier

Sensitive (migrations, child-safety records, production). Astra plan review,
`overhype-migration-review` for any migration, one PR per increment, Codex
review on every changed head.
```

## Why the parent plan needs amending

The parent plan's production steps 2–6 were "a stated design, not an established route". These facts, measured on 2026-10-29, change it. Each was read from production's backup pairs (latest `2026-10-29T20-45-12-621Z-e398bc`), restored with `pg_restore` alone into scratch databases on the Repl's server, so no boot or seeding ran. Production itself was never touched (#770 comments of ~19:20 and ~21:10 UTC).

1. **The workspace holds no production connection, by deliberate choice** (`replit-environment.md`: production "is not present anywhere in [the Repl's settings] … and that is deliberate"). Replit's Database settings do expose production's connection string to David (his screenshot, 2026-10-29). So an operator-held connection is possible. It is David's to grant.
2. **Production's child-safety records are copies of dev's.**
   - **The rows:** 2 NCMEC reports (both `pending`, no tipline `report_id`, no submission environment) and 3 quarantined memes. Each row's full-content hash and `created_at` (2026-05-08) match dev's. Dev keeps them; increment 7 carried them unchanged.
   - **The dependency set:** the reports reference no user. Quarantine row 1 references one user, present in both databases; its 26 columns differ only in `updated_at`. No meme, fact or audit-log row is referenced.
   - **The evidence:** all 4 distinct objects are present under the shared bucket's `restricted/quarantine/2026/05/`, with no ACL policy. They were resolved through `ObjectStorageService.getObjectEntityFile`. Sizes are 33, 16, 415,953 and 49 bytes; md5 values are recorded in the probe. Three are far too small to be images. This is recorded, not interpreted: nothing is assumed synthetic.
3. **The six prompts disagree with the code in two places.** Dev and production hold identical rows, and the repo's legacy fixture (`fixtures/legacy/admin_config.ndjson`) holds the same six texts byte for byte (md5 checked). That fixture is the source for exact text.

   | Key | In use (dev = production) | Code default | Same? |
   |---|---|---|---|
   | `fact_image_prompt_system` | md5 `9229567aba9aaedc09552c8f1ac619f2`, 15,086 chars | same | yes |
   | `fact_source_classifier_system` | md5 `2336feaa7f94f71296a4e1f029d34cfb`, 1,656 | same | yes |
   | `fact_visual_concepts_system` | md5 `840d310ac3ecf904fd0aa418f50b56d4`, 3,916 | same | yes |
   | `scene_prompt_system` | md5 `0bc920bedcbc445c0cba7dbcc76e164d`, 2,359 | same | yes |
   | `fact_enrichment_system` | md5 `e3969859fb94680f16bb1afb55aabc17`, **9,045**, seeded 2026-05-27, never edited | md5 `2db85bd52c00f4c009db8b8fb204dcea`, **18,303** | **no** |
   | `reference_research_system` | md5 `d31fe5f817efd4a12d05c54dd00fb834`, **4,509**, admin-edited 2026-05-30 | md5 `75a0c01b212e3ffab689a8006b03c841`, **2,193** | **no** |

   - **Enrichment.** Boot seeding is `ON CONFLICT DO NOTHING`, so the code's later prompt never reached either database. The request's response schema and user message already ask for `culturalReferences` and `semanticEntities` (`factEnrichment.ts:91`, `:371`). The newer system prompt adds consistent guidance for them. It also revises:
     - the classification of redundant-mechanism jokes;
     - the subject-name, app-name and generic-humour hashtag rules;
     - capitalization-sensitive interpretation;
     - two allowed modifiers.

     The acceptance harness pins the code default (`testing/acceptance/inner.ts:116`), so tests exercise a prompt neither environment runs.
   - **Reference research.** The in-use text is an admin's tuned version: the "capture the joke mechanism" two-step and worked examples. It names the retired `web_search_preview` tool, where the code names `web_search`.
   - **The comparisons.** Readable diffs are produced for D1 from the fixture and the constants at `origin/main` `7108816`.

## Proposed design

### Part A — the child-safety cases through the reset

**A1. A permanent case record, whatever D2 decides.** Before the reset, a workspace tool writes one case record into the backup bucket under `cases/production-reset-<date>/`. Expiry deletes only under `pairs/`, `states/` and `tombstones/` (`mediaBackup/expiry.ts:47,86,96`), so the record outlives pair expiry and Seed's snapshot cleanup. It holds:
- every child-safety row from the final capture (A3), complete;
- every row they reference (today: the one user row);
- an evidence manifest of path, size and md5 for each referenced object;
- the capture's identity, with a sha256 over the whole record.

It is written once (`ifGenerationMatch: 0`) and read back and verified. Evidence bytes stay where they are, in `restricted/`, which the database reset does not touch. They are never copied into the ordinary media backup. A missing or changed evidence object stops the reset and comes back to David.

**A2. Where the cases are handled after the reset is David's choice (D2).** Both options keep A1's record.
- **Leave production's copies behind.** Production starts with none. **Dev's rows are the authoritative handling copy** for the 2 pending reports, handled by the operator, David (today the only admin), out of band, as `legal-safety-moderation.md` describes. There is no submission worker or safety admin surface, and none is built. This is possible only because the final capture's rows are byte-identical to dev's.
- **Carry them into the new production** (the parent plan's stated design). The rows and the one referenced user row are inserted with their original ids through the operator connection (A3). Report ids, statuses and filing fields are kept exactly. Nothing calls `submitNcmecReport()` or any creation helper. Each row hash and relationship is checked against A1's record, and any mismatch refuses. A retry on the same database inserts nothing it already holds. The user link is kept, never set to `NULL`. **After a carry, the new production's rows are the authoritative handling copy, with David as operator.** Dev's copies are marked as superseded in the case record, so the same report is never handled twice.

**Whatever D2 decides, if the final capture's child-safety rows differ from dev's in any way** (a new case, or a changed row such as a handling status that moved on one side), the reset **stops before the database is removed**. The final case record is kept, the differences and their dependencies are reported to David, and the handling disposition is settled with him before the reset resumes. It never switches destination automatically.

**A3. The reset's route: an operator-held connection, for the reset window only.** David's actions:
1. He pauses or shuts down the production deployment, so no writer remains.
2. He copies production's connection string into a workspace secret, `RESET_PRODUCTION_DATABASE_URL`.

Then, through the connector:
1. A tool confirms no other session is connected (`pg_stat_activity`).
2. It takes the **final capture** with `pg_dump` and verifies it restores.
3. It runs the full inventory on it (not a fixed five-row allowance), then writes A1.

David then removes and recreates the database by the parent plan's route.
- **If D2 is "leave behind":** he publishes as normal, and the empty production builds itself from code.
- **If D2 is "carry":** the sequence keeps public access withheld until the import is verified.
  1. He publishes with access restricted to himself. Replit documents private publishing and changing access afterwards; whether that is available for this deployment is checked first in the runbook, and **unable to verify** until then.
  2. The new database builds from code at that boot.
  3. He copies the **new** database's connection string into the secret. The old one names a database that no longer exists.
  4. The import runs and is verified.
  5. Only then does he open access to the public.

  A failed import leaves access withheld.

Then David deletes the secret. Every step refuses on a failed or incomplete capture.
- **No boot-time import is built**, so a crash between bootstrap and import, or two starting copies of the app, cannot half-apply one.
- How Replit pauses a deployment without unpublishing it is **unable to verify** until David looks in the Publishing pane. If it can only be shut down, the reset is done with the site down, which is acceptable pre-launch.
- The operator connection is a credential under David's control, and its creation and deletion are his actions (the irreversible list).

### Part B — prompts in code

**B1. The text David chooses becomes the code constant (D1).** The source text is taken byte-exact from the legacy fixture, and its md5 is checked against the measured value. The reference-research tool name then becomes `web_search` whichever text is chosen, and the **resulting** text's hash is recorded in the PR.

**B2. Code is the only source.** For all six keys:
- each getter returns the code constant, including enrichment's provenance resolver (source `code`) and the visual-concept system-prompt hash;
- boot seeding stops writing those rows;
- the generic `PATCH /admin/config/:key` refuses the six keys;
- `POST /admin/config/fact-enrichment-system/reset-to-default` is removed;
- the acceptance harness's `pinPrompts()` substitution is removed;
- `composeImagePromptSystemPrompt` is unchanged.

Engine ids, engine parameters and every other admin setting keep their ownership.

**B3. The admin screen shows the six prompts read-only,** from the code, labelled "set in code".

**B4. The rows are retired by expand-then-contract.** This increment stops reading them, and a later migration deletes the six `admin_config` rows, capture-first. Historical enrichment provenance on existing facts is untouched.

### Part C — order of work (one PR each)

1. **Part B**, after D1. It is independent of the reset and reaches dev and production at the next publish. UAT: if D1 picks the new enrichment prompt, a sample of facts covering the changed behaviours is enriched and rendered on dev, before and after.
2. **The reset tools:** the final-capture and A1 case-record tool, the equality check that stops the reset on any difference, the A2 import only if D2 is "carry", and the connection check. They are tested against a scratch database and the local storage double.
3. **The reset itself**, David's go: the pause, the secret, the final capture and case record, his database replacement and publish, the import if carried, the admin proof, the audit-boundary record and the platform drill. The secret is deleted at the end.

## Decisions for David (in the approval readout)

- **D1 — wording for the two differing prompts.** Both diffs are attached to the readout.
  - Enrichment: in use (9,045 chars, older) or code (18,303, newer)? **Recommendation: code.** It is the version the parsing, reference research and acceptance tests were written against, and it adds the hashtag and classification refinements. The cost is a change in how facts are classified, which the Part B UAT checks. Astra concurs.
  - Reference research: in use (admin-tuned) or code? **Recommendation: the tuned version**, with `web_search`. Astra concurs.
- **D2 — where the 2 pending reports and 3 quarantines are handled after the reset.**
  - Leave production's copies behind, with dev as the authoritative handling copy and David as operator.
  - Or carry them into the new production with the one user row.

  Either way, A1 keeps a permanent case record. **Recommendation: leave them behind.** They are byte-identical duplicates, a second handling copy invites double handling, and the fresh production then holds no pre-Seed account. It is a legal-handling call, so it is David's. Astra supports leaving them behind once A1's record exists and dev is named the handling home.
- **D3 — grant the operator connection for the reset window.** A temporary workspace secret holds production's connection string, created and deleted by David. **Recommendation: yes.** It is what makes a true final capture possible, and it removes any need for boot-time import code.

## David's decisions (2026-10-29) — amendment approved ("Approved.")

- **D1:** "Use the code's newer version" — the enrichment prompt becomes the code's 18,303-char version. Reference research: the tuned version in use, with the tool name corrected to `web_search` (David: "1.1").
- **D2:** leave production's copies behind — "They're not live and there's nothing real there." Dev's rows are the authoritative handling copy; David is the operator; A1's permanent case record is still written.
- **D3:** yes — a temporary operator connection for the reset window.

## Verification

- **Part B.** Every runtime path sends the approved code text, on a fresh database, on an upgraded one holding the old rows, and on a restored one. Editing the six is refused. All other admin settings still save. Acceptance runs without substitution.
- **Part A.**
  - The case record verifies against the final capture, and every evidence object matches its manifest.
  - If carried: a repeated import adds nothing, a mismatch refuses, and all relationships resolve.
  - If left behind: the final capture's rows equal dev's.
- **The reset:** as in the parent plan's §7 and Definition of Done.

## Risks

- **The new enrichment prompt changes classifications** (if D1 picks code). The Part B UAT shows David real facts before and after.
- **The site is down while paused** for the reset. That is acceptable pre-launch.
- **The operator connection is a production credential in the workspace** for the reset window. It is scoped to that window, and its creation and deletion are David's.

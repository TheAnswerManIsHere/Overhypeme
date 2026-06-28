# Backfill Audit — what each one-off script does, how to run it, and how to confirm it actually ran

**Why this doc exists.** A backfill in this repo is (almost always) a **one-off
script that someone has to run by hand**. The script existing in the repo proves
it was *written*, not that it was ever *executed* against the database. This doc
is the checklist to confirm — for every historical backfill — whether it has
actually been applied to your data, and to re-run the ones that haven't.

> **Replit owns the database connection.** Run every command below in the
> `@workspace/api-server` workspace with your own `DATABASE_URL` already set in the
> environment — do **not** add any `DATABASE_URL=...` export from this doc. The
> verification SQL is run against your database directly (psql / the DB console).

---

## The two ways data gets changed — and which one auto-runs

| Mechanism | Where it lives | Runs automatically? |
|---|---|---|
| **SQL migration** | `lib/db/migrations/NNNN_*.sql` | **Yes** — `pnpm --filter @workspace/db run migrate` applies them (fires on `predev`, `pretest`, and deploy). A data `UPDATE` written into a migration runs itself, once, tracked by hash. **Can't be forgotten.** |
| **One-off TS script** | `artifacts/api-server/scripts/*.ts` | **No** — nothing in dev/test/deploy runs these. A human must invoke them. |

Everything in this audit is the **second** kind. None of them auto-run.

## The universal "did it run?" test

Every script here is **idempotent** — re-running skips rows that are already done.
So the single most reliable check, for any of them, is:

> **Re-run the script (in dry-run mode where it has one) and confirm it reports
> "0 rows to change / processed."** Zero means it's already fully applied (or was
> never needed). Non-zero means it still has work to do — let it.

The per-script **verification SQL** below lets you confirm the same thing from the
DB *without* running the script (handy for the ones that cost money or take a
while). **Expected result for an already-applied backfill: `0`.**

---

## Audit checklist

### 1. `backfill-pexels.ts` — Pexels stock images for root facts
- **Command:** `pnpm --filter @workspace/api-server run backfill:pexels`
- **Cost/speed:** hits the Pexels API, ~1s/fact. **Idempotent** (skips facts that already have images).
- **Verify (expect 0):**
  ```sql
  SELECT count(*) FROM facts WHERE parent_id IS NULL AND pexels_images IS NULL;
  ```

### 2. `backfill-ai-memes.ts` — AI meme backgrounds for active facts
- **Command:** `pnpm --filter @workspace/api-server run backfill:ai-memes`
- **Cost/speed:** calls OpenAI, ~8s/fact. **Idempotent** (skips facts that already have all 9 images: 3 genders × 3).
- **Verify (expect 0) — facts with NO backgrounds at all:**
  ```sql
  SELECT count(*) FROM facts WHERE is_active = true AND ai_meme_images IS NULL;
  ```
  > Note: this catches facts with *zero* backgrounds. Facts with a *partial* set
  > (1–8 of 9) aren't caught by SQL easily — for a complete check, re-run the
  > script and confirm it reports "0 processed."

### 3. `cleanup-subject-name-semantic-entities.ts` — scrub "Alex" out of stored semantic entities
- **Command (dry-run, the default):** `pnpm --filter @workspace/api-server run cleanup:subject-name-entities`
- **Command (apply):** `pnpm --filter @workspace/api-server run cleanup:subject-name-entities -- --apply`
- **Cost/speed:** free, fast. **Idempotent**, **dry-run by default** (writes nothing unless `--apply`).
- **Verify (expect 0) — rows still carrying the subject as a semantic entity:**
  ```sql
  -- facts
  SELECT count(*) FROM facts
  WHERE enrichment IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(enrichment->'semanticEntities') e
      WHERE lower(e->>'normalizedText') IN ('alex','alexs')
         OR lower(e->>'surfaceText')   IN ('alex','alex''s')
    );
  -- pending_reviews (same idea)
  SELECT count(*) FROM pending_reviews
  WHERE enrichment IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(enrichment->'semanticEntities') e
      WHERE lower(e->>'normalizedText') IN ('alex','alexs')
         OR lower(e->>'surfaceText')   IN ('alex','alex''s')
    );
  ```
  > The script's matcher is broader than this SQL (it also strips residual identity
  > tokens), so the **dry-run is authoritative** — if SQL says 0 but you want
  > certainty, run the dry-run and confirm "0 to change."

### 4. `backfill-conjugate-verbs.ts` — repair `{Subj} keeps` → `{Subj} {keeps|keep}`
- **Command (dry-run, the default):** `pnpm --filter @workspace/api-server exec tsx scripts/backfill-conjugate-verbs.ts --dry-run`
- **Command (apply):** `pnpm --filter @workspace/api-server exec tsx scripts/backfill-conjugate-verbs.ts --apply`
- **No npm script entry** — must be run via `tsx` as above. **Free, deterministic, idempotent, dry-run by default.**
- **Verify:** no clean SQL signal (it's a text transform). **Run the dry-run and confirm "0 facts would change."** That is the verification.

### 5. `migrate-ai-backgrounds.ts` — move AI backgrounds out of the storage root
- **Command:** `pnpm --filter @workspace/api-server run migrate:ai-backgrounds`
- **Cost/speed:** GCS copy/delete per file. **Idempotent** (skips paths already under `ai-backgrounds/`).
- **Verify (expect 0) — DB rows still pointing at the old root-level path:**
  ```sql
  SELECT count(*) FROM facts
  WHERE ai_meme_images IS NOT NULL
    AND ai_meme_images::text LIKE '%/objects/ai_meme_%';
  ```

### 6. `migrate-ai-backgrounds-v2.ts` — storage-first re-pass (facts + user_ai_images)
- **Command:** `pnpm --filter @workspace/api-server run migrate:ai-backgrounds-v2`
- **Cost/speed:** bulk GCS copy/delete. **Idempotent.**
- **Verify (expect 0 for both):**
  ```sql
  SELECT
    (SELECT count(*) FROM facts          WHERE ai_meme_images::text LIKE '%/objects/ai_meme_%') AS facts_old,
    (SELECT count(*) FROM user_ai_images WHERE storage_path        LIKE '/objects/ai_meme_%')   AS user_images_old;
  ```

### 7. `fix-ai-backgrounds-db.ts` — repair DB paths after the storage move
- **Command:** `pnpm --filter @workspace/api-server run fix:ai-backgrounds-db`
- **Cost/speed:** GCS `exists()` check per file (slow). **Idempotent** (skips paths already under `/objects/ai-backgrounds/`).
- **Verify (expect 0):**
  ```sql
  SELECT count(*) FROM facts
  WHERE ai_meme_images IS NOT NULL
    AND ai_meme_images::text LIKE '%/objects/ai_meme_%';
  ```
  > #5, #6, #7 all target the same legacy `/objects/ai_meme_*` layout from different
  > angles (move files / re-pass / fix DB paths). If the verify query above is `0`,
  > that whole family is done.

### 8. `migrate-storage-keys.ts` — add a hash-prefix to every storage key
- **Command:** `pnpm --filter @workspace/api-server run migrate:storage-keys`
- **Cost/speed:** GCS copy/delete across `ai-backgrounds/`, `memes/`, `uploads/` + multiple DB tables. **Idempotent** (skips keys already under a `{folder}/{2-hex}/` prefix).
- **Verify:** the "already hashed?" test is a 2-hex-char path segment, which is awkward
  in SQL. Best signal is the obviously-unmigrated upload paths (expect 0):
  ```sql
  SELECT
    (SELECT count(*) FROM users      WHERE profile_image_url LIKE '/api/storage/objects/uploads/%') AS users_old,
    (SELECT count(*) FROM video_jobs WHERE image_url         LIKE '/api/storage/objects/uploads/%') AS videos_old;
  ```
  > For full certainty across all three folders, **re-run the script** — it lists GCS
  > and skips already-hashed keys, so a clean run that copies/deletes nothing = done.

### 9. `retokenize-facts.ts` — LLM re-tokenize legacy plain-English facts ⚠️
- **Command:** `pnpm --filter @workspace/api-server exec tsx scripts/retokenize-facts.ts`
- **No npm script entry. Calls the LLM per fact — costs money. No dry-run.**
- This is **not a routine backfill** — it's a deliberate deeper re-pass. For the
  everyday "missed verb conjugation" repair, use **#4** (free, deterministic) instead.
- **Verify:** no simple SQL signal. Only run this when you specifically want a full
  re-tokenization pass; it's idempotent (skips facts whose tokenized form is unchanged).

---

## How to read the results

- Run the verification SQL for #1–#8. **Every count `0` → that backfill is fully
  applied.** Any non-zero count → run that script's command (apply mode) to finish it.
- For #4 and #9 (no SQL signal), the dry-run / idempotent re-run is the check.
- If a count is non-zero and you're unsure why, tell me the script + the number and
  I'll dig into whether it's leftover work or an edge case the script intentionally skips.

## Going forward (how new backfills will be shipped so this can't recur)

1. **Pure-SQL data fixes → a numbered migration** (`lib/db/migrations/`), so they
   auto-run on deploy and literally cannot be forgotten.
2. **Script backfills** (anything needing app logic / an LLM / storage) will be:
   - **idempotent** and **dry-run-by-default**;
   - shipped with an **"⚠️ ACTION REQUIRED — run against prod: `<command>`"** banner
     at the **top** of that PR's `*_TEST_RUN.md` (not buried); and
   - paired with a **verification query** right there, so Replit confirms it took.

# PR147 — Exclude subject/app name from suggested hashtags — UAT (David)

In-app click-through. Engineering checklist: `PR147_HASHTAG_EXCLUSIONS_TEST_RUN.md`.

## What changed, in one breath

The AI will no longer **suggest** `alex` (the subject's stand-in name) or
`overhype` / `overhypeme` (the app's own name) as hashtags. This is enforced two
ways: the AI is told not to, and any that slip through are stripped automatically
— and if stripping leaves fewer than 3 tags, the AI is re-run for more.

## Important scope note

This fixes **future** suggestions — new submissions and any time you **re-run
classification** on a fact. Facts already in the database keep whatever hashtags
they already have **until a separate backfill is run** (that's a follow-up PR).

## Walkthrough

1. **New fact path.** Submit a fact that would tempt those tags — something the AI
   might tag with the subject or brand, e.g. a punchy one-liner. Approve it through
   moderation. In **Advanced Options → enrichment**, check **Suggested Hashtags**:
   you should see real discovery tags and **no `alex`, no `overhype`/`overhypeme`**.
2. **Re-run path.** Open an existing fact in **Admin → Facts**, click **Re-run
   classification** (the enrichment re-run). When it finishes, confirm the new
   suggested hashtags exclude the subject/app name.
3. **Still get 3–8 tags.** Even when the AI's first idea included the banned ones,
   you should still end up with at least 3 legitimate hashtags (it re-runs to
   top up).

## Expect vs. don't-expect

| Expect | Don't expect |
| --- | --- |
| Newly-enriched facts never suggest `alex` / `overhype` | Those tags appearing on a fresh enrichment |
| Still 3–8 real discovery hashtags | Dropping below 3 because tags were removed |
| Manually-added hashtags untouched | The filter deleting a hashtag *you* typed in |
| Existing facts unchanged for now | Old facts being retroactively cleaned by this PR |

## Regression smoke

| Area | Check |
| --- | --- |
| Enrichment | New submissions still classify (archetype/subtype/etc.) normally |
| Hashtags | Normal facts still get sensible, varied discovery tags |
| Re-run | "Re-run classification" still works and returns valid enrichment |
| Manual edit | You can still add/remove hashtags by hand in the editor |

## Known non-bugs (this version)

- **Existing facts aren't cleaned yet.** A fact approved before this change can
  still show `alex`/`overhype` until the backfill PR runs.
- The denylist is exactly the subject name + the app name. A legitimately
  on-topic real brand in the fact text is still allowed.

## Bug report template

```
Path: (new submission / re-run classification / manual edit)
Fact id / text:
Suggested hashtags I saw:
Which one shouldn't be there (or: dropped below 3):
Screenshot:
```

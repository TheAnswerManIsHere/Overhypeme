# Tokenizer verb conjugation ("They keeps" → "They keep") — user acceptance testing

**PR:** #130 · **Companion:** [`PR130_TOKENIZER_VERB_CONJUGATION_TEST_RUN.md`](./PR130_TOKENIZER_VERB_CONJUGATION_TEST_RUN.md)

## What you're verifying

When a fact's verb belongs to the **person** (the subject is the name/pronoun),
the verb must agree with the viewer's pronoun number:

- he/him & she/her → singular ("He **keeps**")
- they/them → plural ("They **keep**")

The tokenizer turns your plain-English fact into a template. The bug was that it
sometimes left a verb as plain text (`{Subj} keeps`) instead of a conjugation
pair (`{Subj} {keeps|keep}`), so they/them rendered "They **keeps**". This PR
makes that reliable in two independent ways: a stronger tokenizer model **and** a
deterministic repair pass that runs on every tokenize and guarantees the pair.

You are NOT verifying any new UI — the template editor and pronoun preview
already exist. You're verifying the **output** they show is now correct, and that
existing broken facts get fixed by the backfill.

## Where to look

- **Submit a fact** (`/submit`), the **Advanced — view & edit template** panel on
  the review/preview step, and the **pronoun preview** of any fact card.

## 1. The reported case is fixed for new facts

1. Submit a fact: **`Alex keeps the virus in his back yard`** with pronouns
   **they/them**.
2. Open **Advanced — view & edit template**. The template should read:
   `{NAME} keeps the virus in {POSS} back yard` **with `keeps` shown as the
   conjugation pair `{keeps|keep}`** (the "Verb forms" line lists it).
3. The rendered preview reads **"Alex keep the virus in their back yard"** for
   they/them — i.e. **"keep", not "keeps"**.
4. Switch the same fact's pronouns to **he/him** → preview reads **"keeps"**
   ("Alex keeps … his back yard"). She/her → also "keeps".

**Expect:** the verb flips between "keep" (they) and "keeps" (he/she). Before this
PR the template had a bare `keeps` and they/them showed the wrong "They keeps".

## 2. Other person-subject verbs conjugate too

Submit each and check the template shows a pair and they/them reads the plural:

| Fact | Template verb | they/them renders |
|---|---|---|
| `Dave has three shadows` | `{has\|have}` | "have" |
| `Dave is afraid of nothing` | `{is\|are}` | "are" |
| `Dave doesn't blink` | `{doesn't\|don't}` | "don't" |
| `Dave catches bullets` | `{catches\|catch}` | "catch" |
| `Dave flies to work` | `{flies\|fly}` | "fly" |

**Expect:** each verb is a pair; he/him shows the left form, they/them the right.

## 3. Non-person subjects are left alone (no over-correction)

These verbs do **not** belong to the person and must stay plain (no pair):

1. `Sharks have a Chuck Norris week` → "have" stays plain (subject is "Sharks").
2. `Chuck Norris News is trending` / `Chuck Norris Fitness sells out` → the
   label words ("News", "Fitness") are **not** turned into pairs, and the
   sentence still reads normally for every pronoun.
3. A fact mentioning **"the Corona virus"** keeps "virus" as-is (it's a noun, not
   a verb).

**Expect:** no weird output like "New"/"Fitnes"/"viru"; only the person's own
verbs get pairs.

## 4. Existing broken facts get repaired (after the backfill runs)

The fix above only changes **new** tokenizations. Your already-saved facts (like
the screenshot's "Alex Jordan caught the Corona virus. They keeps…") are repaired
by a one-time backfill that Replit runs (see the companion test-run doc — it's a
database operation, no UI).

1. Before backfill: find the offending fact; with they/them it reads "They
   **keeps** it locked up…".
2. After Replit runs the backfill with `--apply`: reload the fact. It now reads
   "They **keep** it locked up…", and its template shows `{keeps|keep}`.

**Expect:** the verb is corrected on existing facts without you editing anything.
If you'd rather fix one by hand in the meantime, the **Advanced** editor lets you
change `keeps` to `keeps|keep` directly — that already worked and still does.

## Regression smoke table

| Surface | Action | Expect |
|---|---|---|
| Submit → Advanced template | submit "Alex keeps the virus…" | verb shown as `{keeps\|keep}` |
| Pronoun preview | set they/them | "keep" (plural) |
| Pronoun preview | set he/him or she/her | "keeps" (singular) |
| Submit | "Dave doesn't blink" | `{doesn't\|don't}`; they/them → "don't" |
| Submit | "Sharks have a {NAME} week" | "have" stays plain (not a pair) |
| Submit | a fact with a Title-Case label after the name | label word unchanged |
| Existing fact (post-backfill) | reload the screenshot fact | "They keep", template `{keeps\|keep}` |
| Advanced editor | manually type `keeps\|keep` | still accepted, renders correctly |

## Known non-bugs / deferred

- **The repair is narrow on purpose.** It only conjugates a present-tense verb
  **directly after** the person's name/pronoun. A verb buried later in a clause
  with the person as subject still relies on the (now stronger + prompt-hardened)
  model. If you ever see one slip, the Advanced editor fixes it in one edit and
  the screenshot-style "verb right after the pronoun" case is fully guaranteed.
- **Embeddings aren't re-computed by the backfill.** The backfill fixes the
  template and its canonical text, but doesn't re-index the duplicate-search
  embedding (the change is a one-word agreement, negligible for dedup). Say the
  word and we'll add an opt-in re-embed pass.
- **Existing facts only change when re-run.** New facts are fixed at creation;
  old ones are fixed by the backfill. Nothing changes silently in between.

## Bug report template

```
Where: Submit/Advanced template, pronoun preview, or an existing fact card
Fact text I submitted: <text>
Pronouns set: <he/him | she/her | they/them | custom>
Template shown (Advanced panel): <…>
What I expected (per this doc): <e.g. "keep" for they/them>
What rendered: <…>
New fact or existing (post-backfill)?: <…>
```

# Tokenizer: "Sharks have…" stays "have" for everyone — user acceptance testing

You spotted this during the a/an testing: submitting **"Sharks have a David
Week."** produced a preview where the they/them example read **"Sharks **has** an
Alex Jordan Week."** That "has" is wrong — "Sharks" is always plural, so it
should be "Sharks **have**…" for every person. The tokenizer was mistakenly
treating "have" as a verb that changes with the person's pronouns. It no longer
does.

This is a fix to the **AI tokenizer** (the step that turns your sentence into a
reusable template). It pairs with the a/an fix
([`AAN_ARTICLE_AGREEMENT_UAT.md`](./AAN_ARTICLE_AGREEMENT_UAT.md)) — together
they make "Sharks have a David Week" come out perfectly: **"Sharks have an Alex
Jordan Week."**

The engineering/automated side is in
[`TOKENIZER_NONPERSON_VERB_TEST_RUN.md`](./TOKENIZER_NONPERSON_VERB_TEST_RUN.md)
(owned by Replit) — you don't need to read it.

> **Heads up:** the tokenizer is an AI step, so it's not 100% guaranteed every
> time. That's why the **Preview** (three sample people) and the **Advanced —
> view & edit template** box exist: if the AI ever gets a verb wrong, you'll see
> it in the preview and can fix the template by hand before submitting. This
> change makes the AI get it right on its own for the common cases.

If anything fails, note the step, what you typed, what you saw vs. expected, and
a screenshot. Bug template at the bottom.

---

## 1. The reported case

1. Go to **Submit a Fact**.
2. Type: **`Sharks have a David Week.`**
3. Continue to **Preview & Submit**.

Expect the three sample cards to ALL keep "have":

| Sample person | Expect |
| --- | --- |
| David Franklin (he/him)   | "Sharks **have** a David Franklin Week." |
| Sarah Mitchell (she/her)  | "Sharks **have** a Sarah Mitchell Week." |
| Alex Jordan (they/them)   | "Sharks **have** an Alex Jordan Week." ✅ |

The they/them card is the one that used to say "has". It should now say "have"
(and "an Alex", thanks to the companion a/an fix).

4. Open **Advanced — view & edit template** and confirm the template reads
   **`Sharks have a {NAME} Week.`** — "have" is plain text, with **no**
   `{have|has}` braces around it.

## 2. Mixed sentence — the person's own verb still changes

The fix is surgical: a verb that belongs to *the person* must still adapt.

1. Submit: **`When David laughs, the earth cries.`**
2. On the preview, expect:

| Sample person | Expect |
| --- | --- |
| David Franklin (he/him)   | "When David Franklin **laughs**, the earth **cries**." |
| Alex Jordan (they/them)   | "When Alex Jordan **laugh**, the earth **cries**." |

- "laughs/laugh" changes with the person (it's *their* verb) — correct.
- "the earth cries" stays "cries" for everyone (it's the earth's verb, not the
  person's) — correct.

Template (Advanced): **`When {NAME} {laughs|laugh}, the earth cries.`**

## 3. Control — a normal person-subject fact is unchanged

Submit something where the person clearly does the verb, e.g.
**`David counts to infinity.`** Expect the they/them card to read "Alex Jordan
**count** to infinity" and he/him "David Franklin **counts** to infinity" —
i.e. person verbs are still conjugated as before. Template:
`{NAME} {counts|count} to infinity.`

---

## Known non-bugs (don't report these)

- **It's an AI step.** If you feed it an unusual sentence and a verb comes out
  wrong, that's not a hard failure — the preview surfaces it and the Advanced
  editor lets you correct the template before submitting. Report it so we can add
  an example to the AI's instructions, but it's not a blocker.
- **The template shows plain "have"/"cries".** That's the whole point — those
  verbs don't belong to the person, so they're left as ordinary words.
- **Facts already submitted before this fix** keep whatever template they were
  saved with; this change only affects new tokenizations. An admin can re-edit a
  fact's template if an old one reads wrong.

---

## Bug report template

```
Step: (1 / 2 / 3)
Fact text (what you typed):
Template shown in Advanced editor:
Which sample card was wrong (he/him, she/her, they/them):
Expected:
Actually saw:
Screenshot:
```

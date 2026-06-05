# Indefinite-article (a/an) agreement around the name — user acceptance testing

You flagged that a fact like **"Sharks have a David Week"** rendered the wrong
article when the viewer's name starts with a vowel: for *Alex* it should read
**"Sharks have an Alex Week"**, because "Alex" starts with a vowel. This fixes
that — the article in front of the name now flips between "a" and "an" to match
whatever name is plugged in.

The engineering/automated side is in
[`AAN_ARTICLE_AGREEMENT_TEST_RUN.md`](./AAN_ARTICLE_AGREEMENT_TEST_RUN.md)
(owned by Replit) — you don't need to read it.

> **One thing to know up front:** this is a *display* fix, not a change to the
> stored template. If you peek at the raw template (the "Advanced" editor on the
> Submit page, or the admin Facts list) it still reads **"a {NAME}"** — that's
> correct. The "a → an" magic happens when the name is filled in, because the
> right article depends on whose name it is. So the thing to check is what the
> **rendered** fact says, not the template.

If anything fails, note the step, what you saw vs. expected, and a screenshot.
Bug template at the bottom.

---

## 1. The headline case — right in the Submit preview

This is the fastest way to see it, and it shows all three article forms at once.

1. Go to **Submit a Fact**.
2. In the writing step, type a fact that puts an indefinite article right before
   the person: **`Sharks have a David Week`**. (Use any consonant name you like
   in the sentence — the tokenizer turns the name into the `{NAME}` slot.)
3. Continue to **Preview & Submit**.

On the preview step you'll see the same fact rendered for three sample people:

| Sample person (pronouns) | Expect |
| --- | --- |
| **David Franklin** (he/him)   | "Sharks have **a David** Franklin Week" |
| **Sarah Mitchell** (she/her)  | "Sharks have **a Sarah** Mitchell Week" |
| **Alex Jordan** (they/them)   | "Sharks have **an Alex** Jordan Week" ✅ |

The **Alex Jordan** card is the exact case you reported: the "a" became **"an"**
because "Alex" starts with a vowel. David and Sarah keep "a" (consonants).

> If you'd rather test with a different sentence, anything of the shape
> "… a &lt;name&gt; …" works: e.g. "Everyone wants a David around" → the Alex
> Jordan card reads "Everyone wants **an Alex** Jordan around".

## 2. The same fact, personalized to *you*

1. Submit the fact from step 1 (or use any existing fact you write with "a"
   before the name), and let it appear in the feed — or just stay on a fact
   card that contains "a {NAME}".
2. On **Home** (or any fact card), set your display name via the name tag /
   name field to a **vowel-starting** name — e.g. **Alex**, **Emma**,
   **Owen**, **Ivy**.
3. Read the fact.

Expect: the article reads **"an"** — "an Alex", "an Emma", "an Owen".

4. Now change your name to a **consonant-starting** name — **David**, **Sarah**,
   **Max**.

Expect: the article flips back to **"a"** — "a David", "a Max".

The fact text updates live as you change the name; no page reload needed.

## 3. Capitalization at the start of a sentence

If a fact *starts* with the article — e.g. "A David walks into a bar" →
template "A {NAME} walks into a bar":

- Name **Owen** → "**An Owen** walks into a bar" (capital "An").
- Name **Sarah** → "**A Sarah** walks into a bar" (capital "A").

The capital letter is preserved; only a/an changes.

## 4. Regression smoke — nothing else moved

Quickly confirm the fix is surgical and didn't disturb normal text:

| Check | Expect |
| --- | --- |
| A fact with "a" **not** before the name, e.g. "a unicorn met {NAME}" | The "a unicorn" is untouched. |
| A fact with an adjective before the name, "a famous {NAME}" | Stays "a famous Alex" (agrees with "famous", not the name) — correct English. |
| A fact with no indefinite article | Renders exactly as before. |
| Pronoun / verb facts ("{NAME} {has\|have} …") | Unchanged. |

---

## Known non-bugs (don't report these)

- **The stored template still says "a {NAME}".** That's by design — see the note
  at the top. Only the rendered output flips a/an.
- **Unusual-sounding names.** The rule goes by the first **letter**, not
  pronunciation. So a name like **Uma** renders "an Uma" (vowel letter) and
  **Hugo** renders "a Hugo" — even though some people pronounce them the other
  way. Letter-based agreement is right for the vast majority of names; we did
  not build a pronunciation dictionary.
- **Existing facts in the feed already read correctly** once you view them with
  a vowel/consonant name — there was nothing to migrate; the fix is purely at
  display time.

---

## Bug report template

```
Step: (1 / 2 / 3 / 4)
Fact text (what you typed) or fact ID:
Name + pronouns you set:
Expected:
Actually saw:
Screenshot:
```

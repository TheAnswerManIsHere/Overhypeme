# Tokenizer `{can|can}` cleanup — user acceptance testing

What you're verifying for PR #151. Engineering checklist:
`docs/PR151_TOKENIZER_COLLAPSE_BRANCHES_TEST_RUN.md`.

## What you're verifying
1. New fact submissions no longer produce a duplicate conjugation token like
   `{can|can}` — the modal verb stays plain text.
2. Legitimate conjugation still works (e.g. `{is|are}`, `{has|have}`) — this change
   only removes exact duplicates.
3. (After the backfill runs on Replit) existing facts/reviews that had `{can|can}`
   now read cleanly.

## Where to look
Anywhere a fact gets tokenized: the submit-a-fact flow, and **Admin → Moderation**
where the submitted/staging template is shown (e.g. the review that showed
`"{NAME} {can|can} fill up an electric car at a gas station."`).

## 1. A modal verb no longer doubles up
1. Submit (or tokenize) a fact using a modal: e.g. **"David can fill up an electric
   car at a gas station."**
2. **Expect** the tokenized template to read `{NAME} can fill up an electric car at
   a gas station.` — **not** `{NAME} {can|can} …`.
3. Try a few more modals: "Sarah will never lose", "Alex should know better".
   **Expect** `will`, `should` plain — no `{will|will}` / `{should|should}`.

## 2. Real conjugation still works
1. Submit "David flies faster than light" / "Sarah doesn't age".
2. **Expect** the normal pairs to survive: `{NAME} {flies|fly} …`,
   `{NAME} {doesn't|don't} …`. (This change does **not** touch non-identical pairs.)

## 3. Rendered output is unchanged
1. View any fact that previously had `{can|can}` (or the one above) on the live site
   / preview for a he/him user and a they/them user.
2. **Expect** the sentence reads "… can …" in both cases — collapsing the duplicate
   changes nothing a reader sees. (That's the whole point: it's cosmetic in the
   template, identical in output.)

## 4. Existing rows (after Replit runs the backfill)
1. Once the backfill has been applied, reopen the moderation review that showed
   `{can|can}`.
2. **Expect** it now reads `{NAME} can fill up an electric car …`.

## Regression smoke
| Check | Expect |
| --- | --- |
| Submit fact with normal verb ("David runs the world") | `{NAME} {runs\|run} …` (conjugation intact) |
| Submit fact with a modal | modal stays plain, no `{x\|x}` |
| Submit fact with pronouns ("David loves his car") | `{POSS}` etc. unaffected |
| Approve / moderate a fact | unchanged |

## Known non-bugs / limitations
- A weird padded form like `{can | can}` (with spaces) is intentionally left alone —
  it isn't produced in practice; we only collapse exact duplicates to stay safe.
- Old facts keep their `{can|can}` until the one-time backfill runs (or they're
  re-tokenized). It never affected what readers saw.

## Bug report template
```
Where: [submit flow | moderation | live render]
Fact text I entered: ...
Tokenized template shown: ...
Expected: ...
Got: ...
Screenshot: ...
```

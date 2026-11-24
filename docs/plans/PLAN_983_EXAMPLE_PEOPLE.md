# Plan — Issue #983: the example people are David Franklin, Raena Franklin and Mango the cat

Short plan (one increment, one PR). Product code, production phase, product tier.

```plan-oracle
# Scope — Issue #983: the system's example people are David Franklin, Raena Franklin and Mango the cat

## Direction served
Launch backlog wave 2 (Issue #628, approved by David 2026-11-21): the before-launch should-haves. `decisions.md`, 2026-11-17, *David is the product's default person* (reaffirmed 2026-11-24).

## Product intent (David, verbatim, Issue #983 and its comment)
> I want to be the default name and image in the product.
> Who is Jordan Franklin? The system examples should be as follows: Male: David Franklin, Female: Raena Franklin, Pet: Mango (cat).
> Mango is a male cat.

"Alex, they/them" stays only where a gender-neutral name is explicitly needed. No other example name stays anywhere.

## This increment
Every remaining stand-in person in the product, its admin tools and its docs is one of the set: David Franklin (he/him, the default), Raena Franklin (she/her), Mango (he/him, the cat), or Alex where the need is explicitly gender-neutral. Known places on `main` at 0c6109b:
- the moderation tokenizer's example-name hints (`subjectExampleNames.ts`) still list "Sarah Franklin" and "Jordan Franklin";
- a render drawn from the pet reference photo is given the sample subject "David Franklin, he/him" (`defaultPreviewSubjectForReference`);
- the Submit page's pronoun preview shows "Sarah Mitchell" (she/her) and "Alex Jordan" (they/them);
- a sweep of `artifacts/*/src`, `lib/*/src`, tests and docs for any other stand-in name.
`decisions.md`'s 2026-11-17 entry is updated to name the full set, Mango included.

## Must not change
- The AI writers' canonical stand-in, "Alex, they/them" (`renderCanonical.ts`), and the bubble-speaker dropdown's "Alex" that comes from it (David, 2026-11-24, Q1: 2).
- The name fields' placeholders PR #1249 just set.
- What a visitor's own name and pronouns render as.
- The acceptance recordings stay replayable. A recording whose request changes is removed and re-recorded under the 2026-11-17 removal rule, a paid run within the monthly budget, or shown not to change.

## Settled decisions
- 2026-11-17: David is the default person; Raena the female default; Alex the gender-neutral one, only where explicitly needed.
- 2026-11-24: the AI writers' stand-in stays "Alex, they/them", and the submit preview's they/them row stays Alex.
- A prompt-wording change needs a paid re-record.

## Now / next / never
- Now: the places above and whatever the sweep finds.
- Next: none known.
- Never here: changing the AI writers' stand-in.

## Ceremony tier
Feature mode, production phase, product tier. Short plan, Astra review, David's approval, Codex review. UAT: the screens a person sees (the Submit preview and the moderation hint) are checked by machine; whether anything still reads wrong is David's.
```

## What this increment makes true

Every **ordinary stand-in person** in the product, its admin tools, its
prompts, its tests and its docs is one of the set:
- **David Franklin, he/him**, the default;
- **Raena Franklin, she/her**, where female is needed;
- **Mango, he/him, the cat**, where a pet is needed;
- **Alex**, only where the need is explicitly gender-neutral.

An ordinary stand-in is a name chosen only to stand for "a person".

**The known places, and what each becomes:**
- **The moderation tokenizer's example-name list** (`subjectExampleNames.ts`,
  sent with each Visual Strategy save from moderation and the Facts page):
  Sarah Franklin and Jordan Franklin go, and Mango joins. The list becomes
  David Franklin, Raena Franklin, Alex Franklin, Mango.
- **The pet reference photo's sample subject**
  (`defaultPreviewSubjectForReference`) becomes Mango, he/him. An explicit
  name or pronoun override still wins, and the reference photos themselves
  are unchanged.
- **Everything that reads those defaults** follows: scenario renders and
  their hashes, failed-attempt text, comparison preparation, and the
  legacy-fixture scrubber's list of preset names (`shapes.ts`), which must
  not mistake Mango for a member's own name.
- **The Submit page:**
  - the she/her pronoun preview "Sarah Mitchell" becomes **Raena Franklin**;
  - the they/them row stays Alex (2026-11-24) and is written "Alex Franklin",
    the family's surname, not "Jordan";
  - the help example "When John does pushups…" becomes David, with its E2E
    selector moving with it.
- **The fact tokenizer's prompt examples:** "Sarah doesn't age…" becomes
  Raena, and "Alex … his back yard" becomes David. These are examples in a
  prompt, not the AI writers' protected stand-in.
- **The acceptance driver's submitted subject** (a "Chuck Norris" boast used
  as a stand-in) becomes David. Real cultural references to Chuck Norris, the
  genre the product is named after, stay.
- **Rendered docs:** the content guidelines' "Sam once out-stared the sun"
  becomes David, and so on through the sweep.
- **`decisions.md`'s 2026-11-17 entry** names the full set, Mango included.

**The sweep** covers `artifacts/*/src`, `lib/*/src`, tests, prompts and docs,
rendered docs included. It is listed in the PR: each hit is changed or kept,
with the reason.

**Kept, under Q26 (recommended):** a name whose particular spelling or
identity is what a test proves stays, with its reason recorded. The reason
goes in an existing explanation where there is one (the fixtures' `why`
fields), otherwise in a one-line comment. An ordinary example inside a test
still changes.
For example:
- James and Chris, possessives ending in *s*;
- `personalNameRule.fixtures.ts`'s accents, apostrophes and scripts;
- the names the name-inference lookup table knows;
- the synthetic identities the legacy-fixture scrubber generates.

Also kept: the AI writers' "Alex, they/them", and PR #1249's placeholders
(their "Sam" included).

## The paid re-record

Changing the tokenizer's prompt examples and the pet's sample subject
changes the requests that four saved tokenizer recordings and the pet image
recording were made from. A request's fingerprint includes its wording, so
those recordings can no longer be replayed. The settled procedure applies
(`TESTING.md`, *Topping up*):
- remove the changed calls' recordings, and every later recording that
  carries their old output;
- top up on the Repl under a spending ceiling;
- replay both baseline variants.

It is a paid AI run within David's monthly budget, read from the fleet
ledger, reported with its cost, and asked about only if it would take the
month past $100. Expected well under $5. A guess: a handful of chat calls
and one image render. Recordings are never hand-edited, and fingerprint
matching is never loosened.

## What bounds it

- No new feature, screen or control.
- The AI writers' stand-in and visitor personalisation are untouched.

## How completion is recognised

- **ci:** the moderation and Facts-page saves send the new name list. This
  is asserted on the request, not on a new visible hint.
- **ci:** the Submit page shows Raena Franklin for she/her and Alex Franklin
  for they/them, and its help example names David.
- **ci:** a newly created pet-reference attempt has Mango, he/him, as its
  subject, with the fact text personalised to Mango, and an explicit override
  still wins. The existing test that asserts the cat is David is updated to
  assert Mango.
- **ci:** the legacy-fixture scrubber treats Mango as a preset, not a member's name.
- **ci:** both acceptance variants replay green on the topped-up recordings.
- **sweep record:** the PR lists every hit and its outcome, kept or changed,
  with the reason.
- **judgement (David, UAT):** in moderation, a *newly drawn* pet-reference
  render, made with an explicit redraw because an existing tile may reuse an
  older attempt, reads right as Mango. Nothing he sees still uses a
  stranger's name.

## Questions for David — answered

**Q26, answered by David on 2026-11-24, beyond both options offered:**

> Replace all male names with David, female names with Raena, non-gendered names with Alex, and pet names with Mango.

**The rule this plan builds:** every personal name the system uses is replaced by the rule below, test inputs included. The exemption for test inputs (option 1, recommended by me and by Astra) is withdrawn by his words.
- male → David;
- female → Raena;
- gender-neutral → Alex;
- a pet → Mango.

Accordingly, the plan's earlier "Kept, under Q26" paragraph no longer applies.

**Still outside the rule:**
- **real people named as themselves**, such as Chuck Norris where the text means the man or the genre, not a stand-in;
- **the AI writers' canonical "Alex, they/them"**, which the rule already maps to itself;
- **a visitor's own name.**

**The trade-off, recorded at David's call** (`decisions.md` gets the entry, with the dissent): tests whose point is a spelling (a possessive of a name ending in "s", accents, other scripts) or a lookup (the name-to-pronoun table) are rewritten onto the four names. Where that loses what the test checked, the loss is named in the PR, not hidden. Where a lookup needs the new name, such as Raena in the pronoun-inference table, the table gains it.

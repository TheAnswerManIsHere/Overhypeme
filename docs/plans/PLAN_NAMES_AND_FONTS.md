# Plan — names and caption fonts: a wider Latin name rule, eleven caption styles, provider names that never garble

```plan-oracle
# Oracle — names and caption fonts (identity flow, Issue #719, after Phase 2)

Agreed by David, in words, 2026-11-02, choosing "Option 1: plan all three together" of this scope:

1. **Wider name rule:** every Latin letter (including Vietnamese and Romanian) that all of the chosen caption fonts draw, pinned by the coverage test across every font.
2. **Caption font picker:** a handful of visibly different styles (serif, sans-serif, hand-drawn, script, block and the like; David's list was examples, not the set), each chosen only if it covers that full letter set, each shipped with the server so saved memes match the preview.
3. **Google/Apple names that break the rule:** nothing garbled is stored; onboarding asks how to write the name in English letters. No automatic conversion of non-Latin scripts.

David's own words that set it:
- "There should be a selection of fonts for style purposes. Yes, all of them need to support the characters that we're supporting, but you should be able to select from a handful of fonts that look different (e.g. serif, san-serif, hand drawn, script, block, etc.) to allow the users some stylistic choices."
- "We should catch the case where a stored Google or Apple name doesn't conform to our rules and give the user the option to update the name we use at that time. I'm OK with broadening the font rule a bit to account for a larger percentage of names if you think it is reasonable".
- At approval, 2026-11-03: "I didn't mean to explicitly enumerate a set of styles in my prompt, I was simply giving examples" (no more than about ten); then, from the measured shortlist and a page showing each face, he cut Oswald ("so similar to the standard that it's not really useful"), Bungee and Source Code Pro ("not different enough to justify using"), kept VT323 and Amatic SC, and chose all eleven over cutting one ("1").
- Earlier the same day: names English-script only until internationalization ("keep the site in English only and meant to support names that can be written in English"); fields stop at 50 characters and never error at save.

**Must not change:** English/Latin-script only (no other scripts); the 50-character limit and the field stopping at it; one shared name rule for browser and server; already-saved memes are fixed artifacts; Anton stays the default caption font; existing saved memes keep their font.

**Now / next / never:** Now: the three items. Next: internationalization (other scripts) after launch. Never: automatic transliteration of non-Latin names.

**Process / tier:** feature, production phase; touches sign-in (provider names, onboarding) — accounts-auth, specialist review. The plan comes to David for approval before anything is built.
```

## Preflight

- **Increment test.** One increment, one PR. When it merges:
  - A visitor can type "Nguyễn", "Ștefan" or "Türkoğlu".
  - They can pick any of eleven visibly different caption styles and download or save a meme that looks exactly like its preview.
  - A Google or Apple account whose name the rule can't hold stores nothing garbled, and onboarding asks for the name in English letters.

  All three are observable in the Repl.
- **Affected surfaces:**
  - the shared name rule (`lib/api-zod/src/personalNameRule.ts`) and its fixture table;
  - the font-coverage test;
  - a new shared caption-font catalogue (`lib/api-zod`);
  - the wizard's font picker (`AdvancedOptionsSheet.tsx`);
  - the remix builder (`MemeBuilder.tsx`, Question N1);
  - `LivePreview.tsx`;
  - the server renderer (`memeGenerator.ts`) and its font assets;
  - `TextOptionsSchema.fontFamily` (`validators/memeBuilder.ts`);
  - the provider callback (`routes/auth.ts`);
  - onboarding's name guidance (`Onboard.tsx`);
  - the legacy recipe render (`routes/memes.ts` image route) and the boot backfill.
- **Claims and their oracles:** each is a measurement named below. The font coverage was measured in this container on 2026-11-02 from each font file's own character map (`fc-query`). Rendering is pinned at build by drawing every admitted character in every face.

## Problem

- **The name rule is narrower than it needs to be, and Google and Apple names get garbled.** The rule admits only Latin-1 and Latin Extended-A letters. That is narrower than the meme font needs: Anton also draws Vietnamese and Romanian letters (Astra's probe, 2026-11-02).
  - The provider cleaner turns each refused letter into a space or deletes it. Astra's read-only probe of `cleanProvidedPersonalName`: `Nguyễn` → `Nguy n`, `Ștefan` → `tefan`, `Țepeș` → `epe`, `John 王` → `John`.
- **The builder's font choices are half broken.**
  - The wizard offers five entries (Bebas Neue, Anton, DM Sans, JetBrains Mono, Impact) as CSS font stacks (`AdvancedOptionsSheet.tsx:11`).
  - The server bundles only Anton, registered as "Anton" and "Impact", and wraps the received stack string in quotes as one family name (`memeGenerator.ts:307-319`). So every choice but Anton and Impact saves in a fallback face that doesn't match the preview.
  - The preview defaults to `Impact, system-ui, sans-serif` (`LivePreview.tsx:123`), while the picker shows Bebas Neue when nothing is selected.
  - The remix builder on the meme page has no picker at all.

## Product intent

1. **The name rule admits every Latin letter all eleven caption fonts draw.** That includes Vietnamese, Romanian, Turkish, Polish, Czech and the Western European accents. Nothing outside the Latin alphabet is admitted, and nothing changes about punctuation, normalization or the 50-character field limit.
2. **A meme's caption can be set in one of eleven visibly different styles**, and the downloaded or saved meme matches its preview in that style. Anton stays the default.
3. **A Google or Apple first or last name the rule can't hold is not stored.** The account just lacks it, and sign-in proceeds as before. Onboarding's required display-name field, already the place every new account confirms its name, tells the visitor to write the name in English letters. Nothing is ever transliterated automatically.
4. **Memes already saved, and memes still rendered from a saved recipe, keep the face they had.**

## Must not change

- Latin script only; the 50-character limit, which the field stops at; one rule for browser and server; the disallowed-character and length hints.
- Phase 2's onboarding name order (draft, the account's explicit display name, the browser's name, blank). A provider name never displaces the browser's name.
- An account's existing names are never overwritten by a later sign-in.
- Stored meme files are untouched. A legacy font string in a stored recipe resolves to exactly the face it resolves to today.
- Anton is the default caption face.

## Settled decisions

- **The eleven faces** (David, 2026-11-03, from 75 Google Fonts measured with each file's own character map, `fc-query -i 0`, and a page showing each face with sample names and memes). All are free, open-licensed Google Fonts:

  | Id | Style | Font | Weight | Letters it lacks |
  |---|---|---|---|---|
  | `block` | Block (default) | Anton (already bundled) | 400 | none |
  | `sans` | Clean sans | Montserrat | 800 | none |
  | `serif` | Elegant serif | Playfair Display | 700 | none |
  | `slab` | Slab poster | Alfa Slab One | 400 | `ſ Ǎ ǎ Ǔ ǔ` |
  | `comic` | Comic shout | Bangers | 400 | `ŉ ſ Ǎ ǎ Ǔ ǔ` |
  | `stencil` | Stencil | Black Ops One | 400 | `ŉ ſ Ǔ ǔ` |
  | `rounded` | Rounded, playful | Baloo 2 | 700 | `ſ` |
  | `hand` | Handwritten | Patrick Hand | 400 | none |
  | `sketch` | Sketched capitals | Amatic SC | 700 | `ſ` |
  | `script` | Script | Lobster | 400 | none |
  | `terminal` | Retro terminal | VT323 | 400 | `ſ Ǎ ǎ Ǔ ǔ` |

  Dropped after measurement: Bebas Neue and Oswald-like condensed faces (too close to Anton), Pacifico (lacks `Ĳ ĳ ſ`), and every horror, pixel, western, marker and graffiti face measured, each of which lacks 100 or more letters including all of Vietnamese.
- **Two of today's letters leave the rule: `ŉ` and `ſ`** (David, 2026-11-03). Both are obsolete (`ŉ` was deprecated by Unicode; `ſ` left English print around 1800), Bangers and Black Ops One lack `ŉ`, and five of the faces lack `ſ`. David accepted this in choosing the eleven. No stored name holds either (Phase 2's check found no name outside the rule; an account with one would meet the field's refusal on its next edit, as any refused character does).
- **The admitted letter set is derived from the font files, not written by hand** (Astra, rounds 1 and 2). A candidate character must have Unicode General_Category Letter and Script Latin. It is admitted when every chosen face contains it, and contains every code point of its JavaScript uppercase mapping, the form the caption renderer's all-caps draws (`toUpperCase`, `memeGenerator.ts:329`, `LivePreview.tsx:161`). Measured 2026-11-03 on the eleven files, the result is 349 characters:

  `U+0041–U+005A U+0061–U+007A U+00AA U+00BA U+00C0–U+00D6 U+00D8–U+00F6 U+00F8–U+0148 U+014A–U+017E U+01A0–U+01A1 U+01AF–U+01B0 U+01FE–U+01FF U+0218–U+021B U+0237 U+1E80–U+1E85 U+1EA0–U+1EF9`

  That is:
  - every letter admitted today except `ŉ` and `ſ` (above);
  - all Vietnamese, Romanian and Turkish letters;
  - `Ǿ ǿ Ẁ ẁ Ẃ ẃ Ẅ ẅ` and the ordinal indicators `ª º`, among others.

  `ƒ` is out, because its capital `Ƒ` is missing from several faces; so are the pinyin letters `Ǎ ǎ Ǔ ǔ`.

  How the set is kept honest:
  - A derivation script in the repository computes the set from the *built* static font files. The pinned character class in the shared rule is generated from it.
  - A test fails if the pinned class and the derivation disagree in either direction, so a supported letter can't be silently omitted and an unsupported one can't be admitted.
  - The rendering test then draws every admitted letter, and its uppercase, in every face, and compares each with that face's own missing-glyph box. It extends today's test, which stops at U+024F and misses the Vietnamese range (scope NF1). It also checks a decomposed input, such as `e` plus a combining mark, after NFC.
- **One shared caption-font catalogue** in `lib/api-zod`, which both the browser and the server import (Astra, scope NF2). Each entry has:
  - a stable id (the table above);
  - a label;
  - an internal family name distinct from every legacy CSS string, for example `OH Block`;
  - its font file;
  - its weight.

  How the catalogue is used:
  - The picker, the preview, request validation, download and save all speak in catalogue ids.
  - `textOptions.fontFamily` carries an id for new memes. The schema accepts the eleven ids, or a legacy string on a stored recipe only.
  - The server registers each face under its internal family and draws `"<internal>", sans-serif`.
  - The browser loads the same file via `@font-face` under the same internal name.
- **The preview and the saved meme never differ in face or weight** (Astra, round 1).
  - **Preview loading:** the preview measures and draws only after the selected face has loaded (`document.fonts.load`). While it loads, save and download are unavailable. If loading fails, the selection and the draft are kept, a Retry appears, and any other face can be chosen. Save and download return once the face shown matches the selected id.
  - **Server registration:** if the server cannot register the selected face, the render fails with an error rather than storing an image in a fallback font. Today a registration failure logs a warning and carries on (`memeGenerator.ts:48`); the missing-packaged-font bug of PR #831 was exactly that.
  - **Weight:** each catalogue entry fixes its weight, and the browser and the server both draw new ids at that weight. Today the preview treats an omitted `bold` as normal and the server treats it as bold (`LivePreview.tsx:123`, `memeGenerator.ts:307`).
- **Restored wizard drafts are moved to ids** (Astra, round 1). A wizard draft restored from storage (`wizardStorage.ts`, kept up to an hour) that holds an old picker's CSS stack has its font mapped to the nearest catalogue id before preview or save; the rest of the draft is untouched, and the picker shows the mapped choice. New API requests accept ids only.
- **Legacy font strings keep today's interpretation** (Astra, scope NF4). A stored recipe with an *omitted* `fontFamily` also keeps today's default face and weight; the new catalogue default (Anton, block) applies to new memes only. A stored recipe whose `fontFamily` is not a catalogue id resolves exactly as the renderer does today. That path is the legacy recipe render (`GET /memes/:slug/image` for an unbaked row or a missing file) and the boot backfill. Because the internal family names are new, a legacy string such as `'Bebas Neue', Impact, sans-serif` can never start selecting a newly bundled face. A test renders a legacy-string recipe before and after and compares the bytes.
- **Provider names: whole value or nothing** (Astra, scope NF3). `cleanProvidedPersonalName` is replaced by `acceptProvidedPersonalName`:
  - It normalizes the provider's first or last name.
  - It keeps the name only if the whole normalized value passes the shared rule, refusing both a disallowed character and an over-length name; otherwise it returns null.
  - It never strips, spaces out or truncates.
  - Sign-in proceeds either way, and an existing account name is never replaced.

  The correction surface is onboarding's existing required display-name field. Its guidance line reads "Write your name in English letters — the way you'd like it on your memes." No correction-state subsystem and no stored rejected text.
- **The picker in both builders** (Question N1, recommended): the wizard's sheet, and a new control in the remix builder on the meme page, both rendering the one catalogue.

## Testing

- **Name rule:**
  - the shared table, run on both sides, gains Vietnamese, Romanian, Turkish, Polish and Czech accepts, keeps `Ĳ ĳ` accepted, and refuses `ŉ`, `ſ` and `ƒ` (its capital isn't in every face), Cyrillic, Greek and CJK;
  - the decomposed input `Nguye` + U+0302 + U+0303 + `n` normalizes to `Nguyễn` and is accepted.
- **Coverage:** every admitted code point, both cases, drawn in each of the eleven faces from the *built* server's font directory, none equal to that face's missing-glyph box.
- **Fonts end to end:**
  - for each id, a render through `generateMemeBuffer` differs from a render in every other id (the faces really differ);
  - the preview requests the same internal family the server registers;
  - an unknown id is refused by the schema;
  - a legacy string on a stored recipe, and a recipe with no `fontFamily`, each render byte-identically before and after, through the live recipe render and the boot backfill;
  - the effective face *and weight* match between preview and download for every id, through both builders, including an untouched default;
  - a server that cannot register the selected face refuses the render;
  - a restored draft holding an old picker string is mapped to an id and saves.
- **Preview loading:** the preview does not draw, and save and download stay unavailable, until the face reports loaded; a failed load shows Retry, keeps the draft, and lets another face be chosen.
- **Provider names:**
  - `Nguyễn` is kept whole;
  - `Иван` and `John 王` are refused whole, with nothing stored;
  - a 60-character name is refused;
  - a missing name stays null;
  - a second sign-in never overwrites a stored name;
  - E2E OAuth journeys for both Google and Apple with a refused name still reach onboarding and save the typed display name.
- **UAT:** David picks each style and downloads a meme with an accented name (human judgement of look). Everything else is a machine lane.

## Implementation steps

One increment, one PR, in dependency order:
1. Bundle the eleven faces (static weights) under the server's assets, where the build copies them (the PR #831 lesson), and as web fonts for the browser.
2. The catalogue in `lib/api-zod`, and the server registration.
3. The name rule's character class, with the shared table and the extended coverage test.
4. The schema (ids, plus legacy strings on stored recipes), the renderer's id resolution, and the legacy path kept as is.
5. The preview's face loading and the picker in the wizard; then the remix builder's picker (N1).
6. The provider-name acceptance.
7. Onboarding's guidance line.

A specialist sign-in review is required (provider names), and `/simplify` runs before the PR.

## Questions for David — answered

- **N1 — Where the picker appears:** both builders (David, 2026-11-03: "1").
- **N2 — The faces:** the eleven in the table above (David, 2026-11-03).

# PR #723 — Identity flow Phase 1: the site asks for your name and pronouns — UAT

**Workstream:** #722 (Phase 1 of #719)

Until now the "What's your name?" sheet never appeared anywhere (#705). With this change it appears on any ordinary page for someone the site doesn't know yet. It asks only for whatever is missing: the name, the pronouns, or both. After that it never asks again on that browser.

- A share link that carries a name and pronouns sets them, and the visitor is never asked.
- Opening a shared meme, video or fact page shows it first; the site asks on the next page the visitor goes to.
- Sign-in, password, onboarding and admin pages never ask.
- Signing out clears the stored name, so the next visitor on that browser starts fresh.
- Home's own name box is gone, as you chose; Home shows the same sheet as every other page.

Everything except how the sheet feels on your phone is checked by a machine.

## Setup

- [claude] Confirm the Repl is synced to the merge commit, so the dev app on your phone serves this change.
- [david] For step 9, open the dev app on your phone in a private browsing tab. A private tab holds no stored name, so you arrive as a new visitor.

## Steps

### 1. A new visitor is asked on Home, and only once

**Do:** Open Home with nothing stored, type a name and save.

**Expect:** The sheet opens and asks "What's your name?". After saving it closes and the name and pronouns are stored. A reload never shows it again.

**Lane:** ci

**Check:** `artifacts/overhype-me/e2e/identityFlow.spec.ts:a cold visitor is asked on Home, saving stores both halves, and a reload never asks again`

### 2. The sheet covers the not-found page, never the sign-in or password pages

**Do:** Visit an unknown address, then the sign-in page and the forgot-password page, with nothing stored.

**Expect:** The sheet opens on the unknown address. It never opens on the sign-in or password pages.

**Lane:** ci

**Check:** `artifacts/overhype-me/e2e/identityFlow.spec.ts:the sheet opens on the not-found page and never on sign-in or password pages` `artifacts/overhype-me/src/lib/identity.test.ts:never asks on a suppressed page, but does on a near-miss sibling`

### 3. The name never leaves the browser while signing up anonymously

**Do:** Type "Maria" in the sheet and save. In a fresh browser, type "Zorblax" instead.

**Expect:** For Maria, she/her is suggested in the visible pronoun choices, and no request goes to the AI suggestion service. For Zorblax, no pronouns are pre-selected and Save stays off until one is picked; nobody is given he/him without choosing it.

**Lane:** ci

**Check:** `artifacts/overhype-me/e2e/identityFlow.spec.ts:signed-out capture suggests pronouns without sending the name to the server` `artifacts/overhype-me/e2e/identityFlow.spec.ts:a name with no pronoun suggestion cannot be saved until the visitor picks pronouns`

### 4. A full share link sets both halves and never asks

**Do:** Open a link carrying a name and pronouns, then reload.

**Expect:** No sheet appears, the name and pronouns from the link are stored, and the address bar loses the parameters. A reload shows the same identity.

**Lane:** ci

**Check:** `artifacts/overhype-me/e2e/identityFlow.spec.ts:a full share link sets both halves, never asks, and leaves the address bar clean` `artifacts/overhype-me/src/hooks/use-person-name.test.ts:applies a full share link to an empty browser in the identity, holding it unwritten until auth resolves`

### 5. A half share link asks only for the missing half

**Do:** Open a link carrying only a name.

**Expect:** The sheet asks "Pick your pronouns", with the name already filled in.

**Lane:** ci

**Check:** `artifacts/overhype-me/e2e/identityFlow.spec.ts:a half share link sets its half and asks only for the other` `artifacts/overhype-me/src/hooks/use-person-name.test.ts:fills only the empty half when the browser holds one`

### 6. A shared meme shows first; leaving it asks on the next page

**Do:** Open a shared meme with nothing stored. Then leave it four ways, as the test does:
- ctrl-click "View full fact", which opens a new tab;
- click "View full fact" in the same tab;
- press Enter in a search;
- on a phone, tap the wordmark.

**Expect:**
- The meme shows with no sheet.
- The new tab is a fresh visit to a fact page, so it shows no sheet either.
- Each in-app departure opens its page with the sheet over it.

**Lane:** ci

**Check:** `artifacts/overhype-me/e2e/identityFlow.spec.ts:a shared meme shows its content first; leaving it by link or by search asks on the next page` `artifacts/overhype-me/e2e/identityFlow.spec.ts:on a phone, tapping the wordmark to leave a shared meme asks on Home`

### 7. A builder opened by its link waits for your name

**Do:** With nothing stored, open a fact's "make a meme" address directly, save a name, then open the image step.

**Expect:** The builder does not appear until the sheet is saved. Once it is saved, the builder shows the fact with the saved name.

**Lane:** ci

**Check:** `artifacts/overhype-me/e2e/identityFlow.spec.ts:a cold visitor arriving at a builder route is asked first; the builder then starts with the saved name`

### 8. Signing out clears the stored name

**Do:** Signed in, with a name stored in the browser, sign out from Profile.

**Expect:** After sign-out the stored name and pronouns are gone, and Home asks again.

**Lane:** ci

**Check:** `artifacts/overhype-me/e2e/identityFlow.spec.ts:signing out clears the browser copy, so the next page asks`

### 9. The sheet feels right on your phone

**Do:** In a private tab on your phone, open the dev app's Home. Wait for the sheet, type your name, look at the suggested pronouns and save. Then open the dev app's address for any shared meme in the same tab and browse away from it.

**Expect:** The sheet appears quickly but not jarringly, reads clearly, and suggests sensible pronouns. Saving feels like the end of a step, not an interruption.

**Lane:** human

**Judgement:** whether the timing, copy and feel of a first-visit prompt is right on a real phone is a matter of taste and of your own device; the machine steps prove only that it opens, asks and saves.

## Regression

### R1. Stored names from before this change are still read

**Do:** Load the site with a name stored under the current keys, or with pronouns stored only under the old subject/object keys.

**Expect:** The stored identity is used. The old pronoun keys migrate into the new one.

**Lane:** ci

**Check:** `artifacts/overhype-me/src/hooks/use-person-name.test.ts:reads a stored name and pronouns as supplied` `artifacts/overhype-me/src/hooks/use-person-name.test.ts:migrates the legacy subject/object keys into a supplied value`

### R2. A share link never overwrites the visitor's own identity

**Do:** With a name and pronouns stored, open a share link carrying different ones.

**Expect:** The visitor's own identity is kept, and nothing is asked.

**Lane:** ci

**Check:** `artifacts/overhype-me/e2e/identityFlow.spec.ts:a share link never overwrites the visitor's own identity`

### R3. The rest of the public site still shows its usual content

**Do:** Browse Home, Top Facts, a fact page, a meme page and a builder, as the existing described-screens tests do.

**Expect:** Every screen shows what it did before.

**Lane:** ci

**Check:** `artifacts/overhype-me/e2e/publicScreens.spec.ts:home, Top Facts and a fact page show their usual layout and content` `artifacts/overhype-me/e2e/publicScreens.spec.ts:logged out, /facts/:id/meme opens the builder and its image step shows no visibility control`

## Not bugs

- **Home still shows "About David Franklin" behind the sheet.** That is Home's sample teaser; the sheet asks for your own name over it.
- **On a shared meme page you can still click its buttons without being asked.** Asking at those in-page actions is Phase 3; for now you are asked on the next page.
- **A signed-in Google or Apple account with no name is asked only when the browser has no name either.** Account completion, and saving the answer to the account, is Phase 2.

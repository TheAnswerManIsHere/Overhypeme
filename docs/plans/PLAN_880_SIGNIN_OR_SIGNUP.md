# Plan — Issue #880: the signed-out photo step invites sign-in as well as sign-up

Short plan (one increment, one PR). Product code, production phase, product tier.

```plan-oracle
# Scope — Issue #880: the meme builder's signed-out photo step invites sign-in as well as sign-up

## Direction served
Launch backlog wave 2 (Issue #628, approved by David 2026-11-21): the before-launch should-haves. The loop is personalize → make a meme with your own photo → share; a returning member who is signed out must not be told they have to create an account.

## Product intent (David, verbatim, Issue #880)
> This screen should say "Sign up or sign in". Make it clear that if you already have an account you can simply sign in but if you don't have an account, you'll need to sign up.

Seen 2026-11-06 on the dev Repl: signed out, the image step shows "Sign up to create a meme using your photo" and one SIGN UP button.

## This increment
The panel a signed-out visitor sees in the meme builder's image step (`GuestPhotoSignupPanel.tsx`) says "Sign up or sign in", and its text makes clear that someone with an account just signs in, and someone without one signs up. Selecting the action takes the visitor to the existing `/login` page, which already offers both (it opens on sign-in, with a link to switch to sign-up).

## Must not change
- The `from` return path: a visitor who signs in or signs up from this panel comes back to the builder where they were.
- The `/login` page's own behaviour and copy.
- What a signed-in member sees in the image step.
- The E2E assertion on this panel's copy (`e2e/publicScreens.spec.ts:210` on `main` at 7cb98ba; the issue named two, at lines that have since moved and merged into one) moves with the copy; it is not dropped.

## Settled decisions
- Stock photos are gone (launch Phase 4, removal 6), so a signed-out visitor has no image source; this panel stays the only thing they see in that step. Restoring a free signed-out preview is Phase 7's, not this.

## Now / next / never
- Now: the panel's heading, explanatory line and button label.
- Next (not this increment): opening `/login` directly in sign-up mode from a separate "Sign up" button; any other signed-out prompt on the site.
- Never here: changing `/login` itself.

## Ceremony tier
Feature mode, production phase, product tier: short plan, Astra review, David's approval; Codex code review on the PR; a UAT step for David (the wording is a judgement).
```

## What this increment makes true

A visitor who is signed out and reaches the meme builder's image step sees a
panel that says **Sign up or sign in**, and its text tells them plainly that
someone with an account just signs in and someone without one signs up. The
one button takes them, exactly as today, to `/login` carrying the `from`
return path; that page already opens on sign-in and offers sign-up.

Proposed copy (the wording is David's judgement at UAT; a word change after
approval is a one-line follow-up, not a new plan):

- **Heading:** Sign up or sign in to make a meme with your photo
- **Line beneath:** Already have an account? Just sign in. New here? Sign up first.
- **Button:** Sign up or sign in

## What bounds it

- One component, `GuestPhotoSignupPanel.tsx`: heading, one new explanatory
  line, button label, and its doc comment. The click handler and destination
  are untouched.
- No change to `/login`, to `Step2Image.tsx`, or to what a signed-in member sees.
- Not here (next, if ever): a second button that opens `/login` straight
  into sign-up mode; other signed-out prompts elsewhere on the site.

## How completion is recognised

- **ci** — `e2e/publicScreens.spec.ts` (the signed-out image-step test) asserts
  the new heading, the explanatory line and the button label, and that the
  old sentence is gone; the same test clicks the button and asserts the
  browser lands on `/login` with `from` equal to the builder path it left,
  query string included (the test opens the builder on a URL that carries one).
- **ci** — the old copy is searched for across the app, the E2E suite and the
  acceptance harness and is found nowhere.
- **judgement (David, UAT)** — signed out, on the dev Repl, the step reads as
  welcoming both a returning member and a newcomer.

## Questions for David

None. The one choice inside this plan, a single button rather than separate
Sign in / Sign up buttons, follows his words ("This screen should say 'Sign up
or sign in'") and the issue's note that the destination already offers both.

# Chapter 9 · Accounts and Authentication

> How you get an account on Overhype.me, the order a new account goes
> through before it can act, what "signed in" means day to day, and what
> happens when an account is [suspended](../ai-context/glossary.md#suspend) or
> [deleted](../ai-context/glossary.md#account-deletion).
>
> Deep spec: [`accounts-and-auth.md`](../ai-context/accounts-and-auth.md).
> Security posture (trust boundaries, session security): [`security-model.md`](../ai-context/security-model.md).

## What it does

Overhype.me needs to know who you are any time an action is tied to a
person rather than just a page — submitting a fact, saving a meme, rating
or commenting, and paying for a membership all require being signed in.
Nothing else does: browsing, personalizing what you see, and sharing a
meme all work without an account.

Since launch Phase 5, an account is a **verified, consenting, age-known
identity that can leave cleanly**: it has confirmed its email, told us its
date of birth and pronouns, recorded its marketing choice, and can be
deleted — by its owner or by an admin — without leaving a mess behind.

## How it works

### Signing in

You can create an account with Google, with Apple, or with an email and
password — all three end up in the same place: a signed-in session that
looks identical to the rest of the product no matter which door you came
through. There's no "sign in via a link we email you" option. The emails
that touch sign-in are a one-time verification message, sent after you
register with email and password or change your email address, and a reset
link if you've forgotten your password. Neither is a standing way to log
in.

Google and Apple tell us whether they have confirmed your email. If they
have, your account counts as verified. If they haven't, and the email
already belongs to an account here, the sign-in is refused and you're
pointed at password sign-in or a password reset instead. Matching on an
unconfirmed email would hand that account to whoever controls the
unconfirmed address.

If you signed up with Google or Apple and later want to also be able to log
in with a password, you can set one from your account settings without being
asked to prove you know a password you never had — or follow a reset link,
which works for an account that has no password yet.

### Verify, then onboard, then act

Every new account goes through the same order, whichever way it signed up,
and the server enforces it on every write. The browser only steers you to
the right screen.

1. **[Verify your email](../ai-context/glossary.md#email-verification).** Until
   you do, you can sign in and look around, but nothing you try to do —
   submit, comment, rate, upload — goes through. (A Google or Apple sign-up
   whose provider confirmed the email skips this step.)
2. **[Onboard](../ai-context/glossary.md#onboarding).** One screen for every
   sign-in method asks for your date of birth, confirms your pronouns and
   name, and records your marketing choice. The box is pre-ticked for
   visitors in the US and unticked everywhere else. It also asks you to
   pass one Cloudflare Turnstile challenge (proving you're a person). If
   you leave half-way, your answers are kept for next time. **Under 13 is
   refused**: nothing is stored and nothing is destroyed. Accounts that
   existed before Phase 5 are asked once too.
3. **Act.** From then on the account can do everything its membership
   allows. Adults (18 and over, worked out from the date of birth each time
   it is needed, never stored as a flag) are also offered a profile photo,
   and only adults can upload photos at all.

There's no separate "guest" or "anonymous" tier of account — every account
you can sign in as is a full account, not a lighter stand-in. (Admin-created
accounts are a separate case — an [admin](../ai-context/glossary.md#admin) can
create an account that starts genuinely
[unregistered](../ai-context/glossary.md#unregistered) rather than at the
normal default, which is a membership state, not something onboarding
controls.)

A sign-up that never finishes onboarding is cleaned up: 30 days after it
was created, it is scheduled for deletion and its owner is emailed, with
the usual 14 days to keep it (below). That never happens to an account an
admin made, or to one that has already kept itself once.

### Resetting or changing your password

Forgetting your password works the way you'd expect: request a reset, get an
email, follow the link, set a new password. Overhype.me always shows the
same confirmation after you request a reset, whether or not that email
actually belongs to an account — so a reset request can't be used to check
who has an account here. A reset link works once: if two tabs use it at the
same moment, one changes the password and the other is told the link was
used.

**Every password change signs your other sessions out.** A reset signs out
every device; setting or changing your password from your account settings
signs out every device but the one you're using. A password change is often a
response to an account being compromised somewhere, so whoever else is
signed in as you shouldn't stay signed in.

### When an account is suspended

An admin can **suspend** an account, giving a reason only admins ever see.
Suspension signs the account out everywhere and stops it signing back in by
any door — password, Google, Apple, or a reset link. A device that was
signed in can still look around, but everything it tries to do is refused
and it's shown one screen: *"This account is suspended."* It never says
why.

Suspension blocks the **person**, not the catalogue: the account's facts,
memes and comments stay live, and its membership billing is left alone. An
admin can lift it at any time, and the account carries on as before; a
reset link requested before the suspension still works afterwards, if it
hasn't expired. An admin
can't suspend their own account, or the last administrator who can reach
the console.

### When an account is deleted

**You can delete your own account** from your profile ("Delete my
account…"). Because it should be hard to do by accident, it asks for your
password first — or, for an account that only signs in with Google or
Apple, a fresh sign-in from the last ten minutes. Then:

- **You're signed out everywhere at once, and your content is hidden at
  once.** Any paid subscription is cancelled at the same moment, so nothing
  bills again, and you're emailed.
- **You have 14 days to change your mind.** Signing back in takes you to
  one screen with a **"Keep my account"** button; pressing it brings your
  account and content back. Anything you deleted by hand before then stays
  deleted.
- **After 14 days the account is deleted.** Your photos, memes and
  generated images are removed from Overhype.me (kept for seven days in a
  backup, as every deleted photo is). Your account goes too. What you gave
  the community stays, without your name: **facts persist forever**,
  credited to a [former member](../ai-context/glossary.md#former-member). So do
  your comments, your submissions waiting for review, and your votes and
  hearts in the totals.

**An admin can [remove](../ai-context/glossary.md#remove) an account at
once**, from the user editor. That is the abuse case, so it goes further: the
account's comments, submissions waiting for review, links, votes and hearts
are deleted, and the totals they fed are recounted. Facts still persist,
credited to a former member. If the member had already asked to delete their
own account, the admin's removal takes it over.

Admins see every deletion in progress on one panel, with when it will
happen and anything that went wrong. "Purge now" brings a member's own
deletion forward, keeping what it keeps; on a deletion that failed
part-way, it is also the retry. Admins can also keep an account on its
owner's behalf, and the owner is emailed. A billing dispute pauses the
deletion until it's settled. Anything tied to a legal or safety report
keeps its record — the report row and its evidence survive the deletion —
though not who it was tied to.

### Deleting things from My content

Separately from deleting your whole account: anything you delete from **My
content** — an upload, a generated image, a meme — moves to **Recently
deleted** for 30 days and comes back with one click. After that it is
removed. While it waits there, only you can see it.

### Staying signed in

Once you're signed in, Overhype.me keeps you that way across visits without
asking you to log in again every time — there's no separate "remember me"
choice to make, that's just how a normal session behaves. You can be signed
in on more than one device at once — a phone and a laptop, say — and signing
in on a new one doesn't sign the others out. Some events sign out every
device at once: a password change (all but the device making it, when you
change it yourself), a suspension, and a request to delete the account.

### Who counts as what

Overhype.me distinguishes a handful of standing [roles](../ai-context/glossary.md#role) — signed-out visitor,
[Unregistered](../ai-context/glossary.md#unregistered) (an admin-created starting state, not the normal default),
[registered](../ai-context/glossary.md#registered) user, [Legendary](../ai-context/glossary.md#legendary) member, admin — and which one applies to you is
always figured out fresh from your actual account state, never something
stored on your session that could go stale or be tampered with. The same is
true of whether you're verified, onboarded, suspended or leaving. For the
standard admin gate the product relies on almost everywhere, an admin who
temporarily views the site "[as a regular user](../ai-context/glossary.md#view-as-regular-user)" (to check what a member
actually sees) never actually loses their admin permissions on the backend
while doing it — that toggle only changes what the interface shows them.
A handful of narrower, more mechanical endpoints (scheduled-job triggers
and similar) check the toggle directly rather than going through that
standard gate, so those specifically would treat a viewing-as-user admin
as a non-admin for as long as the toggle stays on — a known inconsistency
in a small corner, not how authorization works generally.

## Why it works this way

- **One order, enforced in one place.** Verify, then onboard, then act is
  checked by a single gate on every write, with one table saying what each
  kind of not-yet-ready account may still do. A rule spread across every
  screen would have a screen that forgot it.
- **Suspension and deletion are different things.** Suspension stops a
  person and is undone by an admin; deletion is a person leaving, on a clock
  they control. They used to share one "inactive" switch, which meant the
  product couldn't tell a banned account from a departing one. That switch
  is retired (the admin "deactivate" and "reinstate" actions went with it),
  and each state has its own record.
- **Leaving cleanly respects the community and the person.** What someone
  gave others — a fact, a comment, a vote — stays when they leave, without
  their name, as on Reddit and Stack Overflow. Their own things — photos,
  memes, generated images — go. An admin removing an abusive account is the
  exception, so it takes the contributions too (David, 2026-11-02).
- **A deletion is hard to do by accident and easy to undo for two weeks.**
  Asking for the password (or a fresh sign-in) stops a borrowed device or a
  slip of the finger; the 14 days stop a moment of anger.
- **Signing out every device is reserved for real signals.** A password
  change, a suspension and a deletion request each mean whoever else is
  signed in as you shouldn't be. Ordinary actions affect only the session
  they happen on.
- **Roles and account states are computed, never trusted from the
  session.** Storing "this session belongs to an admin" or "this account is
  allowed to act" on the session would let a stale or tampered session keep
  a permission after it was taken away.

## Boundaries & known limitations

- **No Terms acknowledgement yet.** Onboarding records marketing consent
  only; Phase 14 adds the Terms and Privacy pages and asks every account
  once (David overrode the recommendation to add minimal text now).
- **Adult content isn't on.** The data model can mark facts, memes and
  images as adult, and record an adult verification, but nothing uses
  either yet. The old opt-in for NSFW images is withdrawn, so a photo the
  classifier flags is refused for everyone.
- **A member can't yet delete one of their own comments.** That comes in
  Phase 9, before launch.
- **A suspended member who had asked to delete their account can't keep
  it**, since keeping is an action a suspended account can't take.
- **A change that lands in the very instant a suspension does** — a reset's
  new password, a verification — can still be stored. It leaves no session
  and no new capability, so it ends where a moment-earlier action would
  have.
- **Concurrent sign-ins are unlimited.** Overhype.me doesn't cap how many
  devices or sessions one account can be signed into at once, and doesn't
  show you a list of them to review or revoke individually.

## Going deeper

- Spec: [`accounts-and-auth.md`](../ai-context/accounts-and-auth.md) — the
  exact routes, the account states and the gate, session mechanics, token
  handling, suspension, and the deletion engine's stages.
- Security posture: [`security-model.md`](../ai-context/security-model.md) —
  trust boundaries, session security properties, rate limits.
- Related: [`10-payments-and-membership.md`](./10-payments-and-membership.md) (how
  a role and [membership tier](../ai-context/glossary.md#membership-tier) translate into what you can do and pay for).
- Rationale: the auth and account entries in [`decisions.md`](../ai-context/decisions.md).

**Next:** chapter 10 — [`10-payments-and-membership.md`](./10-payments-and-membership.md),
free vs. Legendary, plan shapes, and what a membership unlocks.

*Verified against `54f5b2f` (2026-11-02) · rewritten for launch Phase 5 (#795).*

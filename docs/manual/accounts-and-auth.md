# Accounts and Authentication

> How you get an account on Overhype.me, what "signed in" actually means day
> to day, and what happens to an account when it's deactivated or removed.
>
> Deep spec: [`accounts-and-auth.md`](../ai-context/accounts-and-auth.md).
> Security posture (trust boundaries, session security): [`security-model.md`](../ai-context/security-model.md).

## What it does

Overhype.me needs to know who you are for exactly two reasons: so a fact you
submit is attributed to you, and so a membership you're paying for actually
applies to you. Signing in exists to serve those two things — nothing else on
the site requires an account, and browsing, personalizing what you see, and
sharing a meme all work without one.

## How it works

### Signing in

You can create an account with Google, with Apple, or with an email and
password — all three end up in the same place: a signed-in session that
looks identical to the rest of the product no matter which door you came
through. There's no "sign in via a link we email you" option; the only email
Overhype.me sends that touches sign-in is a one-time verification message
after you register with email and password, and a separate reset link if
you've forgotten your password — neither one is a standing way to log in.

If you signed up with Google or Apple and later want to also be able to log
in with a password, you can set one from your account settings without being
asked to prove you know a password you never had.

### Creating an account

Registering with email and password asks for your name, an email, and a
password; picking pronouns is asked for on the sign-up screen but isn't
actually required to finish creating the account. If you sign up with Google
or Apple you're not asked for pronouns at all — you set them later, from your
profile, the same place anyone can change them.

There's no separate "guest" or "anonymous" tier of account — every account on
Overhype.me is a full account. What can feel like a lighter, more limited
account right after signing up is really a second, one-time step: a short
onboarding challenge (proving you're a person, not a bot) that a fresh
account completes once before it can submit its first fact. Until that step
is done, you can still sign in and look around; you're only stopped at the
point of trying to submit something.

### Verifying your email

Registering with email and password sends a verification link, and clicking
it — even from a browser where you're not currently signed in — signs you
in. **Right now, verifying your email doesn't unlock anything you couldn't
already do** — it's a trust signal shown to moderators and admins, not a
requirement checked anywhere before you submit a fact, comment, or anything
else. The gate that actually matters for a first submission is the
onboarding challenge above, not email verification.

### Resetting or changing your password

Forgetting your password works the way you'd expect: request a reset, get an
email, follow the link, set a new password. Overhype.me always shows the
same confirmation after you request a reset, whether or not that email
actually belongs to an account — so a reset request can't be used to check
who has an account here. Resetting your password signs you out everywhere
else your account was signed in, on every device — a deliberate safety
measure, since a password reset is often a response to your account being
compromised somewhere. If you originally signed up with Google or Apple and
never set a password, requesting a reset doesn't do anything — there's
nothing to reset — you'd use the "set a password" option from your account
settings instead, which (unlike a reset) doesn't sign your other sessions
out.

### When an account is deactivated or removed

You can't deactivate or delete your own account from the product today —
that's an admin-only action, done on request. There are two versions:

- **Deactivating** an account signs it out everywhere, cancels any active
  paid membership, and locks the account out of signing back in — but
  leaves everything that account created exactly as it was. Facts,
  comments, and memes it authored stay live and attributed to it.
- **Removing** an account goes further: the account's own uploaded images
  and personal data are deleted, but content it created and other people
  might be relying on — facts, comments, memes — is **kept**, just no
  longer tied to a real account. It isn't deleted along with the account,
  and it isn't secretly left attributed to a name that no longer resolves
  to anyone. Anything tied to a legal or safety report is deliberately kept
  fully intact regardless, for as long as that kind of record needs to
  exist.

A deactivated account can be reinstated by an admin, which signs it back in
to normal life and re-checks what membership it should actually have — see
[`payments-and-membership.md`](./payments-and-membership.md) for how that
tier gets figured out.

### Staying signed in

Once you're signed in, Overhype.me keeps you that way across visits without
asking you to log in again every time — there's no separate "remember me"
choice to make, that's just how a normal session behaves. You can be signed
in on more than one device at once — a phone and a laptop, say — and signing
in on a new one doesn't sign the others out. The only things that sign out
*every* device at once are a password reset and an admin deactivating the
account; everything else only ever affects the one session it happens on.

### Who counts as what

Overhype.me distinguishes a handful of standing roles — signed-out visitor,
registered user, Legendary member, admin — and which one applies to you is
always figured out fresh from your actual account state, never something
stored on your session that could go stale or be tampered with. An admin who
temporarily views the site "as a regular user" (to check what a member
actually sees) never actually loses their admin permissions on the backend
while doing it — that toggle only changes what the interface shows them, not
what they're allowed to do.

## Why it works this way

- **Every account is a real account, on purpose.** A separate lightweight
  "guest" account type would mean two different identity systems to keep in
  sync, and two different sets of rules for what a fact or comment is
  attributed to. A single onboarding step layered on top of a normal account
  gets the same practical effect — new accounts can't immediately spam
  submissions — without a second account type to maintain.
- **Signing out every device is reserved for genuine compromise signals.**
  A password reset forcing every session closed is a deliberate,
  security-first choice — if someone is resetting your password, the safest
  assumption is that whoever else is signed in as you shouldn't be. Ordinary
  actions, like setting a first password on an OAuth account, don't carry
  that same signal, so they don't force a sign-out.
- **Deactivation preserves content because content usually isn't only about
  the account that made it.** A fact or a meme is something other people
  read, share, and build on — deleting it the moment its author's account is
  removed would punish everyone who's since relied on it for a decision
  that was about the account, not the content.
- **Roles are computed, never trusted from what's already on the session.**
  Storing "this session belongs to an admin" as a flag on the session itself
  would mean a stale or tampered session could keep claiming admin
  permissions after they'd been revoked. Recomputing role from the account's
  actual current state on every request closes that gap entirely.

## Boundaries & known limitations

- **Email verification is a trust signal only, today** — it isn't checked
  before letting a signed-in account submit, comment, or do anything else on
  the product. That may change, but as of today it doesn't gate anything.
- **There's no self-service way to deactivate or delete your own account.**
  It's an admin action taken on request, not a settings-page button.
- **Removing an account doesn't remove what it created.** If you're
  expecting a full "right to be forgotten" erasure of your facts and
  comments along with your account, that's not currently how it works —
  your content stays, just no longer tied to your account.
- **Concurrent sign-ins are unlimited.** Overhype.me doesn't cap how many
  devices or sessions one account can be signed into at once, and doesn't
  show you a list of them to review or revoke individually.

## Going deeper

- Spec: [`accounts-and-auth.md`](../ai-context/accounts-and-auth.md) — the
  exact routes, session mechanics, token handling, and the full deactivation
  and removal sequence.
- Security posture: [`security-model.md`](../ai-context/security-model.md) —
  trust boundaries, session security properties, rate limits.
- Related: [`payments-and-membership.md`](./payments-and-membership.md) (how
  a role and membership tier translate into what you can do and pay for).
- Rationale: the auth entries in [`decisions.md`](../ai-context/decisions.md).

**Next:** chapter 10 — [`payments-and-membership.md`](./payments-and-membership.md),
free vs. Legendary, plan shapes, and what a membership unlocks.

*Verified against `2fc40dd` (2026-08-09) · claim inventory in PR #370.*

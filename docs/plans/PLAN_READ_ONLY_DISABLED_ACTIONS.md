# Read-only mode: gray out every action that saves something

```plan-oracle
# Scope agreed with David, 2026-11-20 (Issue #1109)

## Direction served
Launch Phase 16, outcome 4 (approved plan `docs/plans/PLAN_PHASE16_ANALYTICS_OPERATIONS.md`, design D): "David can pause public writes without taking the site down ... visitors see a short notice; browsing and personalising stay up." The pause stops the public changing anything while David fixes something (a bad release mis-saving submissions; minutes before a database restore; a data repair or migration public writes could race; abuse through a public write path). It is not a database freeze: admins, background jobs and payment webhooks keep writing (that plan's Q3: 1).

## Product intent (David's words)
"When the system is paused, all of the action buttons that are available in the system such as Like, Reaction, Comment, Make a meme, Submit a fact, etc. should be disabled by having their buttons grayed out with a hover that explains that the site is in maintenance mode. You can use the same language as the Banner. ... Please do a sweep of the entire site to find anywhere that a user or admin would be posting content that tries to write to the database and make sure the associated action button is disabled and has a tooltip that explains why."

"Whatever behavior the site allows must be in service of the functionality of pausing."

The banner language: "Overhype.me is undergoing maintenance. Real men get pedicures. Keep browsing but the site is read-only until we're done waiting for our toes to dry."

## Decisions David made in this conversation
- Q28: 1 — admin screens stay usable while paused, "so long as whatever action is being taken is safe to do while the site is paused."
- Q29: 1 — the Make a meme button itself is grayed out while paused (not only the save/post steps inside it).
- Q30: 1 — admin stays fully usable, with a warning: while paused, admins see their own notice saying their changes still save, and that if they are about to restore the database or run a repair they should stop, because changes made now can be lost or collide. Wording is David's to change.

## Must not change
- What the server's read-only gate refuses or allows (`READ_ONLY_ROUTES`), and that admin routes and signing in are let through before the switch is read.
- The banner wording.
- The actions that stay usable while paused because the server allows them: signing in and out, password recovery, saving a name and pronouns, sharing, the support form, billing (cancel, Stripe portal, confirming a purchase already paid for).
- A refused action still explains itself and loses nothing typed (a page learns of the pause on its next config read, about a minute, so a click can still reach the server first).

## Now / next / never
- Now: every visitor- or member-facing control whose action the gate refuses is disabled while the page knows the site is paused, with the maintenance explanation on hover and, on touch devices, on tap; the admin warning.
- Next: nothing planned.
- Never (in this work): changing what the server allows.

## Ceremony tier
product (client-side; the server gate, which is the sensitive part, is not changed).
```

## Preflight

**Increment test.** This increment makes one thing true: *while a page knows the site is paused, nothing on it offers a visitor or member an action the server will refuse, and every such action explains why it is unavailable.* It is bounded by the server's refusal list, which it does not change. It is complete when every refused route's client callers are covered (the inventory oracle below returns no uncovered caller) and the browser checks in *Testing Plan* pass. One increment; the shared control and the sweep are not independently useful.

**Affected-surface inventory.** The class is *a client control or background request that sends a state-changing request the read-only gate refuses*. The refused set is mechanical: every state-changing route not marked `allowed: true` in `READ_ONLY_ROUTES` (the gate refuses by default, `readOnlyGate.ts`, `refuse(res)` last). Its client callers are found two ways, both run against this revision:

- raw paths: `git grep -n -F '<path fragment>' -- artifacts/overhype-me/src ':!*.test.*'` for each refused route (run 2026-11-20: 26 fragments, 1–14 files each; e.g. `api/memes` 7 files, `onboarding` 14, `/comments` 6);
- generated hooks: the `use*` mutation hooks in `lib/api-client-react/src/generated/api.ts` whose operation is a refused route (e.g. `useRateFact`, `useAddComment`, `useHeartComment`, `useHeartMeme`, `useCreateMeme`, `useCheckDuplicate`, `useUpdateMyNotifications`), then `git grep -n` for each hook's callers.

These hits are the starting points, not the scope. The scope is a traced inventory: from each refused route (and the body-limited `PATCH /users/me`), follow request helpers, hooks and callbacks (e.g. `useAppMutations` wrapping `useRateFact` and `useAddComment`) through to the controls they render and the automatic effects that send them; and, separately, trace every entry point into Submit a fact and Make a meme, including links and buttons that never call a write themselves (the Activity Feed and Library empty states linking to `/submit`, the meme page's call-to-action components that receive a creation callback), differently labelled actions and conditional states. Each reachable control or effect is recorded with its treatment or its exclusion by the table. Admin-only screens stay usable (Q28); allowed routes sharing a prefix (`/users/me` name save, `/facts/:id/share`) are excluded by the table, not by judgement. A traced checklist in the PR, not a new framework (Astra, plan exchange 1, R1).

**Claim-oracle.** "Every refused action is covered" is *checked*, not constructed: the inventory above plus the browser sweep in *Testing Plan*. No construct prevents a future control from omitting the treatment; that is an open uncertainty (*Risks*). The server's refusal stays the construct that protects the data either way.

## Problem

Read-only mode refuses the public's writes at the server, but the site still offers every action. A visitor clicks Like, Comment or Make a meme, and only then learns the site is paused. David wants the site to show, up front, which actions are unavailable and why.

## Direction

Phase 16, outcome 4 (above). Read-only mode is an incident tool: stop the public changing anything while David fixes something, keep browsing and personalising up. This increment changes only how the site presents the pause; the server's boundary is settled.

## Product Intent

From the oracle: every action button that would save something is grayed out while paused, and explains on hover (and on tap) that the site is in maintenance, in the banner's words. What stays usable stays usable because it serves the pause. Admins keep working, and are warned when the pause is on.

## Must Not Change

As the oracle block. In addition, settled by existing decisions and therefore not asked: an admin using a *public* control (Like, Comment, Make a meme) meets the public route's policy, since the gate is keyed on the route, not the person (`readOnlyGate.ts`; Phase 16 design D).

## Settled Decisions

- **S1 — The boundary is the gate's table.** Each surface behaves as the unchanged gate makes it behave:

  | Surface | While paused |
  |---|---|
  | Facts | Reading, searching, personalising stay. Rating (Like/dislike/reactions) disabled. |
  | Comments | Reading stays. Posting a comment and hearting a comment disabled. The comment-count icon still opens the comments to read. |
  | Memes | Viewing, downloading, sharing stay. Make a meme (every entry point, Q29) disabled; hearting a meme, deleting and restoring disabled. |
  | Submitting a fact | Every entry point to Submit a fact disabled. |
  | Sharing | Copy link and social share stay. Sending an invitation by email disabled. |
  | Profile and account | Saving a name and pronouns stays. Every other profile field, photo upload, notification setting, account deletion, password set, provider link/unlink, and onboarding steps that save disabled. |
  | Library | Viewing stays. Delete, restore and upload disabled. |
  | Billing | Cancel, the Stripe billing page and confirming a paid purchase stay. Starting a purchase, reactivating, switching plan disabled. |
  | Sign-in | Signing in, signing out, password recovery stay. Creating an account (the sign-up form, resending verification) disabled. Google/Apple buttons stay: they serve existing accounts, and a first sign-in that would create one is already refused in the callback. |
  | Support form | Stays (Phase 16 Q7). |
  | Admin screens | Stay usable (Q28), under the admin warning (Q30). |

- **S2 — "Knows the site is paused" is the client's existing read-only state** (`readOnlyNotice.ts`): learned from the config read every minute and on returning to the tab, and from any refused request. No new polling, no new server endpoint. The page reacts within that interval; a click that beats it is refused by the server and explained as today.
- **S3 — The explanation is the banner's sentence**, held once and used by both.

## Proposed Design

- **D1 — One shared treatment for a paused control.** A single component (or hook plus wrapper) every covered control goes through. While paused it: renders the control disabled and visibly gray (not only lowered opacity); prevents activation, including navigation for link-styled controls and clicks bubbling to a clickable parent card; shows the explanation on pointer hover, on keyboard focus, and on tap for touch input, without activating anything; and leaves the control's own disabled reasons (validation, loading) in force once the pause ends. The existing Radix tooltip ignores touch and closes on click (Astra, scope exchange), so the tap behaviour is the design's, not the library's default, and is proven in a touch-emulated browser test.
- **D2 — The sweep.** Every hit of the inventory oracle that is a visitor- or member-facing control is routed through D1. Surfaces fall into the S1 rows; the PR lists each covered caller beside the oracle's output so the reviewer can diff them.
- **D3 — Requests with no button.** Background requests to refused routes are not sent while paused: the onboarding draft autosave, the share sheet's pronoun suggestion for a typed name, the duplicate check and hashtag suggestion while writing a fact, dropped-file uploads, and the verification email the Check-your-email page sends on arrival. That page says truthfully that sending is paused rather than "Sending a link…", still lets someone use a link they already have and sign out, and sends once the pause ends. Local state (typed text, drafts) is kept and resumes when the pause ends. This also stops the share sheet raising "Paused for a moment" at someone only typing a friend's name (found on PR #1108).
- **D4 — Flows already open.** A meme builder or Submit-a-fact page that is open (or opened by direct URL) when the pause is known keeps working for everything local, and its save/post/submit steps are disabled through D1. Nothing typed or chosen is discarded.
- **D5 — The profile editor.** While paused, only name and pronouns can be edited and saved; other fields are shown disabled through D1, so a save sends only what the server allows and never claims an unsaved field saved. Edits already made to other fields when the pause arrives stay in the draft: saving name and pronouns says that only those saved, and the editor stays open with the other edits shown as unsaved, editable and saveable once the pause ends. When only paused edits remain, nothing is sent and nothing is treated as saved.
- **D6 — The admin warning.** While paused, admin screens show their own banner (Q30), separate from the public one. Wording (Q31: 1, as written): *"The site is paused for the public. Admin changes still save. If you're about to restore the database or run a repair, stop: changes made now can be lost or collide."* It sits where the public banner sits on admin screens and pushes the screen down the same way (PR #1108's layout fix).
- **D8 — A click in the gap says the right thing.** In the minute before a page learns of the pause, a click is refused by the server. Every such refusal shows one maintenance message (Q32), never a generic failure, a false success or a raw error page. Measured 2026-11-20 across every refused action: most already show the server's paused text inline or leave the "Paused for a moment" popup; these do not, and are fixed here: the meme builder's photo upload ("Something went wrong. Check your connection and try again."); the three resend-verification buttons that claim the email was sent whatever happened (top banner, verify-failed page, after sign-up); linking Google or Apple from Profile, which is a page navigation and lands on the server's raw error page; the Profile editor, which prefixes "HTTP 503 …:" to the message. The popup and every form message use David's Q32 wording, held once; forms show the title and text together. The server's own refusal text matches it.
- **D7 — Resuming.** When the pause ends, controls re-enable on the page's next read (within a minute, or on returning to the tab) with no reload.

## Data Model and Migration Impact

None. No server change.

## Runtime Behavior

As D1–D7. The server's refusal remains the guarantee; this is presentation.

## Admin/User UX Impact

Visitors and members see grayed controls with an explanation while paused. Admins see the admin warning. Nothing changes when the site is not paused.

## Security, Permissions, and Validation

No privilege boundary changes. The server gate is untouched and remains the enforcement; a control this work misses still cannot write.

## Testing Plan

- **Unit:** the shared treatment — disabled and gray while paused, explanation on hover, focus and tap, no activation (including inside a clickable card), and its own disabled reasons kept after the pause ends.
- **Browser (e2e), with read-only mode on, through real controls rather than `fetch`,** derived from the traced inventory: one check per distinct surface and activation mechanism (shared-component behaviour is proven once in unit tests). At least the facts feed, a fact page, the meme page, the Library, Profile, Submit a fact, the share sheet, the meme builder opened by direct URL, sign-up and Check-your-email, onboarding and pricing. Each S1 "disabled" control is disabled and explains itself on hover; with touch emulation, a tap shows the explanation and does nothing else; each S1 "stays" control works (name and pronouns save, copy link, comment reading); the admin warning shows beside a successful admin action; typing in a comment box, then the pause arriving, keeps the text; turning the pause off re-enables controls without a reload.
- **The stale page:** a real comment submitted from a page that has not yet learned of the pause shows the maintenance explanation, keeps the typed text, and the control then shows disabled.
- **Profile mixed draft:** edit the name and another field, the pause arrives, save: the name saves, the other edit stays shown as unsaved; the pause ends, the other edit saves.
- **Existing:** the gate's route-table tests and the read-only e2e journey stay green unchanged.

## Implementation Steps

1. The shared treatment (D1) and its unit tests.
2. The sweep (D2–D5), surface by surface, against the inventory oracle.
3. The admin warning (D6).
4. The browser checks.

## Risks and Mitigations

- **A future control ships without the treatment.** Checked, not prevented: the server still refuses it and explains (today's behaviour). Mitigation: the treatment is the one obvious way to build a write control; the inventory oracle is recorded in the PR so it can be re-run.
- **A page learns of the pause up to a minute late.** Accepted (S2); the refusal path covers the gap.

## Questions for David

- **Q31: the admin warning's wording** (D6) — answered 2026-11-20, "q31 1": as written, *"The site is paused for the public. Admin changes still save. If you're about to restore the database or run a repair, stop: changes made now can be lost or collide."*

- **Q32: the message a refused click shows** — answered 2026-11-20 (option 3, David's wording): title *"Overhype.me is undergoing maintenance"*; text *"Real men get pedicures. We can't process any data until we're done waiting for our toes to dry. Try again in a few minutes."* ("toes are dry" in his message read as "toes to dry", matching the banner.) Forms, which show no title, show the title and text as one message.

## Definition of Done

The inventory oracle's hits are each covered or excluded by the table; the browser checks pass; CI green; Codex review returned; UAT section in the PR body.

# Oracle — Get to launch (parent programme plan)

Status: AGREED with David at the scope-of-work gate, 2026-10-05, after an
item-by-item walk of all 222 inventoried features (`docs/plans/LAUNCH_FEATURE_INVENTORY.md`
in the planning session's working tree holds every per-item decision). Pinned
from here; a deliberate change is stamped with `--oracle-changed`.

**Amended 2026-10-05 (David), recorded with `--oracle-changed`:** (1) four
launch stages — Seed → Soft launch → Full launch (US) → Full launch (Global);
(2) the Stripe evidence split replaces the literal live-mode rehearsal (S7);
(3) the full readiness bar holds before Seed (S6); (4) the verification build
is a prerequisite to every product phase; (5) a named exception to the
factory freeze for handbook work a launch phase needs and a second app would
need identically; (6) 2026-10-06: **approved hero images are a hard gate —
a fact cannot go live without them**; no "no-hero fallback" exists, and the
render-approval waiver is retired for the hero scenario; (7) 2026-10-07:
**country eligibility at the US launch (S9)** — blocked are the GDPR
territories (EEA and UK) and OFAC-sanctioned countries; every other country
is admitted ("I'm happy to have users from anywhere other than GDPR and OFAC
countries"); (8) 2026-10-27: **readiness row 8 names its alert sources** —
an unhandled error, the site down, a background job stopped or wedged,
payment webhooks failing, spend that could not be recorded — each proven by
injecting its fault on the deployed site (plan amendment v8).

## Direction served

`product-direction.md`, *Current product bet*: Overhype.me is pre-launch and
the first thing that matters is **"Get to launch / stability"**; growth and
conversion come after. Two reversals of written direction are David's,
recorded here: **video is deferred** (the direction called it launch-critical)
and **Open Graph previews are launch-critical** (the direction called sharing
polish deferrable).

## Product intent of this increment

One approved, phased plan that (1) defines launch in checkable terms — the
feature set, the explicit cuts, and a readiness list a go/no-go is read
against — and (2) sequences the work that makes the definition true, as
phases each small enough to plan, build, review and verify on their own.
David approves the scope once (done), makes the remaining decisions in
batches at phase boundaries, and judges outcomes rather than driving steps.
He is "by far the slowest part" of the system; the plan minimises his time
and cognitive load.

## Four launch stages, one feature set

- **Seed:** the full launch build on a **fresh production database**, behind
  an invite gate on registration and participation (public meme pages and
  previews stay public — S1). A small trusted group submits facts **and makes
  memes from them** ("part of the testing to see how their submitted facts
  end up looking"); David moderates every fact through the full pipeline.
  Target **50 approved facts**, every one submitted by a real user who is not
  David (no CSV seeding). **The full readiness bar holds before Seed** (S6,
  David: "There's no reason to seed prior"): security review with no open
  highs, the operational safety path usable, spend controls demonstrated,
  the admin console finished, every compliance page and consent flow live.
- **Soft launch:** a wider invited group uses the whole loop; the real-data
  verification pass runs here; friends exercise test-mode payments.
- **Full launch (US):** gate off; live Stripe (per the S7 evidence split:
  every adverse event proven in test mode, the live configuration verified on
  the deployed site, genuine payments observed under the launch watch);
  everyone admitted except the GDPR territories (EEA and UK) and
  OFAC-sanctioned countries (S9), proven at the deployment edge (S8); Terms
  name the admitted territories.
- **Full launch (Global):** GDPR readiness (data export, cookie consent, the
  EU-representative question, vendor data-processing terms) lands and the
  geography blocks come off region by region.

## Verification is a prerequisite, and devops serves more than one app

Phase 2 (the scripted verification lanes, acceptance workflow, test doubles,
legacy fixture, lane-tagged UAT docs) completes **before any product phase
starts**, so every later phase ships with its mechanical checks scripted and
David's share of a UAT is the human residue. The factory freeze has one
named exception: handbook work a launch phase needs *and* a second app would
need identically is in scope and lands in the handbook, not as Overhype-only
code.

## Launch scope — what ships

**The loop (rebuilt properly, as much time as it needs):** name/pronoun
personalisation; share-link personalisation; **"make this about you" on every
shared meme page** (absent today); share by every modality including email
(#374 fixed); working Open Graph previews for meme pages (#592) **and fact
pages**; public creator pages; reactions (🔥😂❤️🤯, one per person per item)
with a time-decayed "heat" driving Trending and the hero pick while Wilson on
thumbs stays the all-time ranking; "load more" on the feed if launching with
more than ~50 facts; search with the user's own history shown on the search
screen; leaderboard all-time only (dead pills removed).

**Account:** local, Google and Apple sign-in (Apple already verified
working); provider linking; password reset; email change with verification;
**verified email gates every authenticated action** (provider-verified emails
count); one onboarding path for every sign-in method; pronouns chosen on the
device carried through OAuth sign-up, default never "he/him"; generated
avatars; custom photo avatar (Legendary); "My content" (every upload and
generation listed, per-item delete); **self-service account deletion** that
never destroys legally retained safety records; age gate (13+ at sign-up, 18+
for photo upload; compliance phase has the final word); Cloudflare Turnstile
replacing hCaptcha at registration, submission, comments and share-by-email;
marketing consent at sign-up; account suspension.

**Facts and community:** submission; AI tokenising, duplicate check, hashtag
suggestions; thumbs rating; **comments rebuilt** as the hybrid (verified
email, first-comments-held trust gate, per-account rate limit, report button,
AI pre-screen wired in, AI-assisted moderation); report/takedown on facts,
memes and comments; author notifications; library tabs.

**Image memes:** the builder wizard (legacy builders deleted); free tier =
**the fact's moderation-approved hero renders** (test renders saved as the
approved options; aspect ratios and the waiver fallback to be designed), no
templates, no stock photos, no user-facing text-to-image; Legendary = **your
face in the scene**; photo upload accepting PNG and HEIC; caption and split
caption; speech bubbles **finished** on the moderation side; style presets
reviewed against the winning engine; private memes read from the entitlement
grid (#395 fixed); hearts respect visibility (#375 fixed); only a user's own
uploads or creations are offered to them; anonymous visitors preview only —
download, save and share need a verified account; budget-reached states.

**Membership (monthly only at launch; no existing purchases):** Legendary =
face-in-scene AI memes, private memes, custom avatar, branded watermark
removed (free downloads carry one), monthly face-render allowance with a
visible meter, multiple saved reference photos, early access (beta overlay
on). Ad-free and priority rendering are grid rows with nothing to gate yet.
**The entitlement grid is the definition.** Checkout, confirm, cancel,
reactivate, portal, payment history, grace window, refunds and disputes,
`livemode` on entitlements with all pre-existing rows treated as test-mode,
an operator-run reconciliation runbook, the Stripe account boot guard.
"Legendary Pro" (stronger models at higher cost) is a future tier; keep the
tier list, grid and Stripe tagging additive.

**Email (Resend; consent, preferences, tracking and unsubscribe built around
it):** verification, email change, password reset, approve/reject notices,
payment notices, access-revoked notice, admin notifications, welcome email,
**Fact of the Day free for every opted-in user** with share and make-your-own
links, unsubscribe on every list email, share-by-email invite.

**Admin console:** Dashboard **rebuilt with intention** as an operations home
(moderation front and centre; the counts David must act on; testing-harness
controls removed); Facts; Users (+ suspension); Moderation (pipeline intact;
**UI/UX rebuilt** once core functionality is locked; AI-assisted triage,
keyboard review, batch render approval); Billing; Refunds & Disputes; Config
(Zazzle keys and Debug mode removed); Engines (video and PuLID removed; a
default text engine set); Taxonomy Health; Features; Email Queue; Queue
Health; Eval dashboard (admin-only, the engine-evaluation tool); Help, plus a
**user-facing help/guide derived from the same Manual source** on every user
page; new: **Reports/takedown queue, Invites, Read-only mode switch, Safety**.

**Safety and legal (the compliance phase, before the law firm):** Terms,
Privacy, DMCA policy and agent registration (David registers), repeat-infringer
policy, community guidelines, likeness consent at upload, marketing and cookie
consent, NCMEC reporting path (complete the capability or a counsel-confirmed
manual procedure), evidence retention per statute with a purge job, data
rights (deletion now; export deferred to GDPR readiness), geography policy.

**Analytics and ops:** GA4 (configured, measurement ID set) + **PostHog**
(approved) fed by one event call and a defined funnel event list; Sentry
alerts routed to David and a Sentry uptime check; alerts for the failures
that throw nothing — a background job stopped or wedged, payment webhooks
failing, spend that could not be recorded — by a channel that does not depend
on the database (amendment 8); read-only maintenance mode instead of
takedowns; migrations backward-compatible so deploys need no window.

## Cut, deleted or deferred

Video (pipeline, legacy path, PuLID stage and video engines **deleted**;
rebuilt post-launch on the image pipeline); PuLID everywhere; annual and
lifetime as new sales; Zazzle/merch and the Affiliate screen; Video Styles;
templates; stock photos and **Pexels entirely**; the standalone hashtags page;
dead admin files; Debug mode; route-visit counters; the tester role (docs);
search-history recording stays (David); eval dashboard stays admin-only; NSFW
mode is post-launch (design the audience flag and verified-adult state now,
ship nothing); beta opt-in overlay post-launch; Legendary Pro post-launch;
data export post-launch; public growth surfaces beyond the loop; R2; new
content formats; multi-role RBAC; new vendors beyond PostHog and Turnstile.

## Must not change

- The decisions in `product-direction.md` *Decisions agents should not
  reverse without David* (Visual Concept authoritative; planner/compiler
  split — the engine behind the compiler may change, the split may not; no
  blanket text ban; staged cost-gated moderation; AI baseline vs human
  overrides; `facts.*` as enrichment truth; on-by-default with no rollout
  flags **pre-launch**; two permission rails and union overlays).
- The child-safety boundary: no admin viewer for quarantined evidence, ever.
- The 2026-08-28 disposable-production decision with its four excluded row
  classes and its inversion at launch.
- Codex review and the write-gate on every product PR; UAT per phase.
- No new external vendors without David (PostHog and Turnstile are approved).

## Settled, carried into the plan

- The four-lane verification model (CI gate for invariants; scripted proof
  with evidence; live; human). Only the first enters the per-PR gate;
  everything else re-runnable is on demand. Each remaining UAT step maps to
  one of four dispositions (automated assertion / recorded environment check
  / launch acceptance journey / deferred with its feature); a deferred step
  is not a pass. Ordinary free and paid test accounts, never admin-only
  evidence for paid paths.
- Dev DB preserved as a sanitised legacy fixture; production built fresh from
  code as a launch rehearsal (a schema baseline is needed: migration 0001
  presumes existing tables); backup **and media** restore rehearsed.
- Spend/cost controls hardened as their own phase and launch gate ("no
  runaway cost; I can't afford to cover user spend at scale").
- Engine evaluation (latest image models on the same facts via the eval
  dashboard) picks the default engine; presets tuned after.
- A factory freeze during launch work; `/maintenance` continues.
- Process correction: the between-tool-calls-are-summarised memory note does
  not hold in this client; asks are written once, after tool calls.

## Readiness criteria (checkable; each launch reads them)

1. Scope approved; every route and admin screen is in it or removed.
2. Production database built from code alone, rehearsed; backup + media
   restore rehearsed with recovery time recorded.
3. Stripe monthly lifecycle and every adverse event (failed payment, cancel,
   refund, dispute, duplicate/out-of-order webhook, interrupted processing)
   proven **in test mode** with the reconciliation runbook demonstrated;
   retained test purchases shown unable to grant live benefits after the
   mode switch; the live account, price, credentials, webhook and boot guard
   verified on the deployed site; genuine live payments observed under the
   launch watch (S7 — accepted limitation: no adverse outcome occurs against
   real money before the first real customer). `livemode` recorded; unused
   CI Stripe secrets removed.
4. Spend controls demonstrated under concurrency, pricing failure, restart
   and ledger-write failure; a launch capacity and an emergency stop.
5. `/security-review` on the launch scope with no open highs; `ADMIN_API_KEY`
   scoped or gone; `sharp` upgraded or mitigated; CSP enforcing; HSTS
   complete; dependencies triaged; prod dump purged from history.
6. Every in-scope UAT step has a disposition; manual residue fits an
   afternoon; the real-data pass has run on the Repl.
7. Compliance package in place (Terms, Privacy, DMCA agent registered,
   consent flows, age gate, NCMEC path, retention, geography).
8. Alerts reach David from five sources — an unhandled error, the site
   down, a background job stopped or wedged, payment webhooks failing, spend
   that could not be recorded — each proven by injecting its fault on the
   deployed site and watching the alert arrive and the product degrade as
   designed; uptime check live; read-only mode works; rollback written
   (amendment 8, David, 2026-10-27).
9. UX polish pass completed across every user journey; David accepts the
   catalogue and a representative render sample.
10. Launch runbook with a go/no-go that reads this list per stage: Seed,
    Soft, Full (US), Full (Global).

## Ceremony and stakes

Tier **product**; criticality **85/100**. Phases touching migrations, auth,
payments, safety or the review loop add the specialist review.

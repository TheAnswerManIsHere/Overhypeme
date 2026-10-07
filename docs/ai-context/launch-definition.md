# Launch definition

> **What "launch" means for Overhype.me, in checkable terms.** The feature set
> that ships, the explicit cuts, the readiness criteria a go/no-go is read
> against, and the four stages the launch runs through. Agreed with David at
> the scope-of-work gate of #628 (2026-10-05, after an item-by-item walk of
> every feature in [`launch-feature-inventory.md`](./launch-feature-inventory.md))
> and approved with the parent plan on 2026-10-07. This file is the launch
> *definition*; the parent workstream #628 carries the phased plan that makes
> it true, and each phase's own issue carries its progress. When this conflicts
> with an older note, this wins; when a phase changes a decision here, the
> change is recorded in [`decisions.md`](./decisions.md) and this file is
> updated in the same PR.

## Why it exists

Until 2026-10 the repository had no definition of launch: the direction named
launch-critical *directions* with no finish line, and the roadmap's pre-launch
section held two items. Of the fifty merges to `main` after 2026-08-15, eight
touched the product; the rest built the software factory. The factory is good
enough to use. This definition is what it is pointed at.

## Four launch stages, one feature set

The feature set below is built once and launched in four stages. **The full
readiness bar holds before Seed** (David, 2026-10-06: *"There's no reason to
seed prior"*); later stages add evidence, never relax a requirement.

- **Seed.** The full launch build on a **fresh production database**, behind an
  invite gate on registration and participation. Public meme pages and
  previews stay public, so the share loop can be rehearsed. A small trusted
  group submits facts **and makes memes from them** ("part of the testing to
  see how their submitted facts end up looking"); David moderates every fact
  through the full pipeline. Target **50 approved facts**, every one submitted
  by a real user who is not David: no CSV seeding (*"I really want every fact
  attributable to a real user who isn't me"*).
- **Soft launch.** A wider invited group uses the whole loop; the real-data
  verification pass runs here; friends exercise test-mode payments.
- **Full launch (US).** The gate comes off and money is real. Stripe is in live
  mode under the evidence split below. Geography: **everyone is admitted
  except the GDPR territories (the EEA and the UK) and OFAC-sanctioned
  countries** (David, 2026-10-07: *"I'm happy to have users from anywhere
  other than GDPR and OFAC countries"*), enforced at the deployment edge and
  proven unbypassable through any other public origin. Terms name the
  admitted territories.
- **Full launch (Global).** GDPR readiness lands (data export, cookie consent,
  the EU-representative question, vendor data-processing terms) and the
  geography blocks come off region by region.

## Two reversals of the written direction

Both are David's, recorded in `decisions.md`:

- **Video is deferred.** The direction had called video-pipeline maturity
  launch-critical. The video pipeline, legacy one-shot path, PuLID stage and
  video engines are **deleted** and video is rebuilt post-launch on top of the
  image pipeline.
- **Open Graph previews are launch-critical**, for meme pages *and* fact
  pages. The direction had filed sharing polish under deferrable.

## What ships

**The loop (rebuilt properly, "as much time as necessary"):** name and
pronoun personalisation; share-link personalisation; **"make this about you"
on every shared meme page**; share by every modality including email (#374
fixed: *"Sharing by email is critical. Any modality for sharing should be
supported because growth is what will make the site valuable"*); working Open
Graph previews for meme pages (#592) and fact pages; public creator pages;
reactions (🔥 😂 ❤️ 🤯, one per person per item) with a time-decayed "heat"
driving Trending and the hero pick, while the Wilson score on thumbs stays the
all-time ranking; "load more" on the feed if launching with more than ~50
facts; search, with the user's own search history shown on the search screen;
the leaderboard all-time only, dead pills removed.

**Account:** local, Google and Apple sign-in (Apple verified working);
provider linking; password reset; email change with verification; **a
verified email gates every authenticated action** (provider-verified emails
count); one onboarding path for every sign-in method; pronouns chosen on the
device carried through OAuth sign-up, and the default is never "he/him";
generated avatars; custom photo avatar (Legendary); "My content" listing every
upload and generation with per-item delete; **self-service account deletion**
that never destroys legally retained safety records; an age gate (13+ at
sign-up, 18+ for photo upload; the compliance phase has the final word);
Cloudflare Turnstile replacing hCaptcha at registration, submission, comments
and share-by-email; marketing consent at sign-up; account suspension.

**Facts and community:** submission; AI tokenising, duplicate check and
hashtag suggestions; thumbs rating; **comments rebuilt** as the hybrid
(verified email, first comments held behind a trust gate, per-account rate
limit, report button, AI pre-screen wired in, AI-assisted moderation);
report/takedown on facts, memes and comments (*"my defense against any type of
litigation is that I'm the platform. Takedown is part of that"*); author
notifications; library tabs.

**Image memes:** the builder wizard (legacy builders deleted). Free tier =
**the fact's moderation-approved hero renders**, captioned by the user; no
templates, no stock photos, no user-facing text-to-image. Legendary = **your
face in the scene**. Photo upload accepts PNG and HEIC; caption and split
caption; speech bubbles **finished** on the moderation side; style presets
reviewed against the winning engine; private memes read from the entitlement
grid (#395 fixed); hearts respect visibility (#375 fixed); only a user's own
uploads or creations are offered to them; anonymous visitors preview only, and
download, save and share need a verified account; budget-reached states.

**Membership (monthly only at launch; no existing purchases to honour):**
Legendary = face-in-scene AI memes, private memes, custom avatar, the branded
watermark removed (free downloads carry one), a monthly face-render allowance
with a visible meter, multiple saved reference photos, early access (the beta
overlay, on). Ad-free and priority rendering are grid rows with nothing to
gate yet. **The entitlement grid is the definition.** Checkout, confirm,
cancel, reactivate, portal, payment history, grace window, refunds and
disputes; `livemode` on every entitlement source with all pre-existing rows
treated as test-mode; an operator-run reconciliation runbook; the Stripe
account boot guard. "Legendary Pro" (stronger, costlier models) is a future
tier; the tier list, grid and Stripe tagging stay additive.

**Email (Resend; consent, preferences, tracking and unsubscribe built around
it):** verification, email change, password reset, approve/reject notices,
payment notices, access-revoked notice, admin notifications, welcome email,
**Fact of the Day free for every opted-in user** with share and
make-your-own links, unsubscribe on every list email, the share-by-email
invite.

**Admin console:** the Dashboard **rebuilt with intention** as an operations
home (moderation front and centre, the counts David must act on, the
testing-harness controls removed); Facts; Users with suspension; Moderation
(pipeline intact, **UI/UX rebuilt** once the core functionality is locked,
with AI-assisted triage, keyboard review and batch render approval); Billing;
Refunds & Disputes; Config (Zazzle keys and Debug mode removed); Engines
(video and PuLID removed, a default text engine set); Taxonomy Health;
Features; Email Queue; Queue Health; the Eval dashboard (admin-only); Help,
plus a **user-facing help/guide derived from the same Manual source** on every
user page; and four new screens: **Reports/takedown queue, Invites, a
Read-only mode switch, Safety**.

**Safety and legal (the compliance phase precedes the law firm):** Terms,
Privacy, DMCA policy and agent registration (David registers), repeat-infringer
policy, community guidelines, likeness consent at upload, marketing and cookie
consent, the NCMEC reporting path (complete the capability or a
counsel-confirmed manual procedure), evidence retention per statute with a
purge job, data rights (deletion now; export with GDPR readiness), the
geography policy above.

**Analytics and ops:** GA4 (measurement ID set) plus **PostHog**, fed by one
event call and a defined funnel event list; Sentry alerts routed to David and
a Sentry uptime check; a read-only maintenance mode instead of takedowns;
migrations written backward-compatible so deploys need no window.

## Cut, deleted or deferred

Deleted features keep a **retired-feature record** under `docs/retired/<feature>.md` (a directory the cut phase creates) and a
`pre-cut/<feature>` git tag, so nothing is lost with the code (David,
2026-10-06: *"don't want to throw the baby out with the bathwater"*).

Video (pipeline, legacy path, PuLID stage, video engines); PuLID everywhere;
annual and lifetime as new sales; Zazzle/merch and the Affiliate screen; Video
Styles; templates; stock photos and **Pexels entirely**; the standalone
hashtags page; dead admin files; Debug mode; route-visit counters; the tester
role (gone from the docs; the invite gate is the Seed gate, and a beta
overlay follows post-launch); NSFW mode is post-launch (the audience flag and
verified-adult state are designed now, nothing ships); Legendary Pro; data
export (lands with GDPR readiness at Global); public growth surfaces beyond
the loop; R2; new content formats; multi-role RBAC; new vendors beyond PostHog
and Turnstile.

## Hard gates that used to be waivable

**Approved hero images are a hard gate: a fact cannot go live without them.**
There is no "no-hero fallback" (David, 2026-10-06: *"I don't think there's any
concept of a no-hero fallback on a fact. We should define a successful fact
moderation as having confirmed, approved hero images. Without them, the fact
cannot go live"*). The render-approval waiver is retired for the hero
scenario; it remains an auditable override for any other render scenario.

## Verification is a prerequisite

The scripted-verification build (Phase 2 of #628) completes **before any
product phase starts**, so every later phase ships with its mechanical checks
scripted and David's share of a UAT is the human residue. The four-lane model:
a CI test for an invariant; a scripted proof with evidence, re-runnable on
demand; a live check on the deployed origin; and David's judgement. Only the
first enters the per-PR gate. Every remaining UAT step maps to one of four
dispositions — automated assertion, recorded environment check, launch
acceptance journey, or deferred with its feature — and **a deferred step is
never a pass**. Paid paths are evidenced with ordinary free and paid test
accounts, never admin-only evidence (admins are exempt from the budget gate).

Handbook-shaped parts of that build (lane tags, the acceptance workflow, the
readiness table as a reusable artefact) land in the handbook so a second app
inherits them: the one named exception to the factory freeze that otherwise
holds during launch work.

## Readiness criteria, by stage

Each stage's go/no-go reads this table. Later columns show what is *added*;
nothing earlier is relaxed. A requirement awaiting execution stays visibly
outstanding and never becomes an earlier stage's pass.

| # | Criterion | Seed | Soft | Full (US) | Full (Global) | Payment mode |
|---|---|---|---|---|---|---|
| 1 | Scope approved; every route and admin screen in it or removed | must | — | — | — | — |
| 2 | Production database built from code alone; backup **and media** restore rehearsed with recovery time recorded | must | — | re-verified | — | — |
| 3 | Stripe monthly lifecycle and every adverse event (failed payment, cancel, refund, dispute, duplicate/out-of-order webhook, interrupted processing) proven **in test mode** with the reconciliation runbook demonstrated; retained test purchases shown unable to grant live benefits after the mode switch; live account, price, credentials, webhook and boot guard verified on the deployed site; genuine live payments observed under the launch watch; `livemode` recorded; unused CI Stripe secrets removed | test-mode proof complete | friends' test-mode use | live configuration verified; genuine payments watched | per-region configuration | per column |
| 4 | Spend controls demonstrated under concurrency, pricing failure, restart and ledger-write failure; a launch capacity and an emergency stop exercised | must | — | re-verified live | — | — |
| 5 | `/security-review` on the launch scope with no open highs; `ADMIN_API_KEY` scoped or gone; `sharp` upgraded or mitigated; CSP enforcing; HSTS complete; dependencies triaged; the production dump purged from git history; **every credential rotated and the old one revoked** | must | — | green on the current head | — | — |
| 6 | Every in-scope UAT step has a disposition; the manual residue fits an afternoon; the real-data pass has run on the Repl | dispositions | real-data pass done | — | — | — |
| 7 | Compliance package live (Terms, Privacy, DMCA agent registered, consent flows, age gate, NCMEC path, retention, geography); the safety path usable | must | — | counsel signed | GDPR checklist signed | — |
| 8 | Alerts reach David; uptime check live; read-only mode works; rollback written | must | — | — | — | — |
| 9 | UX polish pass completed across every user journey; David accepts the catalogue and a representative render sample | must | post-Seed fixes | post-Soft fixes | — | — |
| 10 | Launch runbook with a go/no-go that reads this table | Seed go/no-go | Soft go/no-go | US go/no-go | Global go/no-go | — |

**The Stripe evidence split (S7).** Stripe forbids real payment details in
live mode, so the literal live-mode rehearsal of every adverse event is not
available. The accepted limitation is explicit: the live configuration is
verified, but no adverse payment outcome occurs against real money before the
first genuine customer payment. Calling test-mode evidence "live" because the
application is deployed does not satisfy row 3.

## Must not change

- The decisions in [`product-direction.md`](./product-direction.md) *Decisions
  agents should not reverse without David*.
- The child-safety boundary: no admin viewer for quarantined evidence, ever
  ([`legal-safety-moderation.md`](./legal-safety-moderation.md)).
- The 2026-08-28 disposable-production decision, its four excluded row classes
  and its inversion at launch (the fresh production database of Seed is that
  inversion).
- Codex review and the write-gate on every product PR; a UAT per phase.
- No new external vendors without David; PostHog and Turnstile are approved.

## Where the rest lives

- The phased plan, its dependency graph and the decisions David makes at each
  phase boundary: #628 (the plan file itself is never pushed; its approved
  text is pinned there by digest).
- Every per-item decision from the feature walk:
  [`launch-feature-inventory.md`](./launch-feature-inventory.md).
- The rationale for each reversal and hard gate: [`decisions.md`](./decisions.md),
  entries dated 2026-10-05 to 2026-10-07.

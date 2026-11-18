# Plan — Launch Phase 16: Analytics and operations

Workstream: Issue #1029. Parent: Issue #628. Tier: production phase; `sensitive` for increments 1, 2 and 4, `product` for the rest.

```plan-oracle
# Oracle — Launch Phase 16: Analytics and operations (Issue #1029)

Scope agreed with David 2026-11-17 in conversation (answers "q2 1", "q3 1", "q4 1" to the scope banner; he raised the support question himself). Parent: Issue #628, `docs/plans/PLAN_GET_TO_LAUNCH.md` v12, Phase 16, amendment v8, readiness row 8, and the §2 placement for Phase 16.

**Direction served:** the launch plan's Phase 16 outcome — "David can see the funnel, hear about failures, and pause writes without a takedown" — and readiness row 8: alerts reach David from five sources (an unhandled error, the site down, a background job stopped or wedged, payment webhooks failing, spend that could not be recorded), each proven by injecting its fault on the deployed site, recording whether the alert arrived and how long it took, how the product degraded against its design, and whether recovery needed a human; uptime check live; read-only mode works; rollback written.

**Product intent**
1. David hears about each of the five row 8 failures on his phone (Q2: 1 — a Pushover push, with Sentry email as backup), by a route that does not depend on the product's database.
2. The same failure states are visible in the admin console (the in-app half of the queue-health plan's two channels).
3. David can see the funnel in PostHog and GA4: one event call feeds both, from a defined funnel event list (visit, personalise, sign-up, verify, submit, meme made, share, upgrade). Analytics run for every visitor; Phase 14's notice informs and is not a consent switch (amendment 2, David, Q14 → 1 on Issue #1030, 2026-11-18: *"The analytics notice only informs, and is not a consent switch. Phase 16's 'off until Phase 14's notice grants it' is superseded."*).
4. David can pause public writes without taking the site down (Q3: 1 — read-only mode stops public writes only; admins keep working; background jobs and payment webhooks keep running); visitors see a short notice; browsing and personalising stay up.
5. A member — a suspended one included — can ask for help, and every request is kept in one tracked place (Q4: 1 — Issue #877 placed here: a `support@overhype.me` inbox on Resend, a contact form that works signed out, links from the suspended screen, the footer and the billing banner; no ticketing vendor before launch; revisited at the Soft launch go/no-go).
6. Releases need no maintenance window: the deploy and migration policy and the rollback steps are written down; the API-restart investigation of 2026-10-04 is closed with a cause or a fix.
7. A fault-injection afternoon on the deployed site proves row 8: one injected fault per source, including a worker killed mid-render, the image engine's key revoked and the Stripe webhook endpoint broken, three records per fault. Measured and reported; no deadline and no automatic recovery is required.

**Must not change**
- How background jobs are claimed, leased, renewed, reclaimed and resumed (Issue #1000, PR #1026 and earlier); the five-lane split and its isolation.
- A failed spend-ledger write never fails the user's generation.
- Stripe webhook processing semantics.
- Sentry's scrubbing of personal data; analytics identify a person by internal id, never email.
- No vendor beyond PostHog (approved) and Pushover (Q2: 1) without David.
- While Issue #1018 (fact lifecycle rebuild) is in flight: no edit to the moderation or enrichment routes or the admin facts page; any migration here is serialized against #1018's.
- No rollout-flag gating; the child-safety boundary.

**Settled decisions carried**
- 2026-10-27 (`decisions.md`): row 8's five sources and the injected-fault proof; Prometheus and Grafana rejected; the queue-health plan's alert phase (PR #288's Phase 2: in-app plus an out-of-band channel that does not depend on the DB-backed email queue or Resend) is the vehicle for the stopped-or-wedged alert.
- §2 placement: one alert for any background job that has stopped running (covers the rate-limit cleanup job and every other), and one for spend that could not be recorded.
- Launch feature inventory: GA4 plus PostHog fed by one event call; GA4 configured "as useful as possible without going crazy"; read-only mode is a switch in admin where browse and personalise stay up and writes show a short notice; Sentry uptime monitors are the external uptime check.
- 2026-10-30 (amendment v9): an admin-editable value stays editable only if it is an incident lever (the read-only switch is one).

**Now / next / never**
- Now: six increments — alerts; analytics; read-only mode; support; policy and the restart question; the fault-injection afternoon.
- Next: the cookie notice itself (Phase 14); Issue #1028 (job-resume follow-ups); alert digests and cooldowns beyond what the alert route gives; a help-desk vendor if support volume outgrows the inbox.
- Never: Prometheus or Grafana; alert deadlines or automatic recovery; session replay; autocapture.

**Ceremony tier:** production phase, full ceremony. Tier `sensitive` for the increments whose alert hooks touch the spend and payment files; `product` for the rest.
```

## What is true today (read at `362ea73`, 2026-11-17)

- **Sentry** is initialised on the API (`instrument.ts`) and the web app (`lib/sentry.ts`). Sentry holds four issue-alert rules whose only action is email, no uptime monitor and no cron monitor (read through the Sentry connector).
- **The web app records session replays in Sentry** (`lib/sentry.ts`: `replayIntegration`, 10% of sessions, 100% on error, text unmasked).
- **Production does not sleep** (David, 2026-11-17: the 15-minute idle sleep applies to the development app only). The fleet's `replit-platform.md` says Autoscale scales to zero after 15 idle minutes, quoting Replit's general documentation, not a measurement of this deployment; increment 1 confirms the live behaviour and the correction goes to KITT. Every background lane and every scheduled task is an in-process timer.
- **Jobs:** `GET /api/health/queues` returns 503 when a lane has stopped scheduling fleet-wide. A lane keeps stamping its schedule while an earlier tick still runs, so the probe does not show that a running job is progressing. Nine other timers in `index.ts` (pricing refresh, three purgers, the account-deletion worker, meme baking, Fact of the Day and others), the membership schedules and the lease-renewal and reclaim timers write no heartbeat. Heartbeat rows are pruned by `lastScheduledAt` after 15 minutes (`workerHeartbeats.ts`, `pruneDepartedInstances`).
- **Payments:** the Stripe webhook handler (`app.ts`) catches every processing error, logs it and answers 400, so nothing reaches Sentry. `GET /api/health` reports the age of the last processed event and answers 200 even when that read fails. A quiet site and a broken endpoint look the same. The Stripe account also serves other business (`stripeAppTag.ts`).
- **Spend:** `recordCost` (`budgetGate.ts`) has no production caller (`git grep -n "recordCost("` finds only its definition and a lint script). The one accounting write made after a vendor call completes today is comparison settlement (`comparison/runs.ts`, `settleAtBound`, called at line 643). The image request's record (`provenance/records.ts`, `recordGenerationRequest`) is written *before* the vendor is called and is provenance, not spend. Phase 11 owns durable accounting for every paid call.
- **Analytics:** GA4 starts from an inline loader in `index.html`, only when `VITE_GA_MEASUREMENT_ID` is set at build; two events exist. No PostHog. No consent state. The shared `scrubUrl` (`lib/redact`) filters token-, secret- and email-like parameters only: `?displayName=Alice` passes through unchanged.
- **Read-only mode** does not exist. `requireEligibleActor.ts` holds one exported table of which account states may write through which routes, with a CI test that diffs it. The `adminConfig` getters return their default when a read fails, and cache for 60 seconds per process. A signed-in member's name is saved through the profile API (`NameTag`, `WelcomeModal`), and a fact stays hidden until it is.
- **Support:** five code sites name a Gmail alias (`git grep -n "overhypeme+support"`). Suspended, unverified, un-onboarded and deletion-pending sessions are each redirected away from other pages (`setup-redirect.ts`) and refused other writes (`GATE_EXCEPTIONS`). The Resend domain `overhype.me` has receiving enabled and no inbox yet (read through the Resend connector).
- **Migration policy** already exists: `docs/engineering/migrations-and-backfills.md`, *The migration policy: every migration leaves the previous release working*.

## Design

### A. One alert route, two kinds of detector

**The route.** Sentry detects; Pushover rings David's phone; Sentry's own email stays on as the backup. Neither depends on the product's database or on the API being up.

- **The first step of increment 1 proves the route on the real accounts before anything is built on it.** Preferred shape: a Sentry alert's webhook action posting to Pushover's JSON webhook receiver (both documented; Sentry's listed Pushover integration goes through a third vendor and is not used). The proof covers three cases: an error event, an uptime incident, and a second occurrence of the same failure after the rule's throttle interval, since "new issue" and "event seen again" are different Sentry triggers. If the route needs a relay or a third vendor, that comes back to David before anything else is built.
- Accepted trade-off: if Sentry is down, nothing rings. One detector is the proportionate choice for a site this size.

**Detector kind 1 — state, polled from outside.** A Sentry uptime check calls the deployed site. A non-200, a timeout or a refused connection is the alert. This is the only kind that survives the process or the database being gone.

- **One uptime check, not one per source** (amendment 1, David, 2026-11-17, Q13: 2: *"Once we go live and we have revenue we can upgrade. Otherwise I need to purchase a plan now."*). Sentry's current plan allows one active uptime check; each further one needs a paid budget. The one check calls a combined health address, `/api/health/alerts`, which answers 503 when any polled source below is unhealthy, and also fails when the site or the API is down. The push then reads "Downtime detected for …/api/health/alerts" for every polled source, and the Operations page says which part failed. Splitting it into one check per source, so each push names its source, is *next*: after launch revenue, a budget change in Sentry plus one monitor per endpoint, no code change. Until increment 2 ships the combined address, the one check watches the home page.

- **Site down:** the combined address fails outright when the deployment or the API is down.
- **Jobs stopped or wedged:** the jobs half of the combined address (the existing `/api/health/queues` logic, extended) answers 503 when any of these holds: a lane stalled fleet-wide (today's rule); a recurring task whose last *completed* run is older than its cadence plus a grace; a due job nobody has claimed, or a claimed job held, far beyond what its queue allows.
  - Every recurring task is inventoried in one table in code. Each records **completed work**, a successful no-op included, separately from being scheduled, so a timer that fires while its work hangs still reads as overdue. Cadence comes from the scheduler's effective configuration. A task's first expected run after a start is stated, and its record survives a normal restart: these rows are kept on a task-aware rule, not the 15-minute lane pruning, whose behaviour for lanes is unchanged.
  - The class is "every timer that does recurring work". Its oracle is `git grep -n "setInterval\|setTimeout" -- artifacts/api-server/src`, read against the table and recorded in the PR. A CI test holds the table against the timers it knows: *checked*, not impossible to miss.
- **Payment webhooks not arriving or not processed:** the payments half of the combined address answers 503 when Stripe holds an *expected* event the product has not processed.
  - Expected means: in the monitored account and the active mode, of the event types this endpoint is registered for (`stripeInit.ts`), created after monitoring began and older than a threshold, within a bounded, paginated lookback. It is not filtered by local customers, because a first purchase whose webhook never arrived has no local record.
  - A comparison that could not be completed reads unhealthy, never healthy.
  - The Stripe reads go through the existing `StripeApi` contract and its fake.
- **A health check that cannot be evaluated answers 503.** A failure to judge is itself the alert. The endpoints stay unauthenticated and return counts only, as today.
- **The monitors assume production stays up while idle** (David, 2026-11-17). Increment 2 confirms it on the live site before the check moves to the combined address: a server that slept would read as "jobs stopped".

**Detector kind 2 — events, pushed from inside.** At the moment a failure happens, the API reports it to Sentry with a stable fingerprint per source, and a Sentry rule turns it into a push. No database write is on that path. A report that itself fails never throws and never delays the work it is reporting on.

- **Unhandled error:** the existing capture, with the alert rules rerouted to the push.
- **Payment webhook processing failed:** the catch block in `app.ts` reports the error. The response and the processing are unchanged.
- **Spend that could not be recorded:** Phase 16 supplies the database-independent reporting function and observes the failed post-call accounting operations that exist today, beginning with comparison reservation settlement. Pre-call provenance writes are not spend-ledger writes, and their existing failure behaviour is unchanged. Phase 11 supplies the missing durable accounting producers and calls the same function (dependency recorded on #628). Row 8's spend proof stays outstanding until a real paid operation reaches a failing accounting write and the deployed alert arrives (Q9).
- **A job that failed for good** (retries exhausted, or failed without retry): reported from the one place the job core finalises a failure. No handler file is edited.
- **A job interrupted and resumed:** recorded in Sentry and shown in admin; whether it also rings is Q6.

**The in-app half.** A new admin page, **Operations**:

- **Current state, read live:** lanes and recurring tasks, the oldest stuck job, the Stripe comparison, the read-only switch (D).
- **Recent incidents, read from Sentry by the server:** a bounded list for the five sources, each with its source, when it happened and a link. Sentry is the only incident store, so an incident raised while the database was failing still appears. If Sentry cannot be read, the list says "unavailable", never "none".
- **Send test alert:** a real event through the whole route.
- No alert table is added. Storing incidents a second time, in the database they may be reporting on, was considered and rejected.

**No migration is planned for A.** Recurring-task records reuse `worker_lane_heartbeats`. If the build finds a migration unavoidable, it is serialized against Issue #1018's.

### B. Analytics

- **One module** (`lib/analytics.ts`) is the only place that talks to GA4 or PostHog. `track(event, properties)` and `page(path)` feed both.
- **No consent switch** (amendment 2; David's Q14 → 1 on Issue #1030). Analytics run for every visitor whose build carries the vendor's ID (`VITE_GA_MEASUREMENT_ID`, `VITE_POSTHOG_KEY`, both build-time public values); with an ID unset, that vendor loads nothing and sends nothing. The notice's "Got it" only hides the notice. GA4's inline loader leaves `index.html` and moves into the module. *(Until amendment 2 this read: one consent switch, off until Phase 14's notice granted it.)*
- **The disclosures change in the same PR as the code** (amendment 2). The legal texts promise only what the product does on the day they are published (`docs/legal/README.md`), and increment 3 makes two of their statements false: it adds a provider (PostHog) the Privacy Policy and the notice do not name, and it removes the Sentry recordings both describe. So increment 3's PR carries a new Privacy version and a reworded notice. The Privacy wording is David's to approve, and is quoted here as approved:
  - *What we collect*, the bullet "How you use the site, for fixing errors" becomes: "**How you use the site.** Our analytics providers, Google Analytics and PostHog, receive the pages you visit and the steps you take, such as personalising a fact, making a meme or signing up, with a random identifier and, if you are signed in, your account ID. They do not receive your name, your email address, the names you type or what you search for. Our error-monitoring provider receives error details and page-speed measurements. A notice tells you this the first time you visit."
  - *Who receives it*, the Sentry row's "What it receives": "Error details and page-speed measurements; for signed-in members, your account ID; and anything you send through its feedback button".
  - The Google Analytics row: "Counts visits and the steps visitors take" / "Your IP address, pages visited, steps taken and device information, with a random identifier".
  - A new PostHog row: "Shows how visitors move through the site" / "Your IP address, pages visited, steps taken and device information, with a random identifier and, for signed-in members, your account ID".
  - The notice, its storage key moved to `v2` so every browser sees it once more: "We count visits, and the steps people take through the site, with Google Analytics and PostHog, and use an error-monitoring service to find problems. None of them receives the names you type. Read our Privacy Policy."
- **The funnel event list**, each fired once, on the confirmed outcome and not on the click:

  | Event | Fires when |
  |---|---|
  | visit | a page is shown (route change included) |
  | personalise | a visitor's name is saved for rendering |
  | sign-up | the API confirms a new account, by password or by a sign-in provider |
  | verify | the API confirms the email is verified |
  | submit | the API accepts a fact submission |
  | meme made | the API confirms a meme is saved |
  | share | a share action is chosen (intent: the browser cannot confirm delivery) |
  | upgrade | the API confirms this checkout completed; revisiting the success page does not count again |

  GA4 gets its recommended names where one exists (`sign_up`, `share`, `purchase`).
- **A privacy policy of its own, enforced in the one module.** The existing URL scrubber is not enough, since it leaves names in place.
  - Event properties come from a fixed, bounded list. No name, email or free text is ever one.
  - Page addresses are sent as route patterns, with no personalisation or search parameters and no fragment. Referrers and page titles are controlled the same way.
  - What each SDK adds on its own is handled explicitly: GA4's location, referrer and title; PostHog's automatic URL properties, through its `before_send` hook.
  - A person is identified by internal id on sign-in and reset on sign-out. PostHog runs with autocapture and session recording off.
- David creates the PostHog project (US cloud) and supplies its public key; the build asks when increment 3 starts.

### C. Sentry session replay is removed

The approved scope says "Never: session replay", without qualification. The web app records replays in Sentry today, with text unmasked. Increment 3 removes that collection. Error capture, the feedback widget and the scrubbing are unchanged.

### D. Read-only mode

- **One gate**, a single middleware ahead of the routers. While the mode is on it refuses every request a visitor makes in order to change something, with one response the web app recognises. It edits no route file.
- **One classification table** in code names every state-changing route as *refused* or *allowed*, in the same shape as `GATE_EXCEPTIONS`, and a CI test fails on a state-changing route the table does not name. Allowed while on: signing in and out; anything behind real admin privilege; the Stripe webhook; health endpoints; unsubscribe links; the contact form if Q7 says so; saving a name and pronouns if Q11 says so.
- **Not a database freeze.** Jobs, webhooks and admins keep writing (Q3: 1). So do the small bookkeeping writes some page views make on their own, such as noting which hero fact a member saw: the mode pauses what visitors do on purpose. This boundary is named in the approval readout.
- **The switch** is one `admin_config` value (an incident lever, per amendment v9), on the Operations page. It does not use the general config getters, which fall back to a default when a read fails. It has its own small cache with these rules:
  - a pause that was confirmed stays in force when a refresh fails;
  - with no trustworthy value at all, the affected writes are refused;
  - an older read can never overwrite a newer saved value;
  - signing in and the admin routes are let through before the lookup, so David can always turn it off.
- **Propagation:** each server picks the change up within its cache interval, about a minute. The page says so, and shows the state each answering server is enforcing, marked stale or unavailable when it is.
- **In the app:** a site-wide notice while the mode is on; a refused action shows the same short message and loses nothing the visitor typed.

### E. Support

- **The tracked place** is a Resend inbox at `support@overhype.me`: threads, labels, replies. Increment 5 first confirms two things on the real account: mail to that address arrives and a reply stays in its thread; and how long the inbox keeps a thread. If threads expire, that comes back to David before the form is built, since "every request is kept" is the requirement.
- **A contact page** that works signed out: email, a category, a message; a captcha and a rate limit; the account id attached when there is a session. It sends to the inbox with the member's address as reply-to, and sends the member an acknowledgement. If the request could not be stored in the inbox, the page says so and shows the address. If only the acknowledgement failed, the member is told the request was received.
- **Reachable from every account state.** The page and its one request are permitted for suspended, unverified, un-onboarded and deletion-pending accounts, in the web app's redirect rules and in the API's gate, widening nothing else for them. Links: the suspended screen, the footer, the billing banner.
- **The Gmail alias is replaced everywhere**: the class is every site `git grep -n "overhypeme+support"` finds, the stored reply-to value included.
- No support table and no ticketing vendor.

### F. Policy, rollback and the restart question

- The migration policy already exists and is not rewritten. A deploy-and-rollback page is added beside it: how a release goes out with no window, what to check after, how to roll back on Replit, and when read-only mode is the right tool.
- The 2026-10-04 restart investigation closes with evidence of a cause or a demonstrated fix, starting from Issue #894 and the job-resume evidence. The existing guards are leads, not the answer. A defect it finds is fixed as its own bugfix.

### G. The fault-injection afternoon

Last, on the deployed site, one row per fault: the fault, its detector, when the push arrived or that it did not, what the product did, whether a human was needed.

| Source | Fault | What must be shown about the fault itself |
|---|---|---|
| Unhandled error | a forced error on the deployed API | — |
| Site down | the deployment made unreachable for the monitor's window | — |
| Job stopped or wedged | a drill job, started from the Operations page, that never finishes | the polled check turned unhealthy while the job was still held, before its time limit ended it |
| Rehearsal: worker killed mid-render | a publish while a render is running | the old owner stopped while the job was still processing; if a publish does not produce that, another controlled stop is used |
| Rehearsal: image engine key revoked | David revokes the key at the vendor | — |
| Payment webhooks failing | David breaks the endpoint in Stripe's test mode | — |
| Spend not recorded | see Q9 | — |

No fault endpoint ships. The drill job spends nothing and grants nothing; it occupies one job slot until its time limit ends it. Monitor intervals and failure tolerances are detection settings chosen in the build, not a deadline.

## Increments (one PR each)

The oracle's six increments are seven pull requests: alerts ships as two, so the route is proven before the silent sources are built on it.

1. **The alert route and the two loud sources.** Route proven; the error rules rerouted; the one uptime check on the site; the Operations page with live state, recent incidents and the test-alert button. Tier `sensitive`.
2. **The three silent sources.** The combined health address, and the one uptime check moved onto it; recurring-task completion records and the extended jobs check; the payments check and the webhook catch report; the unrecorded-spend report at comparison settlement; the job-failure and interruption reports; the drill job. Tier `sensitive`.
3. **Analytics**, and Sentry replay removed.
4. **Read-only mode.** Tier `sensitive` (it sits in front of auth and payment routes).
5. **Support.**
6. **Policy, rollback and the restart question.**
7. **The fault-injection afternoon**, then close-out against row 8.

**Collision with Issue #1018.** At the start of each increment, that issue's State of Play and open pull requests are read. Increments 1, 2 and 4 touch `app.ts`, `index.ts`, the job core and health files, none of them moderation or enrichment routes or the admin facts page. If #1018 has one of those files open, the increment waits for that merge or takes the next increment first.

## Acceptance

- **Alerts:** for each event source, a test injects the failure and asserts the report is made without a database write, and that a failing report neither throws nor delays the caller. For each polled source, a test drives the health endpoint to 503 on the failing state and 200 on the quiet one, including "the check itself failed". The payments check is tested on four cases: an overdue expected event, an unrelated event, a first-purchase event with no local record, and an incomplete comparison. The deployed proof is G.
- **Operations page:** shows each source's live state and recent incidents; shows "unavailable" when Sentry cannot be read; the test alert reaches David's phone.
- **Analytics:** with the vendor IDs unset at build, no request leaves for GA4 or PostHog. With them set, a scripted journey from a fresh browser that has not dismissed the notice shows all eight events in PostHog and in GA4. The **actual outbound payloads** are inspected on first load, on navigation and on sign-in and sign-out, and carry no name, email, search text or personalised address. No Sentry replay request is made. The published Privacy page and the notice name exactly the analytics and monitoring providers the network log shows.
- **Read-only mode:** the route-table test. With the mode on, a scripted pass shows browsing works signed out and signed in, personalising works signed out (and signed in, per Q11), each public write is refused with the notice, an admin action succeeds, a webhook is processed, and the switch turns off. Two failure cases are tested: a pause stays in force when the refresh fails, and an older read does not undo a newer save. Exercised live in G.
- **Support:** a signed-out visitor and a member in each restricted account state send a request that appears as a thread in the inbox, with an acknowledgement in their mailbox; a direct email and a reply stay in one thread; no Gmail alias remains.
- **Policy:** the page exists and David can follow the rollback steps; the restart question has a written, evidenced answer.
- **Row 8:** the afternoon's table, complete, with the spend row as Q9 decides.

## Open uncertainty

- Whether Sentry's webhook reaches Pushover's receiver in a usable shape (resolved first, in increment 1).
- That production keeps running its timers while idle, as David reports and against the fleet document's general statement (confirmed in increment 1). If it did not, the jobs monitor's interval would keep it awake, and that would come to David with its cost.
- How long a Resend inbox keeps a thread, and whether mail to `support@` arrives today (resolved first, in increment 5).
- Whether Replit lets a deployment be made unreachable and restored for the site-down fault; if not, the fault is chosen with David on the day.
- Whether the webhook handler records every event it receives, including the other business's, so the Stripe comparison's expected set matches what is processed (read in increment 2; it shapes the comparison, not the requirement).

## Decisions taken on my recommendation (each reversible)

- **Incident history lives in Sentry only, and the Operations page reads it.** No alert table. (Q5 as first drafted is retired: storage was a technical choice once in-app display was kept.)
- **Sentry session replay is removed**, following the approved scope's "Never: session replay". (Q8 as first drafted is retired.)
- ~~Analytics stay off until Phase 14's notice grants consent.~~ Superseded by David's Q14 → 1 on Issue #1030 (amendment 2): analytics run for every visitor; the notice informs.
- **Bookkeeping writes made by page views continue during read-only mode.**

## Answered by David (2026-11-17)

- **Q6: 1** — a job that is interrupted and resumes on its own does not ring his phone. It is recorded and shown in admin; the phone rings only if the job is not picked up or fails for good. The mid-render rehearsal records "resumed, no push by design".
- **Q7: 1** — the contact form stays usable during read-only mode.
- **Q9: 1** — the fault-injection afternoon runs at the end of this phase with four sources and the rehearsals; "spend not recorded" is proven when Phase 11 demonstrates a ledger-write failure, and row 8 stays visibly open until then.
- **Q10: 1** — the uptime check runs every few minutes, "with the caveat that I think you're wrong about the sleeping": production does not sleep. Increment 1 confirms the live behaviour; a hosting cost is reported only if the check turns out to change it.
- **Q11: 1** — during read-only mode a signed-in member may save a name and pronouns, and nothing else on the profile.

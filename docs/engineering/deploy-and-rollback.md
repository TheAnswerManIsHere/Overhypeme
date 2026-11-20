# Deploy and rollback — runbook

Launch Phase 16, increment 6 (plan
`docs/plans/PLAN_PHASE16_ANALYTICS_OPERATIONS.md`, design F). This page is the
order of operations for a release, what to check after it, the ways back, and
when read-only mode is the right tool. It restates no rule that has a home:

- what a migration may do, and why the previous release must keep working:
  [`migrations-and-backfills.md`, *The migration policy*](./migrations-and-backfills.md#the-migration-policy-every-migration-leaves-the-previous-release-working);
- how Replit publishes, what its screens offer and what is unmeasured:
  [`replit-platform.md`](../ai-context/replit-platform.md);
- this Repl's own record:
  [`replit-environment.md`](../ai-context/replit-environment.md);
- restoring media and the database pair:
  [`media-backup-and-restore.md`](./media-backup-and-restore.md).

**Who does what.** Publishing, pausing or unpublishing the deployment, and
restoring production's database are David's, every time. Everything that is a
command runs through the Replit connector or a pull request, never as an
instruction to him.

## A release, with no maintenance window

A release needs no window because of one rule, not because of this page: every
migration leaves the previous release working, so the old code and the new
schema can overlap for the length of a rollout
([the policy](./migrations-and-backfills.md#why-the-previous-release-matters)).
The rule binds from Seed, the first real user; until then a rough publish
harms no one and the pre-launch latitude holds (same section, *When it
binds*).

The sequence:

1. **Merge to `main`** through a pull request. Nothing else reaches `main`.
2. **Sync the Repl** and verify, together, that its checked-out commit is the
   merged one **and** its worktree is clean
   ([`replit-environment.md`, *GitHub ⇄ Repl sync and Publish*](../ai-context/replit-environment.md#github--repl-sync-and-publish-shared-fact-not-tool-specific)).
   Every merge is synced at its close-out, so by the time a publish is wanted
   this is a re-check, not a new step.
3. **Read what the publish will carry.** Every commit on `main` since the last
   publish goes out together. For each migration among them, its pull request
   names it expand or contract; a contract names the published release that
   stopped using what it removes. A publish that carries a one-off instruction
   says so in `replit-environment.md` (the 0142 subsection is the current
   example) and on the workstream issue's *Publish order* line.
4. **Publish** (David). On the Republish page, **Copy your development
   database to production database** is looked at and left unticked: it
   replaces production's data
   ([`replit-platform.md`, *What the Republish page holds*](../ai-context/replit-platform.md#what-the-republish-page-holds)).
5. **At Replit's migration prompt, approve**, choosing the reading that keeps
   data wherever it offers several: a rename over drop-and-add, keep a column
   over delete. Cancel stops the publish with production untouched; there is
   no "keep production as it is"
   ([`migrations-and-backfills.md`, *How a database receives a change*](./migrations-and-backfills.md#how-a-database-receives-a-change)).
6. **The new release boots**: it runs its pending migrations, then listens.
   Replit promotes it only after the startup check on `/api/healthz` answers
   (`artifacts/api-server/.replit-artifact/artifact.toml`,
   `[services.production.health.startup]`).

**What a visitor sees during a publish.** Replit prepares the new version
beside the current one and then switches the address; its own pages disagree
on whether a schema change adds a brief stop, so assume a short one when the
schema changes
([`replit-platform.md`, *Publishing*](../ai-context/replit-platform.md#publishing)).
`unable to verify: the length of that stop on this deployment; the fault
afternoon (increment 7) measures a publish while a render is running.`

**What a publish does to work in flight.** The old process receives a stop
signal and gets ten seconds to finish open requests
(`artifacts/api-server/src/shutdown.ts`, `gracePeriodMs = 10_000`). A
background job it held is picked up by the new process and resumed, without
paying the image engine twice (Issue #1000; measured on dev 2026-11-17: *"A
dev-server restart mid-draw: reclaimed after 1 min 43 s, collected with one
fal request, nothing re-paid."*). A job that resumes on its own does not ring
David's phone (the plan's Q6: 1).

## After a publish: what to check

All of it is readable without a log. In order:

1. **The site answers**: `https://overhype.me/api/healthz` is 200.
2. **Nothing is silently failing**: `https://overhype.me/api/health/alerts` is
   200. This is the address the uptime check calls; a 503 means a job lane, a
   recurring task, a stuck job or the Stripe comparison is unhealthy, or could
   not be judged.
3. **The Operations page** (`/admin/operations`): every lane and recurring
   task healthy, the Stripe comparison healthy, read-only mode off, and no new
   entry under recent incidents since the publish. Recurring tasks state their
   first expected run after a start, so one that has not run yet minutes after
   a publish is not a failure.
4. **The publish's own log** (Replit → Publishing → Logs, filtered to the new
   deployment id): the migration lines for this release, each migration's
   notice with its counts, then `Server listening`.
5. **The release's own behaviour, on the published site.** Each merged pull
   request's *Post-merge verification* section was run at its merge, in the
   Repl's workspace against the development database
   ([`test-run-contract.md`](../tests/test-run-contract.md)); that proves the
   change on dev, not on production. For the published site the agent picks,
   from what the release changed, the read-only observations that show it
   working there (a count, a config read, one page) and reports them as
   *checked on the published site*, separately from what was checked on dev.
6. **The phone**: no push from Pushover in the minutes after. An error the
   new release throws for the first time rings as *new or returning
   production error*.

A failure at steps 1 to 3 is the signal to choose a way back, below.

## Ways back

Choose by what is wrong. They are listed from the cheapest.

### 1. The new code is wrong, the data is fine: revert forward

The route known to work
([`replit-platform.md`, *Republishing, history, rollback*](../ai-context/replit-platform.md#republishing-history-rollback)):

1. A pull request that reverts the bad change merges to `main`.
2. The Repl is synced and checked (commit and clean worktree).
3. David republishes.

What it costs: the time of one pull request and one publish, during which the
bad release serves. If visitors' actions are making things worse meanwhile,
turn read-only mode on first (below).

**A revert does not undo a schema change.** The reverted code runs on the
migrated database. Under the migration policy that is safe by construction:
the release being returned to is the "previous release" every migration had
to leave working. A release that knowingly broke that rule (pre-Seed
latitude) says so on its workstream issue's *Publish order* line, and its way
back is route 3, not this one.

Replit's help pages describe redeploying an earlier publish from the history
list. That control has not been seen on screen (the history row showed no
redeploy button; its ⋮ menu was not opened), so it is not a route this page
relies on. `unable to verify: whether the ⋮ menu on a Publish history row
offers a redeploy; opening it on the Publishing → Overview page settles it.`

### 2. A migration failed on production at boot

**It has happened, and the old release broke under it.** On 2026-11-18 a
publish applied Replit's generated structure first, then the new release
booted to run its pending migrations, and 0152 failed (it named a review
stage the structure had already removed). The new release never started:
Replit's publish screen read *"Your app built successfully but failed to
start. … The deployment is crash looping."* It was never switched in. The
**previous** release kept serving, on a structure it could not read, and
answered fact pages with errors: *"Meanwhile the old release, running on the
schema the publish had already changed, answers `GET /api/facts` with
500"* (PR #1053 — Bug: production crash-loops at boot because migration 0152
names a review stage the publish already removed). Fact pages were down for
about 25 minutes (03:34–03:57 UTC) while the home page and its uptime check
stayed green (Issue #1029, comment of 2026-11-18). So **the previous release
is only as healthy as the publish's migrations left it**: read a core page
(a fact page, `/api/facts`) before telling anyone the site is fine or down.
The failure shows as that publish screen message and as no `Server
listening` for the new deployment in the publish log (after-publish step 4).
Each pending migration runs in its own transaction (`lib/db/src/migrate.ts`),
so the failing one leaves its own changes unapplied, and the migrations after
it never run. Adding a later migration therefore does not help: the runner
never reaches it. Reverting code does not help either, because the structure
the old code cannot read is already in place; getting a release to boot is
the way back.

**The rule this meets.** A merged migration file is never edited
([`migrations-and-backfills.md`, *Migration principles*](./migrations-and-backfills.md#migration-principles):
*"A migration file already merged into `main` is byte-for-byte
immutable"*), because the runner identifies a migration by the hash of its
whole file, and an edit makes every database that already ran it run it
again. Which way past is right depends on why it failed, read from the
failing statement in the publish log. The agent diagnoses and proposes;
each route goes through a pull request like any other fix.

- **The migration can be made to run on both histories, and its replay
  changes nothing on a database that already ran it.** This is the repair
  that worked on 2026-11-18: 0152 was edited to accept the old stage name or
  its successor (PR #1053). 0152 fills approvals that are missing and leaves
  recorded ones alone, so a replay changes only rows still missing one. The
  measurement before merge replayed it on a copy of the fully migrated
  **test** database, which held nothing for 0152 to act on (its output began
  `already recorded 0`), so it showed the runner completes, not that a
  populated database is unchanged; that part rested on reading the SQL. The
  rule's danger is a replay that changes something, so the condition for
  another such edit is a showing: the edited file replayed by the real
  runner on a copy of a database that already ran it **and holds rows the
  migration can act on**, with that output in the pull request. A run on a
  database with no such rows shows nothing. A migration whose replay could
  change a row on a database that already ran it is never edited.
  The rule's three homes state it without this exception
  (`migrations-and-backfills.md`, `known-failure-patterns.md` and
  `.agents/memory/migration-file-immutable-once-merged.md`); reconciling
  them is recorded on Issue #1029.
- **Production holds rows the migration cannot handle** (it passed on
  dev's data and fails on production's). The rows are repaired on
  production so the unchanged migration succeeds at the next publish. That
  repair is a write to production, so it waits for David's approval of the
  exact statements before it runs.
- **The migration itself is wrong.** Its pull request is reverted, which
  takes the file out of the release without changing it, and the change
  ships again as a new migration written to be right on both kinds of
  database: one that ran the first attempt (development) and one that never
  did (production). Later migrations that depend on it go with it.
  `unable to verify: that removing a merged migration passes the repo's
  migration checks and leaves development's ledger usable; a run of the real
  runner on a scratch database, with the original applied and then removed,
  would settle it.`

### 3. Data was damaged: restore production's database

Only when rows were lost or rewritten wrongly and no forward repair exists.
A restore winds back everything in the database, and three things in it
shape the order below: the read-only switch is a row in that database, so
**a restore turns read-only mode back off**; the records of media are in it,
while the media itself is not; and the record of every payment taken since
the restore point is in it, while Stripe keeps the money.

1. **Stop the damage.** Read-only mode if visitors' writes are the cause.
   If the server's own work is the cause (a background job, a payment
   webhook), pause the deployment now (David: step 4's control); stopping
   the damage wins over everything below.
2. **Replace the release that did the damage** (route 1: revert, sync,
   republish), before the restore: a restore under the damaging release
   would hand it the restored data. If the deployment is paused and Replit
   will not publish to it, resume it and republish at once, accepting the
   minutes the damaging release runs again. `unable to verify: whether a
   paused deployment can be published to; one look at the Republish page
   while paused settles it, and the fault afternoon's pause (Issue #1029)
   is where it is looked at.` What the damaging release writes to the
   database in those minutes the restore discards; what it does outside the
   database (an email sent, a charge, a file) it does not. If the republish
   fails, pause again (step 1) and the agent proposes the next route.
3. **Choose the recovery point: the latest completed backup pair before the
   damage**, not simply "a moment before"
   ([`media-backup-and-restore.md`, *In an incident*](./media-backup-and-restore.md#in-an-incident)).
   Recovery is promised only at completed pairs, because the database and
   the media must match: media is deleted in the ordinary course (the content
   purger runs hourly), so a database wound back past a deletion points at
   objects the live bucket no longer holds, whether or not the incident
   touched media. Restoring to a later moment to lose less is outside that
   contract; if it is chosen, media changed since the pair will not match.
4. **Pause the deployment** (David: Replit → Republish page → *Manage your
   app* → Pause). Read-only mode is not enough here: admins, background jobs
   and payment webhooks keep writing under it by design, and the restore
   itself switches it off. The site is down for everyone until step 7.
5. **Restore the database** (David: Replit's Database tool, point-in-time,
   to the pair's `database.at`). Seven days back on Core, up to 28 on Pro
   ([`replit-platform.md`, *The two databases*](../ai-context/replit-platform.md#the-two-databases-and-what-a-publish-does-to-productions)).
   Everything written after that moment is lost. `unable to verify: how
   Replit's point-in-time restore treats a deployment that is still running;
   pausing first makes the question moot.`
6. **Restore that pair's media** (the agent, with the media runbook's
   `restore` command). It lands beside the live media under `_restores/`,
   never over it; putting restored objects back under their live names is
   not tooled and is decided with David at the time (same runbook, step 5).
   Until that is done, restored records can point at media the site cannot
   show.
7. **Resume the deployment** (David). The first boot applies any migration
   the restored database's ledger lacks.
8. **Set read-only mode again, on or off, from the Operations page.** Saving
   it is what makes every server agree: a server that was running through
   the restore still holds the old "on", and one that started after reads
   the restored "off".
9. **Check, as after a publish** (*After a publish: what to check*, above).
   Expect the Stripe comparison to report every payment taken since the
   restore point as unprocessed, and the uptime check to ring for it: that
   is the list of payments whose records were wound back. `unable to verify:
   how those payments are replayed into the restored database; Stripe's
   event resend against the webhook, tried on a test-mode event, would
   settle it.`

### 4. The site is down and nothing above applies

Pause and Unpublish take the site away from everyone and are David's
([`replit-platform.md`, *Republishing, history, rollback*](../ai-context/replit-platform.md#republishing-history-rollback)).
A process that exits is restarted by the platform on its own (*Why the API
server restarts*, below), so a crash is not a reason to do either.

## When read-only mode is the right tool

Read-only mode (`/admin/operations` → *Read-only mode*) stops what visitors
and members do on purpose to change something, and leaves browsing,
personalising, signing in, the contact form, admins, background jobs and
payment webhooks working. Each server picks the switch up within about a
minute; the page shows what the answering server is enforcing.

Use it when **public writes are the problem or are in the way**:

- a bad release is corrupting or mis-saving what people submit, and the
  revert is minutes away;
- in the minutes before a production database restore, to limit what
  visitors write that the restore will discard. It does not hold across the
  restore: the restore switches it back off, and jobs, webhooks and admins
  write under it anyway, so the restore itself runs under a paused
  deployment (route 3);
- a data repair or a contract migration is about to run that the public
  write paths could race;
- abuse through a public write path that needs a fix, not a takedown.

It is the wrong tool when:

- **the site is down or erroring on reads**: it changes nothing a reader
  sees;
- **a background job or a payment webhook is doing the damage**: those keep
  running by design; pause the deployment or fix the job;
- **money is being spent wrongly**: jobs already queued still run while it
  is on; the spend controls are Phase 11's;
- **a release simply needs to go out**: no release needs it.

Turn it off from the same page. Signing in and the admin routes are let
through before the switch is read, so it can always be turned off.

## Why the API server restarts

The launch plan carried an open question from 2026-10-04: an API restart that
night nobody could explain. This section is its answer.

**What is on record about that night** is one sentence, in the two
assessments on Issue #628: *"tonight's unexplained API restart went unnoticed
until a log was read."* It does not say whether it was the dev app or the
published site. No log line, exit code or Sentry event was kept. Two things
narrow it: no commit reached `main` between 2026-09-30 and 2026-10-05
(GitHub's commit list for those dates is empty), so if it was the dev app, a
synced merge did not restart it; and whether the published site's logs reach
back that far was not checked (Replit keeps them 30 days, so they would not).
`unable to verify: the cause of that one restart; its log would settle it and
is gone.` What can be settled, and is below, is every way the server restarts,
which of them is a fault, and how a fault is now caught. David accepted this
as the answer (Q27: 1, Issue #1029).

### In development (the Repl)

The dev API runs under `tsx watch`, wrapped by `scripts/dev-watch-guard.sh`,
inside `scripts/dev-supervisor.sh` (`artifacts/api-server/package.json`,
`dev`; `artifacts/api-server/scripts/dev-run.sh`: *"restarts the server
whenever a source file changes"*).

- **Any change to a source file restarts it. This is the ordinary cause, and
  it is by design.** Measured 2026-11-20 with tsx 4.21.0, a process under
  `tsx watch`, one line appended to its file:

  ```
  BOOT pid 2794 2026-11-20T00:04:20.177Z
  12:04:24 AM [tsx] change in …/srv.ts Restarting...
  got SIGTERM
  BOOT pid 2850 2026-11-20T00:04:24.396Z
  ```

  A Repl sync is a `git pull` that rewrites source files, so **every synced
  merge restarts the dev server**, as does any edit made in the Repl. On
  2026-11-17 the dev server logged *"Server listening"* eight times
  (`PLAN_JOB_RESUME.md`); that was a day of many merges, each synced.
  `unable to verify: that each of those eight starts followed a sync; the
  workflow log of that day, read beside the sync times, would settle it.`
- **`tsx watch` force-kills a server that takes more than about five seconds
  to stop** (same measurement: *"Previous process hasn't exited yet. Force
  killing..."*), which is shorter than the server's ten-second grace. A job
  in flight is cut off and resumed by the next process (Issue #1000).
- **A crash in development is restarted by the supervisor.** It was not,
  until 2026-11-20: measured with a process that exits with code 1,

  ```
  BOOT pid 2788 2026-11-20T00:04:20.181Z
  exiting 1
  12:04:24 AM [tsx] change in …/srv.ts Rerunning...
  BOOT pid 2844 2026-11-20T00:04:24.383Z
  ```

  nothing restarted it between the exit and the edit, because `tsx watch`
  stays alive waiting for a change and the supervisor watched only `tsx`.
  PR #1089 — Fix #1083: a dev API server that crashes is restarted, instead
  of staying down until a file changes — added the guard, which notices
  `tsx` alive with no server for about six seconds and exits, so the
  supervisor logs it, backs off and restarts. Two limits remain: on a
  machine that hides its process information the guard says so once and
  detection is off; and a dev server that cannot start at all is restarted
  until the supervisor's cap of 20 crashes in five minutes, after which it
  stays down until the workflow is restarted.
- **The dev workflows can also simply be stopped**
  ([`replit-environment.md`, *The dev app can be stopped*](../ai-context/replit-environment.md#the-dev-app-can-be-stopped-and-boots-in-about-30-seconds)).

### In production

- **A publish** replaces the process. By design.
- **A crash.** An error nothing catches reaches `fatalExit`
  (`artifacts/api-server/src/index.ts`), which reports to Sentry, waits up to
  two seconds for the report to leave, and exits; the platform starts the
  process again. Measured once, on 2026-10-31 (Issue #826): crash at
  04:34:44Z, the next boot's first log line at 04:34:56Z, twelve seconds.
  Every request in flight at the crash is dropped.
- **The platform moving or scaling the deployment.** `unable to verify: how
  often Replit replaces an Autoscale instance of this deployment on its own;
  a count of "Server listening" lines in the Publishing → Logs tab against
  the publish history would settle it.`

The crash causes found so far, and where each stands:

| Cause | Found | State |
|---|---|---|
| A torn-down log pipe (`EIO`, `EPIPE`) treated as fatal (it reached Sentry) | 2026-05-02 (`4c23f1f`, Task #402) | absorbed by `lib/stdioGuard.ts`; reported once, the server keeps serving |
| A database connection dropped while idle or checked out | 2026-10-31, production (Issue #826) | fixed, PR #828 |
| An object-storage error midway through sending an image | 2026-11-07, by review, never observed (Issue #894) | open; its own bugfix |

Sentry holds no event tagged as a fatal exit, or as an absorbed log-pipe
error, in the 90 days to 2026-11-20 (search
`fatal:[uncaughtException,unhandledRejection,stdio-stream-error-absorbed]`,
all projects: *"No issues found"*). **That includes the one real production
crash on record, 2026-10-31**, which `fatalExit` should have reported. Why it
did not is Issue #826's open half: whether production's Sentry key was set
then is unknown. So the alert a crash depends on has never been seen to
arrive from the published site, which is why the fault afternoon's first row
is an error forced on the deployed API.

### What has changed since, and what has not been shown yet

The 2026-10-04 complaint was as much that nobody knew as that it happened.
What exists now, from increments 1 and 2 of this phase:

- an uncaught error is reported to Sentry before the process exits, and the
  rule *Phone: new or returning production error* turns it into a push;
- a process that does not come back fails the uptime check on
  `/api/health/alerts`, which rings as *Phone: site down*;
- a job the dead process held is resumed, and rings only if nobody picks it
  up or it fails for good.

The alert route was proven on the real accounts in increment 1 with an error
event and an uptime incident. Two things have **not** been shown yet. An
error raised on the deployed API reaching the phone is the fault afternoon's
first row (increment 7), which throws inside one request through the admin
Sentry diagnostics route and does not end the process. A crash that ends the
deployed process (through `fatalExit`) is not part of the afternoon at all;
until one is seen to ring, this section claims the mechanism, not the proof.

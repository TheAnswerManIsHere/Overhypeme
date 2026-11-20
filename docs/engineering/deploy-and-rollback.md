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
5. **The release's own checks**: each merged pull request's *Post-merge
   verification* section names what to run against production for that
   change. They are run through the connector, read-only unless the section
   says otherwise.
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

### 2. A migration failed part-way: fix forward

Each pending migration runs in its own transaction
(`lib/db/src/migrate.ts`), so one that fails leaves its own changes unapplied
and the new server does not start. Replit promotes a release only after its
startup check answers, so the previous release should keep serving, on a
schema Replit's own migration has already changed, which the migration
policy makes safe. `unable to verify: that a release whose boot migration
fails is never promoted on this deployment; it has not happened here.` Read
the publish log
for the failing statement, fix the migration in a pull request, sync,
republish. Replit's own generated migration may already have applied the
structure, which is why every migration's structural statements skip work
they find done
([*How a database receives a change*](./migrations-and-backfills.md#how-a-database-receives-a-change)).

### 3. Data was damaged: restore production's database

Only when rows were lost or rewritten wrongly and no forward repair exists.

1. **Stop the damage**: read-only mode if visitors' writes are the cause; a
   paused deployment (Replit → Republish page → *Manage your app* → Pause) if
   the server's own work is.
2. **Restore** with Replit's Database tool, point-in-time, to a moment before
   the damage: seven days back on Core, up to 28 on Pro
   ([`replit-platform.md`, *The two databases*](../ai-context/replit-platform.md#the-two-databases-and-what-a-publish-does-to-productions)).
   Everything written after that moment is lost, which is why writes are
   stopped first. This is David's action.
3. **Media** follows the database only if media was damaged too:
   [`media-backup-and-restore.md`, *In an incident*](./media-backup-and-restore.md#in-an-incident).
4. **Code**: if the release that did the damage is still published, revert it
   forward (route 1) before turning writes back on. The restored database's
   migration ledger says which migrations it has; the next boot applies the
   rest.

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
- before a production database restore, so nothing more is written that the
  restore would discard;
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
until a log was read."* No log line, exit code or Sentry event was kept, and
the dev workflow's log from that night no longer exists. `unable to verify:
the cause of that one restart; its log would settle it and is gone.` What can
be settled, and is below, is every way the server restarts, which of them is
a fault, and that a fault no longer passes unnoticed.

### In development (the Repl)

The dev API runs under `tsx watch` inside `scripts/dev-supervisor.sh`
(`artifacts/api-server/package.json`, `dev`;
`artifacts/api-server/scripts/dev-run.sh`: *"restarts the server whenever a
source file changes"*).

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
- **A crash in development leaves the API down until the next file change.**
  Measured the same way, with a process that exits with code 1:

  ```
  BOOT pid 2788 2026-11-20T00:04:20.181Z
  exiting 1
  12:04:24 AM [tsx] change in …/srv.ts Rerunning...
  BOOT pid 2844 2026-11-20T00:04:24.383Z
  ```

  Between the exit and the edit nothing restarted it: `tsx watch` stays
  alive waiting for a change, so the supervisor, which watches `tsx`, never
  sees an exit. The comment above `fatalExit` in `index.ts` says the
  supervisor restarts the process; under `tsx watch` it does not. This is a
  defect in the dev tooling, tracked as its own bugfix (Issue #1083).
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
| A torn-down log pipe (`EIO`, `EPIPE`) treated as fatal | date not established | absorbed by `lib/stdioGuard.ts`; reported once, the server keeps serving |
| A database connection dropped while idle or checked out | 2026-10-31, production (Issue #826) | fixed, PR #828 |
| An object-storage error midway through sending an image | 2026-11-07, by review, never observed (Issue #894) | open; its own bugfix |

Sentry holds no event tagged as a fatal exit, or as an absorbed log-pipe
error, in the 90 days to 2026-11-20 (search
`fatal:[uncaughtException,unhandledRejection,stdio-stream-error-absorbed]`,
all projects: *"No issues found"*). The 2026-10-31 crash is known from the
log alone, so that empty result is not proof that nothing crashed before
alerts existed.

### Why a restart no longer goes unnoticed

The 2026-10-04 complaint was as much that nobody knew as that it happened.
Since increments 1 and 2 of this phase:

- an uncaught error is reported to Sentry before the process exits, and the
  rule *Phone: new or returning production error* turns it into a push;
- a process that does not come back fails the uptime check on
  `/api/health/alerts`, which rings as *Phone: site down*;
- a job the dead process held is resumed, and rings only if nobody picks it
  up or it fails for good.

The fault afternoon (increment 7) proves each of these on the deployed site,
including a forced error on the deployed API.

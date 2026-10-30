<!-- SYNCED FROM AI-Handbook — do not edit in a consumer repo. Local edits are overwritten by the next sync and their reasoning is lost; change the handbook instead. -->

# Replit — how the platform works, for every product hosted on it

> **What this is.** The fleet's account of Replit as a platform: publishing,
> the two databases, secrets, rollback, Git, Agent modes, and the connector's
> own behaviour. It is true in any repo hosted on Replit. **What one Repl is
> configured as** — its deployment type, domain, databases, secrets, commands —
> is that repo's own [`replit-environment.md`](replit-environment.md), which
> this file never restates. **What I may do with the connector** — sync yes, publish
> only on David's word — is `claude-core.md`, *Connectors → Replit*; this file
> says how things work, not what is authorised.

Built 2026-10-29 from four sources, and each claim says which:

- **docs** — docs.replit.com, read 2026-10-29. Its reference pages carry no
  dates; only the changelog is dated (newest read: 2026-10-23). Where two
  pages disagree, the disagreement is named, not resolved by guessing.
- **measured** — a command run against the Overhype.me or DojoOS Repl through
  the connector, or a file read in the repo, with its output quoted.
- **Agent** — Replit Agent's own account, answering `ask_question`. That is a
  working assumption, never a fact, until a measurement or the docs back it
  (*Asking it well*, below, says why).
- **screen** — what David's Replit screen showed, from his screenshots of the
  DojoOS Repl's Publishing pages, its preview-deploy flow and his account's
  Usage page on 2026-10-29 (from about 22:10 UTC). As good as a
  measurement for what the interface offers; it says nothing about what a
  control does until someone uses it.

Anything still open is listed at the end under *Open*, with what would settle
it.

## The model: a workspace and a published deployment

Every Repl is two environments that share nothing at runtime:

| | Workspace (development) | Published deployment (production) |
|---|---|---|
| Code | the Repl's working tree, tracking `main` | a snapshot taken at the last publish |
| Database | development database (Replit's Helium, PostgreSQL 16) | production database (Neon), created at first publish |
| Secrets | the Secrets pane | Publishing → Republish page → *Production app secrets* (see *Secrets*) |
| Tells code which it is | `REPLIT_DEPLOYMENT` unset; `REPLIT_DEV_DOMAIN` set | `REPLIT_DEPLOYMENT=1`; `REPLIT_DEV_DOMAIN` absent |
| URL | private `*.replit.dev` preview | `<name>.replit.app`, or a custom domain |

Sources: docs (*development-and-production*, *secrets*); measured on
Overhype.me 2026-10-29, `echo "${REPLIT_DEPLOYMENT:-unset}"` → `unset` in the
workspace; production query → `neondb`.

**Nothing moves from the workspace to production except a publish.**
*"Changes in the Project Editor do not automatically replace the live
release"* (docs, *publish-your-app*), and nothing publishes on a Git push. A
merge to GitHub `main` reaches neither environment on its own: the sync is
what brings it to the workspace, and the publish is what brings the
workspace to production.

## Publishing

**What a publish takes.** *"a snapshot of your app's files and
dependencies"* (docs, *replit-deployments*). **Whether uncommitted files are
in it is not stated by the docs**; the Agent says they are and cites the docs,
which say no such thing. It stays unmeasured on purpose (David, 2026-10-29):
the test costs two publishes and could not change what anyone does, since the
rule below already assumes the worst. So the rule stays the one the fleet
already runs:
**publish only from a Repl whose checked-out SHA matches `main` and whose
worktree is clean** — the close-out sync's two checks — because if the
snapshot does include the working tree, a leftover probe ships. Publishing
covers *"every artifact"* in the project together (docs, *after-you-publish*).

**Stages.** Provision → Security checks → Build → Bundle → Promote, *"usually
a minute or two"*; a publish in progress can be cancelled (docs). Each past
publish keeps that stage bar and its own build and runtime log (screen). A security
scan always runs, and a setting decides whether a critical finding blocks the
publish (docs, *publishing/overview*). Promote *"prepares the new version
alongside the current one, then switches your URL"*, but *"Database changes
sometimes require stopping your app temporarily"* — the two pages disagree on
downtime; assume a brief one when the schema changes.

**The published filesystem is not persistent** and *"resets every time you
publish"* (docs, *troubleshooting*). Anything that must survive goes in a
database or object storage.

**Health check.** Before promoting, Replit requests the app; a homepage
slower than five seconds can fail the publish at the last step. The server
must listen on `0.0.0.0`; Autoscale and Reserved VM expose one external port,
and declaring any `[[ports]]` turns off auto-detection and requires one with
`externalPort = 80` (docs, *troubleshooting*, *ports*). An artifact can name
its own startup check — Overhype.me's API declares
`[services.production.health.startup]` `path = "/api/healthz"` (measured, in that artifact's `artifact.toml`).

**Logs** are kept 30 days, in the Publishing pane's Logs tab (docs,
*monitoring-a-deployment*).

### Deployment types

Four, and only four (docs, *deployment-types*):

| Type | Runs | Bills | Fleet use |
|---|---|---|---|
| **Autoscale** (default) | adds servers under load, scales to zero after 15 idle minutes; first request after idle is a cold start | while requests are served | Overhype.me (measured, `.replit`: `deploymentTarget = "autoscale"`) |
| **Reserved VM** | one always-on server | fixed monthly | DojoOS (measured, `.replit`: `deploymentTarget = "vm"`) |
| **Static** | files only, no backend; *"not compatible with Replit Apps created using Agent"* | data served | — |
| **Scheduled** | a command on a cron, then stops; no URL | per run | — |

Autoscale's *Max machines* caps the server count and so the maximum cost. A
published app *"expect[s] your program to keep running. If your program runs
once and exits, the platform restarts it automatically"* (docs,
*troubleshooting*), which is why a supervisor that exits non-zero when a child
dies is the right shape on a Reserved VM (DojoOS's production supervisor).

### Where the publish configuration lives

Two layers, and the second is the one an Agent-built pnpm monorepo uses:

- **`.replit`** — `[deployment]` carries `deploymentTarget`, optional `build`
  / `run`, `ignorePorts`, and `router`; `[deployment.postBuild]` runs after
  the build (both fleet Repls: `pnpm store prune`). `[[artifacts]]` entries
  name the project's artifacts (measured, both repos).
- **`artifacts/<name>/.replit-artifact/artifact.toml`** — one per artifact,
  each declaring `[[services]]` with the `paths` it serves, a
  `[services.development]` run command, and a `[services.production]` block
  with its own build, run, env and health check. With `router =
  "application"`, requests are routed by those `paths`. Measured on
  Overhype.me: `/api` → the API service (run `node --enable-source-maps
  artifacts/api-server/dist/index.mjs`, env `NODE_ENV = "production"`); `/` →
  the web artifact (`serve = "static"`, rewrite `/*` → `/index.html`);
  `/__mockup` → the design artifact, which declares no production service and
  so serves nothing when published.

**`NODE_ENV` is not a platform default anyone has established**: the docs
never say Replit sets it, and Overhype.me's API sets it in its artifact's
production env (measured). That is one place it can come from, not the only
one — a published-app configuration in the Secrets tool or the run command
itself can supply it too (docs, *secrets*, *configuration*). So a missing
`artifact.toml` line does not mean the variable is unset: when the value
matters, read the service's effective environment (a production log line, or
the Publishing pane's configuration), never infer it from one file.

### Republishing, history, rollback

- **Republish** keeps the URL and the deployment's settings; it is the only
  way new code reaches production (docs; the connector's `publish_app`:
  *"If the app has been published before, this republishes it, reusing the
  existing deployment's settings"*).
- **Publish history** sits on Publishing → Overview, under *Current status*
  (Live, who published, when): one row per past publish, newest first, by
  deployment id — `3ff15af5`, `d49a6e77`, `115b5210`, `1eabe174`, and a
  *"failed to publish"* row for `26144f9b`, four days back on DojoOS.
  Opening a row showed that publish's stages and log and **no redeploy
  control**; the row's ⋮ menu was not opened. The list showed only about the
  last four publishes (screen, 2026-10-29). The Agent cannot read the list
  (Agent, 2026-10-29).
- **So the rollback route known to work is a forward change**: revert on
  GitHub through a PR, sync the Repl, republish. The help FAQ's redeploy of
  an earlier version is unconfirmed on screen. **A code revert does not undo
  a schema change**: a publish diffs the development database against
  production, not the code (*The two databases*), so the way back for schema
  is a production restore or a forward migration, per the product's own
  `migrations-and-backfills.md`.
- **The Logs tab** lists Time, Deployment (the id above), Source (`System` or
  `User`) and Log, with Search, *Errors only* and Date filters (screen), so a
  line can be tied to the publish that produced it. The list shows local time
  while a publish's own log shows UTC (screen: `2026-10-28 20:52:36` in the
  list against `2026-10-29T02:52:35Z` in the detail, for the same startup).
- **A workspace checkpoint rollback never touches production.** Code and the
  development database roll back (the database only if ticked under
  *Additional rollback options*); production stays as published. To bring
  production back too: restore its database, roll back to the matching
  checkpoint, and republish (docs, *data-recovery*).
- **Changing who can reach the app requires unpublishing first** (docs,
  *private-deployments*) — an outage, so it is David's call each time. **So
  does changing the deployment type**: *"To change your deployment type, you
  will need to unpublish and publish again"* (screen).
- **Manage your app** offers three controls at the foot of the Republish
  page (screen), all David's: **Pause** — *"Your billing will continue, but
  all users will lose access to your app"*; **Change deployment type**
  (above); **Unpublish** — *"Your published app billing will be canceled, and
  it will cease to exist"*.

### What the Republish page holds

Publishing → the top-right **Republish** button opens a popover first —
status, visibility, how many artifacts are published, domains, a feedback
widget toggle, and **Review security** beside **Republish** (screen). The
full page, top to bottom (screen, DojoOS):

- **Sharing** — Public, or the private options under *Domains and access*.
- **Suggested add-ons** — a deep security scan (*Run scan*), uptime email
  notifications, monitoring alerts, **Block publishing of critical
  vulnerabilities** (a toggle: the security scan always runs, and this decides
  whether a critical finding stops the publish), analytics, a feedback widget,
  and the "Made with Replit" badge.
- **Production app secrets** — *Secrets and environment*, below.
- **Resource usage / Machine configuration** — the machine size and its price
  (DojoOS: *Dedicated 2 vCPU / 8 GiB RAM*, *"$50 per month ($0.0694/hour)"*).
  The Overview's *Infrastructure* panel adds the region (North America) and a
  *See usage logs* link.
- **Database settings** — one checkbox, **Copy your development database to
  production database**, labelled *"This is a destructive action. This will
  replace your production database with your development database,
  overwriting any existing production data. You can always restore your
  production database via Point-in-time recovery or snapshots."* It is on
  the irreversible list by its own description: never ticked except on
  David's explicit word for that publish. It reads unticked on DojoOS
  (screen, 2026-10-29). **Whether a tick persists to the next republish is
  undocumented** — the *Learn more* link leads only to the restore tool — so
  after any deliberate copy it is unticked again in the same visit, and it
  is looked at before every publish.
- **Manage your app** — above.

## The two databases, and what a publish does to production's

- **The development database is the Agent's; production is not.** The docs
  say *"Agent is not able to modify the production database"* — Replit's
  claim, never measured, since a write is not a test anyone should run. What
  is measured is the other half: the Agent **can read production** through a
  query tool of its own, which it describes as read-only (measured
  2026-10-29: `SELECT current_database(), now();` against production →
  `neondb,2026-10-29 21:58:06.18808+00`). So a request that touches
  production says read-only and names what it must not change, whatever the
  docs promise. That is a live read of user data,
  under the disclosure rules of
  [`live-diagnosis`](../../.claude/skills/bugfix/live-diagnosis.md) like any
  other: aggregate or redact in the request itself.
- **At publish, production's schema is brought to the development
  database's.** *"any changes you've made with Agent to the structure of
  your development database ... are applied to your production database"*
  (docs). Data is not copied by the schema step. It can be copied wholesale
  by the Republish page's **Copy your development database to production
  database** checkbox, on any publish of a live app, not only the first
  (screen; *What the Republish page holds*). **What the
  docs do not describe and David has measured** (Overhype.me, 2026-10-28):
  when the two schemas differ, Replit generates one migration and offers
  **Approve and publish**, **Create preview deploy** or **Cancel**, asking per
  difference only when one is ambiguous; there is no "keep production as it
  is". A repo's own migration files are not what runs there — Replit diffs
  and generates — so a repo whose app also runs guarded migrations at boot
  must tolerate a schema Replit already applied. How each product handles
  this is its own `migrations-and-backfills.md`.
- **A preview deploy** is *"a temporary, isolated copy of your production
  environment where you can test database changes and application updates
  before they affect real users"* (docs). What it does on screen (DojoOS,
  2026-10-29, a one-column throwaway table as the schema difference): the
  publish stops at Provision showing *Development database changes
  detected*, *Generated migrations to apply to production database*
  (expandable) and *Database migrations validated successfully*; **Create
  preview deploy** turns to *Building…*, then **View preview**, while the
  top-right button reads **Approve**, which continues to the real publish.
  The preview opens at a temporary `*.replit.dev` address under the banner
  *"This is a temporary development preview, and these links are not for
  public use."* It served what DojoOS shows only in development: the
  password-less *"I'm Jared / I'm David"* sign-in, which production hides
  (screen, 2026-10-29). So a preview link is private — anyone holding it may
  get development-only behaviour. Which database it ran against was not
  shown. **Cancel**
  ends it as *Build canceled* with production untouched. How long a preview
  lives and what it costs were not shown.
- **Recovery.** Development: checkpoint rollback, up to 7 days. Production:
  point-in-time restore — 7 days on Core, up to 28 on Pro (docs,
  *data-recovery*). Production idles after five minutes without queries and
  wakes on the next one (docs).
- **Risky schema changes** at publish are the ordinary ones: dropping a
  column code still reads, adding a required column without a default,
  renaming (docs). They are what the Approve screen is for.

## Secrets and environment

**Workspace secrets are synced to production by default, one by one, and
each can be unsynced** (screen). The Republish page's *Production app
secrets* lists *Deployment secrets*: every workspace secret carries a link
icon, and its ⋮ menu offers **Edit**, **Unsync from workspace value** and
**Delete**; `DATABASE_URL`, the `PG*` variables and the connector hostnames
carry a globe icon instead, which reads as platform-provided; *Add deployment
secret* adds a production-only one. So *publishing/overview* and the 2025
changelog are right and *troubleshooting*'s *"do not automatically carry
over"* is stale; the Agent picked the stale page. Synced values reach production *"when you publish or republish"* (docs,
*publishing/overview*); whether a workspace change reaches the running
deployment between publishes was not shown. **A production secret is still
checked by name in that list before anything depends on it**, since one
unsynced there no longer follows the workspace. Secrets are
unavailable to Static deployments, and an organisation member who cannot see
a value can still print it from the environment (docs, *secrets*).

## Domains and access

- Default `<name>.replit.app`; custom domains through a guided DNS flow or by
  hand: an `A` record plus a `replit-verify=` `TXT` record, **and the `TXT`
  record must stay forever** — TLS renewal re-validates through it. `www` is
  a separate domain. DNS can take 48 hours (docs, *custom-domains*).
  Overhype.me serves at `https://overhype.me`; DojoOS at
  `https://dojo-os.replit.app` (measured, `get_publish_status`, 2026-10-29).
- Access: Public, Password protected, Workspace only, Invite only; Replit puts
  its own sign-in in front, with no code change. Personal workspaces default
  to Public (docs, *private-deployments*). A machine reaching a private app
  uses an External Access Token (docs).
- **A publish locks the region**; changing it means remixing the app (docs).

## Git, and the Repl's own commits

- **Nothing syncs from GitHub to the Repl by itself.** The Git pane has
  Pull, Push and Sync Changes; one help FAQ mentions an auto-sync toggle that
  the Git pane's own page does not, and the Overhype.me Repl showed none
  (measured, 2026-08-11). So the post-merge sync is always an explicit step,
  which is why close-out asks for it every merge.
- **Every Agent checkpoint is a git commit** in the Repl's repository, and
  every checkpoint and publish is also copied to a Replit-managed remote
  named `gitsafe-backup`, which is not GitHub (docs, *disaster-recovery*).
  GitHub receives only what is committed and pushed.
- **`[postMerge]`** in `.replit` names a script the Agent runs after it
  merges one of its own tasks — not after a workspace `git pull` and not at
  publish (Agent, DojoOS, citing the project's guidance; unconfirmed by the
  docs). DojoOS's runs `pnpm install --frozen-lockfile`. It is therefore no
  substitute for installing dependencies after the close-out sync.

## Agent modes, and what a connector request costs

- **Modes are Free, Power and Max** (Economy is gone; Lite, Turbo and
  *Full build* are stale names on older pages). Free always auto-routes the
  model; Power and Max on Core or Pro can pick a model and an Effort level.
  **The mode is a setting of David's account, per message** — *"Your Agent
  settings are tied to you, not to the project"*, and they apply *"when you
  send the next message"* (docs, *agent-modes*, *model-selector*).
- **The connector exposes no way to choose the mode.** Its `ask_question`
  and `update_app_using_prompt` both take a `policy` argument whose own schema
  reads *"Ignored. Don't waste tokens sending this."* **How the server picks
  the mode for a connector request is unknown**: neither the docs nor the
  tool descriptions say it follows David's dropdown, and the Agent cannot see
  which mode it ran in (Agent, 2026-10-29: *"I can't see which Free, Power, or
  Max tier or exact model handled this request"*). What is measured is
  the outcome: **a connector request runs Free whatever the dropdown says.**
  Connector questions appear in the Repl's own Agent chat footed *"Free · No
  credits used"*; with DojoOS's dropdown switched to **Power**, a connector
  question still ran Free, while the same question typed by David ran Power
  and cost **$0.27** (screen, 2026-10-29). Only `ask_question` was tested
  under Power; `update_app_using_prompt` was not.
  Replit documents none of this, so it is an observation that can change, not
  a promise: a connector request's cost is read off its footer, never assumed.
  And every question sent is visible to anyone who opens that Repl's Agent chat, which the tool's own description warns.
- **Billing**: paid modes are effort-priced per request, one checkpoint per
  request, and Replit asks for confirmation before a paid action starts;
  Plan Mode bills reasoning even when nothing changes; usage takes up to 30
  minutes to show (docs, *ai-billing*). Routines never run in Free.
- **The Usage page** (replit.com/settings/usage, by UTC day) confirms it from
  the billing side (screen, 2026-10-29): after a day of some twenty connector
  requests, **Free allowance read 0% used** and that day's *Agent* line held
  one entry — **DojoOS $0.27**, David's typed question, billed to the
  project it was asked in. Connector requests appear nowhere, not even at $0,
  and neither does `get_publish_status`. Most of a month's spend need not be
  AI at all: in that period production database compute was $25.08 of $42.75
  (156.74 hours at $0.16/hour), against $13.37 of AI.
- **Plans** that matter here: Starter allows one published app that expires
  after 30 days; Core and Pro publish without limit, run 1 and 10 background
  tasks, and Pro rolls credits over two months (docs).

## The connector

Tools, as the MCP server exposes them: `list_apps`, `search_apps`,
`resolve_app_by_name`, `create_app_from_prompt`, `ask_question`,
`update_app_using_prompt`, `publish_app`, `get_publish_status` (docs,
*mcp-server*). Two more appear in this fleet's sessions,
`list_app_files` and `read_app_file`, which do not list `*.sql` files
(measured in DojoOS's environment doc).

- **`ask_question` has a 60-second client timeout, and a reply that outlives
  it is lost.** The server's own words on the next call: *"replies that
  outlive your timeout are never delivered ... The server does not remember
  bounced questions."* The Agent keeps working on the lost question, and
  every call to that Repl until it finishes returns `phase: "busy"` with
  nothing submitted. Measured 2026-10-29: an eight-item question and two
  questions that sent the Agent to look up documentation each timed out and
  cost two to three minutes of `busy` afterwards; short questions that said
  *"Don't look anything up … in three sentences at most"* all returned
  inside the limit. **So: one short question per call, say not to look
  anything up when its own knowledge or a command is enough, and after a
  timeout wait two to three minutes before re-asking — never resend at
  once.** Each Repl's Agent is independent, so a busy one does not block
  another.
- **`phase` values seen**: `busy` (dropped, re-ask later) and `paused` (the
  answer is in `response` — the normal successful reply). `updating` belongs
  to the write channel: re-invoking it opens a brand-new Agent turn
  (`claude-core.md`).
- **`update_app_using_prompt` never returns the result**, only a status
  (`claude-core.md`); a read-back is a following `ask_question`.
- **`publish_app` takes only the `replId`.** Type, domain, access and secrets
  are whatever the deployment already has; a first publish takes defaults —
  *"Autoscale hosting, private visibility when the app belongs to a workspace
  (organization), public visibility otherwise"* — and some apps refuse a
  first publish from chat and must be published once from the website (the
  tool's own description; the docs do not mention it). It returns once the
  publish is scheduled: poll `get_publish_status` every 30 seconds until it
  reads `success`, `failed` or `suspended`. `found: false` means never
  published.
- **`get_publish_status` reads deployment state without asking the Agent**:
  it answered for Overhype.me while that Repl's Agent was still busy on a
  lost question, which every `ask_question` at that moment bounced (measured
  2026-10-29). It shows no charge on the Usage page; it is the cheap way to
  learn an app's live URL and whether its last publish landed.
- **`suspended`** is not a state the docs define for a deployment; they only
  describe suspension for continued payment failure and a reached spend
  limit (docs, *about-usage-based-billing*, *managing-spend*). Read it as a
  billing stop until shown otherwise.

### Asking it well

The rule Overhype.me learned on 2026-08-11 and re-measured here: **an answer
that quotes the command it ran and that command's raw output is evidence; an
answer describing how something works is the Agent's understanding, which
can be fluent, specific and false.** On 2026-10-29 the Agent cited the docs
for a claim the docs do not make, and reported a newest log line timestamped
eleven hours in the future. So ask it to run a named command and quote the
output, ask it to say which parts of an answer are observed and which are
general knowledge, and corroborate the second kind against the docs or a
measurement before recording it anywhere.

## Contradictions inside Replit's docs

Recorded so nobody resolves them by picking the page they found first: the
secrets sync (settled on screen in favour of sync, above); the Autoscale base fee ($2 on the pricing page, $1 on
the August 2026 update); whether access controls need Pro (one older page
says so, the access page does not); US-only hosting versus selectable
regions; downtime at publish; `localPort` versus `internalPort` in the ports
page; and whether the dev-database rollback window is 7 days. The model list
on the model-selector page lags the changelog and says it is not the source
of truth — the dropdown is.

## Open

Two things not yet seen, each settled only by David's screen:

1. **A preview deploy's database, lifetime and cost** — which database it
   reads, then a preview left running rather than cancelled, read against
   the Usage page.
2. **Whether the database-copy checkbox persists across publishes** — a
   republish *"reuses the existing deployment's settings"* (the connector's
   `publish_app` description), so a tick that persisted would overwrite
   production again on the next routine republish. Settled only by a
   deliberate copy, which is David's; until then the checkbox is looked at
   before every publish.

Settled on 2026-10-29 by his screenshots: production secrets, the history
list and its reach, what a preview deploy is, that connector requests run
Free regardless of the dropdown and never reach the Usage page. Left
unmeasured by decision: whether a publish includes uncommitted files
(*Publishing*).

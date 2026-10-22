<!-- SYNCED FROM AI-Handbook — do not edit in a consumer repo. Local edits are overwritten by the next sync and their reasoning is lost; change the handbook instead. -->

# The agent-legible codebase: direction, tool and contract

> **What this is.** A codebase built by agents, and soon by swarms of agents
> working without David in the loop, should be legible to an agent *by
> construction*: structure an agent can query rather than scan, invariants a
> machine enforces rather than prose describes. This document is the
> direction, the contract of the tool that serves it (`scripts/map.mjs`), and
> the rules for adopting it and backing it out. The tool ships as an
> **experiment with a pre-registered outcome**: its eval and its kill switch
> arrive with it (David, 2026-10-14), and the first consumer's eval result
> decides whether it stays on there.

## The direction, and the evidence it rests on

Every agent pays navigation cost on every task: finding the owner of a
behaviour whose name does not match its file, reading a four-thousand-line
route file for one handler, and doing the class sweep
[`working-modes.md`](working-modes.md) requires by text search. A swarm pays it
in parallel and collides on the same large files. The research gathered
before this was built (recorded in the AI-Handbook repository's research
notes) points one way:

- **Context loaded up front buys rule-following, not navigation.** Repository
  overviews in context files did not improve task success and raised cost by
  about a fifth (ETH Zurich, 2026). So the map is never loaded into context;
  it is a tool called at defined moments.
- **A structural graph helps exactly where text search fails, and only if it
  is used.** Graph navigation reached 99% on hidden-dependency tasks against
  76% for plain agents, yet 58% of runs with the tool never called it
  (CodeCompass, 2026). Hence the forcing rule below. A two-hop answer
  performed *worse* than no graph in another study (RepoGraph, 2025), so every
  answer is one hop.
- **Structure enforced by machines holds where prose rots** (OpenAI's harness
  engineering report: a million lines, no hand-written code, structure held by
  linters whose failure messages tell the agent what to do).

So: **derive structure, author only intent, enforce boundaries, answer
narrowly, and say what could not be resolved.**

## The tool

`scripts/map.mjs`, dependency-free except for the compiler it loads from the
repository it indexes.

| Command | Answers |
|---|---|
| `node scripts/map.mjs build` | Regenerates the index under `.agents/map/` (`index.json`, with provenance beside it) |
| `node scripts/map.mjs check` | Every guard: adoption, schema, coverage, freshness, headers, boundaries, sizes. What CI runs |
| `node scripts/map.mjs deps <file>` | The modules this file imports |
| `node scripts/map.mjs dependents <file>` | The modules that import or re-export this file |
| `node scripts/map.mjs dependents <file>#<name>` | Every site in other files referencing that declaration, through any alias or re-export; the file itself is read directly |
| `node scripts/map.mjs route <METHOD> <path>` | The registration and handler that own a route (`ANY`, `PAGE` for client routes) |
| `node scripts/map.mjs routes <file>` | The routes a file registers |
| `node scripts/map.mjs table <name>` | Where a table or external relation is declared and used |
| `node scripts/map.mjs purpose <file>` | The file's authored purpose, subsystem, size and sets |
| `node scripts/map.mjs subsystem <tag>` | The files carrying a subsystem tag |
| `node scripts/map.mjs unresolved [kind]` | Every site the extractor examined and could not resolve |
| `node scripts/map.mjs freeze` / `ratchet` | Writes the size baseline at adoption / lowers it later |

`--json` on any query; `--allow-stale` answers from a stale index under a
banner. Exit codes: 0, 1 (a guard failed or the tool could not run), 2 (usage),
3 (a stale index refused a query).

## The compiler

The index is built by **the repository's own TypeScript compiler**: the local
`node_modules/typescript` entry, followed through its symlink (package
managers link entries into a store; the target's location is not the test).
When the repository has no such entry the tool refuses, even though Node's
ambient lookup might find a global or shared compiler: a different compiler
version describes a different program, and an index nobody's build agrees
with is worse than none. The resolved version is recorded in the index and is
a freshness input.

## Configuration

Five consumer-owned files under `.agents/map/`, seeded once by the sync and
never overwritten by it afterwards; each is validated against the shipped
`.agents/map/config.schema.json`, and each failure names the file and the key.

| File | Holds |
|---|---|
| `.agents/map/config.json` | `adopted`, `enabled` (the back-out), the programs, the three file sets, the codegen-owned paths |
| `.agents/map/subsystems.json` | The `@subsystem` vocabulary: each tag names its governing document; `infrastructure` tags are importable by all |
| `.agents/map/architecture.json` | Allowed dependency directions, and dated, reasoned exemptions |
| `.agents/map/size-baseline.json` | The size cap and the frozen baselines |
| `.agents/map/eval-tasks.json` | The eval's question set ([the eval](agent-legible-codebase-eval.md)) |

Plus one seeded rule file, `.claude/rules/map-before-edit.md`, whose `paths:`
the repository completes at adoption.

## Programs and file sets

**Programs.** Every TypeScript program the indexed files belong to: each
product `tsconfig.json`, plus supplementary programs for what no product
configuration reaches, such as tests a configuration excludes, or JavaScript
tooling. A supplementary program names `roots` (globs) and may `extends` a
configuration to inherit its paths and options; without one it defaults to
`allowJs` with bundler resolution. Product build configurations are never
changed for the map's sake.

**Three sets**, each a mechanical oracle over the files git tracks (plus
untracked, unignored ones), recorded in the index so "is this file governed,
and by which guard" is itself a query:

- **Indexed**: `sets.indexed.include` minus `exclude`. Tests, generated code
  and vendored components belong here: they contribute edges and consumers.
- **Headered**: indexed, minus `sets.headered.exclude` (tests by default),
  minus codegen-owned paths, minus `.d.ts`, minus any file carrying the
  `SYNCED FROM AI-Handbook` header (the sync owns those).
- **Sized**: headered, minus `sets.sized.exclude`.

**Reconciliation.** The build compares the indexed set with the files the
declared programs actually analysed. An indexed file no program reached is a
configuration error naming the file and the program to add, never a silent
node with no edges.

## Queries

**Every answer has three sections**: `resolved` (static, with file and line),
`unresolved` (each site with `dynamic-target`, a value computed at runtime, or
`unsupported-form`, a shape the extractor does not analyse), and `coverage`
(what was examined, and how many other unresolved sites exist with the command
that lists them). An empty `resolved` section never prints alone, and while
`unresolved` lists anything, those sites are the reader's to check by hand.

**File queries and symbol queries are different relations.** `dependents
<file>` reports module edges: who imports or re-exports the file.
`dependents <file>#<name>` reports references to the canonical declaration
from other files, through any chain of aliases and re-exports, which is the
question a barrel makes necessary (the declaring file itself is read
directly, and the eval's answer key uses the same definition): a constant declared in one file and imported from a
package's index is used by files that never import the declaring file. Every
name a file exports for the declaration (its own, a local alias, `default`, a
barrel's re-export) answers with the same users. A reverse query also lists
every computed `import()` or `require()` in the repository as unresolved,
since its target could be the file asked about.

**One hop, always.** No query walks further.

### The supported-form matrix

The tool's contract with every consumer. Recognition is by the **resolved type
from the repository's own dependencies**, never by variable name or product
path. A form outside the matrix is reported as `unsupported-form` at its site;
adding a form is a handbook change with a fixture, never a consumer patch.

| Area | Recognised forms |
|---|---|
| Module edges | `import`, `export … from`, `import()`, `require()`, with each program's own resolution (workspace packages through `exports`, path aliases) |
| Symbols | Every identifier resolving to a repository module's export, aliases and re-exports followed to the declaration |
| HTTP routes | Express `Router`/`Application` method registrations, composed through `use(path, router)` mounts, with the handler's declaration when it resolves; `route(path).verb()`; Express 5 named wildcards (`*name`, one or more segments; `{*name}`, optional); wouter `<Route path component>`, or `<Route path>` with a single element child as its page (method `PAGE`; other children are `unsupported-form`); in a Cloudflare Worker (a default-exported object with `fetch`, bare, wrapped in parentheses, `as` or `satisfies`, or held in a same-file `const`), a string or regular-expression literal tested against a request's `pathname` (method `ANY`) |
| Tables | Drizzle `pgTable` declarations map relation names to table symbols; a table answer joins typed references to the symbol with references in SQL text |
| SQL text | Drizzle `sql` tagged templates and `sql.raw`, Drizzle `execute`, the `query` method of a `pg` `Client` or `Pool`, including a statement bound to a same-file variable, and a same-file string constant interpolated into it; a relation is read after `FROM`, `JOIN`, `INTO`, `UPDATE`, `TRUNCATE`, `TABLE`, `REFERENCES`, and `ON` only in `CREATE INDEX … ON`; relation names outside the Drizzle set are reported as **external relations**, derived and never whitelisted |
| Candidates kept | A `query`/`execute` call carrying SQL whose receiver is unresolved or not a supported client, a route-shaped registration on an unresolved receiver, a module loaded by a computed name, a route under a mount whose prefix is computed (reported at the route, naming the mount), and any computed path or relation: each is an `unresolved` site, never dropped |

## Freshness

The index under `.agents/map/` is a deterministic function of its inputs:
sorted keys, no timestamps, no commit id. Its `inputsDigest` covers every
repository source any declared program read, every `tsconfig*.json` and
`package.json`, the lockfile as the fingerprint of dependency declarations,
the four configuration files, the compiler version and the tool version.
Provenance (the base commit, and whether inputs differed from it) lives in a
separate file the check never compares, and a rebuild on unchanged inputs
leaves it untouched. So a commit, a documentation change, a merge or a fresh
checkout never makes the index stale; changing code, a test, a generated
barrel, a package's exports, a lockfile or the compiler does. So does a
handbook change to what the tool recognises: **any change to recognition
bumps `TOOL_VERSION`** in `scripts/map.mjs`, so every consumer's committed
index goes stale at the next sync and is rebuilt, rather than answering
from what the previous recogniser found. (#211 changed two recognisers
without a bump; #212 bumped to `map.mjs/2` and covers both.)

**In CI**, `check` regenerates the index and fails when the committed bytes
differ. **While editing**, every query recomputes the digest and refuses a
stale index with exit 3 and the command that fixes it: `node scripts/map.mjs
build`. The index is never edited by hand.

**What a query's recheck covers is narrower than the build's digest.** A
query loads no compiler, so it cannot learn which files the programs would
read now. It rechecks the files the last build recorded as read, the current
indexed set, the configuration and package files, the lockfile and the
compiler version. A file a program **newly** reads that is outside the
indexed set (a declaration file excluded from indexing but included by a
`tsconfig`, say) is seen by the next `build` and by `check` in CI, not by a
query before then. Keeping every file the programs read inside the indexed
set closes that gap by configuration.

## The header convention

Each headered file opens with a comment carrying two tags, inside the existing
doc comment when the file has one, never as a second block:

```ts
/**
 * @purpose One sentence on what this file is for.
 * @subsystem <tag from .agents/map/subsystems.json>
 */
```

The check requires both and requires the tag to be in the vocabulary. It does
not judge the sentence: a wrong purpose line is worse than none, so the people
and agents writing them review them like code.

## Dependency boundaries

`.agents/map/architecture.json` declares what may depend on what, **written
from the architecture intended, never copied from the imports that exist**,
in three dimensions, all checked against the index's own graph (never a second
resolver that could disagree with the compiler):

- **Package**: `packages` by path, where `.` is the repository root and holds
  every file no more specific package claims; `allowPackages` lists, per
  package, the packages it may import.
- **Layer**: within a package, `layers` by path prefix and `allowLayers`.
- **Feature area**: the `@subsystem` tag; `allowSubsystems` lists what each
  may import, and `infrastructure` tags are importable by all. A header-exempt
  file takes its classification from the sets: a test inherits the tag of the
  file it sits beside, a codegen-owned or synced file is infrastructure. A
  missing tag on a headered file is a header failure, never a permission.

An existing violation being retired is an `exemptions` entry naming the file,
the target, the dimension, the reason and the date. An exemption that no
longer matches a violating import fails the check, so dead ones are removed.

## The size ratchet

`.agents/map/size-baseline.json` sets a `cap` on non-blank lines after the
header comment (adding a header never grows a file). `node scripts/map.mjs
freeze` records every sized file over the cap at adoption; those may only
shrink. `node scripts/map.mjs ratchet` lowers a baseline after a file
shrinks and releases one that falls within the cap; nothing ever raises one.
Growth past the allowance fails the check, and so does a baseline larger
than its file now needs (the file shrank, fell within the cap or is gone)
until `ratchet` is run, so a split file cannot regrow to its old allowance.
`freeze` refuses once `size-baseline.json` is adopted; bringing a file under
governance after that is deliberate and visible: set `"adopted": false`,
freeze, and set it back in the same reviewed change.

## The forcing rule

The research measured that an offered tool goes unused unless the workflow
demands it. The rule lives once, where every agent reads it:
[`agents-core.md`](../../.agents/core/agents-core.md), *Query the structure
before you change it*, binding only where the map is adopted and enabled. The
seeded `.claude/rules/map-before-edit.md` loads it for Claude when an indexed
file is touched. This increment forces by instruction; a mechanical gate is a
later increment.

## Adopting the tool

A repository receives the tool by sync and is **unadopted** until it says
otherwise: `check` fails, naming each file still to complete, and the forcing
rule does not apply. To adopt:

1. Complete `.agents/map/config.json`: the programs, the three sets, the
   codegen-owned paths and their owning command.
2. Write `.agents/map/subsystems.json` from the repository's subsystem
   documents, and `.agents/map/architecture.json` from its intended
   architecture.
3. Replace the placeholder `paths:` in `.claude/rules/map-before-edit.md` with
   the indexed set's globs.
4. Run `node scripts/map.mjs build`. A coverage error names files no program
   reaches; add a program or exclude them.
5. Add the headers. Run `node scripts/map.mjs freeze`.
6. Set `"adopted": true` in the four configuration files; add `node
   scripts/map.mjs check` to the always-on CI job, where a change to agent
   configuration cannot skip it.
7. Run [the eval](agent-legible-codebase-eval.md); its result sets `enabled`.

The adoption steps for the handbook's consumers are also in the handbook's
consuming-repos guide.

## Backing out

Three levels, cheapest first. None touches data or runtime; each is a
corrective commit.

1. **Disable**: set `"enabled": false` in `.agents/map/config.json`. `check`
   prints `map disabled by .agents/map/config.json` and passes, every guard
   stands down, the forcing rule no longer applies, and queries still answer
   from any index present under a `DISABLED` banner. One line, one repository,
   no sync.
2. **Un-adopt**: remove the CI step, `.agents/map/` and the rules file.
   Headers are inert comments and may stay.
3. **Remove from the fleet, in this order**: every consumer first removes its
   CI invocation, its configuration and its rules file (the sync has no
   authority over consumer-owned files); then the handbook deletes the payload
   files, and the next sync takes back every synced copy by its header; then
   the forcing rule's paragraph goes. Done out of order, an always-on check
   would call a script the sync had already removed.

## The eval

The hypothesis, the protocol, the answer keys' independence and the
pre-registered thresholds are in
[`agent-legible-codebase-eval.md`](agent-legible-codebase-eval.md). In short:
**keep** if hidden-dependency recall improves by at least 20 points with median
tokens up by at most 10%; **disable** if it improves by fewer than 10 points
or tokens rise more than 25%; anything between is the agent's call on its
recommendation, reported with the numbers (David, 2026-10-21).

## What it does not do

It indexes TypeScript and JavaScript only. It does not split large files,
choose a repository's architecture, or judge a purpose sentence. It does not
enforce the query mechanically yet. It answers one hop, by design.

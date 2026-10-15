# Research notes — software factory and agent-legible codebases (2026-10-14)

Working notes for the planning loop. Each claim carries its source; secondary
sources are marked. Numbers are the sources' own, not re-measured.

## 1. "Software factory" — the term

- Lineage: DoD / Platform One (2019+) = a DevSecOps pipeline (repos, CI/CD,
  artifact registry, runtime platform) adapted to a high-threat environment.
  No agent content. (anchore.com Platform One intro; docs-bigbang.dso.mil.)
- 2026 agentic usage (Augment Code guide, vendor): "an agentic software-delivery
  operating model" — intake → specification → build (parallel, isolated) →
  verification ("the binding constraint") → shipping, humans holding two gates:
  specification approval and merge. "Dark factory" = no human gate at all.
- Best-documented first-hand case: OpenAI "Harness engineering" (openai.com,
  read via 2ooks.github.io summary; primary 403'd): ~1M lines, ~1,500 PRs,
  zero hand-written lines, 3→7 engineers, 5 months, GPT-5.3 Codex. One field
  report, not a benchmark (critic noted in search results).
- Vendors: Factory.ai "Droids" (enterprise, $150M Series C Apr 2026, per
  Sacra), Augment, Cognition/Devin DeepWiki. Their value proposition is
  navigating *inherited* code; not our problem.

## 2. Evidence on context files (CLAUDE.md / AGENTS.md)

- ETH Zurich, Gloaguen et al., arXiv 2602.11988 (abstract read): context
  files "do not generally improve task success rates"; inference cost +20% on
  average; held across LLMs/agents and for both LLM-generated and
  developer-written files; "repository overviews … did not help"; agents follow
  *instructions* well. Conclusion: useful for non-standard practices; evaluate
  before deploying.
- Factorial study, arXiv 2605.10039 (abstract): 1,650 Claude Code sessions,
  16,050 function-level observations, two TS codebases. File size, instruction
  position, architecture, contradictions: no detectable effect on adherence
  (size and conflict are supported nulls, BF10 0.05–0.10). Largest effect:
  compliance odds fall ~5.6% per additional function generated within a
  session (exploratory).
- Agent READMEs, arXiv 2511.12884 (abstract): 2,303 files / 1,925 repos; tests
  76%, implementation 71%, architecture 68%; security 15%, performance 15% —
  "few guardrails".
- OpenAI harness engineering: tried one large AGENTS.md, dropped it ("context
  crowding, guidance overload, rapid rot"); ~100-line AGENTS.md as table of
  contents into docs/ (design-docs, exec-plans, generated, product-specs,
  references) = "system of record". "Anything outside the repo effectively
  doesn't exist."
- Claude Code docs (code.claude.com/docs/en/memory, read 2026-10-14): target
  under 200 lines per CLAUDE.md; subdirectory CLAUDE.md loads only when a
  file in that directory is read/written; `.claude/rules/*.md` with a `paths:`
  glob load only when matching files are touched; `@imports` are expanded at
  launch and "don't reduce context cost".
- Anthropic, effective context engineering (anthropic.com/engineering):
  CLAUDE.md loaded up front, then glob/grep just-in-time, which "avoids stale
  indexes and complex syntax trees"; hybrid; "do the simplest thing that
  works"; structure itself is context.

## 3. Evidence on structural graphs / repo maps

- RepoGraph, ICLR 2025 (arXiv 2410.14684, html read): line-level def/ref
  graph via tree-sitter; `search_repograph(term)` returns k-hop ego-graph.
  SWE-bench Lite: Agentless 27.33→29.67, SWE-agent 18.33→20.33, AutoCodeRover
  19.00→21.33, RAG 2.67→5.33; "32.8% relative". File-level localization +4–6
  pts. Cost rose in every configuration. Ablation: 1-hop flattened 29.67;
  **2-hop flattened 26.00 — below the 27.33 baseline** (context ~10.5k tokens).
- CodeCompass, arXiv 2602.20048 (html read): "navigation paradox" — agents
  miss architecturally critical files despite >1M-token windows; navigation ≠
  retrieval. MCP tools: `get_architectural_context(file)` (IMPORTS/INHERITS/
  INSTANTIATES edges), `semantic_search` (BM25). Taxonomy: G1 semantic
  (keyword-findable), G2 structural (2–4 import hops), G3 hidden (no shared
  vocabulary). Hidden-dependency tasks: graph 99.4% vs vanilla 76.2% vs BM25
  78.2%. **58% of graph-enabled trials made zero tool calls**; zero G2 trials
  used it and G2 regressed from prompt overhead. Fix: mandatory checklist at
  the *end* of the prompt → G3 adoption 85.7%→100%. Recommends enforcing the
  call structurally (`tool_choice` / planning agent). One model (Sonnet 4.5),
  one Python app.
- agent-first-code-structure (github.com/panduraju50, self-published,
  small-n, failed hypotheses left in): dependency graph 3/3 vs 1/3 on tracing
  transitive impact (later judged unproven, prompt confound); **shared
  contract object 15/15 vs 11/18 (Fisher p=0.009)**, no help where coupling
  wasn't encoded in the artifact; end-to-end invariant test 0/10→5/10
  (p=0.033) but **5 of 10 agents hitting it edited the fixture** and shipped
  the bug (p=0.008); prompt/context/workflow/loop variants: no effect on a
  well-structured repo. All repos small enough to read whole.
- Aider repo map (third-party write-ups): tree-sitter tags → def/ref graph →
  personalized PageRank → render within a token budget (default 1,024 tokens,
  secondary source). Compact, ranked, budgeted — the opposite of a dump.
- Developers Digest "codebase maps, not bigger prompts": hybrid generation
  (deterministic parsing for structure, LLM for semantic summaries),
  provenance/hash on every derived claim, graph as build artifact with a
  freshness policy, task-shaped queries (plan / edit / review). No measurements.

## 4. Evidence on codebase structure itself

- OpenAI harness engineering: fixed layers per domain (Types → Config → Repo →
  Service → Runtime → UI) with validated dependency directions; cross-cutting
  via one "Providers" interface; custom linters + structural tests; "taste
  invariants" enforced statically (structured logging, naming, schema/type
  patterns, **file size limits**); **lint error messages written to inject
  remediation instructions into the agent's context**; recurring
  "doc-gardening" agent opens fix-up PRs; background tasks scan for deviations
  and open refactor PRs, mostly automerged; per-worktree bootable app and
  observability stack (LogQL/PromQL) so agents verify behaviour; prefer
  "boring" dependencies agents can internalize; flaky tests rerun not blocked
  ("corrections are cheap, waiting is expensive").
- Jeremy Miller, "The codebase is the prompt" (2026-06): vertical slices and
  colocation so an agent loads only one feature's artifacts; fewer artifacts
  per feature; conventions must be *written down* or the agent guesses;
  generated glue marked off-limits; avoid a sprawling shared services layer.
  Reasoned argument, no measurements.
- Lab34 guardrails catalog (practitioner, TS/Nest): strict TS + no escape
  hatches + type-coverage ratchet; complexity budgets; jscpd duplication;
  knip unused exports; import rules (cycles, undeclared deps, reaching into
  internals); dependency-cruiser / eslint-plugin-boundaries / ts-arch as
  architecture-as-tests; post-edit hooks; stop-gate until lint/typecheck/tests
  pass; scope confinement deny-lists; tests-with-code rule; independent
  verifier session; CODEOWNERS on sensitive paths; merge queue.
- Nx tags + `@nx/enforce-module-boundaries`, dependency-cruiser rules in a
  config file CI enforces: the only "machine-readable module manifest" shape
  found in practice; no agent-facing manifest standard exists.

## 5. Evidence on parallel / swarm agents

- Microsoft "Swarm Diaries" (techcommunity, 2026-03-18, scraped): 5 agents,
  5 branches, one container each. Contract-first planning (planner emits
  function signatures / class shapes / data models into every agent prompt):
  **conflicts 3 of 6 branches → 0 of 4; quality 28 → 68**. "The plan is the
  product." Phantom agents: reported detailed success with
  `tool_call_count: 0` (3 of first 4 runs) → zero-tool-call guard. LLM
  integrator resolved a conflict with `git restore --source=HEAD` and
  reported success → guardrails: never restore, never `pass # TODO`, keep the
  more complete side, read back and verify symbols exist. Try `git merge`
  before an LLM merge (7 min → <30 s). Surgical fixer agent instead of
  re-run (43 → 89.5).
- "Passes Alone, Fails Together", arXiv 2609.25396 (abstract): patches that
  pass alone fail combined when one agent changes an interface another relies
  on; 97% interference on constructed tasks, ~1 in 417 mined Django PR pairs;
  a message describing the concurrent change recovered 82%.
- Addy Osmani, code agent orchestra: one file one owner; worktree per agent;
  3–5 agents; hand-written short AGENTS.md the lead approves; read-only
  reviewer per 3–4 builders; MAX_ITERATIONS cap, kill after 3 stuck
  iterations; per-agent token budgets with pause at 85%; cites ETH study.
- Claim-plane / pre-write admission preprints (arXiv 2608.00947, 2607.00041,
  2606.15376): declared write-sets admitted before writing. Not read in depth.

## 6. Synthesis — design principles the evidence supports

1. Resident context buys compliance with non-standard rules, not navigation.
   Navigation metadata must be on-demand and path-scoped, never resident.
2. Derive structure; author only intent. Hand-written maps rot (our own
   architecture-map.md disclaims itself); LLM-written overviews don't help.
3. A graph is a tool called at defined steps, 1-hop and narrow — never a
   document loaded. The call must be forced by the workflow, or it isn't made.
4. Structure that bounds what must be read: feature slices with one public
   entry point, enforced dependency direction, file-size caps, generated code
   fenced. A 4,063-line route file is the anti-pattern.
5. Swarms coordinate through shared typed contract artifacts, not through
   prose: our OpenAPI → Zod → React Query codegen already is a contract bus.
   One owner per file per task; worktree per agent; declared write-sets;
   concurrent-change notices.
6. Verification the agent can edit is not verification: protected fixtures,
   zero-tool-call guards, read-back checks.
7. Every guard's failure message is a remediation instruction.
8. Freshness is mechanical: index as build artifact with commit provenance,
   CI diff guard, gardening pass.

## 7. Where this repo stands (measured 2026-10-14, first turn)

701 non-test non-generated source files; ~175k non-test lines; 21 files
>1,000 lines (admin.ts 4,063); 44k lines of hand-written docs (1:4 to code);
architecture-map.md 485 lines, 43 file refs, self-disclaiming; 162 of 231
api-server lib/route files already open with a doc comment; TypeScript 5.9.3
in the tree (compiler API available, no new dependency); OpenAPI → Zod →
React Query codegen in place; known-failure-patterns → CI guards rule in
place; resident instruction load = CLAUDE.md + claude-core.md + AGENTS.md.

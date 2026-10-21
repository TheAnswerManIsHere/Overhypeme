<!-- SYNCED FROM AI-Handbook — do not edit in a consumer repo. Local edits are overwritten by the next sync and their reasoning is lost; change the handbook instead. -->
# Token pricing — the published list prices the spend line uses

**What this is.** The per-million-token list prices that every spend line
(`claude-core.md`, *A reversible choice proceeds, and every turn reports its
spend*, item 2) converts tokens with. They are read from the vendors'
published pricing pages, quoted here with the date they were read, and
**refreshed at the handbook's `/maintenance` pass** (the `maintenance` skill,
step 6b) — the one source; a consumer's copy is vendored and read-only, and
a consumer's pass reports its dates rather than editing it.
A spend line cites a rate from this table; `unable to verify` is for a model
this table does not carry, never for a rate it does (David, 2026-10-11:
*"Why do you keep saying you can't verify the list price for tokens? They're
published!"*).

## Anthropic — Claude API list prices

Read 2026-10-12 from
<https://platform.claude.com/docs/en/about-claude/pricing> (the `.md` form of
the page). Standard tier; USD per million tokens. Rows quoted as the page
printed them, whitespace collapsed and the cache-read column's footnote
markers dropped (the footnotes state the multiplier the figure already
applies):

```
| Claude Fable 5.1 | $10 / MTok | $12.50 / MTok | $20 / MTok | $0.25 / MTok | $50 / MTok |
| Claude Opus 5.5 | $4 / MTok | $5 / MTok | $8 / MTok | $0.20 / MTok | $20 / MTok |
| Claude Sonnet 5.5 | $2 / MTok | $2.50 / MTok | $4 / MTok | $0.10 / MTok | $10 / MTok |
| Claude Haiku 5.5 (for prompts up to 100,000 tokens) | $0.10 / MTok | $0.125 / MTok | $0.20 / MTok | $0.01 / MTok | $0.50 / MTok |
| Claude Haiku 5.5 (for prompts over 100,000 tokens) | $0.50 / MTok | $0.625 / MTok | $1 / MTok | $0.05 / MTok | $2.50 / MTok |
```

Columns, in the page's order: base input, 5-minute cache write, 1-hour cache
write, cache read, output.

| Model | Input | Cache write 5m | Cache write 1h | Cache read | Output |
|---|---|---|---|---|---|
| Claude Fable 5.1 (`claude-fable-5-1`) | $10 | $12.50 | $20 | $0.25 | $50 |
| Claude Opus 5.5 (`claude-opus-5-5`) | $4 | $5 | $8 | $0.20 | $20 |
| Claude Sonnet 5.5 (`claude-sonnet-5-5`) | $2 | $2.50 | $4 | $0.10 | $10 |
| Claude Haiku 5.5 (`claude-haiku-5-5`), prompt ≤ 100K | $0.10 | $0.125 | $0.20 | $0.01 | $0.50 |
| Claude Haiku 5.5, prompt > 100K | $0.50 | $0.625 | $1 | $0.05 | $2.50 |

## OpenAI — the Codex reviewer (Astra)

Read 2026-10-12 from <https://developers.openai.com/api/docs/pricing>
(`openai.com/api/pricing` answered 403 to this container's fetch). Standard
tier, prompts up to 272K tokens; USD per million tokens. Row quoted as the
page printed it: input, cached input, cache write, output, then the four
long-context columns:

```
| gpt-6-astra | $10.00 | $1.00 | $12.50 | $50.00 | $20.00 | $2.00 | $25.00 | $75.00 |
```

| Model | Input | Cached input | Cache write | Output |
|---|---|---|---|---|
| `gpt-6-astra` (the `strongestCodex` pin), prompt ≤ 272K | $10 | $1 | $12.50 | $50 |
| `gpt-6-astra`, prompt > 272K (the long-context columns) | $20 | $2 | $25 | $75 |

### Pricing an Astra run — per bucket, never by the proxy

An Astra run is the one dispatch with a real reading: `review-proxy.mjs` and
`plan-review.mjs` run `codex exec --json` and print the `turn.completed`
event's five usage buckets (`usage in … (cached …, cache-write …) out …
(reasoning …)`; measured on codex-cli 0.160.0, 2026-10-11). So an Astra
figure is priced **per bucket, not by the blended proxy below**:
`(input − cached − cache-write) × input rate + cached × cached rate +
cache-write × cache-write rate + output × output rate`.

Three readings behind that formula, each settled rather than assumed:

- **Cached and cache-write sit inside `input_tokens`** — OpenAI's Responses
  API describes `input_tokens_details` as "A detailed breakdown of the input
  tokens", its `cached_tokens` as "The number of tokens that were retrieved
  from the cache" and its `cache_write_tokens` as "The number of input tokens
  that were written to the cache" (read 2026-10-12), and both probes read
  cached below input (12,288 of 17,967 and 28,160 of 32,193); cache-write read
  0 in both, so its nesting rests on the schema. Both are subtracted before
  the base rate applies.
- **Reasoning sits inside `output_tokens`** and is never added again. OpenAI's
  Responses API describes `output_tokens_details` as "A detailed breakdown of
  the output tokens", and its example totals input plus output alone (328 +
  52 = 380 with `reasoning_tokens: 0`); the CLI copies both counters straight
  from the turn total. So `reasoning_output_tokens` is diagnostic, not a
  bucket (Codex, AI-Handbook #199 round 2).
- **The usage is the turn's cumulative total, but the 272K threshold is per
  request** — "Prompts with more than 272K input tokens are priced at 2x input
  and cache rates and 1.5x output for the full request" (the `gpt-6-astra`
  model page, read 2026-10-12), and the CLI's `turn.completed` is built from
  the turn's running `total`. A turn of several tool-using requests can sum
  past 272K with every request short. So: **`input_tokens` at or under
  272,000 is priced exactly from the short row** — no single request can
  exceed the turn's total. **Above it, the figure is an upper bound priced
  from the long-context row, and the spend line says so** (`≤ $X, long-context
  row as ceiling`), since which requests crossed is not in the reading. That
  overstates and never understates, the side the Haiku rule below takes for
  the same reason (Codex, AI-Handbook #199 round 2).

A run whose log says `usage not reported` is `unable to verify` in the
spend line, as the rule at the top says. That covers a usage object lacking
any of the five buckets, the CLI's all-zero default for a turn that reported
no usage at all, and a stream in which the CLI rerouted the run to another
model — whose counts would be priced at the wrong rates (AI-Handbook #197
items 4 and 5). (This replaces the single $15/M Astra proxy row and
answers Overhype.me #639 `4243652049` and DojoOS #8 `4243765922`.)

## How a spend line converts tokens — the blended proxy

The harness reports one number per turn, the `<total_tokens>` count
differenced, and a task notification reports one usage figure per Claude
subagent (an Astra run is the exception, priced per bucket above).
Neither splits input from output or cache reads from fresh input, so no
spend line can price each bucket at its own rate. **The proxy is a
judgement, named as one**: price every harness-counted token at the model's
base input rate plus half again, which stands in for the output share and the
cache-write premium in an agent turn (an input-heavy mix — roughly nine
tokens read for one written, with reads mostly cached, lands near that
figure under the table above; nothing measures the true mix, so this is the
assumption the line rests on, not a reading).

| Role | Model | Proxy rate per million tokens |
|---|---|---|
| Main loop on Fable, Fable assessor, build report | Claude Fable 5.1 | $15 |
| Main loop on Opus, a build session | Claude Opus 5.5 | $6 |
| Sonnet subagents (sweep readers, investigations) | Claude Sonnet 5.5 | $3 |
| Haiku subagents, dispatch reported at 100,000 tokens or fewer | Claude Haiku 5.5 | $0.15 |
| Haiku subagents, dispatch reported above 100,000 tokens | Claude Haiku 5.5 | $0.75 |
| Astra (Codex CLI) | `gpt-6-astra` | none — priced per bucket from its reported usage (above) |

Haiku has two list tiers, by prompt length, and the harness reports one
total per dispatch with no prompt/output split — so the total is the
stand-in: a Haiku dispatch whose reported usage exceeds 100,000 tokens is
priced at the long-context row for all of its tokens. That overstates a
dispatch that crossed the line late and never understates one, which is the
side to err on for a figure a cap is set from (Codex, Overhype.me #639).

A spend line names the rate it used (`proxy $15/M Fable`) so the reader can
re-derive the figure when this table moves. The proxy rule above changes only
by a decision recorded here; the rates change at every refresh.

## Refreshing this table

At **AI-Handbook's** `/maintenance`, step 6b — and only there, since this
file is payload and a consumer's copy is overwritten by the next sync: fetch
both pricing pages, re-quote the rows for every model this table names and
for any new model the handbook's own `.agents/machinery.json` pins, update
the two tables and each section's read date, and recompute the proxy column
from the rule above. A consumer that pins a model this table does not carry
gets its row by a pull request to the handbook, never by a local edit — a
consumer's pins are its own, so the handbook's pass cannot see them, and
until the row lands every spend line there reads `unable to verify`, which
is the signal to open that pull request. A consumer's `/maintenance` reads
this table and reports each section's read date and how old it is; it never
edits it, and it does not judge the copy stale against the handbook's pass,
whose date it has no way to read — a newer table reaches a consumer only by
the next sync from the handbook. A page that cannot be fetched leaves its
section as is with the old date, and the maintenance report says so — a
stale rate with its date is a reading; a guessed one is not.

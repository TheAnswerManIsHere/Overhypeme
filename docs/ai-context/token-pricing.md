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

Read 2026-10-11 from
<https://platform.claude.com/docs/en/about-claude/pricing> (the `.md` form of
the page). Standard tier; USD per million tokens. Rows quoted as the page
printed them, whitespace collapsed:

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

Read 2026-10-11 from <https://developers.openai.com/api/docs/pricing>
(`openai.com/api/pricing` answered 403 to this container's fetch). Standard
tier, prompts up to 272K tokens; USD per million tokens. Row quoted as the
page printed it: input, cached input, cache write, output, then the four
long-context columns:

```
| gpt-6-astra | $10.00 | $1.00 | $12.50 | $50.00 | $20.00 | $2.00 | $25.00 | $75.00 |
```

| Model | Input | Cached input | Output |
|---|---|---|---|
| `gpt-6-astra` (the `strongestCodex` pin) | $10 | $1 | $50 |

## How a spend line converts tokens — the blended proxy

The harness reports one number per turn, the `<total_tokens>` count
differenced, and a task notification reports one usage figure per subagent.
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
| Main loop on Fable, Fable assessor, round translator | Claude Fable 5.1 | $15 |
| Main loop on Opus, a build session | Claude Opus 5.5 | $6 |
| Sonnet subagents (sweep readers, investigations) | Claude Sonnet 5.5 | $3 |
| Haiku subagents, dispatch reported at 100,000 tokens or fewer | Claude Haiku 5.5 | $0.15 |
| Haiku subagents, dispatch reported above 100,000 tokens | Claude Haiku 5.5 | $0.75 |
| Astra (Codex CLI) | `gpt-6-astra` | $15 |

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

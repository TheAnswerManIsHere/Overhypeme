---
name: domain-modeling
description: Build and sharpen Overhype.me's domain model. Use when discussing product terminology, writing or editing the glossary, or when a design conversation settles a decision worth recording.
---

# Domain Modeling

Actively build and sharpen the project's domain model as you design. This is the *active* discipline: challenging terms, inventing edge-case scenarios, and writing the glossary and decisions down the moment they crystallise. (Merely *reading* the glossary for vocabulary is not this skill: that's a one-line habit any skill can do. This skill is for when you're changing the model, not just consuming it.)

## Where things live (Overhype.me)

Upstream's layout (`CONTEXT.md` + `docs/adr/`) is replaced wholesale: this repo already has canonical homes for both outputs, and creating a second docs system is exactly the drift the single-source-of-truth rule exists to prevent.

| What resolved | Where it lands |
| --- | --- |
| A term of art | [`docs/ai-context/glossary.md`](../../../docs/ai-context/glossary.md) — follow the file's own header rules: every term is a `###` heading with a stable anchor, grouped under its section, with a pointer to the deep doc; when a term's meaning changes, fix the glossary **and** the deep doc in the same edit |
| A settled decision (all three gates below) | [`docs/ai-context/decisions.md`](../../../docs/ai-context/decisions.md) — follow its format: **date · title** — Decision / Why / Reference / Revisit if; newest first, append-only |
| Everything else you discussed | The conversation — and if it must survive the session, the workstream issue's State of Play or the plan document, per the normal ceremony |

**Never create `CONTEXT.md`, `CONTEXT-MAP.md`, or `docs/adr/`.** Those are the upstream skill's homes, not ours.

## During the session

### Challenge against the glossary

When David uses a term that conflicts with the existing language in the glossary, call it out immediately. "The glossary defines 'preview' as X, but you seem to mean Y. Which is it?"

### Sharpen fuzzy language

When a vague or overloaded term shows up, propose a precise canonical term. "You're saying 'account': do you mean the member or the visitor? Those are different things here."

### Discuss concrete scenarios

When domain relationships are being discussed, stress-test them with specific scenarios. Invent scenarios that probe edge cases and force precision about the boundaries between concepts.

### Cross-reference with code

When David states how something works, check whether the code agrees. If you find a contradiction, surface it: "The code cancels entire orders, but you just said partial cancellation is possible. Which is right?"

### Update the glossary inline

When a term is resolved, update the glossary right there. Don't batch these up: capture them as they happen. Keep definitions tight — one or two sentences, what the term IS, not what it does — and only terms specific to this product's context; general programming concepts don't belong even when the project uses them heavily.

### Offer decision-log entries proactively — but the log's own bar is the only eligibility rule

The decision log's canonical bar is its own, set in [`decisions.md`](../../../docs/ai-context/decisions.md)'s header and the shared docs: it records decisions **David has actually settled**, and it binds every agent the same way. This skill adds a *prompting heuristic on top*, never a filter underneath: proactively **offer** to record a decision when all three are true —

1. **Hard to reverse**: the cost of changing your mind later is meaningful
2. **Surprising without context**: a future reader will wonder "why did they do it this way?"
3. **The result of a real trade-off**: there were genuine alternatives and one was picked for specific reasons

When one is missing I don't volunteer an entry — but the gates never veto: anything David wants recorded, or that the shared contracts (the `/document` harvest bar, "remember this") route to the log, gets recorded regardless. A settled decision another agent would record under the shared rules never goes unrecorded because of this skill.

Glossary and decision-log edits ship like any other docs change — committed on the current branch and its PR, never as a side channel.

## Source

Adapted from [mattpocock/skills](https://github.com/mattpocock/skills) (MIT): the session behaviors and the three-gate decision test are upstream's; the file targets and the David-settles-it bar are ours. The interview mechanics this pairs with live in the `grilling` skill.

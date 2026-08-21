---
name: prototype
description: Build a throwaway prototype to answer a design question. Use when David wants to sanity-check whether a state model or logic feels right, or explore what a UI should look like.
---

# Prototype

A prototype is **throwaway code that answers a question**. The question decides the shape.

## Pick a branch

Identify which question is being answered, using the user's prompt, the surrounding code, or by asking if the user is around:

- **"Does this logic / state model feel right?"** → [LOGIC.md](LOGIC.md). Build a single shareable HTML file (free-play buttons plus tabbed guided walkthroughs) that pushes the state machine through cases that are hard to reason about on paper, and that a non-developer can drive.
- **"What should this look like?"** → [UI.md](UI.md). Generate several radically different UI variations on a single route, switchable via a URL search param and a floating bottom bar.

The two branches produce very different artifacts, so getting this wrong wastes the whole prototype. If the question is genuinely ambiguous and the user isn't reachable, default to whichever branch better matches the surrounding code (a backend module → logic; a page or component → UI) and state the assumption at the top of the prototype.

## Rules that apply to both

1. **Throwaway from day one, and clearly marked as such.** Locate the prototype code close to where it will actually be used (next to the module or page it's prototyping for) so context is obvious, but name it so a casual reader can see it's a prototype, not production. For throwaway UI routes, obey whatever routing convention the project already uses; don't invent a new top-level structure.
2. **Trivial to run.** A UI prototype starts from one command in the project's task runner: `pnpm <name>`, `python <path>`, `bun <path>`, etc. A logic demo is a single HTML file the user double-clicks. Either way, no thinking required to start it.
3. **No persistence by default.** State lives in memory. Persistence is the thing the prototype is _checking_, not something it should depend on. If the question explicitly involves a database, hit a scratch DB or a local file with a clear "PROTOTYPE, wipe me" name.
4. **Skip the polish.** No tests, no error handling beyond what makes the prototype _runnable_, no abstractions. The point is to learn something fast.
5. **Surface the state.** After every action (logic) or on every variant switch (UI), print or render the full relevant state so the user can see what changed.
6. **Capture it when done.** Fold any validated decision into the real code, then capture the prototype itself as a **primary source**: commit it to a throwaway branch, out of main, and leave a context pointer to that branch on the implementation issue. Capture the answer too (the verdict and the question it settled) in the issue or a commit. The main branch keeps only the validated decision.

## Overhype.me adaptations

Vendored from [mattpocock/skills](https://github.com/mattpocock/skills) (MIT); the body above and [LOGIC.md](LOGIC.md)/[UI.md](UI.md) are upstream verbatim. Local rules:

- **David never runs commands or opens local files** — that's the standing interaction rule, and it reshapes delivery, not the build:
  - A **logic demo** reaches him as a published **Artifact** page (or via `SendUserFile`), never as "double-click this file."
  - A **UI prototype on a route** is invisible to him: the app he tests runs from the Repl, the Repl tracks `main`, and a prototype branch never touches `main`. So variants for *David's* eyes ship as a self-contained HTML Artifact with the variant switcher built into the page. UI.md's route-based mechanics are for questions I can judge myself (via the `run` skill and screenshots) before showing him the finalists.
- **The selection is David's.** Never build variants, pick a winner myself, and present it as settled — the choice between variants is exactly the kind of product decision the working rules reserve to him.
- **Capture targets:** "the implementation issue" is our **workstream issue**. The default capture is issue-side, no branch at all: the resolution comment records the verdict and the question it settled, and links the artifact (the Artifact page for an HTML demo, or the demo file itself). Only when the prototype *code* is genuinely worth keeping as a primary source does it get a branch — `prototype/<slug>`, pushed **with a draft PR** titled `[PROTOTYPE] <name>`, marked never-merge in its body, linked from the workstream issue, and closed once the validated decision has been folded in (a closed PR keeps its commits resolvable, so the branch may then be deleted). This satisfies the "always open a PR" rule as written — no new branch exception exists, and this skill must not be read as creating one. (Note the rule's actual exception shapes: `plan-review/<slug>` branches *do* get PRs; only the `-combined` branch legitimately has none.) The disclosure check still runs before the first push, same as any artifact on this public repo.
- **A prototype never ships by being promoted.** Folding a validated decision into real code is normal feature/bugfix work through the normal pipeline — branch, PR, Codex review, merge. Prototype code is exempt from tests and the pre-PR quality pass because it never merges and never becomes an implementation PR — the draft `[PROTOTYPE]` PR in the capture rule above is an archive surface for a never-merged artifact, not a review request.
- **Genuine branch ambiguity stops for David.** Upstream's fallback above — "if the question is genuinely ambiguous and the user isn't reachable, default to whichever branch better matches the surrounding code and state the assumption" — does not apply here: the same paragraph says getting the branch wrong wastes the whole prototype, and the standing rule is pause-and-ask on genuine ambiguity. A blocking ask (with its push notification) is cheaper than the wrong artifact; only a question the surrounding code answers *unambiguously* proceeds without him.
- **In-product UI variants still speak the brand** — consult the `overhype-design` skill for tokens — unless breaking the brand is the question being tested.

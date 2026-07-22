# PR223 — Render identity/style reproducibility · UAT (click-through)

What this PR changes, in product terms: when you click **generate**, the image
engine now gets a **frozen** copy of *who* the render is about and *which style*
it uses — captured at the moment you click, not re-looked-up minutes later while
the render sits in the queue. So editing your profile name or a style **after**
you click can no longer quietly change the render that's already in flight. As
part of the same change, the name we feed the image model is shortened to a
**first name** (a ridiculous 40-character display name no longer gets stuffed
into the image prompt) — your **caption still shows your full name**, untouched.

Most of this is invisible correctness: a normal render looks the same. The two
things you *can* see are (1) the shortened name inside the image prompt and
(2) a clean error if you pick a disabled style. The rest is a smoke test that
nothing regressed on either generate path.

## Where to go

1. A **legendary** account (AI meme generation is legendary-gated).
2. A fact you can generate a meme for — both with a **reference photo upload**
   and **without** one (the two paths this PR touched).
3. (For the style check) Admin access to toggle a **look-style** active/inactive.

## The happy path

- **Generate with a reference photo.** Upload a reference, generate. The render
  completes as before and the image looks right for your subject. Nothing about
  the visible result should feel different from `main`.
- **Generate without a reference.** Same fact, no upload → the text-to-image
  path. It completes as before.
- **Your caption keeps your full name.** On the finished meme, the **caption**
  still reads your full display name exactly as stored. (The shortening applies
  only to the prompt the image model reads, not to anything you see on the meme.)

## What you can actually see change

- **First-name in the image prompt.** If your profile display name is long or
  multi-word (e.g. set it to "David Franklin The Third"), the render still works
  and the **caption** shows the full name — but the identity handed to the image
  engine is just the first name ("David"). You won't usually see this on the
  image itself (images rarely spell your name); it's the mechanism that keeps a
  giant name from crowding the prompt.
- **Disabled style → a clean error, not a silent plain render.** If you (as
  admin) disable a look-style and then try to generate a meme selecting that
  style, you get a clear "style unavailable" rejection instead of the old
  behavior where it quietly rendered with **no** style at all. Re-enable the
  style and the same generate succeeds.

## The reproducibility guarantee (why this PR exists)

This is a timing guarantee, so it's more "understand it" than "click it": once
you press generate, the render is pinned to the name/pronouns/style as they were
**at that instant**. If you race to your profile and rename yourself, or an admin
deactivates the chosen style, while the render is still queued — the in-flight
render is unaffected. Your **next** render picks up the new values. (Before this
PR, an edit in that window could produce a render whose text and whose identity
disagreed.)

## Regression smoke table

| Action | Expect |
| --- | --- |
| Generate **with** reference upload | Completes, image correct, caption = full name |
| Generate **without** reference (t2i) | Completes, caption = full name |
| Generate with a **valid** selected style | Style applied as before |
| Generate with a **disabled** style | Clean "style unavailable" rejection; not enqueued |
| Anonymous / no-profile render | Falls back to the canonical test identity, still renders |
| Existing older renders / re-poll | Still display correctly (legacy attempts untouched) |

## What should NOT happen

- Your meme **caption** should **not** be shortened — full display name stays.
- A normal render with a valid (or no) style should **not** error or look
  different from before.
- A disabled/deleted style should **not** silently render as a plain
  no-style image — it should tell you the style is unavailable.
- Editing your profile after clicking generate should **not** change the image
  that was already rendering.

## Known non-bugs (out of scope for this PR)

- **Moderation preview / eval renders still show the full sample name.** The
  admin Runtime Compiled Prompt preview and the moderation/eval render paths use
  fixed **sample** subjects ("David Franklin" and gender variants) and are
  intentionally left as-is — they were already reproducible and their short
  fixture names don't need shortening. This is not the user-render path.
- **No new budget/length rejection at render time.** Enforcing a hard prompt
  budget is a later change; this PR only *bounds* the identity, it doesn't reject
  over-budget prompts yet.

## Bug report template

```
Path (with-reference / no-reference / style / anonymous):
Profile display name used:
Selected style (and active/inactive):
What I did:
What I expected:
What happened (screenshot of meme + caption if visual):
renderJobId / attemptId (if visible):
```

See the engineering checklist in
[`PR223_RENDER_REPRODUCIBILITY_TEST_RUN.md`](PR223_RENDER_REPRODUCIBILITY_TEST_RUN.md)
for the automated coverage behind this.

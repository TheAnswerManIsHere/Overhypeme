# PR #472 — The Manual, inside the admin console — UAT

Your in-app acceptance test, David.

**Why this exists.** The Overhype.me Manual is already written — twelve
chapters explaining how each part of the product works and why. Until now the
only way to read it was to leave the console, find the repo on GitHub, and
navigate `docs/manual/`. This puts it at `/admin/help`: readable, searchable,
and reachable from a `?` on whatever screen raised the question.

**Nothing about the Manual itself changed.** The files in `docs/manual/` are
byte-for-byte what they were; this only reads them. If a chapter says something
wrong, that was already true — it isn't a bug in this PR.

**The one decision you made:** the Manual's own front page (the charter, with
the chapter list) *renders* in-app, but is **not searchable**. Section 4 checks
that deliberately, so the absence reads as your decision rather than a gap.

## Before you start

- No feature flag. Live everywhere once merged and synced.
- **Admin account.** The whole surface is behind the normal admin rail; there
  is no new permission of any kind.
- Nothing to set up, nothing to put back afterwards. This feature reads static
  content and writes nothing — no database, no API, no config.
- **Section 2 asks you to open a link in a fresh tab, and that detail matters.**
  Clicking through from inside the app and cold-loading a URL take genuinely
  different code paths, and the cold one is the path that used to break.

## The main event

### 1. The Manual is there and it looks like a document

Open **Admin → Help** in the sidebar.

**Expect:** the Manual's front page, with a real **table** listing chapters 1–12
(proper bordered rows and columns — *not* a run of `|` pipe characters), a
search box, and a chapter list down the left on a wide screen.

Click into **Chapter 3 · Moderation**.

**Expect:** the chapter renders as a readable document — headings, bullet lists,
bold text, the occasional table or quoted block. It should read like a page,
not like a text file.

### 2. A deep link lands where it says it will

This is the one that used to silently fail, so it's worth doing exactly as
written.

Copy this and open it in a **brand-new browser tab** (not by clicking around
inside the app):

```
/admin/help/11-admin-console#managing-people
```

**Expect:** the page opens *scrolled to* the "Managing people" heading. Not the
top of the chapter with the heading somewhere below the fold — actually parked
on it.

Now, from inside the app, click any chapter in the left-hand list, then click a
link *within* that chapter that points to another chapter.

**Expect:** it navigates inside the console, and if the link pointed at a
specific section, it lands on that section.

### 3. Search finds things, and the results tell you where they are

In the search box, type **`visual concept`**.

**Expect:** a list of results. Each one names a **section** and the **chapter**
it belongs to. Click one.

**Expect:** you land on that section of that chapter — not the top of the
chapter, and not a different one.

Try **`moderation`** and **`stale`** too, to get a feel for it.

### 4. Two things that should find NOTHING

These are the deliberate absences. Both should come back empty.

Search **`ai-context/glossary.md`**.

**Expect:** no results. That text exists only *inside links* — it's a file path
the Manual points at, not words on the page. Searching should match what you can
read, not the plumbing underneath it.

Search **`Chapter quality bar`**.

**Expect:** no results — **and this is your decision, working.** That phrase
appears on the Manual's front page, which you asked to keep out of search
("ignore the readme"). The page is still readable; it just isn't indexed. If you
now think that's the wrong call, this is the moment it'll feel wrong, and it's a
small change to reverse.

### 5. The `?` on each screen

Go to **Admin → Queue Health**. Find the **`?`** in the top bar (next to *View
Site*). Click it.

**Expect:** chapter 12, parked on *"Worker liveness and the Queue Health
surface"*.

Now try a few more — the point is whether each lands somewhere that actually
answers "what is this screen for?":

| From this screen | Should land on |
| --- | --- |
| Moderation | Ch. 3 · Moderation |
| Taxonomy Health | Ch. 4 § *For the admin (Taxonomy Health)* |
| Billing | Ch. 10 § *For the admin* |
| Email Queue | Ch. 12 § *Email, the most consequential rider* |
| Facts | Ch. 2 · Content Lifecycle |
| Dashboard | Ch. 11 · Admin Console |

**Two I already expect you to have opinions about**, flagged so you're judging
them rather than discovering them:

- **Eval** points at Chapter 5 (Visual Pipeline). No chapter actually describes
  the eval dashboard — that's a real gap in the Manual, and chapter 5 is just
  the nearest neighbour because eval scores image prompts. Writing that
  coverage is a separate documentation job, already logged.
- **Engines, Features and Configuration** all land on the same section
  (Ch. 11 § *Tuning how the product behaves*). That's genuinely what the Manual
  currently covers all three under. Accurate, if a bit blunt.

If any other row sends you somewhere unhelpful, say which — the map is a
one-line change per screen.

### 6. Links out of the Manual

Inside any chapter, find a link to something outside the Manual — most chapters
link to `glossary.md` or a spec in `docs/ai-context/`.

**Expect:** it opens **GitHub in a new tab**, and your place in the console is
undisturbed.

### 7. A stale bookmark doesn't break anything

Open:

```
/admin/help/no-such-chapter
```

**Expect:** a tidy "No such chapter" message *inside* the console, with a link
back to the Manual. Not a blank page, not a crash, not the red error screen.

## What should NOT have changed

Quick sweep — none of this is touched by this PR, but the sidebar and top bar
were both edited, so it's worth thirty seconds:

| Check | Expect |
| --- | --- |
| The admin sidebar | Same items, same order, plus **Help** at the bottom |
| Moderation's pending-count badge | Still there, still counting |
| Collapsing the sidebar | Still collapses; icons still have tooltips |
| Admin on a phone | Hamburger menu still opens the drawer |
| *View Site* / *Sign Out* | Still in the top bar, still work |
| Any other admin screen | Loads exactly as before |
| A non-admin visiting `/admin/help` | Same "Access Denied" as any admin page |

## Two things worth knowing (not bugs)

- **The Manual's front page includes some writing aimed at whoever *maintains*
  the Manual** — a chapter template, a style rule about not quoting
  configuration values. That's a bit of inside-baseball for an admin reading for
  product help. It's there because the alternative was generating an edited copy
  of that file, which would create a second, drifting version of it. Rendering
  it whole was the honest option.
- **If a chapter is renumbered later, its URL changes**, so a saved bookmark
  would go stale (and you'd get section 7's not-found page). Renumbering is a
  rare, deliberate act, so we accepted that rather than building a redirect
  table for an admin-only page.

## If something fails

Tell me what you saw and which section. A failure here is a **follow-up
bugfix**, not a reason to revert the merge — and production is untouched either
way, since publishing is a separate step we haven't started using.

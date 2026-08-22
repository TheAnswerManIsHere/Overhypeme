# PR #472 — The Manual, inside the admin console — UAT

**Workstream:** #471

The Overhype.me Manual is twelve chapters explaining how each part of the
product works. Until now the only way to read it was to leave the console and
find it on GitHub. This puts it at `/admin/help` — readable, searchable, and
reachable from a `?` on whatever screen raised the question.

Nothing about the Manual's *content* changed. If a chapter says something
wrong, that was already true and isn't a bug in this PR.

**Your decision that steps 8 and 9 check deliberately:** the Manual's front
page renders in-app but is **not searchable** ("ignore the readme"). If that
now feels wrong, step 9 is where it will feel wrong, and it's a small change
to reverse.

## Setup

- [david] Sign in as an admin. The whole surface is behind the normal admin
  rail; there is no new permission.
- [claude] Confirm the Repl is synced and the app is up before step 1.

## Steps

### 1. The Manual is there and looks like a document

**Do:** Open **Admin → Help** in the sidebar.

**Expect:** the Manual's front page, with a real **bordered table** listing
chapters 1–12 (not a run of `|` pipe characters), a search box, and a chapter
list down the left on a wide screen.

### 2. A chapter renders as prose

**Do:** From the front page, click into **Chapter 3 · Moderation**.

**Expect:** headings, bullet lists, bold text, the occasional table or quoted
block. It reads like a page, not like a text file.

### 3. A cold deep link parks on the right heading

**Do:** Open `/admin/help/11-admin-console#managing-people` in a **brand-new
browser tab** — not by clicking around inside the app. Cold-loading and
clicking through take different code paths, and the cold one is the path that
used to break.

**Expect:** the page opens *scrolled to* the "Managing people" heading —
actually parked on it, not at the chapter top with the heading below the fold.

### 4. An in-app link between chapters keeps its section

**Do:** From inside the app, click any chapter in the left-hand list, then
click a link within that chapter that points to another chapter.

**Expect:** it navigates inside the console, and if the link pointed at a
specific section, it lands on that section.

### 5. Search results name their location

**Do:** In the search box, type **`visual concept`**.

**Expect:** a list of results, each naming a **section** and the **chapter** it
belongs to.

### 6. A search result lands where it says

**Do:** Click any result from step 5.

**Expect:** you land on that section of that chapter — not the top of the
chapter, and not a different one.

### 7. Search holds up on other terms

**Do:** Search **`moderation`**, then **`stale`**.

**Expect:** results in the same shape as step 5, relevant to each term.

### 8. Plumbing inside links is not searchable

**Do:** Search **`ai-context/glossary.md`**.

**Expect:** no results. That text exists only inside links — a file path the
Manual points at, not words on the page.

### 9. The front page is not indexed — your decision

**Do:** Search **`Chapter quality bar`**.

**Expect:** no results. That phrase is on the Manual's front page, which you
asked to keep out of search. The page is still readable; it just isn't indexed.

### 10. The `?` on a screen lands somewhere that answers "what is this?"

**Do:** Go to **Admin → Queue Health** and click the **`?`** in the top bar,
next to *View Site*.

**Expect:** chapter 12, parked on *"Worker liveness and the Queue Health
surface"*.

### 11. The rest of the `?` map is sane

**Do:** Click the `?` from each of these screens in turn: Moderation, Taxonomy
Health, Billing, Email Queue, Facts, Dashboard.

**Expect:** Ch. 3 · Moderation; Ch. 4 § *For the admin (Taxonomy Health)*;
Ch. 10 § *For the admin*; Ch. 12 § *Email, the most consequential rider*;
Ch. 2 · Content Lifecycle; Ch. 11 · Admin Console. Say which row is unhelpful
if any is — it's a one-line change per screen.

### 12. A link out of the Manual opens GitHub

**Do:** Inside any chapter, find a link to something outside the Manual — most
chapters link to `glossary.md` or a spec in `docs/ai-context/` — and click it.

**Expect:** it opens **GitHub in a new tab**, and your place in the console is
undisturbed.

### 13. A stale bookmark fails tidily

**Do:** Open `/admin/help/no-such-chapter`.

**Expect:** a tidy "No such chapter" message *inside* the console, with a link
back to the Manual. Not a blank page, not a crash, not the red error screen.

## Regression

### R1. The admin sidebar is unchanged apart from Help

**Do:** Look down the admin sidebar.

**Expect:** same items in the same order, plus **Help** at the bottom.

### R2. Moderation's pending count still works

**Do:** Look at the Moderation item in the sidebar.

**Expect:** the pending-count badge is there and still counting.

### R3. The sidebar still collapses

**Do:** Collapse the sidebar, then hover an icon.

**Expect:** it collapses, and icons still have tooltips.

### R4. Admin still works on a phone

**Do:** Open the admin console on a phone and tap the hamburger menu.

**Expect:** the drawer opens as before.

### R5. View Site and Sign Out still work

**Do:** Use *View Site*, then *Sign Out*, from the top bar.

**Expect:** both are where they were and both work.

### R6. Other admin screens load unchanged

**Do:** Open two or three admin screens you use often.

**Expect:** each loads exactly as before.

### R7. A non-admin is still refused

**Do:** Visit `/admin/help` while signed out or as a non-admin.

**Expect:** the same "Access Denied" as any other admin page.

## Not bugs

- **The Manual's front page includes writing aimed at whoever maintains it**,
  not just at readers. It renders as-is; tightening that copy is a separate
  documentation job.
- **Eval's `?` points at Chapter 5 (Visual Pipeline).** No chapter describes
  the eval dashboard yet — a real gap in the Manual, already logged, with
  chapter 5 as the nearest neighbour.
- **Engines, Features and Configuration all land on the same section**
  (Ch. 11 § *Tuning how the product behaves*). That is genuinely what the
  Manual currently covers all three under.

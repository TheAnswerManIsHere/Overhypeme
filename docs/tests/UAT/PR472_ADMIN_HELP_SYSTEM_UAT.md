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

**Lane:** ci

**Check:** `artifacts/overhype-me/e2e/adminHelp.spec.ts:renders the manual front page as a document, not as markdown source`

**Deferred:** #631 — 7b — the table listing chapters 1-12 (the first table is a different one), bordered cells, chapter list left of the content — `artifacts/overhype-me/e2e/adminHelp.spec.ts`

### 2. A chapter renders as prose

**Do:** From the front page, click into **Chapter 3 · Moderation**.

**Expect:** headings, bullet lists, bold text, the occasional table or quoted
block. It reads like a page, not like a text file.

**Lane:** ci

**Check:** `artifacts/overhype-me/e2e/adminHelp.spec.ts:renders a chapter as prose with real headings and lists`

**Deferred:** #631 — 7b — bold text, bullet lists and a table or quoted block rendering inside a chapter — `artifacts/overhype-me/e2e/adminHelp.spec.ts`

### 3. A cold deep link parks on the right heading

**Do:** Open `/admin/help/11-admin-console#managing-people` in a **brand-new
browser tab** — not by clicking around inside the app. Cold-loading and
clicking through take different code paths, and the cold one is the path that
used to break.

**Expect:** the page opens *scrolled to* the "Managing people" heading —
actually parked on it, not at the chapter top with the heading below the fold.

**Lane:** ci

**Check:** `artifacts/overhype-me/e2e/adminHelp.spec.ts:a cold deep link parks on its heading, not the chapter top`

### 4. An in-app link between chapters keeps its section

**Do:** From inside the app, click any chapter in the left-hand list, then
click a link within that chapter that points to another chapter.

**Expect:** it navigates inside the console, and if the link pointed at a
specific section, it lands on that section.

**Lane:** ci

**Check:** `artifacts/overhype-me/src/components/admin/helpContent.test.ts:marks every in-app link so the page can make it base-aware and routed`; `artifacts/overhype-me/src/components/admin/helpContent.test.ts:emits a data-help-internal value the guard accepts, matching the href`

**Deferred:** #631 — 7b — clicking a chapter then an in-chapter link to another chapter navigating in-app and landing on its section — `artifacts/overhype-me/e2e/adminHelp.spec.ts`

### 5. Search results name their location

**Do:** In the search box, type **`visual concept`**.

**Expect:** a list of results, each naming a **section** and the **chapter** it
belongs to.

**Lane:** ci

**Check:** `artifacts/overhype-me/src/components/admin/helpContent.test.ts:help search index is populated and attributes every entry to a real chapter section`

**Deferred:** #631 — 7b — typing visual concept in the search box showing result rows that each name a section and its chapter — `artifacts/overhype-me/e2e/adminHelp.spec.ts`

### 6. A search result lands where it says

**Do:** Click any result from step 5.

**Expect:** you land on that section of that chapter — not the top of the
chapter, and not a different one.

**Lane:** ci

**Check:** `artifacts/overhype-me/src/components/admin/helpContent.test.ts:help search index returns hits that land on a real anchor`; `artifacts/overhype-me/e2e/adminHelp.spec.ts:a cold deep link parks on its heading, not the chapter top`

**Deferred:** #631 — 7b — clicking a search result navigating in-app to that section of that chapter, parked on its heading — `artifacts/overhype-me/e2e/adminHelp.spec.ts`

### 7. Search holds up on other terms

**Do:** Search **`moderation`**, then **`stale`**.

**Expect:** results in the same shape as step 5, relevant to each term.

**Lane:** ci

**Check:** `artifacts/overhype-me/src/components/admin/helpContent.test.ts:help search index returns hits that land on a real anchor`

**Deferred:** #631 — 7b — searching stale at all, and hits for moderation and stale containing the term — `artifacts/overhype-me/src/components/admin/helpContent.test.ts`

### 8. Plumbing inside links is not searchable

**Do:** Search **`ai-context/glossary.md`**.

**Expect:** no results. That text exists only inside links — a file path the
Manual points at, not words on the page.

**Lane:** ci

**Check:** `artifacts/overhype-me/src/components/admin/helpContent.test.ts:help search index indexes visible link text but NOT link targets`

### 9. The front page is not indexed — your decision

**Do:** Search **`Chapter quality bar`**.

**Expect:** no results. That phrase is on the Manual's front page, which you
asked to keep out of search. The page is still readable; it just isn't indexed.

**Lane:** ci

**Check:** `artifacts/overhype-me/src/components/admin/helpContent.test.ts:help search index excludes the README`

### 10. The `?` on a screen lands somewhere that answers "what is this?"

**Do:** Go to **Admin → Queue Health** and click the **`?`** in the top bar,
next to *View Site*.

**Expect:** chapter 12, parked on *"Worker liveness and the Queue Health
surface"*.

**Lane:** ci

**Check:** `artifacts/overhype-me/src/components/admin/helpMap.test.ts:admin help map builds the href a ? control actually links to`

**Deferred:** #631 — 7b — the ? control beside View Site on Queue Health, clicked, landing in chapter 12 parked on the Worker liveness heading — `artifacts/overhype-me/e2e/adminQueueHealth.spec.ts`

### 11. The rest of the `?` map is sane

**Do:** Click the `?` from each of these screens in turn: Moderation, Taxonomy
Health, Billing, Email Queue, Facts, Dashboard.

**Expect:** Ch. 3 · Moderation; Ch. 4 § *For the admin (Taxonomy Health)*;
Ch. 10 § *For the admin*; Ch. 12 § *Email, the most consequential rider*;
Ch. 2 · Content Lifecycle; Ch. 11 · Admin Console. Say which row is unhelpful
if any is — it's a one-line change per screen.

**Lane:** ci

**Check:** `artifacts/overhype-me/src/components/admin/helpMap.test.ts:builds the href a ? control actually links to`

**Deferred:** #631 — 7b — hrefs for Taxonomy Health, Billing, Email Queue, Facts and Dashboard, as only Moderation and Queue Health are asserted — `artifacts/overhype-me/src/components/admin/helpMap.test.ts`

### 12. A link out of the Manual opens GitHub

**Do:** Inside any chapter, find a link to something outside the Manual — most
chapters link to `glossary.md` or a spec in `docs/ai-context/` — and click it.

**Expect:** it opens **GitHub in a new tab**, and your place in the console is
undisturbed.

**Lane:** ci

**Check:** `artifacts/overhype-me/src/components/admin/helpContent.test.ts:generated help content opens every off-manual link in a new tab, and no in-app link`; `artifacts/overhype-me/src/components/admin/helpContent.test.ts:rewrites intra-manual links to in-app routes and off-manual links to GitHub`

### 13. A stale bookmark fails tidily

**Do:** Open `/admin/help/no-such-chapter`.

**Expect:** a tidy "No such chapter" message *inside* the console, with a link
back to the Manual. Not a blank page, not a crash, not the red error screen.

**Lane:** ci

**Check:** `artifacts/overhype-me/e2e/adminHelp.spec.ts:a stale bookmark fails tidily, with a way back`

## Regression

### R1. The admin sidebar is unchanged apart from Help

**Do:** Look down the admin sidebar.

**Expect:** same items in the same order, plus **Help** at the bottom.

**Lane:** ci

**Deferred:** #631 — 7b — kept sidebar items in their existing relative order, with Help as the last item — `artifacts/overhype-me/e2e/adminHelp.spec.ts`

### R2. Moderation's pending count still works

**Do:** Look at the Moderation item in the sidebar.

**Expect:** the pending-count badge is there and still counting.

**Lane:** ci

**Deferred:** #631 — 7b — Moderation item showing a pending-count badge equal to the review and comment counts — `artifacts/overhype-me/e2e/adminHelp.spec.ts`

### R3. The sidebar still collapses

**Do:** Collapse the sidebar, then hover an icon.

**Expect:** it collapses, and icons still have tooltips.

**Lane:** ci

**Deferred:** #631 — 7b — the collapse toggle narrowing the sidebar, and a collapsed icon's tooltip naming its page — `artifacts/overhype-me/e2e/adminHelp.spec.ts`

### R4. Admin still works on a phone

**Do:** Open the admin console on a phone and tap the hamburger menu.

**Expect:** the drawer opens as before.

**Lane:** ci

**Deferred:** #631 — 7b — at phone width the hamburger opening the drawer with the nav items, and closing it again — `artifacts/overhype-me/e2e/adminHelp.spec.ts`

### R5. View Site and Sign Out still work

**Do:** Use *View Site*, then *Sign Out*, from the top bar.

**Expect:** both are where they were and both work.

**Lane:** ci

**Deferred:** #631 — 7b — View Site going to the home page, Sign Out ending the session — `artifacts/overhype-me/e2e/adminHelp.spec.ts`

### R6. Other admin screens load unchanged

**Do:** Open two or three admin screens you use often.

**Expect:** each loads exactly as before.

**Lane:** human

**Check:** `artifacts/overhype-me/e2e/routeLoadSmoke.spec.ts`

**Deferred:** #631 — increment 8 (capture and read) — each admin page looks as it did before the help system, sidebar, header and content unchanged

### R7. A non-admin is still refused

**Do:** Visit `/admin/help` while signed out or as a non-admin.

**Expect:** the same "Access Denied" as any other admin page.

**Lane:** ci

**Check:** `artifacts/overhype-me/e2e/adminPermissions.spec.ts:the same Access-Denied selector does match when access is genuinely refused`

**Deferred:** #631 — 7b — signed out and the seeded free account at /admin/help both showing Access Denied — `artifacts/overhype-me/e2e/adminPermissions.spec.ts`

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

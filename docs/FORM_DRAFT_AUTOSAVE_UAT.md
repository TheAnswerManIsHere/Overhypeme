# Form-draft autosave — UAT

In-app click-through for the unified "don't lose your work" autosave helper.
Engineering test plan:
[`FORM_DRAFT_AUTOSAVE_TEST_RUN.md`](./FORM_DRAFT_AUTOSAVE_TEST_RUN.md).

**The goal of this PR:** the autosave behavior that protects in-progress work was
written twice (fact submission + fact moderation). It's now one reusable helper,
and we've extended the same protection to the comment box. Nothing should *look*
different in the two existing flows — they should just keep working — and comments
gain a new "survives a reload" behavior.

There are no schema or server changes. You can test entirely in the browser.

---

## 1. Submit-a-fact draft (regression — should behave as before, only better)

1. Go to **Submit a Fact**.
2. Type a fact (e.g. *"When David sneezes, the weather changes."*). Within a
   second you should see **"Saved just now"** appear under the box.
3. Reload the page. Expect a **"Draft restored"** toast and your text back in
   place.
4. **New:** reload *again* (without typing). Your draft should **still** be there.
   (Previously a restored draft was wiped after the first reload.)
5. Click **Preview**, add hashtags, reload — you should land back on the preview
   step with the template + hashtags intact.
6. Click **"Discard and start over"** → the box clears and the saved draft is
   gone (reload confirms it does not come back).
7. Type a new fact and **submit** it. After the success screen, go back to
   Submit a Fact — the box should be empty (submitting clears the draft).

### Onboarding edge case
If your account hits "Onboarding required" on submit: click **Complete
onboarding**, then come back to `/submit`. Your draft should be restored.

## 2. Comment draft (new behavior)

1. Open any fact (feed card or fact page) so the comment box is visible.
2. Start typing a comment but **don't** post it.
3. Reload the page (or close the tab and reopen the fact). Your half-written
   comment should reappear in the box.
4. Finish and **post** the comment. The box clears; reloading does **not** bring
   the posted text back.
5. Sanity check it's per-fact: type a draft on fact A, then open fact B — fact B's
   box should be empty, and fact A's draft should still be waiting on fact A.

> Note: there is intentionally **no** "Saved" label on the comment box (it's
> deliberately compact). The proof is that the text survives a reload.

## 3. Moderation enrichment autosave (regression — admin)

1. Sign in as admin, open the review queue, open a **pending** review.
2. Edit something in the enrichment editor (e.g. a cultural reference). The small
   status line should read **"Saving…"** then **"Saved X min ago"**.
3. Reload the review. Your edit should persist — this comes from the **server**
   (the database), not your browser, so it would also show up for another admin.
4. Click **Regenerate preview**. It should save first, then kick the preview job.
   If the save were to fail, the preview would not start.

---

## Regression smoke table

| Area | Action | Expect |
|---|---|---|
| Submit a Fact | type → reload | "Draft restored" toast + text back |
| Submit a Fact | submit → return | empty box |
| Submit a Fact | discard | box clears, no restore |
| Comment box | type → reload | comment text restored |
| Comment box | post → reload | empty box |
| Moderation | edit enrichment | "Saving… / Saved" + persists on reload |
| Moderation | regenerate preview | saves first, then previews |

---

## Known non-bugs / limitations

- **Drafts expire after 24 hours.** A day-old fact or comment draft won't restore
  (by design).
- **Drafts are per-browser** for fact submission and comments (localStorage).
  They won't follow you to another device. Moderation enrichment, by contrast, is
  server-side and *does* follow you.
- **No comment "Saved" indicator** — compact composer, intentional.
- A non-empty comment box you're actively typing in **wins** over a stored draft
  (so a restore never overwrites what you're currently writing).

---

## Bug report template

```
Flow: (submit fact / comment / moderation)
Steps:
1.
2.
Expected:
Actual:
Browser + whether you were signed in:
```

<!-- SYNCED FROM KITT — do not edit in a consumer repo. Local edits are overwritten by the next sync and their reasoning is lost; change KITT instead. -->

# /uat — when a step fails

Part of the `uat` skill ([`SKILL.md`](SKILL.md)), its section 4, moved here whole.
Read it the moment a step is not a clean pass.

## 4. When a step fails — file it now, then ask

A bugfix session starts immediately — I start it (item 6 below). My job is
to make sure the report that session inherits is a real one and that the
way back to *this* run survives.

In order, in the same turn:

1. **Capture the evidence before anything else.** The exact error text, the
   exact URL, a screenshot — not a paraphrase. Ask for it plainly if it
   isn't in what he said. Paraphrased symptoms are the single biggest
   quality loss in this hand-off, and the moment to prevent it is now, not
   when a cold session reads the issue tomorrow.
2. **State a severity, as my read, in one word** — showstopper / major /
   minor / cosmetic — so he can correct it by contradicting me rather than
   by classifying anything. **This is not the fix tier**: the tier is
   diagnosis's job in the bugfix session, and pre-empting it here would put
   a guess where a classification belongs.
3. **Run the disclosure check** before writing anything public — this repo
   is public, and a UAT failure can be exactly the kind of thing that must
   not become a public issue
   ([`working-modes.md`](../../../docs/ai-context/working-modes.md#disclosure-check-before-the-workstream-issue-opens)).
   If it fails, **the whole run goes private from that moment** — see
   *The private path* below, and do not write the symptom anywhere public.
4. **File the bug** — check the backlog for a match and promote it rather
   than duplicating, per [`bugfix`](../bugfix/SKILL.md) step 1. New issues
   open with `stage:coding`, `waiting:claude`, `mode:bugfix` and a State of
   Play block. `mode:bugfix` is a hypothesis at intake; diagnosis may make
   it Tier C, and that's fine — the link doesn't care which mode the work
   ends up in.
5. **Record the way back, in the same edit** — `Blocked by: #<bug>` on this
   workstream, plus a State of Play line naming **which step failed**. This
   is what makes resumption "T4" instead of a full re-run, and it goes
   in now, at intake, because a session that ends before it is written loses
   the link entirely. `bugfix` step 1 owns this contract; I'm executing it
   at the earlier moment, because I'm the one holding the context.
6. **Start a fresh session for the fix** — `create_session` with a prompt
   naming the issue number, so that session works the filed bug instead of
   opening a second one for the same defect, that says the UAT run is still
   live and its `waiting:` label is this session's to set (below), and with
   the Astra sign-in as its first action (the `handoff` skill, Step 5, for the call and its
   fallback). Where it cannot be started, hand him that prompt, paste-ready,
   instead.

**The `waiting:` flip is NOT part of intake — it happens when the run
actually stops** (section 6), and it is this session's, not the bugfix
session's: that session starts while the run may still be going, so its
prompt says so and `bugfix` step 1 leaves the label alone. If David says continue, he is
still the holder and the next real action is still his click, so
`stage:uat`/`waiting:david` stays exactly right. Flipping at intake would
also mirror the wrong holder onto a phased parent and hide an active,
David-held run from `/status-all`. What goes in at intake is the `Blocked
by:` link and the failed-step line — the crash-critical parts. The label is
display state, and it costs nothing to set it once, correctly, at the end.

**Then ask: continue or pause?** His call, every time. Continuing is often
worth it — it banks two or three more bugs that can be fixed in parallel
instead of serially — but a Blocked step or a showstopper usually means
there's nothing left worth testing, and I say so rather than making him
work it out. **A pause is a stop: tear the setup down first** (section 2),
and record what's owed on resume.

**Never diagnose the bug inside the UAT session.** Not even when the cause
looks obvious. Diagnosis belongs to the bugfix session with a real branch
and a real review; guessing at it here spends his testing time and produces
a root cause nobody reviewed.

### The private path

When the disclosure check rejects a failure, the descent-stack machinery
cannot be used as written — a private draft Project item **has no issue
number**, so there is no `#N` for a `Blocked by:` marker or for the handoff
prompt, and the run record itself would leak the symptom on a public issue.
So, from that moment:

- **The bug becomes a private draft Project item**, per CLAUDE.md's
  disclosure rule, with a short stable reference of my choosing
  (`UAT-<PR>-<step ID>`, the step's `T` or `R` ID) written into the item.
- **The run record goes manual, and I say so.** A draft Project item is
  write-only to me — no available tool reads or writes Projects v2 item
  fields (`workstream-tracking.md`), so it cannot hold a record I checkpoint
  and rediscover. On the private path the live record is therefore
  maintained **in the session and handed to David at every checkpoint
  moment** (the same moments section 5 names): a compact copy in chat that
  he can paste into the private item himself, and that a resuming session
  asks him for. Resumability degrades from mechanical to David-carried on
  exactly this path — an accepted cost of not leaking the symptom, stated
  out loud at the moment it starts, never silently.
- **The public workstream issue keeps only a content-free pointer**:
  `Blocked by: private tracking (UAT-472-T2)` and a State of Play line saying
  which step failed **without saying how**. That reads as prose rather than
  the anchored `Blocked by: #N` marker, so it does not gate automatically —
  which means I say so plainly to David rather than assuming the stack pops
  on its own.
- **I tell him the automation doesn't cover this path**, in the same breath,
  because a silent downgrade from mechanical to manual tracking is how a
  sensitive bug gets forgotten.

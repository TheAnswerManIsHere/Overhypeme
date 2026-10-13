# Planning-loop records

The deliberation behind the approved plans in `docs/plans/`. They are kept
so a later session can see why a decision was made, or reopen it with its
history, after the session that made it is gone (David, 2026-10-12).

| Folder | Plan | What it holds |
|---|---|---|
| `get-to-launch/` | `PLAN_GET_TO_LAUNCH.md` (#628) | Astra's assessments (`round-0..2.md`), the plan as revised after each round (`plan-round-1..2.md`), every concern and how it was settled (`concerns.json`), and the oracle (`oracle*.{md,txt}`) |
| `phase2-verification/` | `PLAN_PHASE2_VERIFICATION.md` (#631) | The same set, for rounds 1–2 |
| `launch-phase-1/` | Phase 1's implementation PR (#630) | Its oracle and the two assessors' comments |
| `phase2-inc4-ai-doubles/` | `PLAN_PHASE2_INC4_AI_DOUBLES.md` (#631 increment 4, the adapter shape the parent reserves "settled there with Astra") | The same set, for rounds 1–3; `oracle-parent-v4.md` is a byte copy of `PLAN_PHASE2_VERIFICATION.md` |

These are copies, not rewrites, from `.agents/reviews/` in the planning
sessions. Links in them that point to `/home/user/Overhypeme/...` are paths
in that session's container: read them as paths relative to the repository
root. The approved plan is the authority; these records are context.

Left out on purpose: the raw prompts (they repeat the plan and the review
brief), run logs and metadata. Disclosure check (`workstream-tracking.md`)
passed on 2026-10-12.

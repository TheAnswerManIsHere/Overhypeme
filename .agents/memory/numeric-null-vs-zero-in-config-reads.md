# `Number(null)` is `0`, not `NaN` — a nullable numeric column needs an explicit null branch

**The trap.** A `numeric` column that is *legitimately nullable* and whose value
is used in a comparison invites this shape:

```ts
const n = Number(row.someCost);
if (Number.isFinite(n)) return n;   // WRONG for a nullable column
```

`Number(null)` is `0`, and `0` is finite. So a row meaning *"no value
configured"* silently reads as *"the value is zero"* — and if that number is a
cost, a limit, or a threshold, zero is almost always the permissive answer.
`Number(undefined)` is `NaN` and IS caught, which makes the bug worse: it looks
correct in any test that uses `undefined` rather than a real DB `null`.

**Where it bit.** PR #474's generation-spend fallback, three times in one PR:

1. `engine.estimatedCostUsdPerSecond` is nullable, so a bare `Number.isFinite`
   check would have priced a video call at `$0` — inside the very change that
   existed to stop unpriced calls escaping the budget gate.
2. The same shape in the image path's catalogue lookup. **8 of 19 engines carry
   `estimatedCostUsdPerCall: null`**, so this was not a hypothetical.
3. Then in the opposite direction: the guard against (1) and (2) was
   `n > 0`, which *also* discarded a deliberate `0`. The admin engine
   validator accepts any non-negative number
   (`routes/adminEngines.ts`, `v >= 0`), so an operator can legitimately waive
   an engine's cost — and `> 0` silently overrode that with a positive
   estimate, refusing a call the operator had made free.

**The rule.** `null` and `0` are different facts whenever the column is
nullable. Reject `null`/`undefined` **explicitly, before any numeric
conversion**, then apply the range test the domain actually wants:

```ts
function costOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  // A drizzle `numeric` column arrives as a STRING; an empty one is not a zero.
  if (typeof value === "string" && value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
```

Three things that matter in that shape:

- The null check is separate, so relaxing `> 0` to `>= 0` cannot resurrect the
  original bug.
- Drizzle returns `numeric` as a **string** (`"0.030000"`), so `""` has to be
  rejected too — `Number("") === 0` reads a blank as a deliberate zero.
- Negative and non-numeric both fall to `null` rather than to a default.

**Generalizes to:** any nullable numeric column read into a comparison —
`estimated_cost_usd_per_call`, `estimated_cost_usd_per_second`,
`monthly_generation_limit_override_usd`, rate-limit overrides, thresholds. The
question to ask at the read site is *"does this column's `null` mean the same
thing as its `0`?"* If not, branch on it before converting.

**Reference:** PR #474 (rounds 1–3); `artifacts/api-server/src/lib/aiMemePipeline.ts`'s
`costOrNull`, and the parallel inline check in `routes/videos.ts`.

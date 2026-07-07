---
name: React setState functional-updater callback isn't synchronous
description: Why writing to a ref inside a setState(prev => …) updater doesn't fix a same-tick stale-read race — and what does.
---

# A `setState(prev => …)` updater's side effects are not guaranteed to run before your very next line

Symptom: a "commit the current value right now" primitive
(`useDraftForm.ts`'s `save()`) read a ref (`valueRef.current`) that was
supposed to always be current. The obvious-looking fix — write the ref
*inside* the functional updater passed to `setState` — looked correct and
compiled, but did **not** fix the bug: calling `setValue(next)` immediately
followed by `save()` in the same synchronous block (no `await` in between)
still read the stale ref, because React does not guarantee the updater
callback runs synchronously before the next line of your own code executes.

**Durable lesson:** if you need a ref to be genuinely readable-immediately-
after a "set the value" call in the same tick, resolve the new value
yourself (against the ref, which is kept current every render) and write the
ref **before** calling the state setter — never rely on side effects placed
inside a `setState(updater)` callback for same-tick timing. The corrected
shape:

```ts
const setValue = useCallback((next) => {
  const resolved = typeof next === "function" ? next(valueRef.current) : next;
  valueRef.current = resolved;   // synchronous, before setValueState
  setValueState(resolved);
}, []);
```

**How to catch it:** write the regression test as the actual failure
scenario — call the setter and the reader back-to-back in the same
synchronous block (inside one `act()` with no `await` between them), not
across a render boundary. A test that lets a render land between the two
calls will pass even with the broken "write inside the updater" version,
because by the time the render happens the updater has run — the bug only
reproduces same-tick.

**Where this showed up:** `artifacts/overhype-me/src/components/admin/useDraftForm.ts`
(PR #206) — the fix also added a `saveValue(next)` primitive that takes the
value to commit as an argument instead of relying on any ref timing at all,
which is the more robust shape when the caller already has the value in
hand (e.g. a tokenize-then-save flow).

# `admin_config.data_type` must be `integer` or `float` — anything else silently skips validation

The `/admin/config` PATCH route (`routes/admin.ts`) validates
`existing.dataType === "integer"`, then `else if === "float"`, and has **no
else branch**. So an unrecognized `data_type` does not fall back to strict
handling — it skips validation *entirely* and the row accepts arbitrary text
through the generic config UI. The column's own default is `'integer'`.

Writing `data_type: 'number'` (not a recognized value) therefore produced a
free-text field. One operator entering a decimal then broke the consuming SQL
permanently:

```
ERROR:  invalid input syntax for type bigint: "3.5"
```

— and because `noteLedgerWriteFailure` swallows its own errors by design, the
counter would have been dead **and silent**, with the log line it exists to
improve on being the only thing left.

**Three things, because the type alone only closes the UI route:**

1. Use `integer` (or `float`), plus `min_value` where a bound applies.
2. **Make the consuming SQL survive a bad value however it arrived** — a direct
   edit, a migration, a future code path. `CASE WHEN value ~ '^[0-9]+$' THEN
   value::bigint ELSE 0 END + 1` restarts from zero rather than taking the
   signal down with it. Validation at the edge does not cover the other doors.
3. **Self-heal the metadata on conflict** — `data_type = EXCLUDED.data_type` —
   or a row created by an earlier build keeps its unvalidated type forever,
   since `ON CONFLICT` otherwise only touches `value`.

Verified end to end in psql from the broken state (`value='3.5'`,
`data_type='number'`): the old form errors, the new one recovers to `1` and
repairs the type in the same statement.

**Reference:** PR #498 round 2, `budgetGate.noteLedgerWriteFailure`.

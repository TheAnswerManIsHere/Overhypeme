# Test database environment — Replit configuration

This project's test docs (e.g. `docs/MBFO_*_TEST_RUN.md`) sometimes include
commands like:

```bash
DATABASE_URL="postgres://overhype:overhype@localhost:5432/overhype_test" \
  node --import tsx/esm --test src/__tests__/routes.*.test.ts
```

**That `localhost:5432` test DB does not exist in this environment.**  Ignore
any `DATABASE_URL=...` override in test commands — and do **not** run
`node --import tsx/esm --test <file>` directly with the ambient `DATABASE_URL`,
because that points at the live public schema and test writes will leak into it.

---

## Correct setup

### 1. The ambient `DATABASE_URL` is already configured

The environment variable `DATABASE_URL` is pre-set to the live Helium database:

```
postgresql://postgres:password@helium/heliumdb?sslmode=disable
```

### 2. Running individual api-server integration tests

Use the `run-test.sh` wrapper instead of invoking `node` directly.  The wrapper
constructs a `heliumdb_test`-scoped URL (same isolation as the full `pnpm test`
sharded runner) and auto-clones the schema if needed:

```bash
cd artifacts/api-server
BCRYPT_SALT_ROUNDS=4 bash scripts/run-test.sh src/__tests__/<file>.test.ts
```

Multiple files in one shot:

```bash
cd artifacts/api-server
BCRYPT_SALT_ROUNDS=4 bash scripts/run-test.sh \
  src/__tests__/foo.test.ts \
  src/__tests__/bar.test.ts
```

Force a fresh schema clone first (e.g. after adding a migration):

```bash
cd artifacts/api-server
BCRYPT_SALT_ROUNDS=4 bash scripts/run-test.sh --setup src/__tests__/<file>.test.ts
```

### 3. Running the full api-server suite

Use the workflow script — it handles sharding and schema isolation automatically:

```bash
pnpm --filter @workspace/api-server run test
```

### 4. Writing new test run docs

Replace bare `node --import tsx/esm --test <file>` invocations with:

```bash
BCRYPT_SALT_ROUNDS=4 bash scripts/run-test.sh <file>
```

Run from `artifacts/api-server`. Never pass a raw `DATABASE_URL=...` prefix —
the wrapper handles isolation.

### 5. Migrations

`pnpm --filter @workspace/db run migrate` targets the Helium DB directly via
the ambient `DATABASE_URL`. No extra configuration needed.

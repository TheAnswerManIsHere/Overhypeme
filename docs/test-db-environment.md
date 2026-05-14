# Test database environment — Replit configuration

This project's test docs (e.g. `docs/MBFO_*_TEST_RUN.md`) sometimes include
commands like:

```bash
DATABASE_URL="postgres://overhype:overhype@localhost:5432/overhype_test" \
  node --import tsx/esm --test src/__tests__/routes.*.test.ts
```

**That `localhost:5432` test DB does not exist in this environment.** The
`scripts/setup-test-db.sh` script that creates it requires `apt-get`, which is
blocked in Replit. Ignore any `DATABASE_URL=...` override in test commands.

---

## Correct setup

### 1. The ambient `DATABASE_URL` is already configured

The environment variable `DATABASE_URL` is pre-set to the live Helium database:

```
postgresql://postgres:password@helium/heliumdb?sslmode=disable
```

Every test command picks this up automatically. Do **not** override it.

### 2. Running individual api-server integration tests

Drop the `DATABASE_URL=` prefix entirely:

```bash
cd artifacts/api-server
TEST_DB_ALLOW_EXIT_ON_IDLE=1 BCRYPT_SALT_ROUNDS=4 \
  node --import tsx/esm --test src/__tests__/<file>.test.ts
```

### 3. Running the full api-server suite

Use the workflow script — it handles sharding and picks up the ambient URL
automatically:

```bash
pnpm --filter @workspace/api-server run test
```

### 4. Writing new test run docs

Omit the `DATABASE_URL=...` prefix from api-server test commands. The Helium
DB is always available and already configured.

### 5. Migrations

`pnpm --filter @workspace/db run migrate` targets the Helium DB directly via
the ambient `DATABASE_URL`. No extra configuration needed.

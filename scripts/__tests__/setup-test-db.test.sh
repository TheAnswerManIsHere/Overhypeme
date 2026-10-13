#!/usr/bin/env bash
# Regression test for scripts/setup-test-db.sh.
#
# A fresh container's apt package index does not list postgresql-16-pgvector,
# so installing it without refreshing the index first fails with "Unable to
# locate package" and the session starts with no test database. The stubs
# below behave like that fresh container: `apt-get install` succeeds only once
# `apt-get update` has run. The script is stopped at its next step (starting
# the cluster) by a failing `pg_ctlcluster` stub, so nothing real is touched.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="${REPO_ROOT}/scripts/setup-test-db.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT
stubs="${work}/bin"
calls="${work}/calls.log"
mkdir -p "${stubs}"
: > "${calls}"

cat > "${stubs}/apt-get" <<EOF
#!/usr/bin/env bash
echo "apt-get \$*" >> "${calls}"
case " \$* " in
  *" update "*) touch "${work}/index-refreshed"; exit 0 ;;
  *" install "*)
    [ -e "${work}/index-refreshed" ] && exit 0
    echo "E: Unable to locate package postgresql-16-pgvector" >&2
    exit 100 ;;
esac
exit 0
EOF

cat > "${stubs}/dpkg" <<EOF
#!/usr/bin/env bash
echo "dpkg \$*" >> "${calls}"
exit 1
EOF

cat > "${stubs}/pg_isready" <<'EOF'
#!/usr/bin/env bash
exit 1
EOF

cat > "${stubs}/pg_ctlcluster" <<EOF
#!/usr/bin/env bash
echo "pg_ctlcluster \$*" >> "${calls}"
exit 1
EOF

chmod +x "${stubs}"/*

echo "test: on a fresh container the pgvector install refreshes the package index first"

env -u REPL_ID -u REPLIT_DEV_DOMAIN -u REPL_SLUG PATH="${stubs}:${PATH}" \
  bash "${SCRIPT}" >"${work}/out.log" 2>&1 || true

grep -q "^apt-get .*install.*postgresql-16-pgvector" "${calls}" \
  || fail "the script never tried to install pgvector; calls were:"$'\n'"$(cat "${calls}")"

update_line="$(grep -n "^apt-get .*update" "${calls}" | head -1 | cut -d: -f1 || true)"
install_line="$(grep -n "^apt-get .*install" "${calls}" | head -1 | cut -d: -f1 || true)"
[ -n "${update_line}" ] && [ "${update_line}" -lt "${install_line}" ] \
  || fail "apt-get install ran without a prior apt-get update; calls were:"$'\n'"$(cat "${calls}")"

grep -q "^pg_ctlcluster" "${calls}" \
  || fail "the script stopped before starting Postgres (the install failed); output was:"$'\n'"$(cat "${work}/out.log")"

echo "  ok"

/**
 * An older migration's SQL minus its statements on `admin_config.debug_value`.
 *
 * Migrations 0073 and 0082 scrubbed a prompt in both `value` and the Debug mode
 * override column. Migration 0108 dropped that column (launch Phase 4, removal
 * 8), so a test that replays one of those files against today's schema runs the
 * `value` half only. The migrations themselves are unchanged: on a database
 * that still had the column they ran as written, and the runner skips the
 * missing-column error on a fresh one.
 */
export function withoutDebugValueStatements(migrationSql: string): string {
  return migrationSql
    .split(/;(?=\s*(?:\n|$))/)
    .filter((statement) => {
      const code = statement
        .split("\n")
        .filter((line) => !line.trim().startsWith("--"))
        .join("\n");
      return code.trim() !== "" && !code.includes('"debug_value"');
    })
    .map((statement) => `${statement};`)
    .join("\n");
}

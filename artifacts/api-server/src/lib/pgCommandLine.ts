/**
 * @purpose Run Postgres command-line tools (pg_dump, pg_restore) without the database password on their command line: the URL's password moves to PGPASSWORD in the child's environment, so no error message built from the command can carry it.
 * @subsystem storage
 *
 * A failed child's error message repeats its whole command line, and that
 * message is stored and logged (a backup manifest's `dumpError`, an operator's
 * terminal, a pasted report). libpq reads PGPASSWORD when the connection
 * string carries no password, and never echoes it.
 */

/** The URL to pass on the command line, and the environment that carries its password. */
export function pgCommandConnection(url: string, env: NodeJS.ProcessEnv = process.env): { url: string; env: NodeJS.ProcessEnv } {
  const parsed = new URL(url);
  const password = decodeURIComponent(parsed.password);
  parsed.password = "";
  return { url: parsed.href, env: password ? { ...env, PGPASSWORD: password } : { ...env } };
}

/** A message with every form of `url`'s password removed: the backstop for text that may still quote it. */
export function withoutPassword(message: string, url: string): string {
  let password = "";
  try {
    password = new URL(url).password;
  } catch {
    return message;
  }
  if (!password) return message;
  const forms = [...new Set([password, decodeURIComponent(password), encodeURIComponent(decodeURIComponent(password))])];
  return forms.reduce((m, p) => m.split(p).join("***"), message);
}

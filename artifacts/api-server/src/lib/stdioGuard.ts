import * as Sentry from "@sentry/node";

/**
 * Errors that indicate the parent pipe / TTY backing process.stdout or
 * process.stderr was torn down. These are not application bugs; they happen
 * when the workflow restarts, the terminal disconnects, or a container log
 * pipe overruns its buffer. Without explicit handling Node treats the
 * resulting `error` event on the underlying Socket as an uncaught exception
 * and the process dies.
 */
const SAFE_STREAM_ERROR_CODES: ReadonlySet<string> = new Set([
  "EIO",
  "EPIPE",
  "ERR_STREAM_DESTROYED",
]);

export function isSafeStreamError(err: unknown): err is NodeJS.ErrnoException {
  if (!err || typeof err !== "object") return false;
  const code = (err as NodeJS.ErrnoException).code;
  return typeof code === "string" && SAFE_STREAM_ERROR_CODES.has(code);
}

let installed = false;

const reportedStreams = new WeakSet<NodeJS.WritableStream>();

type ErrorReporter = (
  err: unknown,
  ctx: { tags?: Record<string, string> },
) => void;

// The default reporter routes through @sentry/node. The Sentry namespace
// import is read-only so it can't be replaced from a test; the seam below
// lets the test suite swap in an in-memory recorder instead.
const defaultReporter: ErrorReporter = (err, ctx) => {
  try {
    Sentry.captureException(err, ctx);
  } catch {
    // Sentry not initialized — silently swallow. The whole point of this
    // guard is to never throw from the error path.
  }
};

let errorReporter: ErrorReporter = defaultReporter;

function makeListener(stream: NodeJS.WritableStream, name: string) {
  return (err: NodeJS.ErrnoException): void => {
    if (isSafeStreamError(err)) {
      // Capture once per stream so Sentry doesn't get spammed if every log
      // line after the pipe tear-down re-emits the same error.
      if (!reportedStreams.has(stream)) {
        reportedStreams.add(stream);
        errorReporter(err, {
          tags: {
            fatal: "stdio-stream-error-absorbed",
            stream: name,
            code: err.code ?? "unknown",
          },
        });
      }
      return;
    }
    // Anything else is genuinely unexpected. Re-emit synchronously so the
    // normal Node behavior (uncaughtException) takes over and the operator
    // sees the failure.
    throw err;
  };
}

/**
 * Attach `error` listeners to process.stdout / process.stderr so EIO / EPIPE
 * on those streams is absorbed instead of bubbling to `uncaughtException`.
 *
 * Idempotent: safe to call more than once. Must run before any module that
 * could write to stdio.
 */
export function installStdioGuard(): void {
  if (installed) return;
  installed = true;

  const stdout = process.stdout;
  const stderr = process.stderr;
  (stdout as unknown as NodeJS.EventEmitter).on(
    "error",
    makeListener(stdout, "stdout"),
  );
  (stderr as unknown as NodeJS.EventEmitter).on(
    "error",
    makeListener(stderr, "stderr"),
  );
}

// ── Fatal-path short-circuit ────────────────────────────────────────────────
// A synchronous TTY-write throw can still bubble up to `uncaughtException`
// even with the async error listener installed (e.g. process.stdout.write()
// throwing right when the pipe goes away). The fatal-exit handler in
// src/index.ts uses absorbFatalStreamError() to recognize these as expected
// teardown errors and skip process.exit(1).
let fatalStreamErrorReported = false;

export interface AbsorbFatalStreamErrorDeps {
  captureException: (err: unknown, ctx: { tags?: Record<string, string> }) => void;
  warn: (obj: Record<string, unknown>, msg: string) => void;
}

/**
 * Returns `true` when `err` is a known stream-teardown error and was absorbed
 * (in which case the caller should NOT call process.exit). Returns `false`
 * for any other error so the normal fatal-exit path runs.
 *
 * The first absorbed error is reported to Sentry (via the injected
 * `captureException`) and to the logger; subsequent calls are silently
 * swallowed so a flapping pipe doesn't spam alerts.
 */
export function absorbFatalStreamError(
  err: unknown,
  ctx: { kind: string },
  deps: AbsorbFatalStreamErrorDeps,
): boolean {
  if (!isSafeStreamError(err)) return false;
  if (!fatalStreamErrorReported) {
    fatalStreamErrorReported = true;
    try {
      deps.captureException(err, {
        tags: {
          fatal: "stdio-stream-error-absorbed",
          kind: ctx.kind,
          code: err.code ?? "unknown",
        },
      });
    } catch {
      // Sentry not initialized — nothing more to do.
    }
    try {
      deps.warn({ err, kind: ctx.kind }, "Absorbed stdio stream error — process continues");
    } catch {
      // Logger transport itself may be the casualty; ignore.
    }
  }
  return true;
}

/**
 * Test-only escape hatch so unit tests can re-install the guard against a
 * fresh emitter. Not exported from the package barrel.
 */
export function __resetStdioGuardForTests(): void {
  installed = false;
  errorReporter = defaultReporter;
  fatalStreamErrorReported = false;
}

/**
 * Test-only seam that swaps the default Sentry-backed reporter for an
 * in-memory recorder. The Sentry namespace import is read-only, so this is
 * the only way to assert on capture behavior from a unit test.
 */
export function __setStdioGuardErrorReporterForTests(reporter: ErrorReporter | null): void {
  errorReporter = reporter ?? defaultReporter;
}

import pino, { type Logger } from "pino";

const isProduction = process.env.NODE_ENV === "production";

const LOG_METHODS = new Set([
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
]);

/**
 * When the normal pino write path fails (typically because the pino-pretty
 * worker thread exited and thread-stream now rejects writes), emit a plain
 * JSON line to stderr so the failure remains machine-parseable for log
 * aggregators / Sentry's log breadcrumb parser. Mirrors pino's default JSON
 * line shape (level, time, msg, err) so downstream tooling treats it the
 * same as any other log entry.
 */
function writeFallback(level: string, err: unknown): void {
  try {
    const errObj =
      err instanceof Error
        ? { type: err.name, message: err.message, ...(err.stack ? { stack: err.stack } : {}) }
        : { type: typeof err, message: String(err) };
    const line = JSON.stringify({
      level: 50, // pino "error" numeric level
      time: Date.now(),
      pid: process.pid,
      msg: `logger ${level} fallback: pino write failed (transport may have exited)`,
      err: errObj,
    });
    process.stderr.write(line + "\n");
  } catch {
    // Last-resort: nothing we can do if stderr or JSON.stringify itself is broken.
  }
}

/**
 * Wraps a pino logger so that any throw from a log method (typically caused
 * by the pino-pretty worker thread having exited and the underlying
 * thread-stream rejecting writes) is caught and logged to stderr instead of
 * propagating as an uncaught exception that would kill the process.
 *
 * Also wraps `child()` so per-request child loggers (used by pino-http) are
 * equally safe.
 */
function makeSafeLogger(base: Logger): Logger {
  return new Proxy(base, {
    get(target, prop, receiver) {
      const original = Reflect.get(target, prop, receiver);

      if (
        typeof original === "function" &&
        typeof prop === "string" &&
        LOG_METHODS.has(prop)
      ) {
        return function safeLog(this: unknown, ...args: unknown[]): unknown {
          try {
            return (original as (...a: unknown[]) => unknown).apply(
              target,
              args,
            );
          } catch (err) {
            writeFallback(prop, err);
            return undefined;
          }
        };
      }

      if (prop === "child" && typeof original === "function") {
        return function safeChild(this: unknown, ...args: unknown[]) {
          try {
            const child = (original as (...a: unknown[]) => Logger).apply(
              target,
              args,
            );
            return makeSafeLogger(child);
          } catch (err) {
            writeFallback("child", err);
            return target;
          }
        };
      }

      return typeof original === "function" ? original.bind(target) : original;
    },
  }) as Logger;
}

const baseLogger: Logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: [
    "req.headers.authorization",
    "req.headers.cookie",
    "res.headers['set-cookie']",
  ],
  ...(isProduction
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, sync: true },
        },
      }),
});

// Absorb thread-stream / transport errors. When the pino-pretty worker thread
// exits unexpectedly, pino emits an `error` event on the logger; without a
// listener Node treats this as an uncaught exception and kills the process.
// pino's typed `on()` overload only declares the `level-change` event, so we
// reach for the underlying EventEmitter shape to register our handler.
(baseLogger as unknown as NodeJS.EventEmitter).on("error", (err: Error) => {
  writeFallback("transport", err);
});

export const logger: Logger = makeSafeLogger(baseLogger);

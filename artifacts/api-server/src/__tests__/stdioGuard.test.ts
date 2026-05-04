import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  absorbFatalStreamError,
  installStdioGuard,
  isSafeStreamError,
  __resetStdioGuardForTests,
  __setStdioGuardErrorReporterForTests,
} from "../lib/stdioGuard.js";

function makeEioError(): NodeJS.ErrnoException {
  return Object.assign(new Error("write EIO"), { code: "EIO" }) as NodeJS.ErrnoException;
}

function makeEpipeError(): NodeJS.ErrnoException {
  return Object.assign(new Error("write EPIPE"), { code: "EPIPE" }) as NodeJS.ErrnoException;
}

describe("stdioGuard.isSafeStreamError", () => {
  it("recognizes EIO, EPIPE, and ERR_STREAM_DESTROYED", () => {
    assert.equal(isSafeStreamError(Object.assign(new Error("x"), { code: "EIO" })), true);
    assert.equal(isSafeStreamError(Object.assign(new Error("x"), { code: "EPIPE" })), true);
    assert.equal(isSafeStreamError(Object.assign(new Error("x"), { code: "ERR_STREAM_DESTROYED" })), true);
  });

  it("returns false for unrelated errors and non-objects", () => {
    assert.equal(isSafeStreamError(new Error("boom")), false);
    assert.equal(isSafeStreamError(Object.assign(new Error("x"), { code: "ECONNRESET" })), false);
    assert.equal(isSafeStreamError(null), false);
    assert.equal(isSafeStreamError(undefined), false);
    assert.equal(isSafeStreamError("EIO"), false);
  });
});

describe("stdioGuard.installStdioGuard", () => {
  let originalStdout: NodeJS.WriteStream;
  let originalStderr: NodeJS.WriteStream;
  let stdoutEmitter: EventEmitter;
  let stderrEmitter: EventEmitter;
  let reporterCalls: Array<{ err: unknown; ctx: { tags?: Record<string, string> } }>;

  beforeEach(() => {
    __resetStdioGuardForTests();

    // Replace process.stdout/process.stderr with bare EventEmitters so we can
    // observe listener registration and emit synthetic 'error' events without
    // touching the real TTY (which would actually kill the test process).
    originalStdout = process.stdout;
    originalStderr = process.stderr;
    stdoutEmitter = new EventEmitter();
    stderrEmitter = new EventEmitter();
    Object.defineProperty(process, "stdout", { value: stdoutEmitter, configurable: true });
    Object.defineProperty(process, "stderr", { value: stderrEmitter, configurable: true });

    // The Sentry namespace import is read-only and can't be reassigned, so we
    // route the guard through an in-memory reporter instead of mocking Sentry.
    reporterCalls = [];
    __setStdioGuardErrorReporterForTests((err, ctx) => {
      reporterCalls.push({ err, ctx });
    });
  });

  afterEach(() => {
    Object.defineProperty(process, "stdout", { value: originalStdout, configurable: true });
    Object.defineProperty(process, "stderr", { value: originalStderr, configurable: true });
    __setStdioGuardErrorReporterForTests(null);
    __resetStdioGuardForTests();
  });

  it("absorbs EIO emitted on process.stdout without bubbling to uncaughtException", () => {
    installStdioGuard();

    // EventEmitter.emit returns true if there were listeners — confirms our
    // listener was registered. If no listener existed, Node would throw the
    // error synchronously; the absence of a throw here is the actual assertion.
    const hadListeners = stdoutEmitter.emit("error", makeEioError());
    assert.equal(hadListeners, true, "stdout must have an error listener");
  });

  it("absorbs EPIPE emitted on process.stderr", () => {
    installStdioGuard();
    const hadListeners = stderrEmitter.emit("error", makeEpipeError());
    assert.equal(hadListeners, true, "stderr must have an error listener");
  });

  it("captures the EIO to Sentry exactly once across repeated stdout errors", () => {
    installStdioGuard();

    stdoutEmitter.emit("error", makeEioError());
    stdoutEmitter.emit("error", makeEioError());
    stdoutEmitter.emit("error", makeEioError());

    assert.equal(
      reporterCalls.length,
      1,
      "Sentry.captureException should be called exactly once per stream",
    );
    const { err, ctx } = reporterCalls[0]!;
    const errnoErr = err as NodeJS.ErrnoException;
    assert.equal(errnoErr.code, "EIO");
    assert.equal(ctx.tags?.["fatal"], "stdio-stream-error-absorbed");
    assert.equal(ctx.tags?.["stream"], "stdout");
    assert.equal(ctx.tags?.["code"], "EIO");
  });

  it("tracks stdout and stderr independently — each stream gets one Sentry capture", () => {
    installStdioGuard();

    stdoutEmitter.emit("error", makeEioError());
    stdoutEmitter.emit("error", makeEioError());
    stderrEmitter.emit("error", makeEpipeError());
    stderrEmitter.emit("error", makeEpipeError());

    assert.equal(
      reporterCalls.length,
      2,
      "one capture per stream regardless of repeat count",
    );
    const streams = reporterCalls
      .map((c) => c.ctx.tags?.["stream"])
      .filter((s): s is string => typeof s === "string")
      .sort();
    assert.deepEqual(streams, ["stderr", "stdout"]);
  });

  it("re-throws non-stream errors so they remain visible", () => {
    installStdioGuard();
    const unrelated = Object.assign(new Error("kaboom"), { code: "ECONNRESET" });
    assert.throws(
      () => stdoutEmitter.emit("error", unrelated),
      /kaboom/,
      "non-stream-teardown errors must not be silently swallowed",
    );
  });

  it("absorbFatalStreamError returns true for EIO so fatalExit skips process.exit", () => {
    const captured: Array<{ err: unknown; ctx: unknown }> = [];
    const warned: Array<{ obj: unknown; msg: string }> = [];
    const exitCalls: number[] = [];
    const originalExit = process.exit;
    // Belt-and-braces: spy on process.exit so a regression that re-introduced
    // the exit call would fail loudly here instead of taking down the test
    // runner. (absorbFatalStreamError must not call exit on its own.)
    (process as unknown as { exit: (code?: number) => void }).exit = (code?: number) => {
      exitCalls.push(code ?? 0);
      throw new Error("process.exit was called — fatalExit short-circuit failed");
    };

    try {
      const eioErr = makeEioError();
      const absorbed = absorbFatalStreamError(eioErr, { kind: "uncaughtException" }, {
        captureException: (err, ctx) => { captured.push({ err, ctx }); },
        warn: (obj, msg) => { warned.push({ obj, msg }); },
      });

      assert.equal(absorbed, true, "EIO must be absorbed so the caller skips exit");
      assert.equal(exitCalls.length, 0, "process.exit must not be invoked");
      assert.equal(captured.length, 1, "Sentry must capture the absorbed error once");
      assert.equal(warned.length, 1, "logger.warn must record the absorption");

      const ctx = captured[0]!.ctx as { tags?: Record<string, string> };
      assert.equal(ctx.tags?.["fatal"], "stdio-stream-error-absorbed");
      assert.equal(ctx.tags?.["kind"], "uncaughtException");
      assert.equal(ctx.tags?.["code"], "EIO");
    } finally {
      (process as unknown as { exit: typeof originalExit }).exit = originalExit;
    }
  });

  it("absorbFatalStreamError reports only once across repeated EIOs", () => {
    const captured: Array<{ err: unknown; ctx: unknown }> = [];
    const deps = {
      captureException: (err: unknown, ctx: unknown) => { captured.push({ err, ctx }); },
      warn: () => {},
    };

    assert.equal(absorbFatalStreamError(makeEioError(), { kind: "uncaughtException" }, deps), true);
    assert.equal(absorbFatalStreamError(makeEioError(), { kind: "uncaughtException" }, deps), true);
    assert.equal(absorbFatalStreamError(makeEpipeError(), { kind: "unhandledRejection" }, deps), true);

    assert.equal(captured.length, 1, "only the first absorbed error reports to Sentry");
  });

  it("absorbFatalStreamError returns false for non-stream errors so fatalExit runs normally", () => {
    const captured: Array<unknown> = [];
    const result = absorbFatalStreamError(
      new Error("regular crash"),
      { kind: "uncaughtException" },
      {
        captureException: (err) => { captured.push(err); },
        warn: () => {},
      },
    );
    assert.equal(result, false, "non-stream errors must not be absorbed");
    assert.equal(captured.length, 0, "Sentry must not be called for non-stream errors here");
  });

  it("is idempotent — calling installStdioGuard twice does not double-register listeners", () => {
    installStdioGuard();
    installStdioGuard();
    installStdioGuard();

    assert.equal(
      stdoutEmitter.listenerCount("error"),
      1,
      "stdout should have exactly one error listener after repeated install",
    );
    assert.equal(
      stderrEmitter.listenerCount("error"),
      1,
      "stderr should have exactly one error listener after repeated install",
    );
  });
});

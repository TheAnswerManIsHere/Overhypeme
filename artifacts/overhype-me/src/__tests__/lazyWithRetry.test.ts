import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Capture the wrapped factory passed to React.lazy() so we can drive it
// directly without rendering through Suspense. The wrapper is the unit we
// actually want to test — React.lazy() itself is just a thin pass-through
// that invokes the factory once and caches the result.
let capturedFactory: (() => Promise<{ default: unknown }>) | null = null;

vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  return {
    ...actual,
    lazy: (factory: () => Promise<{ default: unknown }>) => {
      capturedFactory = factory;
      // Return a sentinel — the test never renders this, it only inspects
      // capturedFactory. Casting to unknown lets the import keep its types.
      return { __isLazySentinel: true } as unknown as ReturnType<typeof actual.lazy>;
    },
  };
});

import { lazyWithRetry } from "@/lib/lazy-retry";

const RETRY_DELAY_MS = 400;

beforeEach(() => {
  capturedFactory = null;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("lazyWithRetry", () => {
  it("resolves with the module on the first try (success path)", async () => {
    const Component = () => null;
    const factory = vi.fn(() => Promise.resolve({ default: Component }));

    lazyWithRetry(factory as unknown as () => Promise<{ default: React.ComponentType<object> }>);
    expect(capturedFactory).not.toBeNull();

    const result = await capturedFactory!();

    expect(result).toEqual({ default: Component });
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("retries the factory after ~400 ms when the first attempt fails, then resolves", async () => {
    const Component = () => null;
    const factory = vi
      .fn<() => Promise<{ default: typeof Component }>>()
      .mockRejectedValueOnce(new Error("chunk load failed"))
      .mockResolvedValueOnce({ default: Component });

    lazyWithRetry(factory as unknown as () => Promise<{ default: React.ComponentType<object> }>);
    const wrapped = capturedFactory!();

    // Allow the initial rejected promise to be observed by the .catch handler.
    await Promise.resolve();
    expect(factory).toHaveBeenCalledTimes(1);

    // Advance just under the retry delay — the factory should NOT have been
    // called again yet.
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS - 1);
    expect(factory).toHaveBeenCalledTimes(1);

    // Crossing the 400 ms mark triggers the retry.
    await vi.advanceTimersByTimeAsync(1);
    expect(factory).toHaveBeenCalledTimes(2);

    const result = await wrapped;
    expect(result).toEqual({ default: Component });
  });

  it("calls window.location.reload and never settles when both attempts fail (no Sentry noise)", async () => {
    const reload = vi.fn();
    // jsdom marks window.location.reload as non-configurable; redefine the
    // whole `location` object so we can spy on reload without touching the
    // original.
    const originalLocation = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: { ...originalLocation, reload },
    });

    try {
      const factory = vi
        .fn<() => Promise<{ default: React.ComponentType<object> }>>()
        .mockRejectedValueOnce(new Error("first failure"))
        .mockRejectedValueOnce(new Error("second failure"));

      lazyWithRetry(factory);
      const wrapped = capturedFactory!();

      // Track whether the wrapped promise ever settles. It must not — the
      // page is being replaced by reload(), and a rejection here would
      // bubble out to the Suspense boundary as Sentry noise.
      let settled = false;
      wrapped.then(
        () => { settled = true; },
        () => { settled = true; },
      );

      // Let the initial rejection register.
      await Promise.resolve();
      expect(factory).toHaveBeenCalledTimes(1);
      expect(reload).not.toHaveBeenCalled();

      // Trigger the retry attempt.
      await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS);
      expect(factory).toHaveBeenCalledTimes(2);

      // Flush the second rejection's microtasks so the inner .catch runs
      // and invokes window.location.reload().
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
      await Promise.resolve();

      expect(reload).toHaveBeenCalledTimes(1);

      // Run any remaining timers to give the promise a chance to (incorrectly)
      // settle. It should remain pending forever.
      await vi.advanceTimersByTimeAsync(10_000);
      await Promise.resolve();
      await Promise.resolve();

      expect(settled).toBe(false);
    } finally {
      Object.defineProperty(window, "location", {
        configurable: true,
        writable: true,
        value: originalLocation,
      });
    }
  });
});

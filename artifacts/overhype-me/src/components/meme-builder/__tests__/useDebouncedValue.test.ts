import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useDebouncedValue } from "../hooks/useDebouncedValue";

describe("useDebouncedValue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the initial value immediately", () => {
    const { result } = renderHook(() => useDebouncedValue("a", 150));
    expect(result.current).toBe("a");
  });

  it("delays updates by the configured ms", () => {
    const { result, rerender } = renderHook(
      ({ value }: { value: string }) => useDebouncedValue(value, 150),
      { initialProps: { value: "a" } },
    );

    rerender({ value: "b" });
    // Not yet — within debounce window.
    expect(result.current).toBe("a");

    act(() => { vi.advanceTimersByTime(149); });
    expect(result.current).toBe("a");

    act(() => { vi.advanceTimersByTime(2); });
    expect(result.current).toBe("b");
  });

  it("rapidly changing input only commits the final value once", () => {
    const { result, rerender } = renderHook(
      ({ value }: { value: number }) => useDebouncedValue(value, 150),
      { initialProps: { value: 0 } },
    );

    for (let i = 1; i <= 10; i++) {
      rerender({ value: i });
      act(() => { vi.advanceTimersByTime(50); });
    }
    expect(result.current).toBe(0); // none of the intermediate ticks crossed 150ms idle

    act(() => { vi.advanceTimersByTime(150); });
    expect(result.current).toBe(10);
  });
});

import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useAutoSelectDefault } from "../hooks/useAutoSelectDefault";

describe("useAutoSelectDefault", () => {
  it("does nothing while disabled", () => {
    const onSelect = vi.fn();
    renderHook(() =>
      useAutoSelectDefault<string>({
        enabled: false,
        identityKey: "k",
        resolveDefault: () => "value",
        onSelect,
      }),
    );
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("does nothing when identityKey is null", () => {
    const onSelect = vi.fn();
    renderHook(() =>
      useAutoSelectDefault<string>({
        enabled: true,
        identityKey: null,
        resolveDefault: () => "value",
        onSelect,
      }),
    );
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("does nothing when resolveDefault returns null", () => {
    const onSelect = vi.fn();
    renderHook(() =>
      useAutoSelectDefault<string>({
        enabled: true,
        identityKey: "k",
        resolveDefault: () => null,
        onSelect,
      }),
    );
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("fires onSelect exactly once for the same identityKey across re-renders", () => {
    const onSelect = vi.fn();
    const { rerender } = renderHook(
      ({ resolveDefault }: { resolveDefault: () => string | null }) =>
        useAutoSelectDefault<string>({
          enabled: true,
          identityKey: "k",
          resolveDefault,
          onSelect,
        }),
      { initialProps: { resolveDefault: () => "value-1" } },
    );
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("value-1");
    // Re-render with a fresh resolver — must NOT fire again because identityKey is unchanged.
    rerender({ resolveDefault: () => "value-2" });
    rerender({ resolveDefault: () => "value-3" });
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("re-arms and fires again when identityKey changes", () => {
    const onSelect = vi.fn();
    const { rerender } = renderHook(
      ({ identityKey }: { identityKey: string }) =>
        useAutoSelectDefault<string>({
          enabled: true,
          identityKey,
          resolveDefault: () => `resolved-${identityKey}`,
          onSelect,
        }),
      { initialProps: { identityKey: "a" } },
    );
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenLastCalledWith("resolved-a");

    rerender({ identityKey: "b" });
    expect(onSelect).toHaveBeenCalledTimes(2);
    expect(onSelect).toHaveBeenLastCalledWith("resolved-b");

    rerender({ identityKey: "b" });
    expect(onSelect).toHaveBeenCalledTimes(2);
  });

  it("becomes enabled after the default resolves (e.g. data finishes loading)", () => {
    const onSelect = vi.fn();
    let images: string[] = [];
    const { rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        useAutoSelectDefault<string>({
          enabled,
          identityKey: "preselected",
          resolveDefault: () => images.find((i) => i === "preselected") ?? null,
          onSelect,
        }),
      { initialProps: { enabled: false } },
    );
    expect(onSelect).not.toHaveBeenCalled();

    // Data arrives, picker becomes enabled — auto-select fires.
    images = ["preselected"];
    rerender({ enabled: true });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("preselected");
  });
});

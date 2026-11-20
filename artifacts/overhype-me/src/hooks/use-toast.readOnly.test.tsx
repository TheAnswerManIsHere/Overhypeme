/**
 * Issue #1107: while read-only, a refused comment showed "Failed to post
 * comment / Please try again." because the form's own toast replaced the one
 * saying why. Only one toast shows, so the refusal's must be the one left.
 */
import { afterEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { toast, useToast } from "./use-toast";
import { __resetReadOnlyNoticeForTests, noteReadOnlyRefusal, READ_ONLY_REFUSED_TITLE } from "@/lib/readOnlyNotice";

afterEach(() => __resetReadOnlyNoticeForTests());

describe("the toast shown after a read-only refusal", () => {
  it("is the refusal's, whether the form's failure toast comes after it or before it", () => {
    const { result } = renderHook(() => useToast());

    act(() => {
      noteReadOnlyRefusal();
      toast({ title: READ_ONLY_REFUSED_TITLE });
      toast({ title: "Failed to post comment", variant: "destructive" });
    });
    expect(result.current.toasts.filter((t) => t.open).map((t) => t.title)).toEqual([READ_ONLY_REFUSED_TITLE]);

    __resetReadOnlyNoticeForTests();
    act(() => {
      toast({ title: "Failed to post comment", variant: "destructive" });
      noteReadOnlyRefusal();
      toast({ title: READ_ONLY_REFUSED_TITLE });
    });
    expect(result.current.toasts[0].title).toBe(READ_ONLY_REFUSED_TITLE);
  });

  it("is untouched when nothing was refused", () => {
    const { result } = renderHook(() => useToast());
    act(() => {
      toast({ title: "Failed to post comment", variant: "destructive" });
    });
    expect(result.current.toasts[0].title).toBe("Failed to post comment");
  });
});

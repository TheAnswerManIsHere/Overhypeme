/**
 * The site-wide read-only banner (Issue #1107): while read-only mode is on it
 * reads David's maintenance wording, exactly; while off it is not shown.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ReadOnlyNotice } from "./ReadOnlyNotice";
import { __resetReadOnlyNoticeForTests, setReadOnlyNow } from "@/lib/readOnlyNotice";

const WORDING =
  "Overhype.me is undergoing maintenance. Real men get pedicures. Keep browsing but the site is read-only until we're done waiting for our toes to dry.";

function stubConfig(readOnlyMode: boolean) {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ readOnlyMode }) })) as unknown as typeof fetch);
}

afterEach(() => {
  vi.unstubAllGlobals();
  __resetReadOnlyNoticeForTests();
});

describe("the read-only banner", () => {
  it("reads the maintenance wording exactly while read-only mode is on", () => {
    stubConfig(true);
    setReadOnlyNow(true);
    render(<ReadOnlyNotice />);
    expect(screen.getByTestId("read-only-notice").textContent).toBe(WORDING);
  });

  it("is not shown while read-only mode is off", () => {
    stubConfig(false);
    render(<ReadOnlyNotice />);
    expect(screen.queryByTestId("read-only-notice")).toBeNull();
  });
});

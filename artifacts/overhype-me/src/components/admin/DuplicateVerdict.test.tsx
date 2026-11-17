/**
 * The duplicate verdict at triage (plan docs/plans/PLAN_DUPLICATE_VERDICT.md):
 * every state reads as a verdict, never a percentage; Couldn't check shows the
 * closest fact without a click; Not a duplicate offers it behind a click; and
 * the on-open check applies only to the wording it was asked about and never
 * lets a superseded answer restore an older verdict.
 */
import { useState } from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import {
  DuplicateMatchPanel,
  DuplicateVerdictLine,
  NOT_CHECKED,
  useDuplicateCheck,
  verdictLabel,
  type DuplicateView,
} from "./DuplicateVerdict";

afterEach(() => vi.unstubAllGlobals());

const FACT = { id: 41, text: "{NAME} can hear sign language." };
const PENDING = { id: 6800, text: "{NAME} can hear sign languages!" };

function Verdict({ view, failed = false, checking = false }: { view: DuplicateView; failed?: boolean; checking?: boolean }) {
  const [showClosest, setShowClosest] = useState(false);
  return (
    <div>
      <DuplicateVerdictLine view={view} checking={checking} failed={failed} canCheck onRetry={() => {}} showClosest={showClosest} onShowClosest={() => setShowClosest(true)} />
      <DuplicateMatchPanel view={view} showClosest={showClosest} />
    </div>
  );
}

describe("the verdict line and the match panel", () => {
  it("words every state as a verdict, with no percentage anywhere", () => {
    expect(verdictLabel({ state: "duplicate", fact: FACT, review: null })).toBe("Duplicate of #41");
    expect(verdictLabel({ state: "duplicate", fact: null, review: PENDING })).toBe("Duplicate of pending review #6800");
    expect(verdictLabel({ state: "distinct", fact: FACT, review: null })).toBe("Not a duplicate");
    expect(verdictLabel({ state: "unavailable", fact: FACT, review: null })).toBe("Couldn't check");
    expect(verdictLabel(NOT_CHECKED)).toBe("Not checked yet");
    const { container } = render(<Verdict view={{ state: "duplicate", fact: FACT, review: null }} />);
    expect(container.textContent).not.toMatch(/%/);
  });

  it("a duplicate shows its match: a fact with a link, or the pending review it matches", () => {
    const { unmount } = render(<Verdict view={{ state: "duplicate", fact: FACT, review: null }} />);
    expect(screen.getByTestId("duplicate-match").textContent).toContain(FACT.text);
    expect(screen.getByText("View").closest("a")?.getAttribute("href")).toBe("/facts/41");
    unmount();
    render(<Verdict view={{ state: "duplicate", fact: null, review: PENDING }} />);
    expect(screen.getByTestId("duplicate-match").textContent).toContain("Matches pending review #6800");
  });

  it("Couldn't check shows the closest fact straight away, with Try again", () => {
    render(<Verdict view={{ state: "unavailable", fact: FACT, review: null }} />);
    expect(screen.getByTestId("duplicate-match").textContent).toContain(FACT.text);
    expect(screen.getByText("Try again")).toBeTruthy();
  });

  it("Not a duplicate keeps the closest fact behind Show closest fact", () => {
    render(<Verdict view={{ state: "distinct", fact: FACT, review: null }} />);
    expect(screen.queryByTestId("duplicate-match")).toBeNull();
    fireEvent.click(screen.getByText("Show closest fact"));
    expect(screen.getByTestId("duplicate-match").textContent).toContain(FACT.text);
  });

  it("a failed check request reads Couldn't check; a running one reads Checking", () => {
    const { unmount } = render(<Verdict view={NOT_CHECKED} failed />);
    expect(screen.getByTestId("duplicate-verdict").getAttribute("data-state")).toBe("unavailable");
    unmount();
    render(<Verdict view={NOT_CHECKED} checking />);
    expect(screen.getByTestId("duplicate-verdict").textContent).toContain("Checking for duplicates…");
  });
});

// ── the on-open check ────────────────────────────────────────────────────────

type Pending = { resolve: (body: unknown) => void };
function deferredFetch(): Pending[] {
  const pending: Pending[] = [];
  vi.stubGlobal("fetch", vi.fn(() => new Promise((res) => {
    pending.push({ resolve: (body) => res({ ok: true, status: 200, json: async () => body }) });
  })) as unknown as typeof fetch);
  return pending;
}

function Harness({ text, canCheck = true, initial = NOT_CHECKED, onChecked = () => {}, expose }: {
  text: string; canCheck?: boolean; initial?: DuplicateView; onChecked?: () => void;
  expose?: (api: ReturnType<typeof useDuplicateCheck>) => void;
}) {
  const [view, setView] = useState<DuplicateView>(initial);
  const api = useDuplicateCheck({ reviewId: 7, submittedText: text, view, canCheck, onView: setView, onChecked });
  expose?.(api);
  return <span data-testid="state">{api.checking ? "checking" : view.state}</span>;
}

describe("the on-open check", () => {
  it("checks a review with no verdict once on opening, and applies the answer for its wording", async () => {
    const pending = deferredFetch();
    const onChecked = vi.fn();
    render(<Harness text="{NAME} a" onChecked={onChecked} />);
    await waitFor(() => expect(pending).toHaveLength(1));
    expect(screen.getByTestId("state").textContent).toBe("checking");
    await act(async () => pending[0]!.resolve({ submittedText: "{NAME} a", duplicate: { state: "duplicate", fact: FACT, review: null } }));
    await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("duplicate"));
    expect(onChecked).toHaveBeenCalledTimes(1);
  });

  it("does not check a review with a usable verdict, or one past triage", async () => {
    const pending = deferredFetch();
    const { unmount } = render(<Harness text="{NAME} a" initial={{ state: "distinct", fact: null, review: null }} />);
    unmount();
    render(<Harness text="{NAME} a" canCheck={false} />);
    await new Promise((r) => setTimeout(r, 10));
    expect(pending).toHaveLength(0);
  });

  it("drops an answer for wording that has since changed", async () => {
    const pending = deferredFetch();
    const { rerender } = render(<Harness text="{NAME} old" />);
    await waitFor(() => expect(pending).toHaveLength(1));
    rerender(<Harness text="{NAME} new" />);
    await act(async () => pending[0]!.resolve({ submittedText: "{NAME} old", duplicate: { state: "duplicate", fact: FACT, review: null } }));
    expect(screen.getByTestId("state").textContent).not.toBe("duplicate");
  });

  it("a wording save supersedes a check in flight: its late answer cannot restore the old verdict", async () => {
    const pending = deferredFetch();
    let api!: ReturnType<typeof useDuplicateCheck>;
    render(<Harness text="{NAME} a" expose={(a) => { api = a; }} />);
    await waitFor(() => expect(pending).toHaveLength(1));
    act(() => api.supersede());
    await act(async () => pending[0]!.resolve({ submittedText: "{NAME} a", duplicate: { state: "duplicate", fact: FACT, review: null } }));
    expect(screen.getByTestId("state").textContent).toBe("not_checked");
  });

  it("an older Try again cannot overwrite a newer one", async () => {
    const pending = deferredFetch();
    let api!: ReturnType<typeof useDuplicateCheck>;
    render(<Harness text="{NAME} a" initial={{ state: "unavailable", fact: null, review: null }} canCheck expose={(a) => { api = a; }} />);
    await waitFor(() => expect(pending).toHaveLength(1));
    await act(async () => { void api.check(); });
    await act(async () => pending[1]!.resolve({ submittedText: "{NAME} a", duplicate: { state: "distinct", fact: null, review: null } }));
    await act(async () => pending[0]!.resolve({ submittedText: "{NAME} a", duplicate: { state: "duplicate", fact: FACT, review: null } }));
    expect(screen.getByTestId("state").textContent).toBe("distinct");
  });
});

/**
 * MarkMajorUpdateModal — the guarded confirm for a corpus-wide engine-revision
 * bump. Covers the confirm path (POSTs the trimmed note, hands back the new
 * revision) and the cancel path (no request).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { MarkMajorUpdateModal } from "./MarkMajorUpdateModal";

function mockFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const fetchMock = vi.fn(async (url: string, opts?: RequestInit) => {
    calls.push({
      url: String(url),
      method: opts?.method ?? "GET",
      body: opts?.body ? JSON.parse(String(opts.body)) : undefined,
    });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MarkMajorUpdateModal", () => {
  it("shows the current → next revision and the corpus-wide warning", () => {
    render(<MarkMajorUpdateModal currentRevision={3} onCancel={() => {}} onDone={() => {}} />);
    expect(screen.getByText(/Engine revision 3/)).toBeTruthy();
    expect(screen.getByText(/entire corpus/i)).toBeTruthy();
  });

  it("POSTs the trimmed note and reports the new revision on confirm", async () => {
    const { calls } = mockFetch(200, { success: true, engineRevision: 4, previousRevision: 3 });
    const onDone = vi.fn();
    render(<MarkMajorUpdateModal currentRevision={3} onCancel={() => {}} onDone={onDone} />);

    fireEvent.change(screen.getByTestId("mark-major-update-note"), {
      target: { value: "  switched enricher  " },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("mark-major-update-confirm"));
    });

    await waitFor(() => expect(onDone).toHaveBeenCalledWith({ engineRevision: 4, previousRevision: 3 }));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("/api/admin/taxonomy-health/actions/mark-major-update");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.body).toEqual({ note: "switched enricher" });
  });

  it("sends note undefined when the textarea is blank", async () => {
    const { calls } = mockFetch(200, { success: true, engineRevision: 2, previousRevision: 1 });
    render(<MarkMajorUpdateModal currentRevision={1} onCancel={() => {}} onDone={vi.fn()} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("mark-major-update-confirm"));
    });
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.body).toEqual({});
  });

  it("cancel fires onCancel and never calls the endpoint", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const onCancel = vi.fn();
    render(<MarkMajorUpdateModal currentRevision={3} onCancel={onCancel} onDone={() => {}} />);
    fireEvent.click(screen.getByText("Cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows a server error and does not call onDone", async () => {
    mockFetch(400, { error: "note must be 2000 characters or fewer" });
    const onDone = vi.fn();
    render(<MarkMajorUpdateModal currentRevision={3} onCancel={() => {}} onDone={onDone} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("mark-major-update-confirm"));
    });
    await waitFor(() => expect(screen.getByTestId("mark-major-update-error")).toBeTruthy());
    expect(onDone).not.toHaveBeenCalled();
  });
});

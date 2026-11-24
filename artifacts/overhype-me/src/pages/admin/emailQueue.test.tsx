/**
 * The Email Queue page speaks the server's job vocabulary (Issue #1000,
 * increment 3; PR #1026 round 1). An email held back because it may already
 * have gone out is `failed`, and a person must be able to find it, read why,
 * and send it with Retry from here (David's Q14: 2).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/components/admin/AdminLayout", () => ({
  AdminLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import AdminEmailQueue from "./emailQueue";

const HELD_BACK = {
  id: 4242,
  to: "held@example.test",
  subject: "Held back for a person",
  text: "body",
  html: null,
  kind: null,
  status: "failed",
  attempts: 1,
  maxAttempts: 5,
  lastError: "An earlier version of the server may already have sent this email without duplicate protection; it was not sent again. Retry it from the email queue to send it anyway.",
  nextAttemptAt: new Date().toISOString(),
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

function stubApi(rows: unknown[]) {
  const calls: Array<{ url: string; method: string }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET" });
    if (url.includes("/retry")) {
      return new Response(JSON.stringify({ success: true, row: { ...HELD_BACK, status: "recovering" } }), { status: 200 });
    }
    return new Response(JSON.stringify({ rows, total: rows.length, page: 1, limit: 50, retentionDays: 30, validStatuses: [] }), { status: 200 });
  }));
  return calls;
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("AdminEmailQueue", () => {
  it("offers Retry on a held-back (failed) email, with its reason, and posts the retry", async () => {
    const calls = stubApi([HELD_BACK]);
    render(<AdminEmailQueue />);
    fireEvent.click((await screen.findAllByText("Held back for a person"))[0]!);
    expect((await screen.findAllByText(/may already have sent this email/)).length).toBeGreaterThan(0);
    // The list's row and the opened detail view each offer it.
    const retries = await screen.findAllByRole("button", { name: /^retry$/i });
    expect(retries.length).toBe(2);
    fireEvent.click(retries[retries.length - 1]!);
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.url.endsWith(`/api/admin/email-queue/${HELD_BACK.id}/retry`))).toBe(true));
  });

  it("filters on the statuses the server returns", async () => {
    const calls = stubApi([]);
    render(<AdminEmailQueue />);
    fireEvent.click(await screen.findByRole("button", { name: "Abandoned", exact: true } as never));
    await waitFor(() => expect(calls.some((c) => c.url.includes("status=failed"))).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Finished", exact: true } as never));
    await waitFor(() => expect(calls.some((c) => c.url.includes("status=done"))).toBe(true));
  });
});

/**
 * @purpose The Missed Stripe events panel (Issue #1244): it lists what the payment alert counts, replays only after a confirm, shows the row running and then its result, re-reads the list, and shows an unjudgeable check and an empty list as different things.
 * @subsystem payments
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MissedStripeEventsPanel } from "./MissedStripeEventsPanel";

const EVENT = { id: "evt_1UejZRBoYd2wqzWnwrUPw27K", type: "invoice.upcoming", created: "2026-11-22T23:02:37.000Z" };

afterEach(() => vi.unstubAllGlobals());

function stub(lists: unknown[], replay: { status: number; body: unknown } = { status: 200, body: { outcome: "processed" } }) {
  let listCall = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/admin/stripe/missed-events") {
      const body = lists[Math.min(listCall++, lists.length - 1)];
      return { ok: true, status: 200, json: async () => body } as Response;
    }
    if (url.endsWith("/replay") && init?.method === "POST") {
      await gate;
      return { ok: replay.status < 400, status: replay.status, json: async () => replay.body } as Response;
    }
    throw new Error(`unexpected ${url}`);
  });
  vi.stubGlobal("fetch", fn);
  return { fn, release: () => release() };
}

describe("MissedStripeEventsPanel", () => {
  it("lists each missed event and replays it only after the confirm, showing it running, then its result", async () => {
    const { fn, release } = stub([{ status: "ok", unprocessed: 1, events: [EVENT] }, { status: "ok", unprocessed: 0, events: [] }]);
    render(<MissedStripeEventsPanel />);
    expect(await screen.findByText("invoice.upcoming")).toBeTruthy();
    expect(screen.getByText(EVENT.id)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Replay" }));
    expect(fn.mock.calls.some(([u]) => String(u).endsWith("/replay"))).toBe(false);
    expect(screen.getByText(/same effect as its\s+original delivery/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Replay event" }));
    await waitFor(() => expect(fn.mock.calls.some(([u, i]) => u === `/api/admin/stripe/missed-events/${EVENT.id}/replay` && (i as RequestInit).method === "POST")).toBe(true));
    expect(screen.getByRole("button", { name: /Replaying/ })).toBeTruthy();
    release();
    expect(await screen.findByText(/processed as its delivery would have been/)).toBeTruthy();
    expect(await screen.findByText(/Every event Stripe sent has been processed/)).toBeTruthy();
  });

  it("Cancel closes the confirm without replaying", async () => {
    const { fn } = stub([{ status: "ok", unprocessed: 1, events: [EVENT] }]);
    render(<MissedStripeEventsPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Replay" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Replay" })).toBeTruthy();
    expect(fn.mock.calls.some(([u]) => String(u).endsWith("/replay"))).toBe(false);
  });

  it("an already-processed event reads plainly", async () => {
    const { release } = stub([{ status: "ok", unprocessed: 1, events: [EVENT] }], { status: 200, body: { outcome: "already_processed" } });
    render(<MissedStripeEventsPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Replay" }));
    fireEvent.click(screen.getByRole("button", { name: "Replay event" }));
    release();
    expect(await screen.findByText(/Already processed — nothing was changed/)).toBeTruthy();
  });

  it("a refusal says why", async () => {
    const { release } = stub([{ status: "ok", unprocessed: 1, events: [EVENT] }], { status: 409, body: { outcome: "refused", reason: "wrong_mode" } });
    render(<MissedStripeEventsPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Replay" }));
    fireEvent.click(screen.getByRole("button", { name: "Replay event" }));
    release();
    expect(await screen.findByText(/belongs to the other Stripe mode/)).toBeTruthy();
  });

  it("a replay whose request is lost says the result is not known, that replaying is safe, and re-reads the list", async () => {
    let listCalls = 0;
    const fn = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/admin/stripe/missed-events") {
        listCalls++;
        return { ok: true, status: 200, json: async () => ({ status: "ok", unprocessed: 1, events: [EVENT] }) } as Response;
      }
      if (url.endsWith("/replay") && init?.method === "POST") throw new TypeError("Failed to fetch");
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal("fetch", fn);
    render(<MissedStripeEventsPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Replay" }));
    fireEvent.click(screen.getByRole("button", { name: "Replay event" }));
    expect(await screen.findByText(/did not come back \(the connection was lost\).*Replaying it again is safe/)).toBeTruthy();
    expect(screen.queryByText(/Processing failed/)).toBeNull();
    await waitFor(() => expect(listCalls).toBe(2));
    expect(screen.getByRole("button", { name: "Replay" })).toBeTruthy();
  });

  it("an answer with no verdict (a gateway page) is not shown as a failure", async () => {
    const fn = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/admin/stripe/missed-events") return { ok: true, status: 200, json: async () => ({ status: "ok", unprocessed: 1, events: [EVENT] }) } as Response;
      if (url.endsWith("/replay") && init?.method === "POST") {
        return { ok: false, status: 504, json: async () => { throw new SyntaxError("Unexpected token <"); } } as unknown as Response;
      }
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal("fetch", fn);
    render(<MissedStripeEventsPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Replay" }));
    fireEvent.click(screen.getByRole("button", { name: "Replay event" }));
    expect(await screen.findByText(/did not come back \(HTTP 504\)/)).toBeTruthy();
    expect(screen.queryByText(/Processing failed/)).toBeNull();
  });

  it("an answer that is JSON but not a verdict (an auth error) is not shown as a failure either", async () => {
    const fn = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/admin/stripe/missed-events") return { ok: true, status: 200, json: async () => ({ status: "ok", unprocessed: 1, events: [EVENT] }) } as Response;
      if (url.endsWith("/replay") && init?.method === "POST") return { ok: false, status: 500, json: async () => ({ error: "The replay could not be started" }) } as Response;
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal("fetch", fn);
    render(<MissedStripeEventsPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Replay" }));
    fireEvent.click(screen.getByRole("button", { name: "Replay event" }));
    expect(await screen.findByText(/did not come back \(HTTP 500\)/)).toBeTruthy();
  });

  it("a failure the server reported still reads as a failure, with its reason", async () => {
    const { release } = stub([{ status: "ok", unprocessed: 1, events: [EVENT] }], { status: 502, body: { outcome: "failed", reason: "lease busy" } });
    render(<MissedStripeEventsPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Replay" }));
    fireEvent.click(screen.getByRole("button", { name: "Replay event" }));
    release();
    expect(await screen.findByText(/Processing failed; the event can be replayed again\. lease busy/)).toBeTruthy();
  });

  it("a check that could not run is said so, and is not shown as an empty list", async () => {
    stub([{ status: "unjudgeable", reason: "stripe_unavailable" }]);
    render(<MissedStripeEventsPanel />);
    expect(await screen.findByText(/Stripe could not be reached/)).toBeTruthy();
    expect(screen.queryByText(/Every event Stripe sent has been processed/)).toBeNull();
  });
});

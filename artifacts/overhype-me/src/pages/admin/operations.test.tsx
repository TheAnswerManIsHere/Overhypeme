/**
 * The Operations page never shows a reading it does not have (launch Phase 16,
 * Issue #1029): a failed first load is not a healthy page, incidents Sentry
 * cannot supply read "unavailable" rather than "none", and the test alert
 * says whether it will ring.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/components/admin/AdminLayout", () => ({
  AdminLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import AdminOperations from "./operations";

const LANE = { lane: "render", liveInstanceCount: 1, lastScheduledAt: new Date().toISOString(), inFlightCount: 0, stalled: false };

function stub(payload: unknown, rings = true, status = 200) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).includes("/test-alert")) {
      return new Response(JSON.stringify({ sent: true, rings }), { status: 200 });
    }
    return new Response(JSON.stringify(payload), { status });
  }));
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Operations page", () => {
  it("says a failed first load is not a healthy reading", async () => {
    stub({ error: "boom" }, true, 500);
    render(<AdminOperations />);
    expect((await screen.findByTestId("operations-load-error")).textContent).toContain("not a healthy reading");
    expect(screen.queryByTestId("operations-lanes")).toBeNull();
  });

  it("shows incidents as unavailable, not as none, when Sentry cannot be read", async () => {
    stub({ checkedAt: new Date().toISOString(), lanes: { status: "ok", lanes: [LANE] }, incidents: { status: "unavailable", reason: "unreachable" } });
    render(<AdminOperations />);
    expect((await screen.findByTestId("operations-incidents-unavailable")).textContent).toContain("Unavailable");
    expect(screen.queryByTestId("operations-incidents-none")).toBeNull();
    expect(screen.getByTestId("operations-lanes").textContent).toContain("running");
  });

  it("lists incidents with their source and a link to Sentry", async () => {
    stub({
      checkedAt: new Date().toISOString(),
      lanes: { status: "ok", lanes: [{ ...LANE, stalled: true }] },
      incidents: { status: "ok", incidents: [{ title: "Downtime detected", source: "site_down", label: "Site down", lastSeen: new Date().toISOString(), count: 3, link: "https://sentry.example/1" }] },
    });
    render(<AdminOperations />);
    const list = await screen.findByTestId("operations-incidents");
    expect(list.textContent).toContain("Site down");
    expect(screen.getByRole("link", { name: /Open in Sentry/ }).getAttribute("href")).toBe("https://sentry.example/1");
    expect(screen.getByTestId("operations-lanes").textContent).toContain("stopped");
  });

  it("says a test alert from a non-live site does not ring", async () => {
    stub({ checkedAt: new Date().toISOString(), lanes: { status: "ok", lanes: [] }, incidents: { status: "ok", incidents: [] } }, false);
    render(<AdminOperations />);
    fireEvent.click(await screen.findByTestId("operations-test-alert"));
    await waitFor(() => expect(screen.getByTestId("operations-test-sent").textContent).toContain("does not ring"));
  });
});

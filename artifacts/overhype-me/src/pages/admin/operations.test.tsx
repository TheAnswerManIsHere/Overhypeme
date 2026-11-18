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

function stub(payload: unknown, rings: boolean | "not_connected" = true, status = 200) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).includes("/test-alert")) {
      return new Response(JSON.stringify(rings === "not_connected" ? { sent: false, reason: "not_connected" } : { sent: true, rings }), { status: 200 });
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
      incidents: { status: "ok", incidents: [{ title: "Downtime detected", source: "site_down", label: "Site down", ongoing: false, lastSeen: new Date().toISOString(), count: 3, link: "https://sentry.example/1" }] },
    });
    render(<AdminOperations />);
    const list = await screen.findByTestId("operations-incidents");
    expect(list.textContent).toContain("Site down");
    expect(list.textContent).toContain("resolved");
    expect(screen.getByRole("link", { name: /Open in Sentry/ }).getAttribute("href")).toBe("https://sentry.example/1");
    expect(screen.getByTestId("operations-lanes").textContent).toContain("stopped");
  });

  it("says plainly when the server is not connected to Sentry, never that it sent", async () => {
    stub({ checkedAt: new Date().toISOString(), lanes: { status: "ok", lanes: [] }, incidents: { status: "ok", incidents: [] } }, "not_connected");
    render(<AdminOperations />);
    fireEvent.click(await screen.findByTestId("operations-test-alert"));
    await waitFor(() => expect(screen.getByTestId("operations-test-not-connected").textContent).toContain("not connected to Sentry"));
    expect(screen.queryByTestId("operations-test-sent")).toBeNull();
  });

  it("says a test alert from a non-live site does not ring", async () => {
    stub({ checkedAt: new Date().toISOString(), lanes: { status: "ok", lanes: [] }, incidents: { status: "ok", incidents: [] } }, false);
    render(<AdminOperations />);
    fireEvent.click(await screen.findByTestId("operations-test-alert"));
    await waitFor(() => expect(screen.getByTestId("operations-test-sent").textContent).toContain("does not ring"));
  });
  const verdict = (over: Record<string, unknown>) => ({
    checkedAt: new Date().toISOString(),
    healthy: true,
    tasks: { status: "ok", healthy: true, detail: [{ id: "content_purge", label: "Deleted content purge", cadenceMs: 3_600_000, lastCompletedAt: new Date().toISOString(), dueBy: new Date().toISOString(), overdue: false }] },
    jobs: { status: "ok", healthy: true, detail: { unclaimedQueues: [], held: [] } },
    payments: { status: "ok", healthy: true, detail: { expected: 4, unprocessed: 0, oldestUnprocessedAt: null } },
    ...over,
  });
  const withAlerts = (health: unknown) => ({
    checkedAt: new Date().toISOString(),
    lanes: { status: "ok", lanes: [LANE] },
    incidents: { status: "ok", incidents: [] },
    alerts: { status: "ok", health },
  });

  it("shows what the uptime check reads, part by part", async () => {
    stub(withAlerts(verdict({})));
    render(<AdminOperations />);
    expect((await screen.findByTestId("operations-alert-verdict")).textContent).toContain("reads 200");
    expect(screen.getByTestId("operations-tasks").textContent).toContain("Deleted content purge");
    expect(screen.getByTestId("operations-payments").textContent).toContain("4 checked");
  });

  it("names the part that is failing, and never calls an unjudged part healthy", async () => {
    stub(withAlerts(verdict({
      healthy: false,
      jobs: { status: "ok", healthy: false, detail: { unclaimedQueues: [], held: [{ id: 7, queue: "operations_drill", heldForMs: 180_000 }] } },
      payments: { status: "unjudgeable", reason: "incomplete" },
    })));
    render(<AdminOperations />);
    expect((await screen.findByTestId("operations-alert-verdict")).textContent).toContain("503");
    expect(screen.getByTestId("operations-jobs").textContent).toContain("operations_drill job 7: held for 3 min");
    expect(screen.getByTestId("operations-payments-unjudgeable").textContent).toContain("not a healthy reading");
    expect(screen.getByTestId("operations-payments-icon-unjudgeable")).toBeTruthy();
  });

  it("says the verdict is unavailable rather than showing nothing", async () => {
    stub({ checkedAt: new Date().toISOString(), lanes: { status: "ok", lanes: [] }, incidents: { status: "ok", incidents: [] }, alerts: { status: "unavailable" } });
    render(<AdminOperations />);
    expect((await screen.findByTestId("operations-alerts-unavailable")).textContent).toContain("not a healthy reading");
  });

  it("starts the drill and says when it will read as stuck", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/drill")) return new Response(JSON.stringify({ started: true, alreadyRunning: false, jobId: 1, holdMinutes: 10, alertAfterMinutes: 2 }), { status: 200 });
      return new Response(JSON.stringify(withAlerts(verdict({}))), { status: 200 });
    }));
    render(<AdminOperations />);
    fireEvent.click(await screen.findByTestId("operations-drill"));
    await waitFor(() => expect(screen.getByTestId("operations-drill-started").textContent).toContain("stuck after 2 minutes"));
  });
});

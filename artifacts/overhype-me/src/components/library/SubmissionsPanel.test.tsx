/**
 * @purpose Proves the Library's Submissions panel opens on the first status that has anything in it (No longer live included), honours a status named in the address even when empty, shows No longer live only when it has items, and draws each card for the status list it is in: progress under review, the reason's label and the team's note when declined, a hidden comment as hidden, and a link to a comment's fact only while the fact is live.
 * @subsystem public-site
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import type { MySubmission, MySubmissionCounts, MySubmissionStatusCounts } from "@workspace/api-client-react";

const api = vi.hoisted(() => ({
  counts: null as unknown as MySubmissionCounts,
  pages: {} as Record<string, MySubmission[]>,
  listCalls: [] as Record<string, unknown>[],
}));

vi.mock("@workspace/api-client-react", () => ({
  getGetMySubmissionCountsQueryKey: (p?: unknown) => ["counts", p],
  getListMySubmissionsQueryKey: (p?: unknown) => ["list", p],
  getMySubmissionCounts: async () => api.counts,
  listMySubmissions: async (p: { type: string; status: string }) => {
    api.listCalls.push(p);
    return { items: api.pages[`${p.type}:${p.status}`] ?? [], nextCursor: null };
  },
}));

vi.mock("@/components/facts/FactCard", () => ({
  FactCard: ({ fact }: { fact: { text: string } }) => <div data-testid="fact-card">{fact.text}</div>,
}));

import { SubmissionsPanel, SubmissionCard, openingStatus } from "./SubmissionsPanel";

const zero: MySubmissionStatusCounts = { review: 0, live: 0, declined: 0, gone: 0 };

function setCounts(facts: Partial<MySubmissionStatusCounts>, comments: Partial<MySubmissionStatusCounts> = {}) {
  api.counts = { totals: { facts: { ...zero, ...facts }, comments: { ...zero, ...comments } }, matches: null };
}

function renderPanel(path: string) {
  const { hook } = memoryLocation({ path });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Router hook={hook}><SubmissionsPanel /></Router>
    </QueryClientProvider>,
  );
}

const base: MySubmission = {
  kind: "review", id: 1, text: "{NAME} waits", hashtags: [], createdAt: "2026-11-18T04:00:00.000Z",
  decidedAt: null, progress: null, reason: null, teamNote: null, fact: null,
  factId: null, factText: null, factLive: null, hidden: null,
};

beforeEach(() => {
  api.pages = {};
  api.listCalls = [];
});

describe("openingStatus", () => {
  it("is the first status with items, in the order Under Review, Approved & Live, Declined, No longer live", () => {
    expect(openingStatus({ ...zero, review: 2, live: 5 })).toBe("review");
    expect(openingStatus({ ...zero, live: 5, declined: 1 })).toBe("live");
    expect(openingStatus({ ...zero, declined: 1, gone: 3 })).toBe("declined");
    expect(openingStatus({ ...zero, gone: 3 })).toBe("gone");
    expect(openingStatus(zero)).toBe("review");
  });
});

describe("SubmissionsPanel", () => {
  it("opens on No longer live when that is the only status with facts, and shows its tab", async () => {
    setCounts({ gone: 1 });
    api.pages["facts:gone"] = [{ ...base, kind: "fact_gone", id: 9, text: "{NAME} was taken down", decidedAt: "2026-10-01T00:00:00.000Z" }];
    renderPanel("/library?tab=submitted");
    expect(await screen.findByText("{NAME} was taken down")).toBeTruthy();
    expect(screen.getByRole("tab", { name: /no longer live/i }).getAttribute("aria-selected")).toBe("true");
  });

  it("opens on No longer live for comments too, when that is all there is", async () => {
    setCounts({ live: 1 }, { gone: 1 });
    api.pages["comments:gone"] = [{ ...base, kind: "comment", id: 4, text: "still funny", factId: 3, factText: "{NAME} left", factLive: false, hidden: false }];
    renderPanel("/library?tab=submitted&type=comments");
    expect(await screen.findByText("still funny")).toBeTruthy();
    expect(screen.getByText("Fact taken down")).toBeTruthy();
    expect(screen.queryByRole("link", { name: /view fact/i })).toBeNull();
  });

  it("hides the No longer live tab when it has nothing, and honours an empty status named in the address", async () => {
    setCounts({ review: 3 });
    renderPanel("/library?tab=submitted&status=declined");
    expect(await screen.findByText("No declined facts.")).toBeTruthy();
    expect(screen.queryByRole("tab", { name: /no longer live/i })).toBeNull();
    expect(api.listCalls.every((p) => p.status === "declined")).toBe(true);
  });

  // Issue #1104: a comment can be visible, hidden for another look, then
  // declined, so the Declined line must not say declined comments never appeared.
  it("explains declined comments without claiming they never appeared", async () => {
    setCounts({ live: 1 }, { declined: 1 });
    api.pages["comments:declined"] = [{ ...base, kind: "comment", id: 7, text: "was up once", factId: 3, factText: "{NAME} x", factLive: true, hidden: false, teamNote: "Off topic." }];
    renderPanel("/library?tab=submitted&type=comments&status=declined");
    expect(await screen.findByText("was up once")).toBeTruthy();
    expect(screen.queryByText(/never appeared/i)).toBeNull();
    expect(screen.getByText(/hidden for another look/i)).toBeTruthy();
  });

  it("says the person has submitted nothing yet when the type is empty", async () => {
    setCounts({});
    renderPanel("/library?tab=submitted");
    expect(await screen.findByText("You haven't submitted any facts yet.")).toBeTruthy();
  });

  it("shows each status tab's count, and its matches while searching", async () => {
    api.counts = {
      totals: { facts: { review: 7, live: 2, declined: 1, gone: 0 }, comments: zero },
      matches: { facts: { review: 2, live: 0, declined: 1, gone: 0 }, comments: zero },
    };
    renderPanel("/library?tab=submitted&q=moon");
    const tabs = await screen.findAllByRole("tab");
    const review = tabs.find((t) => /under review/i.test(t.textContent ?? ""))!;
    await waitFor(() => expect(review.textContent).toMatch(/2 of 7/));
  });
});

describe("SubmissionCard", () => {
  it("shows how far a fact under review has got, without the team's step names", () => {
    render(<SubmissionCard item={{ ...base, progress: "first_look" }} status="review" />);
    expect(screen.getByText(/waiting for a first look/i)).toBeTruthy();
    render(<SubmissionCard item={{ ...base, id: 2, progress: "preparing" }} status="review" />);
    expect(screen.getByText(/passed the first look/i)).toBeTruthy();
  });

  it("shows a declined fact's reason label, not its code, and the team's note", () => {
    render(<SubmissionCard item={{ ...base, reason: "visual", teamNote: "Three framings, none landed." }} status="declined" />);
    expect(screen.getByText("Couldn't make it work visually")).toBeTruthy();
    expect(screen.queryByText("visual")).toBeNull();
    expect(screen.getByText("Three framings, none landed.")).toBeTruthy();
  });

  it("marks a hidden comment as hidden, never as visible, and links to its fact only while the fact is live", () => {
    const { container } = render(
      <Router hook={memoryLocation({ path: "/library" }).hook}>
        <SubmissionCard item={{ ...base, kind: "comment", text: "hidden one", factId: 5, factText: "{NAME} x", factLive: true, hidden: true }} status="review" />
      </Router>,
    );
    const card = within(container);
    expect(card.getByText("Hidden for another look")).toBeTruthy();
    expect(card.queryByText("Visible")).toBeNull();
    expect(card.getByRole("link", { name: /view fact/i })).toBeTruthy();
  });
});

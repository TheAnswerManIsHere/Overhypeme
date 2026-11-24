/**
 * The fact sheet (plan docs/plans/PLAN_FACT_LIFECYCLE_REBUILD.md, items 19–20;
 * Issue #1018, increment 3.1): its four tabs, the Overview's groups with the
 * hashtags as the only edit there, the Humor Note's at-once save, the
 * read-only gags, and Deactivate kept from the old editor.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { buildPlaceholderFactEnrichment } from "@workspace/api-zod";
import { FactSheet, FACT_SHEET_TABS } from "./FactSheet";
import type { FactSheetView } from "./factSheetView";

const SHEET: FactSheetView = {
  id: 42,
  text: "{NAME} once out-stared the sun.",
  canonicalText: "Alex once out-stared the sun.",
  isActive: true,
  createdAt: "2026-11-01T10:00:00Z",
  updatedAt: "2026-11-02T10:00:00Z",
  splitTokenIndex: null,
  submittedById: "u1",
  submittedByName: "Sam Submitter",
  approvedAt: "2026-11-03T10:00:00Z",
  approvalSource: "moderator",
  approvedByName: "Dee Admin",
  upvotes: 12,
  downvotes: 2,
  score: 10,
  wilsonScore: 0.71,
  commentCount: 3,
  shareCount: 4,
  enrichmentStatus: "ok",
  suggestedHashtags: ["sun"],
  hasEmbedding: true,
  attention: ["example_missing", "not_a_reason_this_build_knows"],
  reviewId: 9,
  hashtags: ["staring", "sun"],
  usage: { memes: 5, aiPictures: 1 },
  pictures: [
    { gagId: 1, slot: 1, approvedKinds: ["male"], missingKinds: ["female", "pet"] },
    { gagId: 2, slot: 2, approvedKinds: ["male", "female", "pet"], missingKinds: [] },
  ],
  reading: {
    latest: {
      id: 5, status: "ok", draftNote: "draft",
      research: { references: [{ phrase: "out-stared", meaning: "won a staring contest", pictureImplication: "eyes locked", sources: [] }] },
      error: null, createdAt: "2026-11-01T10:00:00Z", completedAt: "2026-11-01T10:01:00Z",
    },
    approved: { text: "The joke is who blinks first.", readingId: 5, approvedBy: "a1", approvedAt: "2026-11-02T10:00:00Z" },
    approvedByName: "Dee Admin",
  },
} as FactSheetView;

interface Call { url: string; method: string; body: unknown }

function stub(sheet: FactSheetView = SHEET) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url: String(url), method, body });
    const u = String(url);
    let json: unknown = {};
    if (u.endsWith("/sheet")) json = sheet;
    else if (u.endsWith("/hashtags")) json = { hashtags: [...(body as { hashtags: string[] }).hashtags].sort() };
    else if (u.endsWith("/humor-note")) json = { humorNote: { text: (body as { text: string }).text, approvedAt: "2026-11-24T10:00:00Z" } };
    else if (u.endsWith("/taxonomy-runs")) json = { runs: [] };
    else if (u.endsWith("/gags")) json = { factId: 42, gags: [], maxGags: 3 };
    else if (u.match(/\/api\/admin\/facts\/42$/) && method === "GET") json = { id: 42, enrichment: buildPlaceholderFactEnrichment(), enrichmentStatus: "ok" };
    else if (method === "DELETE") json = { success: true };
    return new Response(JSON.stringify(json), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
  return calls;
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function open(onChanged = vi.fn(), onClose = vi.fn()) {
  render(<FactSheet factId={42} onClose={onClose} onChanged={onChanged} />);
  return { onChanged, onClose };
}

describe("FactSheet", () => {
  it("shows the four tabs, the wording, the status and the known reasons", async () => {
    stub();
    open();
    expect((await screen.findByTestId("sheet-wording")).textContent).toContain(SHEET.text);
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(FACT_SHEET_TABS.map((t) => t.label));
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Overview", "Reading and taxonomy", "Gags", "Renders"]);
    expect((screen.getByTestId("sheet-status")).textContent).toContain("Live");
    const header = screen.getByTestId("fact-sheet").querySelector("header")!;
    expect(header.textContent).toContain("Example missing");
    expect(header.textContent).not.toContain("not_a_reason");
  });

  it("Overview: the five groups, read-only but for the hashtags", async () => {
    stub();
    open();
    await screen.findByTestId("sheet-group-identity");
    for (const g of ["identity", "scoring", "usage", "pictures", "hashtags"]) expect(screen.getByTestId(`sheet-group-${g}`)).toBeTruthy();
    const identity = screen.getByTestId("sheet-group-identity");
    expect((identity).textContent).toContain("Sam Submitter");
    expect((identity).textContent).toContain("Dee Admin");
    expect((identity).textContent).toContain("#9");
    expect((screen.getByTestId("sheet-group-usage")).textContent).toContain("5");
    expect((screen.getByTestId("sheet-pictures-gag-1")).textContent).toContain("no female and pet example published");
    expect((screen.getByTestId("sheet-pictures-gag-2")).textContent).toContain("all three examples published");
    // The only inputs on the Overview are the hashtag editor's.
    for (const g of ["identity", "scoring", "usage", "pictures"]) {
      expect(screen.getByTestId(`sheet-group-${g}`).querySelectorAll("input, textarea, select")).toHaveLength(0);
    }
    expect(within(screen.getByTestId("sheet-group-hashtags")).getAllByRole("textbox").length).toBeGreaterThan(0);
  });

  it("a legacy approval says so", async () => {
    stub({ ...SHEET, approvalSource: "legacy", approvedByName: null });
    open();
    expect((await screen.findByTestId("sheet-group-identity")).textContent).toContain("Legacy");
  });

  it("removing a hashtag saves at once, and leaves the list alone (it shows no hashtags)", async () => {
    const calls = stub();
    const { onChanged } = open();
    const group = await screen.findByTestId("sheet-group-hashtags");
    fireEvent.click(within(group).getByRole("button", { name: /remove staring/i }));
    await waitFor(() => expect((screen.getByTestId("sheet-hashtags-status")).textContent).toContain("Saved"));
    const put = calls.find((c) => c.method === "PUT" && c.url.endsWith("/hashtags"));
    expect(put?.body).toEqual({ hashtags: ["sun"] });
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("removing the last hashtag is not sent", async () => {
    const calls = stub({ ...SHEET, hashtags: ["sun"] });
    open();
    const group = await screen.findByTestId("sheet-group-hashtags");
    fireEvent.click(within(group).getByRole("button", { name: /remove sun/i }));
    expect((screen.getByTestId("sheet-hashtags-status")).textContent).toContain("at least one hashtag");
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  // PR #1217 round 1 (Codex 4684437653): saves are held so they overlap.
  /** A fetch stub that holds every PUT until released, answering the list it was sent. */
  function holdPuts() {
    const held: { body: { hashtags?: string[]; text?: string }; release: () => void }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      if (method === "PUT") {
        const body = JSON.parse(String(init!.body)) as { hashtags?: string[]; text?: string };
        await new Promise<void>((resolve) => held.push({ body, release: resolve }));
        const json = u.endsWith("/hashtags") ? { hashtags: [...body.hashtags!].sort() } : { humorNote: { text: body.text, approvedAt: "2026-11-24T10:00:00Z" } };
        return new Response(JSON.stringify(json), { status: 200 });
      }
      const json = u.endsWith("/sheet") ? SHEET : u.endsWith("/taxonomy-runs") ? { runs: [] } : { id: 42, enrichment: buildPlaceholderFactEnrichment(), enrichmentStatus: "ok" };
      return new Response(JSON.stringify(json), { status: 200 });
    }));
    return held;
  }

  function addTag(group: HTMLElement, tag: string) {
    fireEvent.change(within(group).getByPlaceholderText("Add hashtag…"), { target: { value: tag } });
    fireEvent.click(within(group).getByRole("button", { name: "Add" }));
  }

  const shown = (group: HTMLElement) => within(group).queryAllByRole("button", { name: /^Remove / }).map((b) => b.getAttribute("aria-label")!.slice(7));

  it("quick hashtag edits: one save at a time, the latest list sent last, no chosen tag lost on screen", async () => {
    const held = holdPuts();
    open();
    const group = await screen.findByTestId("sheet-group-hashtags");
    addTag(group, "one");
    addTag(group, "two");
    addTag(group, "three");
    await waitFor(() => expect(held).toHaveLength(1));
    expect(held[0]!.body.hashtags).toEqual(["staring", "sun", "one"]);
    expect(shown(group)).toEqual(["staring", "sun", "one", "two", "three"]);
    expect(screen.getByTestId("sheet-hashtags-status").textContent).toContain("Saving");

    held[0]!.release();
    await waitFor(() => expect(held).toHaveLength(2));
    // The first answer did not replace the newer choice, and only the latest list is sent next.
    expect(shown(group)).toEqual(["staring", "sun", "one", "two", "three"]);
    expect(held[1]!.body.hashtags).toEqual(["staring", "sun", "one", "two", "three"]);
    expect(screen.getByTestId("sheet-hashtags-status").textContent).not.toContain("Saved");

    held[1]!.release();
    await waitFor(() => expect(screen.getByTestId("sheet-hashtags-status").textContent).toContain("Saved"));
    expect(held).toHaveLength(2);
    expect([...shown(group)].sort()).toEqual(["one", "staring", "sun", "three", "two"]);
  });

  it("removing the last hashtag while a save is in flight keeps its warning", async () => {
    const held = holdPuts();
    open();
    const group = await screen.findByTestId("sheet-group-hashtags");
    fireEvent.click(within(group).getByRole("button", { name: "Remove staring" }));
    await waitFor(() => expect(held).toHaveLength(1));
    fireEvent.click(within(group).getByRole("button", { name: "Remove sun" }));
    expect(screen.getByTestId("sheet-hashtags-status").textContent).toContain("at least one hashtag");
    held[0]!.release();
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByTestId("sheet-hashtags-status").textContent).toContain("at least one hashtag");
    expect(shown(group)).toEqual([]);
    expect(held).toHaveLength(1);
  });

  it("text typed while a note save is in flight is kept, and is not called saved", async () => {
    const held = holdPuts();
    open();
    await screen.findByTestId("sheet-wording");
    fireEvent.click(screen.getByTestId("sheet-tab-reading"));
    const note = screen.getByRole("textbox", { name: "Humor note" }) as HTMLTextAreaElement;
    fireEvent.change(note, { target: { value: "First." } });
    fireEvent.click(screen.getByTestId("sheet-save-note"));
    await waitFor(() => expect(held).toHaveLength(1));
    fireEvent.change(note, { target: { value: "First. And more." } });
    held[0]!.release();
    await waitFor(() => expect(screen.getByTestId("sheet-humor-note").textContent).not.toContain("Saving…"));
    expect(note.value).toBe("First. And more.");
    expect(screen.getByTestId("sheet-humor-note").textContent).not.toContain("Saved");
    expect((screen.getByTestId("sheet-save-note") as HTMLButtonElement).disabled).toBe(false);
  });

  it("Reading and taxonomy: the note saves at once; the research and the taxonomy are shown", async () => {
    const calls = stub();
    open();
    await screen.findByTestId("sheet-wording");
    fireEvent.click(screen.getByTestId("sheet-tab-reading"));
    const note = screen.getByRole("textbox", { name: "Humor note" });
    expect((note as HTMLTextAreaElement).value).toBe("The joke is who blinks first.");
    expect((screen.getByTestId("sheet-save-note") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("reading-research")).textContent).toContain("out-stared");
    expect(await screen.findByTestId("fact-taxonomy-panel")).toBeTruthy();

    fireEvent.change(note, { target: { value: "The joke is the sun blinks." } });
    fireEvent.click(screen.getByTestId("sheet-save-note"));
    await waitFor(() => expect((screen.getByTestId("sheet-humor-note")).textContent).toContain("Saved"));
    expect(calls.find((c) => c.url.endsWith("/humor-note"))?.body).toEqual({ text: "The joke is the sun blinks." });
  });

  it("Gags and Renders are read-only and say why", async () => {
    stub();
    open();
    await screen.findByTestId("sheet-wording");
    fireEvent.click(screen.getByTestId("sheet-tab-gags"));
    expect((screen.getByTestId("sheet-gags-read-only")).textContent).toContain("Publish changes");
    fireEvent.click(screen.getByTestId("sheet-tab-renders"));
    expect((screen.getByTestId("sheet-renders-read-only")).textContent).toContain("Publish changes");
  });

  it("Deactivate asks first, then deactivates and reloads", async () => {
    const calls = stub();
    const { onChanged } = open();
    fireEvent.click(await screen.findByTestId("deactivate-fact-button"));
    fireEvent.click(screen.getByTestId("deactivate-fact-confirm"));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith("/api/admin/facts/42"))).toBe(true);
  });

  it("a deactivated fact offers no Deactivate", async () => {
    stub({ ...SHEET, isActive: false });
    open();
    expect((await screen.findByTestId("sheet-status")).textContent).toContain("Deactivated");
    expect(screen.queryByTestId("deactivate-fact-button")).toBeNull();
  });

  it("a fact that is not approved says it isn't on the Facts page", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Fact not found" }), { status: 404 })));
    open();
    expect((await screen.findByRole("alert")).textContent).toContain("never approved");
  });

  it("Escape and the close button close it", async () => {
    stub();
    const { onClose } = open();
    await screen.findByTestId("sheet-wording");
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Close the fact sheet" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

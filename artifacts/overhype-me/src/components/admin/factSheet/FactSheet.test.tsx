/**
 * The fact sheet (plan docs/plans/PLAN_FACT_LIFECYCLE_REBUILD.md, items 19–20;
 * Issue #1018, increment 3.1): its four tabs, the Overview's groups with the
 * hashtags as the only edit there, the Humor Note's at-once save, the
 * read-only gags, and Deactivate kept from the old editor; and increment 3.2:
 * the gag tabs editing the draft, Publish changes and Discard changes,
 * Deactivate and Reactivate, the unsaved-changes guard, and the hashtags'
 * save surviving a tab round-trip.
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
  hasUnpublishedChanges: false,
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

/** A gags view for the stub: no gags, a draft that is ready unless said otherwise. */
function gagsView(extra: Record<string, unknown> = {}) {
  return { factId: 42, isActive: true, review: null, gags: [], maxGags: 3, draftReady: { ok: true, reason: null }, filling: false, fillFailed: false, ...extra };
}

function stub(sheet: FactSheetView = SHEET, opts: { gags?: unknown; refuse?: Record<string, string>; sheetAfterAction?: FactSheetView; history?: unknown[] } = {}) {
  let acted = false;
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url: String(url), method, body });
    const u = String(url);
    let json: unknown = {};
    const action = u.match(/\/api\/admin\/facts\/42\/(publish|discard|deactivate|reactivate)$/)?.[1];
    if (action && opts.refuse?.[action]) return new Response(JSON.stringify({ error: opts.refuse[action] }), { status: 409 });
    if (action) acted = true;
    if (u.endsWith("/sheet")) json = acted && opts.sheetAfterAction ? opts.sheetAfterAction : sheet;
    else if (u.endsWith("/hashtags")) json = { hashtags: [...(body as { hashtags: string[] }).hashtags].sort() };
    else if (u.endsWith("/humor-note")) json = { humorNote: { text: (body as { text: string }).text, approvedAt: "2026-11-24T10:00:00Z" } };
    else if (u.endsWith("/taxonomy-runs")) json = { runs: [] };
    else if (u.endsWith("/history")) json = { history: opts.history ?? [], limit: 500 };
    else if (u.endsWith("/gags")) json = opts.gags ?? gagsView();
    else if (u.match(/\/api\/admin\/facts\/42$/) && method === "GET") json = { id: 42, enrichment: buildPlaceholderFactEnrichment(), enrichmentStatus: "ok" };
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
  it("shows the five tabs, the wording, the status and the known reasons", async () => {
    stub();
    open();
    expect((await screen.findByTestId("sheet-wording")).textContent).toContain(SHEET.text);
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(FACT_SHEET_TABS.map((t) => t.label));
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Overview", "Reading and taxonomy", "Gags", "Renders", "History"]);
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

  it("Gags and Renders edit the draft and say so", async () => {
    stub();
    open();
    await screen.findByTestId("sheet-wording");
    fireEvent.click(screen.getByTestId("sheet-tab-gags"));
    expect((screen.getByTestId("sheet-gags-note")).textContent).toContain("Members keep seeing the published gags");
    fireEvent.click(screen.getByTestId("sheet-tab-renders"));
    expect((screen.getByTestId("sheet-renders-note")).textContent).toContain("part of the draft");
  });

  it("Deactivate asks first, then deactivates and reloads", async () => {
    const calls = stub();
    const { onChanged } = open();
    fireEvent.click(await screen.findByTestId("deactivate-fact-button"));
    expect(screen.getByTestId("sheet-deactivate-confirm").textContent).toContain("unpublished changes");
    fireEvent.click(screen.getByTestId("deactivate-fact-confirm"));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/api/admin/facts/42/deactivate"))).toBe(true);
  });

  it("a deactivated fact offers Reactivate, not Deactivate", async () => {
    const calls = stub({ ...SHEET, isActive: false });
    const { onChanged } = open();
    expect((await screen.findByTestId("sheet-status")).textContent).toContain("Deactivated");
    expect(screen.queryByTestId("deactivate-fact-button")).toBeNull();
    fireEvent.click(screen.getByTestId("reactivate-fact-button"));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/api/admin/facts/42/reactivate"))).toBe(true);
    expect(screen.getByTestId("sheet-action-done").textContent).toContain("live again");
  });

  it("a refused Reactivate says why and changes nothing on screen", async () => {
    stub({ ...SHEET, isActive: false }, { refuse: { reactivate: "Visual gag 1 needs pet render approved." } });
    const { onChanged } = open();
    fireEvent.click(await screen.findByTestId("reactivate-fact-button"));
    expect((await screen.findByTestId("sheet-action-error")).textContent).toContain("Visual gag 1 needs pet render approved.");
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("no unpublished changes: no chip, no Publish or Discard", async () => {
    stub();
    open();
    await screen.findByTestId("sheet-footer");
    expect(screen.queryByTestId("sheet-unpublished")).toBeNull();
    expect(screen.queryByTestId("publish-changes-button")).toBeNull();
  });

  it("unpublished changes: the chip, then Publish changes publishes and reloads", async () => {
    const calls = stub({ ...SHEET, hasUnpublishedChanges: true });
    const { onChanged } = open();
    expect((await screen.findByTestId("sheet-unpublished")).textContent).toContain("Unpublished changes");
    fireEvent.click(screen.getByTestId("publish-changes-button"));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/api/admin/facts/42/publish"))).toBe(true);
    expect(screen.getByTestId("sheet-action-done").textContent).toContain("Published");
  });

  it("Discard changes asks first, then discards", async () => {
    const calls = stub({ ...SHEET, hasUnpublishedChanges: true });
    open();
    fireEvent.click(await screen.findByTestId("discard-changes-button"));
    expect(calls.some((c) => c.url.endsWith("/discard"))).toBe(false);
    fireEvent.click(screen.getByTestId("discard-changes-confirm"));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/api/admin/facts/42/discard"))).toBe(true));
  });

  it("tells the list once when a gag change makes the draft differ, and never on a plain open and close", async () => {
    const changed = {
      id: 7, slot: 1, state: "pending", availableToUsers: true, isDefault: true,
      approvedContent: null, approvedExamples: { male: null, female: null, pet: null }, grandfathered: false, approvedAt: null,
      pendingContent: null, pendingExamples: { male: null, female: null, pet: null }, draftRemoved: true, prefilledUntouched: false,
      renders: { male: null, female: null, pet: null },
    };
    stub(SHEET, { gags: gagsView({ gags: [changed], draftReady: { ok: false, reason: "Visual gag 1 needs male, female and pet renders approved." } }) });
    const { onChanged, onClose } = open();
    await screen.findByTestId("sheet-wording");
    expect(onChanged).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("sheet-tab-gags"));
    await screen.findByTestId("sheet-unpublished");
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByTestId("sheet-tab-overview"));
    fireEvent.click(screen.getByRole("button", { name: "Close the fact sheet" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("a plain open and close does not tell the list anything", async () => {
    stub();
    const { onChanged, onClose } = open();
    await screen.findByTestId("sheet-wording");
    fireEvent.click(screen.getByTestId("sheet-tab-gags"));
    await screen.findByTestId("sheet-gags-note");
    fireEvent.click(screen.getByRole("button", { name: "Close the fact sheet" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("Publish tells the list once, not again when the sheet reloads", async () => {
    stub({ ...SHEET, hasUnpublishedChanges: true }, { sheetAfterAction: SHEET });
    const { onChanged } = open();
    fireEvent.click(await screen.findByTestId("publish-changes-button"));
    await waitFor(() => expect(screen.getByTestId("sheet-action-done").textContent).toContain("Published"));
    await new Promise((r) => setTimeout(r, 30));
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("a draft that isn't ready: Publish is held and the reason shown", async () => {
    const pending = {
      id: 7, slot: 1, state: "pending", availableToUsers: true, isDefault: true,
      approvedContent: null, approvedExamples: { male: null, female: null, pet: null }, grandfathered: false, approvedAt: null,
      pendingContent: null, pendingExamples: { male: null, female: null, pet: null }, draftRemoved: true, prefilledUntouched: false,
      renders: { male: null, female: null, pet: null },
    };
    stub(SHEET, { gags: gagsView({ gags: [pending], draftReady: { ok: false, reason: "A fact needs at least one visual gag before it can go live." } }) });
    open();
    await screen.findByTestId("sheet-wording");
    fireEvent.click(screen.getByTestId("sheet-tab-gags"));
    expect((await screen.findByTestId("sheet-publish-blocked")).textContent).toContain("at least one visual gag");
    expect((screen.getByTestId("publish-changes-button") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("sheet-unpublished")).toBeTruthy();
  });

  it("an unsaved Humor Note asks before a tab switch, Escape or a click outside", async () => {
    stub();
    const { onClose } = open();
    await screen.findByTestId("sheet-wording");
    fireEvent.click(screen.getByTestId("sheet-tab-reading"));
    fireEvent.change(screen.getByRole("textbox", { name: "Humor note" }), { target: { value: "A new reading." } });

    fireEvent.click(screen.getByTestId("sheet-tab-overview"));
    expect(screen.getByTestId("sheet-leave-confirm").textContent).toContain("The Humor Note has changes that aren't saved");
    expect(screen.getByTestId("sheet-tab-reading").getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByTestId("sheet-leave-cancel"));
    expect((screen.getByRole("textbox", { name: "Humor note" }) as HTMLTextAreaElement).value).toBe("A new reading.");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByTestId("sheet-leave-confirm")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" }); // Escape on the question keeps editing
    expect(screen.queryByTestId("sheet-leave-confirm")).toBeNull();

    fireEvent.click(document.querySelector("[data-modal-overlay]")!);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("sheet-leave-confirm-button"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("a hashtag save in flight survives a tab round-trip", async () => {
    const held = holdPuts();
    open();
    let group = await screen.findByTestId("sheet-group-hashtags");
    addTag(group, "one");
    await waitFor(() => expect(held).toHaveLength(1));
    fireEvent.click(screen.getByTestId("sheet-tab-reading"));
    fireEvent.click(screen.getByTestId("sheet-tab-overview"));
    group = await screen.findByTestId("sheet-group-hashtags");
    expect(shown(group)).toEqual(["staring", "sun", "one"]);
    expect(screen.getByTestId("sheet-hashtags-status").textContent).toContain("Saving");
    addTag(group, "two");
    held[0]!.release();
    await waitFor(() => expect(held).toHaveLength(2));
    expect(held[1]!.body.hashtags).toEqual(["staring", "sun", "one", "two"]);
    held[1]!.release();
    await waitFor(() => expect(screen.getByTestId("sheet-hashtags-status").textContent).toContain("Saved"));
  });

  it("History: every recorded action, newest first, in words, with who and the review", async () => {
    const calls = stub(SHEET, {
      history: [
        { id: 3, action: "publish", reviewId: null, actorId: "a1", actorName: "Dee Admin", detail: { published: 1, removed: 0, unchanged: 1 }, createdAt: "2026-11-24T12:00:00Z" },
        { id: 2, action: "hashtags_save", reviewId: null, actorId: null, actorName: null, detail: { added: ["sun"], removed: ["moon"] }, createdAt: "2026-11-23T12:00:00Z" },
        { id: 1, action: "duplicate_check", reviewId: 9, actorId: null, actorName: null, detail: { outcome: "distinct" }, createdAt: "2026-11-01T12:00:00Z" },
        { id: 0, action: "an_action_from_a_later_build", reviewId: null, actorId: "a1", actorName: "Dee Admin", detail: {}, createdAt: "2026-10-01T12:00:00Z" },
      ],
    });
    open();
    await screen.findByTestId("sheet-wording");
    fireEvent.click(screen.getByTestId("sheet-tab-history"));
    const entries = await screen.findAllByTestId("sheet-history-entry");
    expect(entries.map((e) => e.querySelector("span")!.textContent)).toEqual(["Changes published", "Hashtags changed", "Duplicate check", "an_action_from_a_later_build"]);
    expect(entries[0]!.textContent).toContain("1 gag published");
    expect(entries[0]!.textContent).toContain("Dee Admin");
    expect(entries[1]!.textContent).toContain("added #sun; removed #moon");
    expect(entries[1]!.textContent).toContain("No admin on record");
    expect(entries[1]!.textContent).not.toContain("system");
    expect(entries[2]!.textContent).toContain("No admin on record");
    expect(entries[2]!.textContent).toContain("review #9");
    expect(calls.some((c) => c.url.endsWith("/api/admin/facts/42/history"))).toBe(true);
  });

  it("History with nothing recorded says so", async () => {
    stub();
    open();
    await screen.findByTestId("sheet-wording");
    fireEvent.click(screen.getByTestId("sheet-tab-history"));
    expect((await screen.findByTestId("sheet-history-empty")).textContent).toContain("No admin actions");
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

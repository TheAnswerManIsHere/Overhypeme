/**
 * AdminTrace — /admin/trace (image tracing). AdminLayout is stubbed. Sends the
 * pasted id or link, shows the record and its chain with the code version
 * and the lookup that matched, every match when there are several, a deleted
 * account, and what was tried when nothing matched.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("@/components/admin/AdminLayout", () => ({
  AdminLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import AdminTrace from "./trace";

const record = (over: Record<string, unknown> = {}) => ({
  id: 1234567890123,
  kind: "ai_render",
  generationRequestId: 9,
  sourceProvenanceId: null,
  actorKind: "admin",
  actorUserId: "u1",
  actorEmail: "dana@example.com",
  memeSlug: null,
  objectPath: "/objects/ai-bg-v2/5/9-1.png",
  attemptId: 9,
  comparisonCellId: null,
  factId: 5,
  engineId: "nano-banana-2",
  snapshot: {},
  sha256: "ab".repeat(32),
  mime: "image/png",
  byteSize: 2048,
  width: 1024,
  height: 1024,
  watermarkScheme: null,
  sourceCommit: "0123456789abcdef0123456789abcdef01234567",
  sourceCommitAt: "2026-11-10T12:00:00Z",
  sourceCommitTitle: "Image tracing, increment 1 (#907)",
  deploymentId: null,
  createdAt: "2026-11-10T13:00:00Z",
  ...over,
});

const TRACED = {
  method: "id",
  matches: [{
    record: record(),
    generationRequest: {
      id: 9, producer: "review_render", engineId: "nano-banana-2", endpointId: "fal-ai/nano-banana-2",
      request: { prompt: "a heroic cat on a mountain", output_format: "png" }, vendorRequestId: "req-1",
      actorKind: "admin", actorUserId: "u1", actorEmail: "dana@example.com",
      sourceCommit: "0123456789abcdef0123456789abcdef01234567", sourceCommitAt: null, sourceCommitTitle: null,
      createdAt: "2026-11-10T12:59:00Z",
    },
    source: null,
    stillExists: { account: false, meme: null },
  }],
  tried: ["record id 1234567890123: found"],
  note: null,
};

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function trace(input: string) {
  fireEvent.change(screen.getByLabelText("Record id or link"), { target: { value: input } });
  fireEvent.click(screen.getByRole("button", { name: /trace/i }));
}

describe("AdminTrace", () => {
  it("shows the record, the request, the code version and the lookup that matched", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => TRACED }) as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);
    render(<AdminTrace />);
    trace("1234567890123");
    expect(await screen.findByText(/Found by the record id/)).toBeTruthy();
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain("q=1234567890123");
    expect(screen.getByText("AI render")).toBeTruthy();
    expect(screen.getAllByText("dana@example.com").length).toBeGreaterThan(0);
    expect(screen.getByText(/account since deleted/)).toBeTruthy();
    expect(screen.getByText("0123456")).toBeTruthy();
    expect(screen.getByText("Image tracing, increment 1 (#907)")).toBeTruthy();
    expect(screen.getByText("a heroic cat on a mountain")).toBeTruthy();
    expect(screen.getByText("req-1")).toBeTruthy();
  });

  it("shows every match and says none was picked", async () => {
    const two = { ...TRACED, method: "link", matches: [TRACED.matches[0], { ...TRACED.matches[0], record: record({ id: 2, kind: "upload" }), generationRequest: null }] };
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => two }) as unknown as Response));
    render(<AdminTrace />);
    trace("https://overhype.me/api/storage/objects/uploads/ab/x.jpg");
    expect(await screen.findByText(/2 records/)).toBeTruthy();
    expect(screen.getByText(/none is picked for you/)).toBeTruthy();
    expect(screen.getByText("Member upload")).toBeTruthy();
  });

  it("says what it tried when nothing matched", async () => {
    const none = { method: null, matches: [], tried: ["stored picture /objects/ai-backgrounds/x.png: 0 records"], note: "Legacy path, settings not recorded: an AI background from the old FLUX backfill, made before image tracing." };
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => none }) as unknown as Response));
    render(<AdminTrace />);
    trace("/objects/ai-backgrounds/x.png");
    expect(await screen.findByText("No record found.")).toBeTruthy();
    expect(screen.getByText(/Legacy path, settings not recorded/)).toBeTruthy();
  });

  it("shows the error when the trace fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 400, json: async () => ({ error: "Give an id or a link." }) }) as unknown as Response));
    render(<AdminTrace />);
    trace("x");
    expect(await screen.findByText("Give an id or a link.")).toBeTruthy();
  });
});

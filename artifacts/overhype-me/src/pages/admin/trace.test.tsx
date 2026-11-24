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
  fireEvent.click(screen.getByRole("button", { name: /^trace$/i }));
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

  it("a picture Nano Banana drew after GPT Image refused names both engines and the refusal (plan PLAN_NB_FALLBACK.md)", async () => {
    const m = TRACED.matches[0]!;
    const fellBack = {
      ...TRACED,
      matches: [{
        ...m,
        record: record({ engineId: "nano-banana-2-1-edit" }),
        engineFallback: {
          record: { routedEngineId: "gpt-image-2-6-edit", fallbackEngineId: "nano-banana-2-1-edit", reason: "flagged by a content checker", refusedVendorRequestId: "req-refused", at: "2026-11-17T00:40:24Z" },
          refusedRequest: { ...m.generationRequest, id: 8, engineId: "gpt-image-2-6-edit", endpointId: "openai/gpt-image-2.6/sunburst/edit" },
        },
      }],
    };
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => fellBack }) as unknown as Response));
    render(<AdminTrace />);
    trace("1234567890123");
    const block = await screen.findByTestId("trace-engine-fallback");
    expect(block.textContent).toMatch(/gpt-image-2-6-edit refused this picture under its content policy, so nano-banana-2-1-edit drew it\./);
    expect(block.textContent).toContain("flagged by a content checker");
    expect(block.textContent).toContain("openai/gpt-image-2.6/sunburst/edit");
    expect(block.textContent).toContain("req-refused");
  });

  it("a picture drawn by its routed engine shows no fallback block", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => TRACED }) as unknown as Response));
    render(<AdminTrace />);
    trace("1234567890123");
    await screen.findByText(/Found by the record id/);
    expect(screen.queryByTestId("trace-engine-fallback")).toBeNull();
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

  it("traces a picture file by its stamp, bytes and watermark, sending the file itself, and says how it matched", async () => {
    const meme = record({
      kind: "meme_bake", memeSlug: "abc123", engineId: null, generationRequestId: null, attemptId: null,
      watermarkScheme: "trustmark-q/bch5/v1", mime: "image/jpeg",
      snapshot: { caption: "Alex pushes the limit.", identity: { name: "Alex", pronouns: "they/them" } },
    });
    const body = {
      method: "watermark",
      matches: [{ record: meme, generationRequest: null, source: null, stillExists: { account: true, meme: true } }],
      tried: [
        "metadata: no Overhype.me id in the file (stripped, or never stamped)",
        "exact bytes: no record of these exact bytes (the file has been re-saved, resized or edited)",
        "watermark: id 1234567890123 (after cutting away bars round the picture, 2 damaged bits repaired), found",
      ],
      note: null,
    };
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => body }) as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);
    render(<AdminTrace />);
    const file = new File([new Uint8Array([0xff, 0xd8, 0xff])], "screenshot.jpg", { type: "image/jpeg" });
    fireEvent.change(screen.getByLabelText("Picture to trace"), { target: { files: [file] } });
    expect(await screen.findByText(/Found by the invisible watermark/)).toBeTruthy();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/admin/provenance/trace-image");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(file);
    expect(screen.getByText("Saved meme")).toBeTruthy();
    expect(screen.getByText("Alex pushes the limit.")).toBeTruthy();
    expect(screen.getByText(/carries record 1234567890123/)).toBeTruthy();
    expect(screen.getByText(/after cutting away bars/)).toBeTruthy();
  });
});

describe("AdminTrace — take down a member's meme or photo (#875 R9)", () => {
  const memeTrace = {
    ...TRACED,
    matches: [{ ...TRACED.matches[0]!, record: record({ kind: "meme_bake", memeSlug: "abc123", generationRequestId: null }), generationRequest: null, stillExists: { account: true, meme: true } }],
  };

  it("asks for a reason, sends the takedown, and says what happened", async () => {
    const calls: Array<{ url: string; body?: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), body: init?.body as string | undefined });
      if (String(url).includes("/takedown")) return { ok: true, json: async () => ({ success: true, wasProfile: false }) } as unknown as Response;
      return { ok: true, json: async () => memeTrace } as unknown as Response;
    }));
    render(<AdminTrace />);
    trace("abc123");
    fireEvent.click(await screen.findByTestId("takedown-open"));
    const confirm = screen.getByTestId("takedown-confirm") as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Reason for the takedown"), { target: { value: "harassment report" } });
    fireEvent.click(confirm);
    expect(await screen.findByTestId("takedown-done")).toBeTruthy();
    const sent = calls.find((c) => c.url.includes("/takedown"))!;
    expect(sent.url).toBe("/api/admin/content/takedown");
    expect(JSON.parse(sent.body!)).toEqual({ kind: "meme", key: "abc123", reason: "harassment report" });
  });

  it("offers no takedown for a meme already gone, or for a picture that is not a member's", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({
      ...memeTrace, matches: [{ ...memeTrace.matches[0]!, stillExists: { account: true, meme: false } }],
    }) }) as unknown as Response));
    render(<AdminTrace />);
    trace("abc123");
    await screen.findByText(/meme since deleted/);
    expect(screen.queryByTestId("takedown")).toBeNull();
  });
});

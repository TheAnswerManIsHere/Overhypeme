// Launch Phase 7, increment 2: the "Make an AI picture" panel. It offers a
// choice of gag only where the fact has more than one, names the cost ("your
// free picture" or "1 credit") and the balance after, follows the picture to
// done (handing it over as the background) or to failed (saying the credit
// was returned), and a retry after a lost response reuses the request id.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { AiPicturePanel } from "../AiPicturePanel";

type Handler = (url: string, init?: RequestInit) => unknown;
function stubFetch(handler: Handler) {
  const calls: Array<{ url: string; body?: unknown }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const out = handler(url, init);
    if (out instanceof Error) throw out;
    const [status, body] = Array.isArray(out) ? out : [200, out];
    return new Response(JSON.stringify(body), { status: status as number });
  }));
  return calls;
}

const options = (gags: number, extra: Record<string, unknown> = {}) => ({
  gags: Array.from({ length: gags }, (_, i) => ({ gagId: 10 + i, slot: i + 1, examples: { male: `/ex/${i}/m`, female: null, pet: null } })),
  choice: gags > 1, credits: 1, nextIsFree: true, ...extra,
});
const picture = (status: string, extra: Record<string, unknown> = {}) => ({
  attemptId: 5, factId: 3, status, reason: null, creditReturned: false, aiImageId: null, imageUrl: null, createdAt: "2026-11-25T00:00:00Z", ...extra,
});

afterEach(() => vi.unstubAllGlobals());

function base(url: string) {
  if (url === "/api/member-pictures") return { pictures: [] };
  if (url === "/api/look-styles") return [200, [{ id: "comic", label: "Comic", description: "" }]];
  return undefined;
}

describe("AiPicturePanel", () => {
  it("with one gag there is no choice; the cost reads as the free picture with the balance after", async () => {
    stubFetch((url) => base(url) ?? options(1));
    render(<AiPicturePanel factId="3" photoUploadKey="/objects/uploads/p.jpg" onPicture={() => {}} selectedAiImageId={null} />);
    fireEvent.click(screen.getByTestId("ai-picture-open"));
    await waitFor(() => expect(screen.getByTestId("ai-picture-confirm").textContent).toContain("Make it: your free picture"));
    expect(screen.getByTestId("ai-picture-confirm").textContent).toContain("0 credits left after");
    expect(screen.getByText("The joke")).toBeTruthy();
    expect(screen.getAllByTestId("ai-picture-gag")[0].hasAttribute("disabled")).toBe(true);
  });

  it("with several gags the member picks one and the request names it", async () => {
    const calls = stubFetch((url) => base(url) ?? (url.includes("/member-pictures") ? [202, { picture: picture("queued"), credits: 0 }] : options(2, { nextIsFree: false })));
    render(<AiPicturePanel factId="3" photoUploadKey="/objects/uploads/p.jpg" onPicture={() => {}} selectedAiImageId={null} />);
    fireEvent.click(screen.getByTestId("ai-picture-open"));
    await waitFor(() => expect(screen.getAllByTestId("ai-picture-gag")).toHaveLength(2));
    expect(screen.getByText("Pick the joke")).toBeTruthy();
    fireEvent.click(screen.getAllByTestId("ai-picture-gag")[1]!);
    expect(screen.getByTestId("ai-picture-confirm").textContent).toContain("Make it: 1 credit");
    fireEvent.click(screen.getByTestId("ai-picture-confirm"));
    await waitFor(() => expect(screen.getByTestId("ai-picture-status").textContent).toContain("Waiting to start drawing"));
    const sent = calls.find((c) => c.url === "/api/facts/3/member-pictures")!.body as { gagId: number; subject: { kind: string } };
    expect(sent.gagId).toBe(11);
    expect(sent.subject).toEqual({ kind: "me" });
  });

  it("a lost response is retried with the same request id, so it cannot spend twice", async () => {
    let first = true;
    const calls = stubFetch((url) => {
      const b = base(url); if (b !== undefined) return b;
      if (url.includes("/member-pictures")) {
        if (first) { first = false; return new Error("network"); }
        return [200, { picture: picture("queued"), credits: 0 }];
      }
      return options(1);
    });
    render(<AiPicturePanel factId="3" photoUploadKey="/objects/uploads/p.jpg" onPicture={() => {}} selectedAiImageId={null} />);
    fireEvent.click(screen.getByTestId("ai-picture-open"));
    await waitFor(() => expect(screen.getByTestId("ai-picture-confirm").hasAttribute("disabled")).toBe(false));
    fireEvent.click(screen.getByTestId("ai-picture-confirm"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("won't be charged twice"));
    fireEvent.click(screen.getByTestId("ai-picture-confirm"));
    await waitFor(() => expect(screen.getByTestId("ai-picture-status")).toBeTruthy());
    const ids = calls.filter((c) => c.url === "/api/facts/3/member-pictures").map((c) => (c.body as { requestId: string }).requestId);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
  });

  it("a picture in flight is picked up again on return, and a finished one becomes the background", async () => {
    const onPicture = vi.fn();
    let polls = 0;
    stubFetch((url) => {
      if (url === "/api/member-pictures") return { pictures: [picture("drawing")] };
      if (url === "/api/member-pictures/5") {
        polls++;
        return { picture: picture("done", { aiImageId: 9, imageUrl: "/api/memes/ai-user/image?storagePath=x" }), credits: 0 };
      }
      return base(url) ?? options(1);
    });
    render(<AiPicturePanel factId="3" photoUploadKey="/objects/uploads/p.jpg" onPicture={onPicture} selectedAiImageId={null} />);
    await waitFor(() => expect(screen.getByTestId("ai-picture-status").textContent).toContain("Drawing your picture"));
    await waitFor(() => expect(onPicture).toHaveBeenCalledWith({ aiImageId: 9, imageUrl: "/api/memes/ai-user/image?storagePath=x" }), { timeout: 4000 });
    expect(polls).toBeGreaterThan(0);
  });

  it("a failed picture says why and that the credit was returned", async () => {
    stubFetch((url) => {
      if (url === "/api/member-pictures") return { pictures: [picture("drawing")] };
      if (url === "/api/member-pictures/5") return { picture: picture("failed", { reason: "The image engine would not draw this scene from this photo.", creditReturned: true }), credits: 1 };
      return base(url) ?? options(1);
    });
    render(<AiPicturePanel factId="3" photoUploadKey="/objects/uploads/p.jpg" onPicture={() => {}} selectedAiImageId={null} />);
    await waitFor(() => expect(screen.getByTestId("ai-picture-status").textContent).toContain("Your credit was returned."), { timeout: 4000 });
    expect(screen.getByTestId("ai-picture-status").textContent).toContain("would not draw");
  });

  it("with no credit the confirm button is off and says so", async () => {
    stubFetch((url) => base(url) ?? options(1, { credits: 0, nextIsFree: false }));
    render(<AiPicturePanel factId="3" photoUploadKey="/objects/uploads/p.jpg" onPicture={() => {}} selectedAiImageId={null} />);
    fireEvent.click(screen.getByTestId("ai-picture-open"));
    await waitFor(() => expect(screen.getByText("You have no credits left for a picture.")).toBeTruthy());
    expect(screen.getByTestId("ai-picture-confirm").hasAttribute("disabled")).toBe(true);
  });
});

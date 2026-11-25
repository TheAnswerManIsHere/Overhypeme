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
  if (url.startsWith("/api/users/me/ai-images")) return { images: [], nextCursor: null };
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

  it("offers the member's finished pictures of this fact, and uses one only when tapped (PR #1313, round 1)", async () => {
    const onPicture = vi.fn();
    const calls = stubFetch((url) => {
      if (url.startsWith("/api/users/me/ai-images")) {
        return url.includes("cursor=c1")
          ? { images: [{ id: 8, storagePath: "b.png" }], nextCursor: null }
          : { images: [{ id: 7, storagePath: "a.png" }], nextCursor: "c1" };
      }
      return base(url) ?? options(1);
    });
    render(<AiPicturePanel factId="3" photoUploadKey="/objects/uploads/p.jpg" onPicture={onPicture} selectedAiImageId={null} />);
    await waitFor(() => expect(screen.getByTestId("ai-picture-finished")).toBeTruthy());
    expect(calls.find((c) => c.url.startsWith("/api/users/me/ai-images"))!.url).toBe("/api/users/me/ai-images?imageType=member_picture&factId=3");
    expect(onPicture).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Show more"));
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Use this picture" })).toHaveLength(2));
    fireEvent.click(screen.getAllByRole("button", { name: "Use this picture" })[1]!);
    expect(onPicture).toHaveBeenCalledWith({ aiImageId: 8, imageUrl: "/api/memes/ai-user/image?storagePath=b.png" });
  });

  it("a server error or an unreadable answer keeps the request, choices included; a refusal starts a new one (PR #1313, round 1)", async () => {
    const answers: Array<() => Response> = [
      () => new Response("{}", { status: 500 }),
      () => new Response("not json", { status: 202 }),
      () => new Response(JSON.stringify({ message: "No credit." }), { status: 402 }),
      () => new Response(JSON.stringify({ picture: picture("queued"), credits: 0 }), { status: 202 }),
    ];
    const posts: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/facts/3/member-pictures") {
        posts.push(JSON.parse(String(init!.body)));
        return answers.shift()!();
      }
      const out = base(url) ?? options(2, { credits: 3, nextIsFree: false });
      const [status, body] = Array.isArray(out) ? out : [200, out];
      return new Response(JSON.stringify(body), { status: status as number });
    }));
    render(<AiPicturePanel factId="3" photoUploadKey="/objects/uploads/p.jpg" onPicture={() => {}} selectedAiImageId={null} />);
    fireEvent.click(screen.getByTestId("ai-picture-open"));
    await waitFor(() => expect(screen.getAllByTestId("ai-picture-gag")).toHaveLength(2));
    fireEvent.click(screen.getAllByTestId("ai-picture-gag")[1]!);
    fireEvent.click(screen.getByTestId("ai-picture-confirm"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("won't be charged twice"));
    // The member changes the gag before retrying: the retry is still the first request.
    fireEvent.click(screen.getAllByTestId("ai-picture-gag")[0]!);
    fireEvent.click(screen.getByTestId("ai-picture-confirm"));
    await waitFor(() => expect(posts).toHaveLength(2));
    await waitFor(() => expect(screen.getByTestId("ai-picture-confirm").textContent).not.toContain("Starting"));
    fireEvent.click(screen.getByTestId("ai-picture-confirm"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("No credit."));
    fireEvent.click(screen.getByTestId("ai-picture-confirm"));
    await waitFor(() => expect(screen.getByTestId("ai-picture-status")).toBeTruthy());
    expect(posts[1]).toEqual(posts[0]);
    expect(posts[2]).toEqual(posts[0]);
    expect(posts[0]!.gagId).toBe(11);
    expect(posts[3]!.requestId).not.toBe(posts[0]!.requestId);
    expect(posts[3]!.gagId).toBe(10);
  });

  it("a failed status check keeps following the picture until it is done (PR #1313, round 1)", async () => {
    const onPicture = vi.fn();
    let polls = 0;
    stubFetch((url) => {
      if (url === "/api/member-pictures") return { pictures: [picture("drawing")] };
      if (url === "/api/member-pictures/5") {
        polls++;
        if (polls === 1) return new Error("network");
        if (polls === 2) return [503, {}];
        return { picture: picture("done", { aiImageId: 9, imageUrl: "/x" }), credits: 0 };
      }
      return base(url) ?? options(1);
    });
    render(<AiPicturePanel factId="3" photoUploadKey="/objects/uploads/p.jpg" onPicture={onPicture} selectedAiImageId={null} />);
    await waitFor(() => expect(onPicture).toHaveBeenCalledWith({ aiImageId: 9, imageUrl: "/x" }), { timeout: 10_000 });
    expect(polls).toBe(3);
  }, 15_000);

  it("\"Make another\" reads the cost again, so a spent free picture is not offered twice (PR #1313, round 1)", async () => {
    let optionReads = 0;
    stubFetch((url) => {
      const b = base(url); if (b !== undefined) return b;
      if (url === "/api/facts/3/member-pictures") return [202, { picture: picture("failed", { reason: "No.", creditReturned: false }), credits: 2 }];
      optionReads++;
      return optionReads === 1 ? options(2, { credits: 3, nextIsFree: true }) : options(2, { credits: 2, nextIsFree: false });
    });
    render(<AiPicturePanel factId="3" photoUploadKey="/objects/uploads/p.jpg" onPicture={() => {}} selectedAiImageId={null} />);
    fireEvent.click(screen.getByTestId("ai-picture-open"));
    await waitFor(() => expect(screen.getByTestId("ai-picture-confirm").textContent).toContain("your free picture"));
    fireEvent.click(screen.getAllByTestId("ai-picture-gag")[1]!);
    fireEvent.click(screen.getByTestId("ai-picture-confirm"));
    await waitFor(() => expect(screen.getByText("Make another")).toBeTruthy());
    fireEvent.click(screen.getByText("Make another"));
    await waitFor(() => expect(screen.getByTestId("ai-picture-confirm").textContent).toContain("Make it: 1 credit"));
    expect(screen.getByTestId("ai-picture-confirm").textContent).toContain("1 credit left after");
    expect(optionReads).toBe(2);
    // The member's gag survives the re-read.
    expect(screen.getAllByTestId("ai-picture-gag")[1]!.getAttribute("aria-pressed")).toBe("true");
  });
});

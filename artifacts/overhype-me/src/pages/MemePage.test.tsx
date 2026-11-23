/**
 * The meme page's "Make this fact about me" (#851).
 *
 * @purpose Proves that a signed-in visitor's "Make this fact about me" on someone else's meme opens the standard meme builder on the fact's own builder route, with that fact already chosen, and that the meme page no longer opens a separate builder of its own.
 * @subsystem public-site
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import MemePage from "./MemePage";

let role = "registered";
let user: { id: string } | null = { id: "viewer-1" };
vi.mock("@workspace/replit-auth-web", () => ({
  useAuth: () => ({ user, role, can: (k: string) => k === "meme_private_visibility" && role === "legendary" }),
}));
vi.mock("@workspace/api-client-react", () => ({
  useGetFact: (id: number) => ({ data: id ? { id, text: "{NAME} fought a bear and won." } : undefined }),
  getGetFactQueryKey: (id: number) => ["fact", id],
}));
vi.mock("@/components/layout/Layout", () => ({
  Layout: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/memes/MemeHeartButton", () => ({ MemeHeartButton: () => null }));
vi.mock("@/components/share/MemeShareModal", () => ({ MemeShareModal: () => null }));
const toastSpy = vi.fn();
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: toastSpy }) }));

const meme = {
  id: 7,
  slug: "abc",
  factId: 42,
  factText: "Sarah fought a bear and won.",
  imageUrl: "https://example.test/m.jpg",
  createdById: "creator-9",
  heartCount: 0,
  viewerHasHearted: false,
  originalWidth: 1080,
  originalHeight: 1080,
  isPublic: true,
};

function renderAt(path: string) {
  const location = memoryLocation({ path, record: true });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Router hook={location.hook}>
        <MemePage />
      </Router>
    </QueryClientProvider>,
  );
  return location;
}

describe("MemePage — Make this fact about me (#851)", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(meme), { status: 200, headers: { "Content-Type": "application/json" } })),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(["registered", "legendary"])(
    "a %s visitor goes to the standard builder with the fact chosen",
    async (r) => {
      role = r;
      const location = renderAt("/m/abc");
      const [button] = await screen.findAllByTestId("make-this-about-me");
      await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
      fireEvent.click(button);
      expect(location.history.at(-1)).toBe("/facts/42/meme");
      // The meme page's own builder, with its own header, is gone.
      expect(screen.queryByText(/make this fact about you/i)).toBeNull();
    },
  );
});

// #591 (David, 2026-11-21, Q2): a private meme's link reads as private, not as
// an error, and a signed-out visitor is offered sign-in in case it is theirs.
describe("MemePage — a private meme (#591)", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "This meme is private", private: true }), { status: 403, headers: { "Content-Type": "application/json" } })),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    user = { id: "viewer-1" };
  });

  it("says the meme is private, not that it was not found", async () => {
    renderAt("/m/abc");
    expect(await screen.findByTestId("meme-private")).toBeTruthy();
    expect(screen.getByText(/this meme is private/i)).toBeTruthy();
    expect(screen.queryByText(/not found/i)).toBeNull();
  });

  it("offers a signed-out visitor sign-in that comes back to this meme", async () => {
    user = null;
    renderAt("/m/abc");
    const signIn = await screen.findByTestId("meme-private-sign-in");
    expect(signIn.closest("a")?.getAttribute("href")).toBe("/login?from=%2Fm%2Fabc");
  });

  it("offers a signed-in non-owner no sign-in and no request-access button", async () => {
    renderAt("/m/abc");
    await screen.findByTestId("meme-private");
    expect(screen.queryByTestId("meme-private-sign-in")).toBeNull();
    expect(screen.queryByText(/request/i)).toBeNull();
  });
});

describe("MemePage — a meme that does not exist", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Meme not found" }), { status: 404, headers: { "Content-Type": "application/json" } })));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("still reads as not found", async () => {
    renderAt("/m/abc");
    expect(await screen.findByText(/meme not found/i)).toBeTruthy();
    expect(screen.queryByTestId("meme-private")).toBeNull();
  });
});

// #875 R3: the owner manages the meme from its own page.
describe("MemePage — the owner's visibility and delete controls (#875)", () => {
  let calls: Array<{ url: string; method: string; body?: string }>;
  beforeEach(() => {
    calls = [];
    user = { id: "creator-9" };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, method: init?.method ?? "GET", body: init?.body as string | undefined });
        if (init?.method === "PATCH") return new Response(JSON.stringify({ isPublic: false }), { status: 200 });
        if (init?.method === "DELETE") return new Response(JSON.stringify({ success: true }), { status: 200 });
        return new Response(JSON.stringify(meme), { status: 200, headers: { "Content-Type": "application/json" } });
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    user = { id: "viewer-1" };
  });

  it("a Legendary owner can make a public meme private", async () => {
    role = "legendary";
    renderAt("/m/abc");
    const [button] = await screen.findAllByTestId("own-make-private");
    fireEvent.click(button!);
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const patch = calls.find((c) => c.method === "PATCH")!;
    expect(patch.url).toBe("/api/memes/abc/visibility");
    expect(JSON.parse(patch.body!)).toEqual({ isPublic: false });
    // A copy cached while it was public can outlive the switch; the owner is told (Phase 5 answer 5(b)).
    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({
      title: "Your meme is private", description: expect.stringMatching(/up to a day/),
    })));
  });

  it("a free owner is shown that private memes are Legendary, with no private switch", async () => {
    role = "registered";
    renderAt("/m/abc");
    expect((await screen.findAllByTestId("own-private-upsell")).length).toBeGreaterThan(0);
    expect(screen.queryAllByTestId("own-make-private")).toHaveLength(0);
  });

  it("delete asks once, says where the meme goes, then deletes and opens Recently deleted", async () => {
    role = "registered";
    const location = renderAt("/m/abc");
    const [first] = await screen.findAllByTestId("own-delete");
    fireEvent.click(first!);
    const message = (await screen.findAllByTestId("own-delete-message"))[0]!.textContent;
    expect(message).toMatch(/Recently deleted/);
    expect(message).toMatch(/up to a day/);
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    fireEvent.click(screen.getAllByTestId("own-delete-confirm")[0]!);
    await waitFor(() => expect(location.history.at(-1)).toBe("/library?tab=deleted"));
    expect(calls.find((c) => c.method === "DELETE")!.url).toBe("/api/memes/abc");
  });
});

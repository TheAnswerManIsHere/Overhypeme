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
vi.mock("@workspace/replit-auth-web", () => ({
  useAuth: () => ({ user: { id: "viewer-1" }, role }),
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

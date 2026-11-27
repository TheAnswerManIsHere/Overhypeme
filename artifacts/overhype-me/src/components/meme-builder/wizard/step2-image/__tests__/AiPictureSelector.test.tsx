// Phase 7 amendment: the panel is gone from the builder, and its
// finished-picture selector stays. The member's finished pictures of this fact
// are offered by tap and never applied on their own; a picture still drawing
// shows its state and leads back to the flow; the button opens the flow.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AiPictureSelector } from "../AiPictureSelector";

afterEach(() => vi.unstubAllGlobals());

function renderSelector(pictures: unknown[]) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const body = url.startsWith("/api/users/me/ai-images")
      ? { images: [{ id: 41, storagePath: "a.png" }], nextCursor: null }
      : url === "/api/member-pictures" ? { pictures, credits: 1 } : {};
    return new Response(JSON.stringify(body), { status: 200 });
  }));
  const onPicture = vi.fn();
  const onMakePicture = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AiPictureSelector factId="3" selectedAiImageId={null} onPicture={onPicture} onMakePicture={onMakePicture} />
    </QueryClientProvider>,
  );
  return { onPicture, onMakePicture };
}

describe("AiPictureSelector", () => {
  it("offers finished pictures by tap, never applying one on its own", async () => {
    const { onPicture } = renderSelector([]);
    const pick = await screen.findByRole("button", { name: "Use this picture" });
    expect(onPicture).not.toHaveBeenCalled();
    fireEvent.click(pick);
    expect(onPicture).toHaveBeenCalledWith({ aiImageId: 41, imageUrl: "/api/memes/ai-user/image?storagePath=a.png" });
  });

  it("shows a picture of this fact still drawing, with a way back to the flow; another fact's is not shown", async () => {
    const { onMakePicture } = renderSelector([
      { attemptId: 1, factId: 3, status: "drawing" },
      { attemptId: 2, factId: 9, status: "queued" },
    ]);
    await waitFor(() => expect(screen.getByTestId("ai-picture-drawing").textContent).toContain("Drawing your picture"));
    expect(screen.getAllByRole("status")).toHaveLength(1);
    fireEvent.click(screen.getByText("Follow it"));
    expect(onMakePicture).toHaveBeenCalled();
  });

  it("the button opens the flow", () => {
    const { onMakePicture } = renderSelector([]);
    fireEvent.click(screen.getByTestId("ai-picture-open"));
    expect(onMakePicture).toHaveBeenCalled();
  });
});

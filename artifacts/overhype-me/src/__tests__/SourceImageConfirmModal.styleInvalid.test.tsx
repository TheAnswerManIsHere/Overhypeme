/**
 * #686 — generating with a style an admin has disabled is refused by the
 * server with `400 { error: "style_invalid" }`. The modal must show a readable
 * "style unavailable" message, never the raw code, and must not start polling
 * a render (nothing was enqueued).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SourceImageConfirmModal } from "@/components/SourceImageConfirmModal";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const analysis = {
  subjectKind: "human_face",
  confidence: "high",
  hasUsableHumanFace: true,
  hasUsableSubject: true,
  subjectCount: 1,
  suggestedRenderMode: "human_identity_i2i",
  warnings: [],
  classificationMethod: "test",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(generateResponse: () => Response) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/analyze-source")) return json(200, { analysis });
    if (url.endsWith("/generate-v2")) return generateResponse();
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function generate() {
  render(
    <SourceImageConfirmModal
      open
      factId={7}
      uploadedObjectPath="/objects/uploads/me.jpg"
      lookStyleId="disabled-style"
      onComplete={vi.fn()}
      onCancel={vi.fn()}
      onUploadDifferent={vi.fn()}
    />,
  );
  fireEvent.click(await screen.findByText("Use this face"));
  await screen.findByText("Something went wrong");
}

describe("SourceImageConfirmModal — disabled style refusal (#686)", () => {
  it("shows a readable 'style unavailable' message, not the code, and polls nothing", async () => {
    const fetchMock = stubFetch(() =>
      json(400, { error: "style_invalid", styleId: "disabled-style", reason: "inactive" }),
    );
    await generate();

    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).not.toContain("style_invalid");
    expect(dialog.textContent).toMatch(/style/i);
    expect(dialog.textContent).toMatch(/unavailable|isn't available|not available/i);

    const urls = fetchMock.mock.calls.map(([u]) => String(u));
    expect(urls.some((u) => u.includes("/renders/"))).toBe(false);
  });

  it("never shows another raw code from the generate refusal either", async () => {
    stubFetch(() => json(422, { error: "fact_template_unresolved" }));
    await generate();
    expect(screen.getByRole("dialog").textContent).not.toContain("fact_template_unresolved");
  });
});

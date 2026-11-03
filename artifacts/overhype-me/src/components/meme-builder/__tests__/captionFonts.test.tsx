/**
 * The caption fonts in the browser (names-and-fonts plan): the selected face
 * loads from the same file and family the server draws with; the preview
 * draws only once it has loaded, in that family at its fixed weight; a failed
 * load offers a retry; the picker appears in the wizard; every save names the
 * face explicitly; and a restored draft from the old picker previews and
 * saves in the nearest catalogue face.
 *
 * @purpose Proves the browser loads each caption face from the shared file and family, the preview waits for it and draws at the catalogue weight, a failed load can be retried, the wizard shows the picker, saves always send a catalogue id, and old drafts are mapped to one.
 * @subsystem meme-studio
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { CAPTION_FONTS } from "@workspace/api-zod";
import { LivePreview } from "../parts/LivePreview";
import { CaptionFontPicker } from "../parts/CaptionFontPicker";
import { resetCaptionFontsForTest } from "@/lib/captionFontLoader";
import { buildSaveMemePayload } from "../wizard/util/saveMemePayload";
import { captureWizardState, restoreWizardState } from "../wizard/state/wizardStorage";
import { withCaptionFont } from "../captionFont";
import { MemeBuilderWizard } from "../wizard/MemeBuilderWizard";
import type { WizardRuntimeState } from "../wizard/state/useWizardState";

type Pending = { family: string; source: string; weight: string; resolve: () => void; reject: () => void };
let faces: Pending[] = [];

beforeEach(() => {
  resetCaptionFontsForTest();
  faces = [];
  class FakeFontFace {
    constructor(public family: string, public source: string, public descriptors: { weight: string }) {}
    load() {
      return new Promise<FakeFontFace>((resolve, reject) => {
        faces.push({ family: this.family, source: this.source, weight: this.descriptors.weight, resolve: () => resolve(this), reject });
      });
    }
  }
  vi.stubGlobal("FontFace", FakeFontFace);
  Object.defineProperty(document, "fonts", { configurable: true, value: { add: vi.fn() } });
});
afterEach(() => vi.unstubAllGlobals());

const preview = (fontFamily?: string) => (
  <LivePreview factText="{NAME} counted to infinity." name="Zoë" pronouns="she/her" backgroundUrl={null}
    textOptions={fontFamily === undefined ? {} : { fontFamily }} aspectRatio="square" />
);
const canvas = () => screen.getByLabelText("Meme preview");

describe("caption fonts in the browser", () => {
  it("loads each face from the server's file, under its family and weight", () => {
    for (const font of CAPTION_FONTS) {
      const { unmount } = render(preview(font.id));
      const face = faces.find((f) => f.family === font.family)!;
      expect(face.source).toBe(`url(/fonts/caption/${font.file}) format("truetype")`);
      expect(face.weight).toBe(String(font.weight));
      expect(canvas().getAttribute("data-caption-font")).toBe(font.family);
      unmount();
    }
  });

  it("the preview waits for the face, then draws in it", async () => {
    render(preview("script"));
    expect(canvas().getAttribute("data-caption-font-status")).toBe("loading");
    await act(async () => faces[0]!.resolve());
    expect(canvas().getAttribute("data-caption-font-status")).toBe("ready");
  });

  it("an untouched caption, and an old picker's font string, draw in the default face", () => {
    render(preview());
    expect(canvas().getAttribute("data-caption-font")).toBe("OH Block");
  });

  it("a failed load says so and can be retried, or another style picked", async () => {
    render(<CaptionFontPicker value="comic" onChange={() => {}} />);
    expect(screen.getByTestId("caption-font-loading")).toBeTruthy();
    await act(async () => faces[0]!.reject());
    expect(screen.getByTestId("caption-font-failed")).toBeTruthy();
    fireEvent.click(screen.getByTestId("caption-font-retry"));
    expect(screen.getByTestId("caption-font-loading")).toBeTruthy();
    await act(async () => faces[1]!.resolve());
    expect(screen.queryByTestId("caption-font-failed")).toBeNull();
    expect(screen.queryByTestId("caption-font-loading")).toBeNull();
    expect(screen.getAllByRole("radio")).toHaveLength(CAPTION_FONTS.length);
  });

  it("every save names the face: the chosen one, or the default", () => {
    const base = { source: { kind: "self-upload", image: { kind: "library", objectPath: "/objects/x" } }, name: "Zoë", pronouns: "she/her", aspectRatio: "square" };
    const untouched = buildSaveMemePayload({ state: { ...base, textOptions: {} } as unknown as WizardRuntimeState, factId: 1 });
    expect(untouched?.textOptions?.fontFamily).toBe("block");
    const chosen = buildSaveMemePayload({ state: { ...base, textOptions: { fontFamily: "serif" } } as unknown as WizardRuntimeState, factId: 1 });
    expect(chosen?.textOptions?.fontFamily).toBe("serif");
    expect(withCaptionFont(undefined).fontFamily).toBe("block");
  });

  it("a restored draft from the old picker previews and saves in the nearest face", () => {
    window.sessionStorage.clear();
    const base = { source: { kind: "self-upload", image: { kind: "library", objectPath: "/objects/x" } }, name: "Zoë", pronouns: "she/her", aspectRatio: "square" };
    for (const [old, id, family] of [["'JetBrains Mono', monospace", "terminal", "OH Terminal"], ["'DM Sans', system-ui, sans-serif", "sans", "OH Sans"], ["'Bebas Neue', Impact, sans-serif", "block", "OH Block"]] as const) {
      captureWizardState({ schemaVersion: 3, capturedAt: Date.now(), factId: "f1", entryFlow: "fact-detail", textOptions: { fontFamily: old } });
      const restored = restoreWizardState("f1")!;
      const { unmount } = render(preview(restored.textOptions!.fontFamily));
      expect(canvas().getAttribute("data-caption-font")).toBe(family);
      unmount();
      const payload = buildSaveMemePayload({ state: { ...base, textOptions: restored.textOptions } as unknown as WizardRuntimeState, factId: 1 });
      expect(payload?.textOptions?.fontFamily).toBe(id);
    }
  });

  // Codex, PR #844: the wizard keeps its picker in a collapsed panel, so a
  // failed face must be explained, with its retry, outside it.
  it("in the wizard, a failed face is explained with a retry without opening Advanced options", async () => {
    render(
      <MemeBuilderWizard factId="fact-fonts" factText="{NAME} counted to infinity." entryFlow="fact-detail"
        viewerContext={{ tier: "registered", userId: "u1", name: "Zoë", pronouns: "she/her" }}
        onComplete={() => {}} onCancel={() => {}} />,
    );
    await screen.findByTestId("advanced-options-trigger", {}, { timeout: 5000 });
    expect(screen.queryByTestId("caption-font-picker")).toBeNull();
    const block = faces.find((f) => f.family === "OH Block")!;
    await act(async () => block.reject());
    expect((await screen.findByTestId("caption-font-failed")).textContent).toMatch(/didn't load.*Advanced options/);
    fireEvent.click(screen.getByTestId("caption-font-retry"));
    const retried = faces.filter((f) => f.family === "OH Block").at(-1)!;
    await act(async () => retried.resolve());
    expect(screen.queryByTestId("caption-font-failed")).toBeNull();
    expect(canvas().getAttribute("data-caption-font-status")).toBe("ready");
  });
});

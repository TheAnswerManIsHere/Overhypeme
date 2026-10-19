import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemeBuilderWizard } from "../MemeBuilderWizard";
import { captureWizardState } from "../state/wizardStorage";
import type { ViewerContext } from "../../types";

// Under CI load the wizard's enter-animation can delay Step 2 rendering past
// testing-library's 1 s default. 5 s gives plenty of headroom without being
// a real blocker if something is genuinely broken.
const S2 = { timeout: 5000 };

const VIEWER: ViewerContext = {
  tier: "registered",
  userId: "user-1",
  name: "Quinn",
  pronouns: "they/them",
};

function renderWizard(
  overrides: Partial<React.ComponentProps<typeof MemeBuilderWizard>> = {},
) {
  const onComplete = vi.fn();
  const onCancel = vi.fn();
  const utils = render(
    <MemeBuilderWizard
      factId="fact-42"
      factText="{NAME} can teach a fish to fly."
      viewerContext={VIEWER}
      entryFlow="fact-detail"
      onComplete={onComplete}
      onCancel={onCancel}
      {...overrides}
    />,
  );
  return { ...utils, onComplete, onCancel };
}

function directionAttr(): string | null {
  const container = screen
    .getByTestId("meme-builder-wizard")
    .querySelector("[data-direction]");
  return container?.getAttribute("data-direction") ?? null;
}

describe("MemeBuilderWizard", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it("renders Step 1 by default with both artifact-type cards", () => {
    renderWizard();
    expect(screen.getByRole("heading", { name: /what kind of meme/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^image$/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^video$/i })).toBeTruthy();
  });

  it("hides the back arrow on Step 1", () => {
    renderWizard();
    const backBtn = screen.getByLabelText("Back");
    expect(backBtn.className).toMatch(/invisible/);
  });

  it("advances to Step 2 when an artifact type is selected", async () => {
    renderWizard();
    fireEvent.click(screen.getByRole("button", { name: /^image$/i }));

    expect(await screen.findByRole("heading", { name: /build your meme/i }, S2)).toBeTruthy();
    expect(screen.getByTestId("wizard-primary-action")).toBeTruthy();
    expect(directionAttr()).toBe("forward");
  });

  it("back arrow returns to Step 1 from Step 2 with state preserved", async () => {
    // Entitled viewer so the video card is tappable (an unentitled viewer
    // would open the upgrade modal instead of advancing).
    renderWizard({
      viewerContext: {
        ...VIEWER,
        tier: "legendary",
        entitlements: { video_generation: { allowed: true, limit: null } },
      },
    });
    fireEvent.click(screen.getByRole("button", { name: /^video$/i }));
    expect(await screen.findByRole("heading", { name: /pick a photo, choose your options/i }, S2)).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Back"));
    expect(await screen.findByRole("heading", { name: /what kind of meme/i }, S2)).toBeTruthy();

    const videoCard = screen.getByRole("button", { name: /^video$/i });
    expect(videoCard.getAttribute("aria-pressed")).toBe("true");
    expect(directionAttr()).toBe("back");
  });

  it("close button invokes onCancel", () => {
    const { onCancel } = renderWizard();
    fireEvent.click(screen.getByLabelText("Close meme builder"));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("progress bar advances from step 1 to step 2", async () => {
    renderWizard();
    const progressbar = screen.getByRole("progressbar", { name: /meme builder progress/i });
    expect(progressbar.getAttribute("aria-valuenow")).toBe("1");

    fireEvent.click(screen.getByRole("button", { name: /^image$/i }));
    await screen.findByRole("heading", { name: /build your meme/i }, S2);
    expect(progressbar.getAttribute("aria-valuenow")).toBe("2");
  });

  it("persists state across an unmount+remount cycle via sessionStorage", async () => {
    const { unmount } = renderWizard();
    fireEvent.click(screen.getByRole("button", { name: /^image$/i }));
    await screen.findByRole("heading", { name: /build your meme/i }, S2);
    unmount();

    renderWizard();
    expect(await screen.findByRole("heading", { name: /build your meme/i }, S2)).toBeTruthy();
    expect(screen.queryByRole("heading", { name: /what kind of meme/i })).toBeNull();
  });

  it("does not hydrate from a different factId's draft", async () => {
    const first = renderWizard({ factId: "fact-A" });
    fireEvent.click(screen.getByRole("button", { name: /^image$/i }));
    await screen.findByRole("heading", { name: /build your meme/i }, S2);
    first.unmount();

    renderWizard({ factId: "fact-B" });
    expect(screen.getByRole("heading", { name: /what kind of meme/i })).toBeTruthy();
  });

  // Regression: Step 2 shipped with no privacy control at all, so every meme
  // built here saved public no matter what the creator wanted — and there is
  // no way to change a meme's visibility after the fact.
  describe("visibility control on Step 2", () => {
    // The privacy lock is now the SERVER's resolved entitlement, not a tier the
    // client derived — that derivation is what PR #402 broke. So the fixture
    // supplies the entitlement the way the real payload does.
    async function openImageStep(tier: ViewerContext["tier"], canSetPrivate = tier === "legendary") {
      renderWizard({
        viewerContext: {
          ...VIEWER,
          tier,
          entitlements: { meme_private_visibility: { allowed: canSetPrivate, limit: null } },
        },
      });
      fireEvent.click(screen.getByRole("button", { name: /^image$/i }));
      await screen.findByRole("heading", { name: /build your meme/i }, S2);
    }

    it("lets a legendary creator choose private before saving", async () => {
      await openImageStep("legendary");
      const priv = screen.getByTestId("meme-visibility-private");
      expect(priv.getAttribute("aria-pressed")).toBe("false");
      fireEvent.click(priv);
      expect(screen.getByTestId("meme-visibility-private").getAttribute("aria-pressed")).toBe("true");
    });

    it("shows a registered creator the upsell instead of letting them pick private", async () => {
      await openImageStep("registered");
      fireEvent.click(screen.getByTestId("meme-visibility-private"));
      expect(screen.getByTestId("meme-visibility-private").getAttribute("aria-pressed")).toBe("false");
      expect(await screen.findByText(/go legendary to keep memes private/i)).toBeTruthy();
    });

    it("omits the control for a viewer who cannot save yet", async () => {
      await openImageStep("unregistered");
      expect(screen.queryByTestId("meme-visibility")).toBeNull();
    });
  });

  // The save leg of the visibility control: what the builder POSTs to
  // /api/memes for each choice, and where the browser lands afterwards.
  describe("saving from Step 2 with a stock photo already chosen", () => {
    const PERMALINK = "/m/saved-meme-77";
    let memeBodies: Array<Record<string, unknown>>;
    let stockPhotos: Array<{ id: number; url: string }>;

    beforeEach(() => {
      memeBodies = [];
      stockPhotos = [];
      window.history.pushState({}, "", "/");
      vi.stubGlobal(
        "fetch",
        vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          let body: unknown = {};
          if (url.endsWith("/api/memes") && init?.method === "POST") {
            memeBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
            body = { memeId: 77, permalinkUrl: PERMALINK };
          } else if (url.includes("/pexels-images")) {
            body = { photos: stockPhotos, hasMore: false };
          } else if (url.includes("/api/users/me/uploads")) {
            body = { uploads: [], uploadCount: 0, maxUploads: 5 };
          }
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response);
        }),
      );
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      window.history.pushState({}, "", "/");
    });

    /** Seed the Step 2 draft the way a returning creator's session holds it:
     *  image meme, a stock photo picked, name and pronouns filled in. */
    function openStep2WithPhoto(tier: ViewerContext["tier"], canSetPrivate: boolean) {
      captureWizardState({
        schemaVersion: 2,
        capturedAt: Date.now(),
        factId: "fact-42",
        entryFlow: "fact-detail",
        currentStep: 2,
        artifactType: "image",
        source: { kind: "stock", stockImageId: "777" },
        name: "Quinn",
        pronouns: "they/them",
      });
      return renderWizard({
        viewerContext: {
          ...VIEWER,
          tier,
          entitlements: { meme_private_visibility: { allowed: canSetPrivate, limit: null } },
        },
      });
    }

    it("saving with Private picked in the builder sends isPublic false and the browser lands on the returned permalink", async () => {
      const { onComplete } = openStep2WithPhoto("legendary", true);
      await screen.findByRole("heading", { name: /build your meme/i }, S2);

      fireEvent.click(screen.getByTestId("meme-visibility-private"));
      expect(screen.getByTestId("meme-visibility-private").getAttribute("aria-pressed")).toBe("true");
      fireEvent.click(screen.getByRole("button", { name: "Make my meme" }));

      await waitFor(() => expect(memeBodies).toHaveLength(1), S2);
      expect(memeBodies[0]!.isPublic).toBe(false);
      await waitFor(() => expect(window.location.pathname).toBe(PERMALINK), S2);
      expect(onComplete).toHaveBeenCalledWith({ kind: "saved", memeId: "", permalinkUrl: PERMALINK });
    });

    it("saving with the control left on Public posts isPublic true to /api/memes and navigates to the returned permalink", async () => {
      const { onComplete } = openStep2WithPhoto("registered", false);
      await screen.findByRole("heading", { name: /build your meme/i }, S2);

      expect(screen.getByTestId("meme-visibility-public").getAttribute("aria-pressed")).toBe("true");
      fireEvent.click(screen.getByRole("button", { name: "Make my meme" }));

      await waitFor(() => expect(memeBodies).toHaveLength(1), S2);
      expect(memeBodies[0]!.isPublic).toBe(true);
      await waitFor(() => expect(window.location.pathname).toBe(PERMALINK), S2);
      expect(onComplete).toHaveBeenCalledWith({ kind: "saved", memeId: "", permalinkUrl: PERMALINK });
    });

    it("closing the upgrade modal leaves Public selected and the in-progress meme intact, and saving it then sends Public", async () => {
      const { onComplete } = openStep2WithPhoto("registered", false);
      await screen.findByRole("heading", { name: /build your meme/i }, S2);

      fireEvent.click(screen.getByTestId("meme-visibility-private"));
      expect(await screen.findByTestId("unified-upgrade-modal")).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: "Not now" }));
      await waitFor(() => expect(screen.queryByTestId("unified-upgrade-modal")).toBeNull(), S2);

      // Public is still the selection; Private never took.
      expect(screen.getByTestId("meme-visibility-public").getAttribute("aria-pressed")).toBe("true");
      expect(screen.getByTestId("meme-visibility-private").getAttribute("aria-pressed")).toBe("false");
      // The meme in progress is intact: still on Step 2, photo still chosen
      // (Make my meme enabled), and its draft is still held.
      expect(screen.getByRole("heading", { name: /build your meme/i })).toBeTruthy();
      expect((screen.getByRole("button", { name: "Make my meme" }) as HTMLButtonElement).disabled).toBe(false);
      const draft = JSON.parse(window.sessionStorage.getItem("pending_meme_wizard_v2::fact-42") ?? "{}");
      // The heading alone cannot prove the step: the step container animates
      // its exit, so Step 2 stays mounted for a moment after a step change.
      expect(draft.currentStep).toBe(2);
      expect(draft.source).toEqual({ kind: "stock", stockImageId: "777" });
      expect(draft.name).toBe("Quinn");
      expect(draft.isPublic).toBe(true);
      expect(onComplete).not.toHaveBeenCalled();
      expect(memeBodies).toHaveLength(0);

      // Saving that same draft after the upsell is dismissed still sends Public.
      fireEvent.click(screen.getByRole("button", { name: "Make my meme" }));
      await waitFor(() => expect(memeBodies).toHaveLength(1), S2);
      expect(memeBodies[0]!.isPublic).toBe(true);
      await waitFor(() => expect(window.location.pathname).toBe(PERMALINK), S2);
    });

    it("built from Step 1 with no draft: Image, the Stock tab's first photo auto-picked, saved public, lands on the permalink", async () => {
      window.sessionStorage.clear();
      stockPhotos = [{ id: 555, url: "https://images.example/555.jpg" }];
      const { onComplete } = renderWizard({
        viewerContext: {
          ...VIEWER,
          entitlements: { meme_private_visibility: { allowed: false, limit: null } },
        },
      });
      fireEvent.click(screen.getByRole("button", { name: /^image$/i }));
      await screen.findByRole("heading", { name: /build your meme/i }, S2);
      fireEvent.click(screen.getByTestId("source-tab-stock"));
      await waitFor(() => expect(screen.getByTestId("stock-thumb-555").getAttribute("aria-checked")).toBe("true"), S2);
      // The pick has reached the wizard's draft, not only the thumbnail.
      await waitFor(() => {
        const draft = JSON.parse(window.sessionStorage.getItem("pending_meme_wizard_v2::fact-42") ?? "{}");
        expect(draft.source).toEqual({ kind: "stock", stockImageId: "555" });
      }, S2);

      fireEvent.click(screen.getByRole("button", { name: "Make my meme" }));
      await waitFor(() => expect(memeBodies).toHaveLength(1), S2);
      expect(memeBodies[0]!.imageSource).toEqual({ type: "stock", pexelsPhotoId: 555 });
      expect(memeBodies[0]!.isPublic).toBe(true);
      await waitFor(() => expect(window.location.pathname).toBe(PERMALINK), S2);
      expect(onComplete).toHaveBeenCalledWith({ kind: "saved", memeId: "", permalinkUrl: PERMALINK });
    });
  });

  it("ignores expired drafts in sessionStorage", () => {
    const expired = {
      schemaVersion: 2,
      capturedAt: Date.now() - 61 * 60 * 1000,
      factId: "fact-42",
      entryFlow: "fact-detail",
      currentStep: 2,
      artifactType: "video",
    };
    window.sessionStorage.setItem(
      "pending_meme_wizard_v2::fact-42",
      JSON.stringify(expired),
    );
    renderWizard();
    expect(screen.getByRole("heading", { name: /what kind of meme/i })).toBeTruthy();
  });
});

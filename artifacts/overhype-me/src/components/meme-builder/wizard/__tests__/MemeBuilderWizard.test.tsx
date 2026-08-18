import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemeBuilderWizard } from "../MemeBuilderWizard";
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

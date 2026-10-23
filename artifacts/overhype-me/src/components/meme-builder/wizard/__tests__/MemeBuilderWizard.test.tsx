import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemeBuilderWizard } from "../MemeBuilderWizard";
import { captureWizardState } from "../state/wizardStorage";
import type { ViewerContext } from "../../types";

// Under CI load the image builder's first render can land past
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

const DRAFT_KEY = (factId: string) => `pending_meme_wizard_v2::${factId}`;

function storedDraft(factId = "fact-42"): Record<string, unknown> {
  return JSON.parse(window.sessionStorage.getItem(DRAFT_KEY(factId)) ?? "{}") as Record<string, unknown>;
}

describe("MemeBuilderWizard", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  // Video was cut in launch Phase 4, and with it the Step 1 choice between an
  // image and a video meme: the wizard now opens straight on the image builder.
  it("opens directly on the image builder, with no artifact-type step", async () => {
    renderWizard();
    expect(await screen.findByRole("heading", { name: /build your meme/i }, S2)).toBeTruthy();
    expect(screen.getByTestId("wizard-primary-action")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: /what kind of meme/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^video$/i })).toBeNull();
    expect(screen.queryByLabelText("Back")).toBeNull();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("close button invokes onCancel", () => {
    const { onCancel } = renderWizard();
    fireEvent.click(screen.getByLabelText("Close meme builder"));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("does not hydrate from a different factId's draft", async () => {
    captureWizardState({
      schemaVersion: 3,
      capturedAt: Date.now(),
      factId: "fact-A",
      entryFlow: "fact-detail",
      source: { kind: "self-upload", image: { kind: "library", objectPath: "/objects/uploads/777.jpg" } },
    });
    renderWizard({ factId: "fact-B" });
    await screen.findByRole("heading", { name: /build your meme/i }, S2);
    await waitFor(() => expect(storedDraft("fact-B").schemaVersion).toBe(3), S2);
    expect(storedDraft("fact-B").source).toBeUndefined();
    expect(storedDraft("fact-A").source).toEqual({ kind: "self-upload", image: { kind: "library", objectPath: "/objects/uploads/777.jpg" } });
  });

  it("discards a version-2 draft from before video was cut, rather than misreading it", async () => {
    window.sessionStorage.setItem(
      DRAFT_KEY("fact-42"),
      JSON.stringify({
        schemaVersion: 2,
        capturedAt: Date.now(),
        factId: "fact-42",
        entryFlow: "fact-detail",
        currentStep: 2,
        artifactType: "video",
        source: { kind: "self-upload", image: { kind: "library", objectPath: "/objects/uploads/777.jpg" } },
      }),
    );
    renderWizard();
    expect(await screen.findByRole("heading", { name: /build your meme/i }, S2)).toBeTruthy();
    await waitFor(() => expect(storedDraft().schemaVersion).toBe(3), S2);
    expect(storedDraft().source).toBeUndefined();
    expect("artifactType" in storedDraft()).toBe(false);
    expect("currentStep" in storedDraft()).toBe(false);
  });

  // Regression: the image builder shipped with no privacy control at all, so every meme
  // built here saved public no matter what the creator wanted — and there is
  // no way to change a meme's visibility after the fact.
  describe("visibility control on the image builder", () => {
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
  describe("saving from the image builder with a photo already chosen", () => {
    const PERMALINK = "/m/saved-meme-77";
    let memeBodies: Array<Record<string, unknown>>;
    let uploads: Array<Record<string, unknown>>;

    beforeEach(() => {
      memeBodies = [];
      uploads = [];
      window.history.pushState({}, "", "/");
      vi.stubGlobal(
        "fetch",
        vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          let body: unknown = {};
          if (url.endsWith("/api/memes") && init?.method === "POST") {
            memeBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
            body = { memeId: 77, permalinkUrl: PERMALINK };
          } else if (url.includes("/api/users/me/uploads")) {
            body = { uploads, uploadCount: uploads.length, maxUploads: 5, displayLimit: 5 };
          }
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response);
        }),
      );
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      window.history.pushState({}, "", "/");
    });

    /** Seed the builder draft the way a returning creator's session holds it:
     *  image meme, an uploaded photo picked, name and pronouns filled in. */
    function openStep2WithPhoto(tier: ViewerContext["tier"], canSetPrivate: boolean) {
      captureWizardState({
        schemaVersion: 3,
        capturedAt: Date.now(),
        factId: "fact-42",
        entryFlow: "fact-detail",
        source: { kind: "self-upload", image: { kind: "library", objectPath: "/objects/uploads/777.jpg" } },
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
      // The meme in progress is intact: still in the builder, photo still chosen
      // (Make my meme enabled), and its draft is still held.
      expect(screen.getByRole("heading", { name: /build your meme/i })).toBeTruthy();
      expect((screen.getByRole("button", { name: "Make my meme" }) as HTMLButtonElement).disabled).toBe(false);
      const draft = storedDraft();
      expect(draft.source).toEqual({ kind: "self-upload", image: { kind: "library", objectPath: "/objects/uploads/777.jpg" } });
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

    it("built with no draft: the library's first photo auto-picked, saved as an upload, public, lands on the permalink", async () => {
      window.sessionStorage.clear();
      uploads = [{
        objectPath: "/objects/uploads/555.jpg",
        width: 1200,
        height: 800,
        isLowRes: false,
        fileSizeBytes: 1000,
        createdAt: "2026-01-01T00:00:00Z",
        transform: null,
        sourceObjectPath: null,
        factId: null,
        transformParamsHash: null,
        isProfile: false,
      }];
      const { onComplete } = renderWizard({
        viewerContext: {
          ...VIEWER,
          entitlements: { meme_private_visibility: { allowed: false, limit: null } },
        },
      });
      await screen.findByRole("heading", { name: /build your meme/i }, S2);
      // The pick has reached the wizard's draft, not only the thumbnail.
      await waitFor(() => {
        const draft = storedDraft();
        expect(draft.source).toEqual({ kind: "self-upload", image: { kind: "library", objectPath: "/objects/uploads/555.jpg" } });
      }, S2);

      fireEvent.click(screen.getByRole("button", { name: "Make my meme" }));
      await waitFor(() => expect(memeBodies).toHaveLength(1), S2);
      expect(memeBodies[0]!.imageSource).toEqual({ type: "upload", uploadKey: "/objects/uploads/555.jpg" });
      expect(memeBodies[0]!.isPublic).toBe(true);
      await waitFor(() => expect(window.location.pathname).toBe(PERMALINK), S2);
      expect(onComplete).toHaveBeenCalledWith({ kind: "saved", memeId: "", permalinkUrl: PERMALINK });
    });

    // Launch Phase 4, removal 6: stock photos went with Pexels. A draft saved
    // before it that had the stock source selected restores with no photo, and
    // there is no source switcher left to offer one.
    it("a draft that had a stock photo restores with no photo chosen, and the screen offers only the user's own photos", async () => {
      captureWizardState({
        schemaVersion: 3,
        capturedAt: Date.now(),
        factId: "fact-42",
        entryFlow: "fact-detail",
        mode: "stock",
        source: { kind: "stock", stockImageId: "777" },
        name: "Quinn",
        pronouns: "they/them",
      } as unknown as Parameters<typeof captureWizardState>[0]);
      renderWizard();
      await screen.findByRole("heading", { name: /build your meme/i }, S2);
      await waitFor(() => expect(storedDraft().name).toBe("Quinn"), S2);
      expect(storedDraft().source).toBeUndefined();
      expect((screen.getByRole("button", { name: "Make my meme" }) as HTMLButtonElement).disabled).toBe(true);
      expect(screen.queryByTestId("source-tab-stock")).toBeNull();
      expect(screen.queryByRole("tab", { name: /stock/i })).toBeNull();
      expect(await screen.findByText("My photos")).toBeTruthy();
      expect(memeBodies).toHaveLength(0);
    });
  });

  it("ignores expired drafts in sessionStorage", async () => {
    window.sessionStorage.setItem(
      DRAFT_KEY("fact-42"),
      JSON.stringify({
        schemaVersion: 3,
        capturedAt: Date.now() - 61 * 60 * 1000,
        factId: "fact-42",
        entryFlow: "fact-detail",
        source: { kind: "self-upload", image: { kind: "library", objectPath: "/objects/uploads/777.jpg" } },
      }),
    );
    renderWizard();
    expect(await screen.findByRole("heading", { name: /build your meme/i }, S2)).toBeTruthy();
    await waitFor(() => expect(storedDraft().capturedAt).not.toBeLessThan(Date.now() - 60_000), S2);
    expect(storedDraft().source).toBeUndefined();
  });
});

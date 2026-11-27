// Phase 7 amendment (plan docs/plans/PLAN_PHASE7_AI_PICTURE_FLOW.md, *The
// builder*): leaving for the picture flow keeps the draft exactly, caption
// split included, even past the ordinary draft's hour; a finished picture's
// hand-off wins once over it, changing only the background, the shape and the
// caption; a reload afterwards restores the draft as it then stands.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useWizardState } from "../state/useWizardState";
import {
  captureWizardState,
  claimWizardStates,
  clearAllWizardStates,
  restoreWizardState,
  readPictureHandoff,
  readReturnSnapshot,
  writePictureHandoff,
  type PendingWizardState,
} from "../state/wizardStorage";

const FACT = "fact-9";
const draft: PendingWizardState = {
  schemaVersion: 3,
  capturedAt: Date.now(),
  factId: FACT,
  entryFlow: "fact-detail",
  mode: "self-upload",
  source: { kind: "self-upload", image: { kind: "library", objectPath: "/objects/uploads/1.jpg" } },
  aspectRatio: "landscape",
  framingOffset: { x: 0.2, y: -0.1 },
  name: "Alex",
  pronouns: "she/her",
  textOptions: { fontFamily: "comic" } as PendingWizardState["textOptions"],
  isPublic: false,
  splitIndex: 3,
  captionChosen: true,
};

const open = () => renderHook(() => useWizardState({ factId: FACT, entryFlow: "fact-detail", initialName: "Seed", initialPronouns: "he/him" }));

beforeEach(() => window.sessionStorage.clear());
afterEach(() => vi.useRealTimers());

describe("the builder and the picture flow", () => {
  it("cancel restores the draft exactly, caption split included, after the ordinary draft's hour has passed", () => {
    captureWizardState(draft);
    const first = open();
    act(() => first.result.current.keepForPictureFlow({ splitIndex: 4 }));
    first.unmount();

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 3 * 60 * 60 * 1000);
    const back = open();
    const { generation, ...restored } = back.result.current.state;
    void generation;
    const { schemaVersion, capturedAt, factId, entryFlow, ...expected } = draft;
    void schemaVersion; void capturedAt; void factId; void entryFlow;
    expect(restored).toEqual({ ...expected, splitIndex: 4 });
    // Used once: the draft now holds it.
    expect(readReturnSnapshot(FACT)).toBeNull();
  });

  it("the return snapshot lasts a day, and no longer", () => {
    captureWizardState(draft);
    const first = open();
    act(() => first.result.current.keepForPictureFlow({}));
    first.unmount();
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000);
    expect(readReturnSnapshot(FACT)).toBeNull();
  });

  it("a hand-off changes only the background, the shape and the caption, and is used once", () => {
    captureWizardState(draft);
    writePictureHandoff({ factId: FACT, aiImageId: 7, imageUrl: "/pic/7", aspectRatio: "portrait", caption: { name: "Rex", pronouns: "he/him", chosen: false } });
    const { result, unmount } = open();
    expect(result.current.state).toMatchObject({
      source: { kind: "ai-picture", aiImageId: 7, imageUrl: "/pic/7" },
      aspectRatio: "portrait",
      name: "Rex",
      pronouns: "he/him",
      captionChosen: false,
      framingOffset: draft.framingOffset,
      textOptions: draft.textOptions,
      isPublic: false,
      splitIndex: 3,
    });
    expect(readPictureHandoff(FACT)).toBeNull();
    unmount();
    // A reload restores the draft as it now stands, not the hand-off again.
    const reloaded = open();
    expect(reloaded.result.current.state.source).toEqual({ kind: "ai-picture", aiImageId: 7, imageUrl: "/pic/7" });
    expect(reloaded.result.current.state.name).toBe("Rex");
  });

  it("the hand-off wins over the restored draft's names, which today override incoming ones", () => {
    captureWizardState({ ...draft, name: "Old", captionChosen: false });
    writePictureHandoff({ factId: FACT, aiImageId: 8, imageUrl: "/pic/8", aspectRatio: "square", caption: { name: "Sam", pronouns: null, chosen: true } });
    const { result } = open();
    expect(result.current.state.name).toBe("Sam");
    // No pronouns recorded: the draft's stay.
    expect(result.current.state.pronouns).toBe("she/her");
    expect(result.current.state.captionChosen).toBe(true);
  });

  it("an older picture with no recorded caption leaves the builder's caption as it is", () => {
    captureWizardState(draft);
    writePictureHandoff({ factId: FACT, aiImageId: 9, imageUrl: "/pic/9", aspectRatio: "square", caption: null });
    const { result } = open();
    expect(result.current.state).toMatchObject({ name: "Alex", pronouns: "she/her", captionChosen: true, aspectRatio: "square" });
  });

  it("saving clears the return snapshot", () => {
    const { result } = open();
    act(() => result.current.keepForPictureFlow({}));
    expect(readReturnSnapshot(FACT)).not.toBeNull();
    act(() => result.current.clearDraft());
    expect(readReturnSnapshot(FACT)).toBeNull();
  });

  it("a hand-off for another fact is never applied", () => {
    writePictureHandoff({ factId: "other", aiImageId: 9, imageUrl: "/pic/9", aspectRatio: "square", caption: null });
    const { result } = open();
    expect(result.current.state.source).toBeUndefined();
    expect(readPictureHandoff("other")).not.toBeNull();
  });

  describe("whose builder state survives a page load (Codex, PR #1340)", () => {
    const keep = () => {
      captureWizardState(draft);
      const { result, unmount } = open();
      act(() => result.current.keepForPictureFlow({}));
      unmount();
      writePictureHandoff({ factId: FACT, aiImageId: 7, imageUrl: "/pic/7", aspectRatio: "portrait", caption: null });
    };

    it("a reload by the same member keeps the draft, the return snapshot and the hand-off", () => {
      claimWizardStates("member-a");
      keep();
      claimWizardStates("member-a");
      expect(restoreWizardState(FACT)).not.toBeNull();
      expect(readReturnSnapshot(FACT)).not.toBeNull();
      expect(readPictureHandoff(FACT)).not.toBeNull();
    });

    it("another member's first load clears them", () => {
      claimWizardStates("member-a");
      keep();
      claimWizardStates("member-b");
      expect(restoreWizardState(FACT)).toBeNull();
      expect(readReturnSnapshot(FACT)).toBeNull();
      expect(readPictureHandoff(FACT)).toBeNull();
    });

    it("a guest's state is cleared when someone signs in, and an unknown owner clears too", () => {
      keep();
      claimWizardStates("member-a");
      expect(restoreWizardState(FACT)).toBeNull();
      keep();
      claimWizardStates(undefined);
      expect(readReturnSnapshot(FACT)).toBeNull();
    });

    it("sign-out clears them and forgets the owner, so the next sign-in starts clean", () => {
      claimWizardStates("member-a");
      keep();
      clearAllWizardStates();
      expect(readReturnSnapshot(FACT)).toBeNull();
      keep();
      claimWizardStates("member-a");
      expect(restoreWizardState(FACT)).toBeNull();
    });
  });
});

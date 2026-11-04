/**
 * The landing pages' in-page actions go through the identity module's one operation (identity-flow Phase 3).
 *
 * @purpose Proves each wired action family hands its effect to `askBefore` and that the effect runs once when the operation runs it: the fact card's share opens the share modal only through it, its comment button and a signed-in vote likewise; a signed-out vote and a signed-out heart go straight to sign-in without asking (P3-1, David 2026-11-04); the gallery card's copy-link and open-full shortcuts copy or open at once when nothing must wait, and when it must, the deferred action opens the card's menu so the browser gesture is the visitor's next tap; the card menu's opener goes through it.
 * @subsystem public-site
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

import { resetIdentityGateForTest, setAskSnapshotForTest, takePendingActionForTest, useAskBefore } from "@/hooks/use-identity-gate";

// `useAskBefore` subscribes to nothing; it returns the module's operation.
const askBefore = useAskBefore();

/** Whether an action taken now must wait for the identity sheet. */
function mustWait(wait: boolean) {
  setAskSnapshotForTest({ mustWait: wait, location: "/facts/7" });
}
/** The identity sheet was saved: the runner runs the waiting action. */
function runWaiting() {
  const run = takePendingActionForTest();
  expect(run).not.toBeNull();
  act(() => run!());
}

const setLocation = vi.fn();
vi.mock("wouter", () => ({ useLocation: () => ["/facts/7", setLocation], Link: (p: { children: React.ReactNode }) => <a>{p.children}</a> }));

let isAuthenticated = false;
vi.mock("@workspace/replit-auth-web", () => ({ useAuth: () => ({ isAuthenticated }) }));

const rateMutate = vi.fn();
vi.mock("@/hooks/use-mutations", () => ({ useAppMutations: () => ({ rateFact: { mutate: rateMutate, isPending: false } }) }));
const heartMutate = vi.fn();
vi.mock("@workspace/api-client-react", () => ({ useHeartMeme: () => ({ mutate: heartMutate }) }));
vi.mock("@/components/ShareModal", () => ({
  ShareModal: ({ open }: { open: boolean }) => (open ? <div data-testid="share-modal-open" /> : null),
}));
const toast = vi.fn();
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));

import { FactActionCluster } from "@/components/facts/FactActionCluster";
import { MemeHeartButton } from "@/components/memes/MemeHeartButton";
import { ImageCard } from "@/components/ui/ImageCard";

const fact = { id: 7, text: "{NAME} wins.", upvotes: 1, downvotes: 0, commentCount: 0, shareCount: 0, userRating: null } as never;

beforeEach(() => {
  resetIdentityGateForTest();
  mustWait(false);
  setLocation.mockClear();
  rateMutate.mockClear();
  heartMutate.mockClear();
  isAuthenticated = false;
});

describe("the fact card's actions", () => {
  it("share opens the share modal only through askBefore, once it runs", () => {
    mustWait(true);
    render(<FactActionCluster fact={fact} onCommentClick={() => {}} />);
    fireEvent.click(screen.getByTitle("Share"));
    expect(screen.queryByTestId("share-modal-open")).toBeNull();
    // The identity sheet is saved: the operation runs the deferred action.
    runWaiting();
    expect(screen.getByTestId("share-modal-open")).toBeTruthy();
  });

  it("share opens at once when nothing has to wait", () => {
    render(<FactActionCluster fact={fact} onCommentClick={() => {}} />);
    fireEvent.click(screen.getByTitle("Share"));
    expect(screen.getByTestId("share-modal-open")).toBeTruthy();
  });

  it("the comment button hands its effect to askBefore", () => {
    const onCommentClick = vi.fn();
    mustWait(true);
    render(<FactActionCluster fact={fact} onCommentClick={onCommentClick} />);
    fireEvent.click(screen.getByTitle("Comments"));
    expect(onCommentClick).not.toHaveBeenCalled();
    runWaiting();
    expect(onCommentClick).toHaveBeenCalledTimes(1);
  });

  it("a signed-out vote goes straight to sign-in without asking (P3-1)", () => {
    render(<FactActionCluster fact={fact} onCommentClick={() => {}} />);
    fireEvent.click(screen.getByTitle("Upvote"));
    expect(setLocation).toHaveBeenCalledWith("/login?from=/facts/7");
    expect(takePendingActionForTest()).toBeNull();
    expect(rateMutate).not.toHaveBeenCalled();
  });

  it("a signed-in vote goes through askBefore", () => {
    isAuthenticated = true;
    mustWait(true);
    render(<FactActionCluster fact={fact} onCommentClick={() => {}} />);
    fireEvent.click(screen.getByTitle("Upvote"));
    expect(rateMutate).not.toHaveBeenCalled();
    runWaiting();
    expect(rateMutate).toHaveBeenCalledTimes(1);
  });
});

describe("hearts", () => {
  it("a signed-out heart goes straight to sign-in without asking (P3-1)", () => {
    render(<MemeHeartButton memeId={3} initialHeartCount={0} initialViewerHasHearted={false} />);
    fireEvent.click(screen.getByRole("button"));
    expect(setLocation).toHaveBeenCalledWith(expect.stringMatching(/^\/login\?from=/));
    expect(takePendingActionForTest()).toBeNull();
    expect(heartMutate).not.toHaveBeenCalled();
  });

  it("a signed-in heart goes through askBefore", () => {
    isAuthenticated = true;
    mustWait(true);
    render(<MemeHeartButton memeId={3} initialHeartCount={0} initialViewerHasHearted={false} />);
    fireEvent.click(screen.getByRole("button"));
    expect(heartMutate).not.toHaveBeenCalled();
    runWaiting();
    expect(heartMutate).toHaveBeenCalledTimes(1);
  });
});

describe("the gallery card", () => {
  function card() {
    return render(
      <ImageCard src="/x.jpg" permalink="https://overhype.me/m/x" actions={["copyLink", "openFull"]} askBefore={askBefore} compact />,
    );
  }

  it("copy link copies at once when nothing has to wait", () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.assign(navigator, { clipboard: { writeText } });
    card();
    fireEvent.click(screen.getByLabelText("Copy link"));
    expect(writeText).toHaveBeenCalledWith("https://overhype.me/m/x");
  });

  it("copy link that must wait opens the card's menu instead, never copying from the delayed callback", () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.assign(navigator, { clipboard: { writeText } });
    mustWait(true);
    card();
    fireEvent.click(screen.getByLabelText("Copy link"));
    expect(writeText).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).toBeNull();
    runWaiting();
    expect(writeText).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Image actions").getAttribute("aria-expanded")).toBe("true");
  });

  it("open full size that must wait opens the menu instead of a window", () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    mustWait(true);
    card();
    fireEvent.click(screen.getByLabelText("Open full resolution"));
    runWaiting();
    expect(open).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Image actions").getAttribute("aria-expanded")).toBe("true");
    open.mockRestore();
  });

  it("the menu opener goes through askBefore", () => {
    mustWait(true);
    card();
    fireEvent.click(screen.getByLabelText("Image actions"));
    expect(screen.getByLabelText("Image actions").getAttribute("aria-expanded")).toBe("false");
    runWaiting();
    expect(screen.getByLabelText("Image actions").getAttribute("aria-expanded")).toBe("true");
  });
});

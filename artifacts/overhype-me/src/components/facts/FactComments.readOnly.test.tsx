/**
 * Issue #1107: a comment refused because the site is read-only showed
 * "Failed to post comment / Please try again." in place of the refusal's own
 * toast saying why. The form now skips its generic toast for that refusal
 * only, decided from the request's own error, and keeps the typed text either
 * way. Any other failure still shows it, even while the site is paused.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { FactSummary } from "@workspace/api-client-react";
import { FactComments } from "./FactComments";
import { __resetReadOnlyNoticeForTests, noteReadOnlyRefusal, setReadOnlyNow } from "@/lib/readOnlyNotice";

const toast = vi.fn();
let onError: ((err: unknown) => void) | undefined;

vi.mock("@workspace/replit-auth-web", () => ({
  useAuth: () => ({
    isAuthenticated: true,
    role: "registered",
    entitlements: {},
    can: () => true, // comment_captcha_bypass: no challenge in the way
    user: { id: "u2", displayName: "Reg", firstName: "Reg" },
  }),
}));
vi.mock("@workspace/api-client-react", () => ({
  useListComments: () => ({ data: { comments: [] }, isLoading: false }),
  getListCommentsQueryKey: () => ["comments"],
}));
vi.mock("@/hooks/use-mutations", () => ({
  useAppMutations: () => ({
    addComment: { mutate: (_vars: unknown, opts: { onError: (err: unknown) => void }) => { onError = opts.onError; } },
  }),
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));
vi.mock("@/hooks/use-identity-gate", () => ({
  useAskBefore: () => (_to: string, fn: () => void) => fn(),
  useAskBeforeSignedIn: () => (_to: string, fn: () => void) => fn(),
}));
vi.mock("@/components/comments/CommentHeartButton", () => ({ CommentHeartButton: () => null }));
vi.mock("@/components/AccessGate", () => ({ AccessGate: () => null }));
vi.mock("wouter", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  useLocation: () => ["/", vi.fn()],
}));
vi.mock("@/components/ui/Turnstile", () => ({ Turnstile: () => null }));

const fact = { id: 456, commentCount: 0 } as unknown as FactSummary;
const refusal = { status: 503, data: { code: "READ_ONLY_MODE", error: "paused" } };

function postComment(variant: "detail" | "feed"): HTMLTextAreaElement {
  render(<FactComments fact={fact} variant={variant} />);
  const box = (screen.queryByPlaceholderText("Smack some knowledge on us...") ??
    screen.getByPlaceholderText("Add a comment…")) as HTMLTextAreaElement;
  fireEvent.change(box, { target: { value: "Legend." } });
  fireEvent.submit(box.closest("form")!);
  expect(onError, "the form sent the comment").toBeDefined();
  return box;
}

beforeEach(() => {
  window.localStorage.clear();
  toast.mockClear();
  onError = undefined;
});
afterEach(() => __resetReadOnlyNoticeForTests());

describe("a comment that fails", () => {
  for (const variant of ["detail", "feed"] as const) {
    it(`${variant} form: a read-only refusal raises no generic failure toast, and the text is kept`, () => {
      const box = postComment(variant);
      act(() => onError!(refusal));
      expect(toast).not.toHaveBeenCalled();
      expect(box.value).toBe("Legend.");
    });

    it(`${variant} form: any other failure still says it failed, even once the site is known to be paused`, () => {
      postComment(variant);
      act(() => noteReadOnlyRefusal());
      act(() => onError!({ status: 500, data: { error: "boom" } }));
      expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Failed to post comment" }));
    });

    it(`${variant} form: while the site is known to be paused, the post button is grayed out and submitting sends nothing (#1109)`, () => {
      setReadOnlyNow(true);
      render(<FactComments fact={fact} variant={variant} />);
      const box = (screen.queryByPlaceholderText("Smack some knowledge on us...") ??
        screen.getByPlaceholderText("Add a comment…")) as HTMLTextAreaElement;
      fireEvent.change(box, { target: { value: "Legend." } });
      expect(screen.getAllByTestId("read-only-paused").length).toBeGreaterThan(0);
      fireEvent.submit(box.closest("form")!);
      expect(onError, "nothing was sent").toBeUndefined();
      expect(box.value).toBe("Legend.");
    });
  }
});

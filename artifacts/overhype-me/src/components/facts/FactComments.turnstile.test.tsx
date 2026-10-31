/**
 * The comment forms mount Cloudflare Turnstile only while a comment is being
 * written (launch Phase 5, increment 1, #795): a reader never loads the
 * third-party script, and a page with a form on it can settle.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { FactSummary } from "@workspace/api-client-react";
import { FactComments } from "./FactComments";

vi.mock("@workspace/replit-auth-web", () => ({
  useAuth: () => ({
    isAuthenticated: true,
    role: "registered",
    entitlements: {},
    can: () => false, // no comment_captcha_bypass
    user: { id: "u2", displayName: "Reg", firstName: "Reg" },
  }),
}));
vi.mock("@workspace/api-client-react", () => ({
  useListComments: () => ({ data: { comments: [] }, isLoading: false }),
  getListCommentsQueryKey: () => ["comments"],
}));
vi.mock("@/hooks/use-mutations", () => ({ useAppMutations: () => ({ addComment: { mutate: vi.fn() } }) }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/components/comments/CommentHeartButton", () => ({ CommentHeartButton: () => null }));
vi.mock("@/components/AccessGate", () => ({ AccessGate: () => null }));
vi.mock("wouter", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  useLocation: () => ["/", vi.fn()],
}));
vi.mock("@/components/ui/Turnstile", () => ({
  Turnstile: () => <div data-testid="turnstile-widget" />,
}));

const fact = { id: 456, commentCount: 0 } as unknown as FactSummary;

describe("FactComments — the challenge waits for a comment", () => {
  for (const variant of ["detail", "feed"] as const) {
    it(`${variant} form: no challenge until text is typed, then it appears, and goes when the text is cleared`, () => {
      window.localStorage.clear();
      render(<FactComments fact={fact} variant={variant} />);
      const box = (screen.queryByPlaceholderText("Smack some knowledge on us...") ??
        screen.getByPlaceholderText("Add a comment…")) as HTMLTextAreaElement;
      expect(screen.queryByTestId("turnstile-widget")).toBeNull();
      fireEvent.change(box, { target: { value: "Legend." } });
      expect(screen.getByTestId("turnstile-widget")).toBeTruthy();
      fireEvent.change(box, { target: { value: "" } });
      expect(screen.queryByTestId("turnstile-widget")).toBeNull();
    });
  }
});

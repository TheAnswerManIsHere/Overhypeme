import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import type { FactSummary } from "@workspace/api-client-react";
import { FactComments } from "./FactComments";
import { stableSerialize } from "@/lib/form-draft-storage";

// Minimal mocks — we only exercise the feed composer's draft persistence.
vi.mock("@workspace/replit-auth-web", () => ({
  useAuth: () => ({
    isAuthenticated: true,
    role: "legendary",
    // The composer asks the SERVER's entitlement now, not the role — granting
    // comment_captcha_bypass is what makes it render plainly.
    entitlements: { comment_captcha_bypass: { allowed: true, limit: null } },
    can: (key: string) => key === "comment_captcha_bypass",
    user: { id: "u1", displayName: "Me", firstName: "Me" },
  }),
}));
vi.mock("@workspace/api-client-react", () => ({
  useListComments: () => ({ data: { comments: [] }, isLoading: false }),
  getListCommentsQueryKey: () => ["comments"],
}));
vi.mock("@/hooks/use-mutations", () => ({
  useAppMutations: () => ({ addComment: { mutate: vi.fn() } }),
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/components/comments/CommentHeartButton", () => ({ CommentHeartButton: () => null }));
vi.mock("@/components/AccessGate", () => ({ AccessGate: () => null }));
vi.mock("wouter", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  useLocation: () => ["/", vi.fn()],
}));

const fact = { id: 123, commentCount: 0 } as unknown as FactSummary;

function seedDraft(text: string) {
  window.localStorage.setItem(
    "comment_draft::u1::123",
    stableSerialize({ schemaVersion: 1, savedAt: Date.now(), value: { text } }),
  );
}

describe("FactComments draft persistence", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("does not clobber a non-empty in-memory draft with the stored draft", async () => {
    seedDraft("from storage");
    render(<FactComments fact={fact} variant="feed" draft="in memory" onDraftChange={() => {}} />);
    const ta = (await screen.findByPlaceholderText("Add a comment…")) as HTMLTextAreaElement;
    // In-memory fast path wins; localStorage restore is skipped.
    expect(ta.value).toBe("in memory");
  });

  it("restores the stored draft when there is no in-memory draft", async () => {
    seedDraft("from storage");
    render(<FactComments fact={fact} variant="feed" draft="" onDraftChange={() => {}} />);
    const ta = (await screen.findByPlaceholderText("Add a comment…")) as HTMLTextAreaElement;
    await waitFor(() => expect(ta.value).toBe("from storage"));
  });
});

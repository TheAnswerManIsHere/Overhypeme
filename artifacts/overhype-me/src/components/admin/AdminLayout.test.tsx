import { describe, expect, it, vi } from "vitest";

vi.mock("@workspace/replit-auth-web", () => ({
  useAuth: () => ({
    isAuthenticated: true,
    isLoading: false,
    logout: vi.fn(),
    role: "admin",
  }),
}));
import { isAdminNavItemActive } from "./AdminLayout";

describe("isAdminNavItemActive", () => {
  it("matches exact dashboard links only at /admin", () => {
    expect(isAdminNavItemActive("/admin", "/admin", true)).toBe(true);
    expect(isAdminNavItemActive("/admin/facts", "/admin", true)).toBe(false);
  });

  it("matches nested admin routes on path segment boundaries", () => {
    expect(isAdminNavItemActive("/admin/facts", "/admin/facts")).toBe(true);
    expect(isAdminNavItemActive("/admin/facts/123", "/admin/facts")).toBe(true);
  });

  it("does not mark sibling routes with the same prefix as active", () => {
    expect(isAdminNavItemActive("/admin/facts-archive", "/admin/facts")).toBe(false);
    expect(isAdminNavItemActive("/admin/email-queue-history", "/admin/email-queue")).toBe(false);
  });
});

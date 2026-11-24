// #875 R1: the file/size/type/resolution strip under images is an admin
// debugging aid. Every other viewer, signed out included, sees nothing.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";

let role: string | undefined = "registered";
vi.mock("@workspace/replit-auth-web", () => ({ useAuth: () => ({ role }) }));

import { AdminMediaInfo } from "./AdminMediaInfo";

const props = { fileName: "meme.jpg", fileSizeBytes: 2048, mimeType: "image/jpeg", width: 800, height: 600 };

describe("AdminMediaInfo", () => {
  beforeEach(() => { role = "registered"; });

  it("renders nothing for a member, a Legendary member or a signed-out visitor", () => {
    for (const r of ["registered", "legendary", "unregistered", undefined]) {
      role = r;
      const { container, unmount } = render(<AdminMediaInfo {...props} />);
      expect(container.textContent).toBe("");
      unmount();
    }
  });

  it("shows the strip to an admin", () => {
    role = "admin";
    const { container } = render(<AdminMediaInfo {...props} />);
    expect(container.textContent).toContain("meme.jpg");
    expect(container.textContent).toContain("800×600");
  });
});

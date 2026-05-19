import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { AiSourcePanel } from "../AiSourcePanel";

interface MockRow {
  object_path: string;
  /** Marks the row as the user's current profile photo (task #507). */
  isProfile?: boolean;
  /** "raw" (library) or "pulid"/"pulid_fallback_text" (AI stylings). */
  transform?: "pulid" | "pulid_fallback_text" | null;
}

function mockFetchUploads(rows: MockRow[] = []) {
  return vi.fn().mockImplementation((url: string) => {
    if (url.startsWith("/api/users/me/uploads")) {
      // The new endpoint sorts is_profile=true first, so the picker's
      // auto-select picks the profile photo when present.
      const sorted = [...rows].sort((a, b) => Number(!!b.isProfile) - Number(!!a.isProfile));
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            uploads: sorted.map((r) => ({
              objectPath: r.object_path,
              width: 1024,
              height: 1024,
              isLowRes: false,
              fileSizeBytes: 100,
              createdAt: new Date().toISOString(),
              transform: r.transform ?? "pulid",
              sourceObjectPath: "/objects/ref.jpg",
              factId: 42,
              transformParamsHash: null,
              isProfile: !!r.isProfile,
            })),
            uploadCount: rows.length,
            maxUploads: 20,
            displayLimit: 12,
          }),
      });
    }
    return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
  });
}

function renderPanel(overrides: Partial<React.ComponentProps<typeof AiSourcePanel>> = {}) {
  const onSelect = vi.fn();
  const onSubTabChange = vi.fn();
  const onCreate = vi.fn();
  const utils = render(
    <AiSourcePanel
      factId="42"
      selected={null}
      onSelect={onSelect}
      subTab="existing"
      onSubTabChange={onSubTabChange}
      onCreate={onCreate}
      aiReloadKey={0}
      {...overrides}
    />,
  );
  return { ...utils, onSelect, onSubTabChange, onCreate };
}

describe("AiSourcePanel", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("renders both sub-tabs with the new labels", () => {
    globalThis.fetch = mockFetchUploads([]) as typeof globalThis.fetch;
    renderPanel();
    expect(screen.getByTestId("ai-sub-tab-existing").textContent).toMatch(/use existing ai image/i);
    expect(screen.getByTestId("ai-sub-tab-create").textContent).toMatch(/create new ai image/i);
  });

  it("'Use existing AI image' shows the AI stylings grid and lets the user select one", async () => {
    globalThis.fetch = mockFetchUploads([
      { object_path: "/objects/ai-1.jpg" },
      { object_path: "/objects/ai-2.jpg" },
    ]) as typeof globalThis.fetch;
    const { onSelect } = renderPanel();
    const tile = await screen.findByTestId("ai-existing-thumb-/objects/ai-1.jpg");
    fireEvent.click(tile);
    expect(onSelect).toHaveBeenCalledWith({ kind: "ai-styling", objectPath: "/objects/ai-1.jpg" });
  });

  it("'Create new AI image' fires onCreate with the chosen reference + style", async () => {
    // Task #507: the profile photo now lives in the library grid (tagged
    // is_profile=true, sorted first). MyImagePicker auto-selects the first
    // library row so Create becomes enabled without an extra tap.
    globalThis.fetch = mockFetchUploads([
      { object_path: "/objects/profile.jpg", isProfile: true, transform: null },
    ]) as typeof globalThis.fetch;
    const { onCreate } = renderPanel({ subTab: "create" });

    const createBtn = screen.getByTestId("ai-create-button") as HTMLButtonElement;
    await waitFor(() => expect(createBtn.disabled).toBe(false));

    // Open Advanced options and switch style.
    fireEvent.click(screen.getByTestId("ai-advanced-toggle"));
    const select = screen.getByTestId("ai-style-select") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "anime" } });

    fireEvent.click(createBtn);
    expect(onCreate).toHaveBeenCalledWith({
      referenceImagePath: "/objects/profile.jpg",
      aiStyleId: "anime",
    });
  });

  it("'Create' is disabled while a job is in flight (prevents duplicate PuLID jobs)", async () => {
    globalThis.fetch = mockFetchUploads([]) as typeof globalThis.fetch;
    const { onCreate } = renderPanel({ subTab: "create", creating: true });
    const createBtn = screen.getByTestId("ai-create-button") as HTMLButtonElement;
    await waitFor(() => expect(createBtn.disabled).toBe(true));
    expect(createBtn.textContent).toMatch(/creating/i);
    fireEvent.click(createBtn);
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("'Create' is disabled when no reference is available (empty library)", async () => {
    globalThis.fetch = mockFetchUploads([]) as typeof globalThis.fetch;
    renderPanel({ subTab: "create" });
    const createBtn = screen.getByTestId("ai-create-button") as HTMLButtonElement;
    await waitFor(() => expect(createBtn.disabled).toBe(true));
  });

  it("clicking a sub-tab calls onSubTabChange", () => {
    globalThis.fetch = mockFetchUploads([]) as typeof globalThis.fetch;
    const { onSubTabChange } = renderPanel();
    fireEvent.click(screen.getByTestId("ai-sub-tab-create"));
    expect(onSubTabChange).toHaveBeenCalledWith("create");
  });

  it("highlights the selected AI styling tile", async () => {
    globalThis.fetch = mockFetchUploads([
      { object_path: "/objects/ai-1.jpg" },
      { object_path: "/objects/ai-2.jpg" },
    ]) as typeof globalThis.fetch;
    renderPanel({ selected: { kind: "ai-styling", objectPath: "/objects/ai-2.jpg" } });
    await waitFor(() => {
      const second = screen.getByTestId("ai-existing-thumb-/objects/ai-2.jpg");
      expect(second.getAttribute("aria-checked")).toBe("true");
    });
    const first = screen.getByTestId("ai-existing-thumb-/objects/ai-1.jpg");
    expect(first.getAttribute("aria-checked")).toBe("false");
  });
});

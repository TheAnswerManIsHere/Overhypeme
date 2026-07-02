import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { FieldInfo, FieldLabel, guardModalOverlayDismiss } from "./FieldInfo";
import { fieldLabel } from "./fieldDocs";

/**
 * FieldInfo/FieldLabel behavior:
 *  - tap/click (not hover) opens a persistent popover with the registry content
 *  - content is scrollable and layered above the review modal (z-[70])
 *  - Escape and outside-tap close it
 *  - inside the review-modal backdrop stack, an outside-tap on the dark
 *    backdrop closes ONLY the popover — the modal's onClick={onClose} must not
 *    fire (the capture-phase click swallow in FieldInfo)
 *  - the info button is a sibling of <label>, never a child (a button inside a
 *    label would receive label-forwarded clicks and toggle the field control)
 */

afterEach(() => cleanup());

const open = () => fireEvent.click(screen.getByTestId("field-info-primaryArchetype"));
const content = () => screen.queryByTestId("field-info-content-primaryArchetype");

describe("FieldInfo", () => {
  it("opens on click with registry content, scrollable and above the modal z-index", () => {
    render(<FieldInfo docKey="primaryArchetype" />);
    expect(content()).toBeNull();

    open();
    const el = content();
    expect(el).toBeTruthy();
    // Registry-sourced content: the hint and a known value doc are present.
    expect(el!.textContent).toContain(fieldLabel("primaryArchetype"));
    expect(el!.textContent).toContain("superhuman_physical_feat");
    // Persistent + scrollable + layered above the z-50 review modal.
    expect(el!.className).toContain("overflow-y-auto");
    expect(el!.className).toContain("z-[70]");
    expect(el!.className).toContain("max-h-[70vh]");
  });

  it("closes on Escape", () => {
    render(<FieldInfo docKey="primaryArchetype" />);
    open();
    expect(content()).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(content()).toBeNull();
  });

  // NOTE: Radix's outside-*pointerdown* dismissal doesn't fire under jsdom's
  // synthetic events, so we verify dismissal via Escape (above) — which proves
  // the dismissable layer is wired — and cover the real outside-tap gesture in
  // the UAT (manual iPad check). The modal-backdrop guard itself is unit-tested
  // below via guardModalOverlayDismiss, which is the actual regression risk.
});

describe("guardModalOverlayDismiss (modal-backdrop close guard)", () => {
  it("swallows the next click ONLY for a direct backdrop hit (one-shot)", () => {
    document.body.innerHTML = `<div data-modal-overlay><div data-testid="card"></div></div>`;
    const overlay = document.querySelector("[data-modal-overlay]") as HTMLElement;
    const onClose = vi.fn();
    overlay.addEventListener("click", onClose);

    // Simulate what onPointerDownOutside does when the tap lands on the dark
    // backdrop itself (the overlay element, not a descendant).
    guardModalOverlayDismiss(overlay);

    overlay.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onClose).not.toHaveBeenCalled(); // popover closed; modal stayed open

    // One-shot: the next backdrop click closes the modal as normal.
    overlay.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does NOT swallow clicks on controls INSIDE the modal card (Codex P2)", () => {
    // The card and all its controls are DESCENDANTS of the overlay — dismissing
    // the popover by tapping one of them must not eat that control's click
    // (which would force admins to tap twice).
    document.body.innerHTML = `<div data-modal-overlay><div data-testid="card"><button data-testid="btn"></button></div></div>`;
    const btn = document.querySelector('[data-testid="btn"]') as HTMLElement;
    const onBtnClick = vi.fn();
    btn.addEventListener("click", onBtnClick);

    guardModalOverlayDismiss(btn); // pointerdown landed on an in-modal control
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onBtnClick).toHaveBeenCalledTimes(1); // not swallowed
  });

  it("does nothing when the dismiss did not land on a modal overlay", () => {
    document.body.innerHTML = `<div data-testid="plain"></div>`;
    const el = document.querySelector('[data-testid="plain"]') as HTMLElement;
    const onClose = vi.fn();
    el.addEventListener("click", onClose);

    guardModalOverlayDismiss(el);
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onClose).toHaveBeenCalledTimes(1); // not swallowed
  });
});

describe("FieldInfo inside the review-modal backdrop stack", () => {
  /** Faithful replica of ReviewModal's stack (moderation.tsx): a fixed
   *  data-modal-overlay backdrop whose onClick closes the modal, with a card
   *  that stops propagation. */
  function ModalStack({ onClose }: { onClose: () => void }) {
    return (
      <div data-modal-overlay data-testid="overlay" onClick={onClose}>
        <div data-testid="card" onClick={(e) => e.stopPropagation()}>
          <FieldInfo docKey="primaryArchetype" />
        </div>
      </div>
    );
  }

  it("Escape closes the popover and leaves the modal open", () => {
    const onClose = vi.fn();
    render(<ModalStack onClose={onClose} />);
    open();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(content()).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("FieldLabel", () => {
  it("renders the registry label text with the info button as a SIBLING of <label>", () => {
    const { container } = render(<FieldLabel docKey="modifiers" />);
    const label = container.querySelector("label");
    expect(label?.textContent).toBe(fieldLabel("modifiers"));
    const btn = screen.getByTestId("field-info-modifiers");
    expect(label?.contains(btn)).toBe(false);
  });

  it("renders labelSuffix so legacy label text stays byte-identical", () => {
    const { container } = render(<FieldLabel docKey="vso.moderatorIntent" />);
    // Pre-rename this must render exactly the historical on-screen string.
    expect(container.querySelector("label")?.textContent).toBe("Moderator Intent (admin-only, not rendered)");
  });
});

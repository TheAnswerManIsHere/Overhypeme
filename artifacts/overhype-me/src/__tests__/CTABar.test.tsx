import { describe, it, expect, vi } from "vitest";
import { render, fireEvent, screen } from "@testing-library/react";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import {
  CTABarAnonOther,
  CTABarLegendaryOther,
  CTABarOwn,
  CTABarRegisteredOther,
} from "@/pages/memePage/cta/CTABar";

function renderWithRouter(ui: React.ReactElement) {
  const { hook } = memoryLocation({ path: "/m/abc" });
  return render(<Router hook={hook}>{ui}</Router>);
}

// Since stock photos went with Pexels (launch Phase 4, removal 6) a signed-out
// visitor has nothing to build a meme on until Phase 7, so the card asks for
// the sign-up and makes no promise of a preview with their name.
describe("CTABarAnonOther", () => {
  it("is a sign-up card with the browse button and tier ladder, and no name form", () => {
    renderWithRouter(<CTABarAnonOther onSignup={vi.fn()} />);

    expect(screen.getByText(/make this meme about you/i)).toBeTruthy();
    expect(screen.getByTestId("anon-signup-make").textContent).toMatch(/sign up free/i);
    expect(screen.getByTestId("browse-more-facts")).toBeTruthy();
    expect(screen.getByTestId("tier-ladder-signup")).toBeTruthy();
    expect(screen.getByTestId("tier-ladder-legendary")).toBeTruthy();
    expect(screen.queryByText(/see it with your name/i)).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
    // No own/legendary CTAs
    expect(screen.queryByTestId("turn-up-to-11")).toBeNull();
  });

  it("sends the visitor to sign up", () => {
    const onSignup = vi.fn();
    renderWithRouter(<CTABarAnonOther onSignup={onSignup} />);
    fireEvent.click(screen.getByTestId("anon-signup-make"));
    expect(onSignup).toHaveBeenCalledOnce();
  });
});

describe("CTABarOwn", () => {
  it("offers download and custom share only: no merch (removal 4), no PuLID turn-up and no upsell (removal 3)", () => {
    const onDownload = vi.fn();
    const onCustomShare = vi.fn();
    renderWithRouter(
      <CTABarOwn
        onDownload={onDownload}
        onCustomShare={onCustomShare}
      />,
    );
    fireEvent.click(screen.getByTestId("own-download"));
    fireEvent.click(screen.getByTestId("own-custom-share"));
    expect(onDownload).toHaveBeenCalledOnce();
    expect(onCustomShare).toHaveBeenCalledOnce();
    expect(screen.queryByTestId("merch-wear")).toBeNull();
    expect(screen.queryByText(/wear this meme/i)).toBeNull();
    expect(screen.queryByTestId("turn-up-to-11")).toBeNull();
    expect(screen.queryByTestId("legendary-upsell")).toBeNull();
    expect(screen.queryByTestId("make-this-about-me")).toBeNull();
  });
});

describe("CTABarRegisteredOther", () => {
  it("primary is make-this-about-me; secondary is browse; no face-in-scene upsell (removal 3)", () => {
    const onMakeAboutMe = vi.fn();
    renderWithRouter(
      <CTABarRegisteredOther
        onMakeAboutMe={onMakeAboutMe}
        factTemplateReady={true}
      />,
    );
    fireEvent.click(screen.getByTestId("make-this-about-me"));
    expect(onMakeAboutMe).toHaveBeenCalledOnce();
    expect(screen.getByTestId("browse-more-facts")).toBeTruthy();
    expect(screen.queryByTestId("legendary-upsell")).toBeNull();
  });

  it("disables make-this-about-me until the fact template is loaded", () => {
    const onMakeAboutMe = vi.fn();
    renderWithRouter(
      <CTABarRegisteredOther
        onMakeAboutMe={onMakeAboutMe}
        factTemplateReady={false}
      />,
    );
    const cta = screen.getByTestId("make-this-about-me") as HTMLButtonElement;
    expect(cta.disabled).toBe(true);
    fireEvent.click(cta);
    expect(onMakeAboutMe).not.toHaveBeenCalled();
  });
});

describe("CTABarLegendaryOther", () => {
  it("renders make-this-about-me + browse, no tier upsell", () => {
    const onMakeAboutMe = vi.fn();
    renderWithRouter(
      <CTABarLegendaryOther onMakeAboutMe={onMakeAboutMe} factTemplateReady={true} />,
    );
    fireEvent.click(screen.getByTestId("make-this-about-me"));
    expect(onMakeAboutMe).toHaveBeenCalledOnce();
    expect(screen.getByTestId("browse-more-facts")).toBeTruthy();
    expect(screen.queryByTestId("legendary-upsell")).toBeNull();
  });

  it("disables make-this-about-me until the fact template is loaded", () => {
    const onMakeAboutMe = vi.fn();
    renderWithRouter(
      <CTABarLegendaryOther onMakeAboutMe={onMakeAboutMe} factTemplateReady={false} />,
    );
    const cta = screen.getByTestId("make-this-about-me") as HTMLButtonElement;
    expect(cta.disabled).toBe(true);
    fireEvent.click(cta);
    expect(onMakeAboutMe).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, vi } from "vitest";
import { render, fireEvent, screen } from "@testing-library/react";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import {
  CTABarAnonOther,
  CTABarAnonOwnTransient,
  CTABarLegendaryOther,
  CTABarLegendaryOwnPulid,
  CTABarLegendaryOwnStock,
  CTABarRegisteredOther,
  CTABarRegisteredOwn,
} from "@/pages/memePage/cta/CTABar";

function renderWithRouter(ui: React.ReactElement) {
  const { hook } = memoryLocation({ path: "/m/abc" });
  return render(<Router hook={hook}>{ui}</Router>);
}

describe("CTABarAnonOther", () => {
  it("renders the inline name+pronoun form, browse button, and tier ladder", () => {
    const onOpenBuilder = vi.fn();
    renderWithRouter(<CTABarAnonOther onOpenBuilder={onOpenBuilder} />);

    expect(screen.getByTestId("anon-name-input")).toBeTruthy();
    expect(screen.getByTestId("anon-pronouns-input")).toBeTruthy();
    expect(screen.getByTestId("anon-see-with-name")).toBeTruthy();
    expect(screen.getByTestId("browse-more-facts")).toBeTruthy();
    expect(screen.getByTestId("tier-ladder-signup")).toBeTruthy();
    expect(screen.getByTestId("tier-ladder-legendary")).toBeTruthy();
    // No own/legendary CTAs
    expect(screen.queryByTestId("turn-up-to-11")).toBeNull();
    expect(screen.queryByTestId("merch-wear")).toBeNull();
  });

  it("submits form and opens builder with name + pronouns", () => {
    const onOpenBuilder = vi.fn();
    renderWithRouter(<CTABarAnonOther onOpenBuilder={onOpenBuilder} />);
    fireEvent.change(screen.getByTestId("anon-name-input"), { target: { value: "Sam" } });
    fireEvent.change(screen.getByTestId("anon-pronouns-input"), { target: { value: "she/her" } });
    fireEvent.click(screen.getByTestId("anon-see-with-name"));
    expect(onOpenBuilder).toHaveBeenCalledWith({
      initialName: "Sam",
      initialPronouns: "she/her",
    });
  });
});

describe("CTABarAnonOwnTransient", () => {
  it("primary is signup, secondary is download", () => {
    const onSignup = vi.fn();
    const onDownload = vi.fn();
    renderWithRouter(
      <CTABarAnonOwnTransient onSignup={onSignup} onDownload={onDownload} />,
    );
    fireEvent.click(screen.getByTestId("anon-signup"));
    fireEvent.click(screen.getByTestId("anon-download"));
    expect(onSignup).toHaveBeenCalledOnce();
    expect(onDownload).toHaveBeenCalledOnce();
    expect(screen.queryByTestId("turn-up-to-11")).toBeNull();
  });
});

describe("CTABarRegisteredOwn", () => {
  it("renders download, custom-share, legendary upsell with subject, and merch", () => {
    const onDownload = vi.fn();
    const onCustomShare = vi.fn();
    renderWithRouter(
      <CTABarRegisteredOwn
        onDownload={onDownload}
        onCustomShare={onCustomShare}
        wearHref="/wear/abc?source=meme-page"
        legendaryUpsellSubject="Alice"
      />,
    );
    expect(screen.getByTestId("own-download")).toBeTruthy();
    expect(screen.getByTestId("own-custom-share")).toBeTruthy();
    expect(screen.getByTestId("legendary-upsell")).toBeTruthy();
    expect(screen.getByTestId("merch-wear")).toBeTruthy();
    // Concrete legendary copy mentions creator name
    expect(screen.getByTestId("legendary-upsell").textContent).toContain("Alice");
    // No remix CTA
    expect(screen.queryByTestId("make-this-about-me")).toBeNull();
  });
});

describe("CTABarRegisteredOther", () => {
  it("primary is make-this-about-me; secondary is browse; legendary upsell present", () => {
    const onMakeAboutMe = vi.fn();
    renderWithRouter(
      <CTABarRegisteredOther
        onMakeAboutMe={onMakeAboutMe}
        legendaryUpsellSubject="Bob"
      />,
    );
    fireEvent.click(screen.getByTestId("make-this-about-me"));
    expect(onMakeAboutMe).toHaveBeenCalledOnce();
    expect(screen.getByTestId("browse-more-facts")).toBeTruthy();
    expect(screen.getByTestId("legendary-upsell").textContent).toContain("Bob");
  });
});

describe("CTABarLegendaryOwnStock", () => {
  it("primary is turn-up-to-11; download/share secondary; merch tertiary", () => {
    const onTurnUp = vi.fn();
    renderWithRouter(
      <CTABarLegendaryOwnStock
        onTurnUp={onTurnUp}
        onDownload={() => {}}
        onCustomShare={() => {}}
        wearHref="/wear/abc"
      />,
    );
    fireEvent.click(screen.getByTestId("turn-up-to-11"));
    expect(onTurnUp).toHaveBeenCalledOnce();
    expect(screen.getByTestId("own-download")).toBeTruthy();
    expect(screen.getByTestId("own-custom-share")).toBeTruthy();
    expect(screen.getByTestId("merch-wear")).toBeTruthy();
  });
});

describe("CTABarLegendaryOwnPulid", () => {
  it("hides turn-up-to-11; download/share are primary", () => {
    renderWithRouter(
      <CTABarLegendaryOwnPulid
        onDownload={() => {}}
        onCustomShare={() => {}}
        wearHref="/wear/abc"
      />,
    );
    expect(screen.queryByTestId("turn-up-to-11")).toBeNull();
    expect(screen.getByTestId("own-download")).toBeTruthy();
    expect(screen.getByTestId("own-custom-share")).toBeTruthy();
    expect(screen.getByTestId("merch-wear")).toBeTruthy();
  });
});

describe("CTABarLegendaryOther", () => {
  it("renders make-this-about-me + browse, no tier upsell", () => {
    const onMakeAboutMe = vi.fn();
    renderWithRouter(<CTABarLegendaryOther onMakeAboutMe={onMakeAboutMe} />);
    fireEvent.click(screen.getByTestId("make-this-about-me"));
    expect(onMakeAboutMe).toHaveBeenCalledOnce();
    expect(screen.getByTestId("browse-more-facts")).toBeTruthy();
    expect(screen.queryByTestId("legendary-upsell")).toBeNull();
  });
});

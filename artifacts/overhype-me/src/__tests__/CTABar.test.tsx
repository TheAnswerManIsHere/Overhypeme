import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, screen } from "@testing-library/react";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import {
  CTABarAnonOther,
  CTABarAnonOwnTransient,
  CTABarLegendaryOther,
  CTABarOwn,
  CTABarRegisteredOther,
} from "@/pages/memePage/cta/CTABar";
import { act } from "@testing-library/react";
import { PersonNameProvider, usePersonName } from "@/hooks/use-person-name";

function renderWithRouter(ui: React.ReactElement) {
  const { hook } = memoryLocation({ path: "/m/abc" });
  return render(<Router hook={hook}>{ui}</Router>);
}

describe("CTABarAnonOther", () => {
  it("renders the inline name+pronoun form, browse button, and tier ladder", () => {
    const onOpenBuilder = vi.fn();
    renderWithRouter(
      <CTABarAnonOther onOpenBuilder={onOpenBuilder} factTemplateReady={true} />,
    );

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
    renderWithRouter(
      <CTABarAnonOther onOpenBuilder={onOpenBuilder} factTemplateReady={true} />,
    );
    fireEvent.change(screen.getByTestId("anon-name-input"), { target: { value: "Sam" } });
    fireEvent.change(screen.getByTestId("anon-pronouns-input"), { target: { value: "she/her" } });
    fireEvent.click(screen.getByTestId("anon-see-with-name"));
    expect(onOpenBuilder).toHaveBeenCalledWith({
      initialName: "Sam",
      initialPronouns: "she/her",
    });
  });

  it("disables the submit until the fact template is loaded", () => {
    const onOpenBuilder = vi.fn();
    renderWithRouter(
      <CTABarAnonOther onOpenBuilder={onOpenBuilder} factTemplateReady={false} />,
    );
    const submit = screen.getByTestId("anon-see-with-name") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(submit.textContent).toContain("Loading");
    fireEvent.click(submit);
    expect(onOpenBuilder).not.toHaveBeenCalled();
  });
});

describe("CTABarAnonOther pre-fills what the browser holds (#732)", () => {
  beforeEach(() => localStorage.clear());

  function renderWithIdentity(onOpenBuilder = vi.fn()) {
    renderWithRouter(
      <PersonNameProvider>
        <CTABarAnonOther onOpenBuilder={onOpenBuilder} factTemplateReady={true} />
      </PersonNameProvider>,
    );
    return onOpenBuilder;
  }

  const nameInput = () => screen.getByTestId("anon-name-input") as HTMLInputElement;
  const pronounsInput = () => screen.getByTestId("anon-pronouns-input") as HTMLSelectElement;

  it("opens with the saved name and pronouns, and submits them untouched", () => {
    localStorage.setItem("fact_db_name", "Dana");
    localStorage.setItem("fact_db_pronouns", "he/him");
    const onOpenBuilder = renderWithIdentity();
    expect(nameInput().value).toBe("Dana");
    expect(pronounsInput().value).toBe("he/him");
    fireEvent.click(screen.getByTestId("anon-see-with-name"));
    expect(onOpenBuilder).toHaveBeenCalledWith({ initialName: "Dana", initialPronouns: "he/him" });
  });

  // The builder's picker and the download endpoint take only the three presets,
  // so any other saved value would reach a download that produces no file (#733).
  it.each([
    ["a custom five-form set", "xe|xem|xyr|xyrs|xemself|s"],
    ["a plural custom set", "fae|faer|faer|faers|faerself|p"],
    ["a slash form outside the presets", "fae/faer"],
    ["an allowlisted pair the builder picker lacks", "xe/xem"],
  ])("falls back to they/them for %s, and sends only a preset", (_label, stored) => {
    localStorage.setItem("fact_db_name", "Rue");
    localStorage.setItem("fact_db_pronouns", stored);
    const onOpenBuilder = renderWithIdentity();
    expect(nameInput().value).toBe("Rue");
    expect(pronounsInput().value).toBe("they/them");
    expect(Array.from(pronounsInput().options, (o) => o.value)).toEqual(["he/him", "she/her", "they/them"]);
    fireEvent.click(screen.getByTestId("anon-see-with-name"));
    expect(onOpenBuilder).toHaveBeenCalledWith({ initialName: "Rue", initialPronouns: "they/them" });
  });

  it.each(["he/him", "she/her", "they/them"])("pre-selects the saved preset %s", (stored) => {
    localStorage.setItem("fact_db_pronouns", stored);
    renderWithIdentity();
    expect(pronounsInput().value).toBe(stored);
  });

  it("never fills in a silent he/him when only a name is saved", () => {
    localStorage.setItem("fact_db_name", "Dana");
    renderWithIdentity();
    expect(nameInput().value).toBe("Dana");
    expect(pronounsInput().value).toBe("they/them");
  });

  it("stays empty for a visitor who has saved nothing", () => {
    renderWithIdentity();
    expect(nameInput().value).toBe("");
    expect(pronounsInput().value).toBe("they/them");
  });

  it("picks up a name saved while the page is open, until the visitor types", () => {
    let save: (n: string) => void = () => {};
    function Saver() {
      save = usePersonName().setName;
      return null;
    }
    renderWithRouter(
      <PersonNameProvider>
        <Saver />
        <CTABarAnonOther onOpenBuilder={vi.fn()} factTemplateReady={true} />
      </PersonNameProvider>,
    );
    expect(nameInput().value).toBe("");
    act(() => save("Dana"));
    expect(nameInput().value).toBe("Dana");
    fireEvent.change(nameInput(), { target: { value: "Sam" } });
    act(() => save("Lee"));
    expect(nameInput().value).toBe("Sam");
  });

  it("keeps what the visitor types over the saved identity", () => {
    localStorage.setItem("fact_db_name", "Dana");
    localStorage.setItem("fact_db_pronouns", "he/him");
    const onOpenBuilder = renderWithIdentity();
    fireEvent.change(nameInput(), { target: { value: "Sam" } });
    fireEvent.change(pronounsInput(), { target: { value: "she/her" } });
    fireEvent.click(screen.getByTestId("anon-see-with-name"));
    expect(onOpenBuilder).toHaveBeenCalledWith({ initialName: "Sam", initialPronouns: "she/her" });
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

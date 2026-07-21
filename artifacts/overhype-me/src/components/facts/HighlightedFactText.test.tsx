/**
 * HighlightedFactText — the shared name-highlighting renderer for fact text
 * (FactCard headlines, Home pronoun previews, cold hero). Regression for the
 * PR188 UAT Part A item 4 bug: the possessive "James's" must be highlighted
 * whole — splitting the rendered sentence on the bare name left the "'s"
 * unhighlighted.
 */
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { HighlightedFactText } from "./HighlightedFactText";

function highlightedSpans(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("span.text-primary")).map(
    (el) => el.textContent ?? "",
  );
}

describe("HighlightedFactText", () => {
  it("highlights the whole possessive — name plus 's — as one segment", () => {
    const { container } = render(
      <HighlightedFactText
        template="{NAME_POSSESSIVE} PIN is the last four digits of pi."
        name="John James"
        pronouns="they/them"
      />,
    );
    expect(highlightedSpans(container)).toEqual(["John James's"]);
    expect(container.textContent).toBe(
      "John James's PIN is the last four digits of pi.",
    );
  });

  it("highlights a plain {NAME} substitution", () => {
    const { container } = render(
      <HighlightedFactText template="{NAME} once punched a shark" name="Sam" pronouns="she/her" />,
    );
    expect(highlightedSpans(container)).toEqual(["Sam"]);
    expect(container.textContent).toBe("Sam once punched a shark");
  });

  it("highlights both a name and its possessive in the same fact", () => {
    const { container } = render(
      <HighlightedFactText
        template="{NAME} says {NAME_POSSESSIVE} dog barks"
        name="Alex"
        pronouns="he/him"
      />,
    );
    expect(highlightedSpans(container)).toEqual(["Alex", "Alex's"]);
  });

  it("does not highlight literal text that happens to match the name", () => {
    const { container } = render(
      <HighlightedFactText template="Sharks fear {NAME}" name="Sharks" pronouns="he/him" />,
    );
    // Only the token-derived segment is highlighted, not the literal "Sharks".
    expect(highlightedSpans(container)).toEqual(["Sharks"]);
    expect(container.textContent).toBe("Sharks fear Sharks");
  });

  it("renders the ___ placeholder unhighlighted when no name is set", () => {
    const { container } = render(
      <HighlightedFactText template="{NAME_POSSESSIVE} legend grows" name="" pronouns="they/them" />,
    );
    expect(highlightedSpans(container)).toEqual([]);
    expect(container.textContent).toBe("___'s legend grows");
  });
});

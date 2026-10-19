/**
 * The identity sheet's billboard teaser — regression for #731: before a name
 * was typed it read "You pushes it", because the "You" fallback went through
 * the third-person template. The verb agrees with the subject's person, never
 * with the pronoun set: "You push it" whatever pronouns are picked, and a typed
 * name is a third-person singular subject even for they/them.
 */
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { HighlightedFactText } from "./facts/HighlightedFactText";
import { teaserFor } from "./welcomeTeaser";

const PRONOUN_SETS = ["he/him", "she/her", "they/them", "ze/zir"];

function renderTeaser(draftName: string, pronouns: string) {
  const { template, name } = teaserFor(draftName);
  const { container } = render(<HighlightedFactText template={template} name={name} pronouns={pronouns} />);
  const highlighted = Array.from(container.querySelectorAll("span.text-primary")).map((el) => el.textContent);
  return { text: container.textContent, highlighted };
}

describe("WelcomeModal teaser", () => {
  for (const pronouns of PRONOUN_SETS) {
    it(`speaks to the visitor in the second person before a name is typed (${pronouns})`, () => {
      for (const draft of ["", "   "]) {
        const { text, highlighted } = renderTeaser(draft, pronouns);
        expect(text).toBe("The universe doesn't expand. You push it.");
        expect(highlighted).toEqual(["You"]);
      }
    });

    it(`reads about the typed name in the third person (${pronouns})`, () => {
      const { text, highlighted } = renderTeaser("  Alex Rivera ", pronouns);
      expect(text).toBe("The universe doesn't expand. Alex Rivera pushes it.");
      expect(highlighted).toEqual(["Alex Rivera"]);
    });
  }
});

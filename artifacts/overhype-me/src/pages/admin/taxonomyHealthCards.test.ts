/**
 * The Taxonomy Health cards point at no removed action: sending a live fact
 * back through review went with refresh reviews (plan
 * PLAN_FACT_LIFECYCLE_REBUILD.md 1H; PR #1027).
 */
import { describe, it, expect } from "vitest";
import { CARD_META } from "./taxonomyHealthCards";

describe("Taxonomy Health cards", () => {
  it("never tell an admin to send a fact back to review", () => {
    for (const card of CARD_META) {
      const text = [card.description, card.whatToDo, ...card.actions.flatMap((a) => [a.label, a.help])].join(" ");
      expect(text, card.key).not.toMatch(/send (it |those |them )?back|back to review|refresh cycle|promote the candidate/i);
    }
  });
});

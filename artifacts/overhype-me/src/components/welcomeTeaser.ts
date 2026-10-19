/**
 * @purpose The identity sheet's billboard teaser: about the typed name once there is one, spoken to the visitor before that.
 * @subsystem token-rendering
 */

const TEASER_FACT = "The universe doesn't expand. {NAME} pushes it.";
/** "You" is second person, so its verb takes the base form whatever pronouns are picked. */
const TEASER_FACT_YOU = "The universe doesn't expand. {NAME} push it.";

/** The teaser's template and the name to render into it, for the name field as typed so far. */
export function teaserFor(draftName: string): { template: string; name: string } {
  const name = draftName.trim();
  return name ? { template: TEASER_FACT, name } : { template: TEASER_FACT_YOU, name: "You" };
}

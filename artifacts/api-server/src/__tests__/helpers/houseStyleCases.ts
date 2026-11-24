/**
 * The fact wording house style's rule table (plan
 * docs/plans/PLAN_FACT_HOUSE_STYLE.md, *The rule*), shared by the TypeScript
 * rule's tests and the SQL twin's parity test (migration 0165).
 */
/** [as written, in the house style] — the plan's rule table, row by row. */
export const HOUSE_STYLE_TABLE: ReadonlyArray<readonly [string, string]> = [
  // Spacing
  ["  lots   of\tspace  ", "Lots of space."],
  ["two\n\nlines", "Two lines."],
  // Start
  ["chuck norris can divide by zero", "Chuck norris can divide by zero."],
  ['"when {NAME} sneezes, the earth moves"', '"When {NAME} sneezes, the earth moves."'],
  ["'twas {NAME}", "'Twas {NAME}."],
  ["{NAME} beats the sun", "{NAME} beats the sun."],
  ["{NAME_POSSESSIVE} shadow runs", "{NAME_POSSESSIVE} shadow runs."],
  ["{SUBJ} wins", "{Subj} wins."],
  ["{POSS_PRO} is the best", "{Poss_Pro} is the best."],
  ["{he} wins", "{He} wins."],
  ["{his} shadow runs", "{His} shadow runs."],
  ["{he's} done", "{He's} done."],
  // Start: a capital that does not lowercase back is left as written
  ["µ-waves fear {NAME}", "µ-waves fear {NAME}."],
  ["{does|do} {SUBJ} ever lose", "{Does|Do} {SUBJ} ever lose."],
  ["{doesn't|don't} {SUBJ} sleep", "{Doesn't|Don't} {SUBJ} sleep."],
  ["7 days a week {NAME} works", "7 days a week {NAME} works."],
  ["ßtraße bows to {NAME}", "ßtraße bows to {NAME}."],
  // Q3: a brand-style first word stays as written
  ["iPhone fears {NAME}", "iPhone fears {NAME}."],
  ["eBay sells {POSS} shadows", "eBay sells {POSS} shadows."],
  // End: kept
  ["Done.", "Done."],
  ["Really?!", "Really?!"],
  ["Wait...", "Wait..."],
  ["And then…", "And then…"],
  ['{NAME} said "no!"', '{NAME} said "no!"'],
  // End: Q5 replaced
  ["divide by zero,", "Divide by zero."],
  ["{NAME} wins;", "{NAME} wins."],
  ["{NAME} wins:", "{NAME} wins."],
  // End: Q4 emoji left
  ["{NAME} wins 🏆", "{NAME} wins 🏆"],
  ["{NAME} wins 👍🏽", "{NAME} wins 👍🏽"],
  ["{NAME} flies to 🇺🇸", "{NAME} flies to 🇺🇸"],
  // End: added, placed around closers and tokens
  ["costs $5", "Costs $5."],
  ["{NAME} beats {NAME}", "{NAME} beats {NAME}."],
  ["{NAME} {doesn't|don't} sleep", "{NAME} {doesn't|don't} sleep."],
  ['said "no"', 'Said "no."'],
  ["said “no”", "Said “no.”"],
  ["zero (really)", "Zero (really)."],
  ['("no")', '("No.")'],
  ["[{NAME} wins]", "[{NAME} wins.]"],
  ['"he did it (twice)"', '"He did it (twice)."'],
  ["said 'no'", "Said 'no.'"],
  ["said ‘no’", "Said ‘no.’"],
  ["the Joneses'", "The Joneses'."],
  ["don't say 'no'", "Don't say 'no.'"],
  ["the Joneses' dog said 'hi'", "The Joneses' dog said 'hi.'"],
  ["{NAME}'s dog", "{NAME}'s dog."],
  // End: a trailing bracket is matched to its own opener (PR #1213 round 1)
  ["(unlike others) {NAME} can divide by zero (really)", "(Unlike others) {NAME} can divide by zero (really)."],
  ["({NAME} wins) (really)", "({NAME} wins) (really)."],
  ["({NAME} wins (really))", "({NAME} wins (really).)"],
  ["(({NAME} wins) twice)", "(({NAME} wins) twice.)"],
  ["[{NAME} wins (really)]", "[{NAME} wins (really).]"],
  ["[(a) b] c (d)", "[(A) b] c (d)."],
  ['{NAME} said ("no")', '{NAME} said ("no").'],
  ["{NAME} wins :)", "{NAME} wins :)."],
  // End: a trademark-style symbol is not an emoji ending
  ["{NAME} is Chuck Norris™", "{NAME} is Chuck Norris™."],
  ["{NAME} owns ©", "{NAME} owns ©."],
  // End: a mark already inside a trailing bracket is kept, with nothing added
  ["{NAME} counted to infinity. (Twice.)", "{NAME} counted to infinity. (Twice.)"],
  ["{NAME} can divide by zero (yes, really!)", "{NAME} can divide by zero (yes, really!)"],
  ["{NAME} wins. [Citation needed.]", "{NAME} wins. [Citation needed.]"],
  ["(unlike others) {NAME} counted to infinity. (Twice.)", "(Unlike others) {NAME} counted to infinity. (Twice.)"],
  ['{NAME} said (and meant "no!")', '{NAME} said (and meant "no!")'],
  ["{NAME} won (🏆)", "{NAME} won (🏆)"],
];

/**
 * The shared table the browser and the server suites both run against the
 * name rule (identity-flow plan, Phase 2, Testing), so a change to the rule
 * breaks both sides at once or neither.
 *
 * @purpose Accepted and refused personal names, with the normalized value each accepted one becomes, shared by the browser and server test suites.
 * @subsystem accounts-auth
 */
export const PERSONAL_NAME_ACCEPTED: { input: string; value: string; why: string }[] = [
  { input: "Ada Lovelace", value: "Ada Lovelace", why: "plain Latin" },
  { input: "José Núñez", value: "José Núñez", why: "precomposed accents" },
  { input: "José", value: "José", why: "combining accent, normalized to NFC" },
  { input: "O’Brien", value: "O'Brien", why: "the curly apostrophe iOS types" },
  { input: "Mary-Jane  St. Clair ", value: "Mary-Jane St. Clair", why: "hyphen, period, whitespace collapsed and trimmed" },
  { input: "مهر‌ناز", value: "مهر‌ناز", why: "Persian with ZWNJ" },
  { input: "देवनागरी", value: "देवनागरी", why: "Devanagari with combining vowel signs" },
  { input: "क्‍ष", value: "क्‍ष", why: "ZWJ after a virama (a mark, not a letter)" },
  { input: "क्‌ष", value: "क्‌ष", why: "ZWNJ after a virama" },
  { input: "李小龙", value: "李小龙", why: "CJK" },
  { input: "김민준", value: "김민준", why: "Hangul" },
  { input: "Louis 14", value: "Louis 14", why: "digits" },
  { input: "a".repeat(50), value: "a".repeat(50), why: "exactly 50 graphemes" },
  { input: "é".repeat(50).normalize("NFD"), value: "é".repeat(50), why: "50 graphemes of 100 code points" },
  { input: "One Two Three Four Five", value: "One Two Three Four Five", why: "no word-count limit" },
];

export const PERSONAL_NAME_REFUSED: { input: unknown; reason: "empty" | "characters" | "length" | "type"; why: string }[] = [
  { input: "", reason: "empty", why: "empty" },
  { input: "   ", reason: "empty", why: "only spaces" },
  { input: "‍", reason: "empty", why: "only a joiner" },
  { input: "Ada 😀", reason: "characters", why: "an emoji" },
  { input: 'Ada "the" Great', reason: "characters", why: "quotes" },
  { input: "Ada (Countess)", reason: "characters", why: "brackets" },
  { input: "Ada<script>", reason: "characters", why: "angle brackets" },
  { input: "Ada‮", reason: "characters", why: "a bidi override" },
  { input: "a".repeat(51), reason: "length", why: "51 graphemes" },
  { input: 42, reason: "type", why: "not text" },
];

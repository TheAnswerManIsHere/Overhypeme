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
  { input: "Jose\u0301", value: "José", why: "a combining accent, composed by NFC" },
  { input: "Zoë Łukasz Siobhán Øyvind", value: "Zoë Łukasz Siobhán Øyvind", why: "Latin-1 and Latin Extended-A letters" },
  { input: "O\u2019Brien", value: "O'Brien", why: "the curly apostrophe iOS types" },
  { input: "Mary-Jane  St. Clair ", value: "Mary-Jane St. Clair", why: "hyphen, period, whitespace collapsed and trimmed" },
  { input: "Louis 14", value: "Louis 14", why: "digits" },
  { input: "a".repeat(50), value: "a".repeat(50), why: "exactly 50 characters" },
  { input: "One Two Three Four Five", value: "One Two Three Four Five", why: "no word-count limit" },
  // Every Latin letter all caption fonts draw (names-and-fonts plan, David 2026-11-03).
  { input: "Nguyễn Thị Minh Khai", value: "Nguyễn Thị Minh Khai", why: "Vietnamese" },
  { input: "Nguye\u0302\u0303n", value: "Nguyễn", why: "Vietnamese typed with combining marks, composed by NFC" },
  { input: "Ștefan Țepeș", value: "Ștefan Țepeș", why: "Romanian comma-below letters" },
  { input: "Ayşe Türkoğlu İlhan", value: "Ayşe Türkoğlu İlhan", why: "Turkish" },
  { input: "Dvořák Čapek", value: "Dvořák Čapek", why: "Czech" },
  { input: "Ĳsbrand", value: "Ĳsbrand", why: "the Dutch Ĳ, kept from the earlier rule" },
];

// English-script names only (David, 2026-11-02): other scripts are refused
// until internationalization, after launch.
export const PERSONAL_NAME_REFUSED: { input: unknown; reason: "empty" | "characters" | "length" | "type"; why: string }[] = [
  { input: "", reason: "empty", why: "empty" },
  { input: "   ", reason: "empty", why: "only spaces" },
  { input: "Ada 😀", reason: "characters", why: "an emoji" },
  { input: 'Ada "the" Great', reason: "characters", why: "quotes" },
  { input: "Ada (Countess)", reason: "characters", why: "brackets" },
  { input: "Ada<script>", reason: "characters", why: "angle brackets" },
  { input: "Ada\u202E", reason: "characters", why: "a bidi override" },
  { input: "Ada\u200B", reason: "characters", why: "a zero-width space" },
  { input: "مهر\u200Cناز", reason: "characters", why: "Persian (not an English-script name)" },
  { input: "देवनागरी", reason: "characters", why: "Devanagari" },
  { input: "李小龙", reason: "characters", why: "CJK" },
  { input: "Ольга", reason: "characters", why: "Cyrillic" },
  { input: "Ελένη", reason: "characters", why: "Greek" },
  { input: "Pfeiffer ƒ", reason: "characters", why: "ƒ, whose capital not every caption font draws" },
  { input: "ſamuel", reason: "characters", why: "the long s, which not every caption font draws" },
  { input: "\u0149on", reason: "characters", why: "ŉ, which not every caption font draws" },
  { input: "Hǎo", reason: "characters", why: "a pinyin tone letter not every caption font draws" },
  { input: "a".repeat(51), reason: "length", why: "51 characters" },
  { input: 42, reason: "type", why: "not text" },
];

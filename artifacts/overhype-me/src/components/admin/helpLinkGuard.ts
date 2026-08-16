/**
 * Validation for the in-app links inside generated Manual HTML.
 *
 * These arrive as raw `<a data-help-internal="…">` inside content injected via
 * `dangerouslySetInnerHTML`, so the page reads them back out of the DOM to
 * make them base-aware and to route their clicks. That read-from-DOM /
 * write-to-href shape is what CodeQL flags as "DOM text reinterpreted as
 * HTML", and it was right to: the original guard was `startsWith("/")`, which
 * **accepts `//evil.com`** — a protocol-relative URL that navigates off-site.
 *
 * The value is only ever written by the generator, whose output is asserted
 * free of executable content, so the hole was not reachable. But a guard whose
 * correctness rests on its input never being hostile is the wrong guard; this
 * one accepts a help route and nothing else.
 *
 * Lives in its own module so both call sites share one implementation — the
 * paired-check drift this feature was caught on twice — and so the property is
 * testable without mounting the page.
 *
 * THE PATH AND THE FRAGMENT ARE DIFFERENT PROBLEMS, and holding them to one
 * ASCII character class was a defect in its own right: a fragment is a HEADING
 * slug from `github-slugger`, which preserves non-ASCII letters, so `#café` is
 * a link the generator legitimately emits and the guard silently rejected —
 * leaving the href unprefixed under a non-root base and falling back to a full
 * page load at the root. The generator emitting what the consumer rejects is
 * the same producer/consumer split that once made every in-app link inert.
 *
 * Widening the fragment's character class was the WRONG fix, and CodeQL was
 * right to stop treating the result as a sanitizer. Chasing the slugger's
 * alphabet means enumerating Unicode categories — letters, digits, combining
 * marks, connector punctuation, enclosed alphanumerics — a list that is both
 * fragile and, verified empirically, still incomplete.
 *
 * So the fragment is not pattern-matched at all. It is SPLIT OFF, and the
 * caller percent-encodes it when building the href — which is what a URL
 * requires anyway, and is symmetric with the decoding `currentHash()` already
 * does on the way back in. Only the path is validated, and it stays strictly
 * ASCII because chapter slugs come from filenames. The security property is
 * carried entirely by the path: it is anchored, literal, and root-relative, so
 * no fragment can change the navigation target.
 */
export const INTERNAL_HELP_PATH = /^\/admin\/help(?:\/[A-Za-z0-9._-]+)?$/;

export interface InternalHelpTarget {
  /** Unbased in-app route, e.g. `/admin/help/3-moderation`. Always ASCII. */
  path: string;
  /** Heading slug WITHOUT `#`, decoded. May hold any script. "" if none. */
  fragment: string;
}

/** The vetted in-app target an element carries, or null if it is not one. */
export function internalHelpTarget(el: Element | null): InternalHelpTarget | null {
  const raw = el?.getAttribute("data-help-internal") ?? "";
  const at = raw.indexOf("#");
  const path = at === -1 ? raw : raw.slice(0, at);
  const fragment = at === -1 ? "" : raw.slice(at + 1);
  if (!INTERNAL_HELP_PATH.test(path)) return null;
  // Not the security boundary — the path already is. This only rejects values
  // the generator cannot produce, so a malformed marker fails loudly here
  // rather than producing a link that goes somewhere unexpected.
  if (fragment !== "" && /[\s#]/.test(fragment)) return null;
  return { path, fragment };
}

/**
 * The href to write for a vetted target, under the router base.
 *
 * `encodeURIComponent` on the fragment is what lets the fragment hold any
 * script safely: the emitted href is ASCII, which is what the URL grammar
 * wants, and `currentHash()` decodes it back on read.
 */
export function helpHref(base: string, target: InternalHelpTarget): string {
  return base + target.path + (target.fragment ? `#${encodeURIComponent(target.fragment)}` : "");
}

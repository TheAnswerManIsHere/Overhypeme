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
 * THE PATH AND THE FRAGMENT ARE NOT THE SAME PROBLEM, and holding them to one
 * character class was a defect in the other direction. Chapter slugs come from
 * filenames and stay strictly ASCII, so the path segment stays narrow. But a
 * fragment is a HEADING slug produced by `github-slugger`, which preserves
 * non-ASCII letters — so an ASCII-only fragment class rejects a link the
 * generator legitimately emits (`#café`), leaving the href unprefixed under a
 * non-root base and falling back to a full page load at the root. The generator
 * accepting what the consumer rejects is the same producer/consumer split that
 * previously made every in-app link inert.
 *
 * Widening the fragment costs nothing security-wise: only the leading path can
 * change the navigation target, and the fragment class still excludes the
 * characters that could — `/`, `\`, `:`, `?`, `#`, and whitespace — so
 * `//evil.com` and `javascript:` remain unrepresentable.
 */
export const INTERNAL_HELP_PATH = /^\/admin\/help(?:\/[A-Za-z0-9._-]+)?(?:#[^\s/\\:?#]+)?$/;

/** The vetted in-app path an element carries, or null if it is not one. */
export function internalHelpTarget(el: Element | null): string | null {
  const raw = el?.getAttribute("data-help-internal") ?? "";
  return INTERNAL_HELP_PATH.test(raw) ? raw : null;
}

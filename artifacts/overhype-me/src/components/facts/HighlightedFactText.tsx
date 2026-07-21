import { renderFactSegments } from "@/lib/render-fact";

/**
 * Render a fact template with the personalized name in the brand colour.
 *
 * Works from the raw template via `renderFactSegments` — not by splitting the
 * already-rendered sentence on the bare name — so a `{NAME_POSSESSIVE}`
 * substitution ("James's") is highlighted as one whole name segment, `'s`
 * included. When no name is set (cold visitor) the "___" placeholder renders
 * unhighlighted, matching the plain-text fallback.
 */
export function HighlightedFactText({
  template,
  name,
  pronouns,
}: {
  template: string;
  name: string;
  pronouns?: string;
}) {
  return (
    <>
      {renderFactSegments(template, name, pronouns).map((seg, i) =>
        seg.isName && name
          ? <span key={i} className="text-primary">{seg.text}</span>
          : <span key={i}>{seg.text}</span>
      )}
    </>
  );
}

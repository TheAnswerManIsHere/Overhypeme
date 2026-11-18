/**
 * @purpose Renders one legal document (Terms, Privacy, Copyright, Guidelines) from its generated module (source: docs/legal/), with its version, the operator, and the "awaiting counsel's review" line every page carries until a firm signs it off (launch Phase 14, increment 1).
 * @subsystem public-site
 */
import { useEffect } from "react";
import { Layout } from "@/components/layout/Layout";
import * as terms from "@/generated/legal/terms";
import * as privacy from "@/generated/legal/privacy";
import * as copyright from "@/generated/legal/copyright";
import * as guidelines from "@/generated/legal/guidelines";

const DOCS = { terms, privacy, copyright, guidelines } as const;
export type LegalPageSlug = keyof typeof DOCS;

/** True until counsel signs the texts off; then this line goes and every version changes. */
const AWAITING_COUNSEL = true;

export default function LegalPage({ slug }: { slug: LegalPageSlug }) {
  const doc = DOCS[slug];
  useEffect(() => {
    document.title = `${doc.title} · Overhype.me`;
    window.scrollTo(0, 0);
  }, [doc.title]);
  return (
    <Layout>
      <article className="max-w-3xl mx-auto px-4 py-10 md:py-16">
        <h1 className="font-display text-5xl md:text-6xl uppercase tracking-wide text-foreground">{doc.title}</h1>
        <p className="mt-3 font-mono text-xs text-muted-foreground" data-testid="legal-version">
          Version {doc.version}
        </p>
        {AWAITING_COUNSEL && (
          <p
            role="note"
            className="mt-6 border border-border bg-card px-4 py-3 text-sm text-muted-foreground"
            data-testid="legal-counsel-note"
          >
            This document is awaiting review by our lawyers and may change. If it does, we will post the new
            version here and ask you to accept significant changes.
          </p>
        )}
        <div
          className={[
            "mt-8 text-[15px] leading-relaxed text-foreground/90",
            "[&_h2]:font-display [&_h2]:text-3xl [&_h2]:uppercase [&_h2]:tracking-wide [&_h2]:text-foreground [&_h2]:mt-10 [&_h2]:mb-3",
            "[&_h3]:font-semibold [&_h3]:mt-6 [&_h3]:mb-2",
            "[&_p]:my-3 [&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-6 [&_li]:my-1",
            "[&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2 [&_strong]:text-foreground",
            "[&_table]:my-4 [&_table]:w-full [&_table]:text-sm [&_table]:border-collapse [&_th]:text-left [&_th]:border-b [&_th]:border-border [&_th]:py-2 [&_th]:pr-3 [&_td]:align-top [&_td]:border-b [&_td]:border-border/50 [&_td]:py-2 [&_td]:pr-3",
          ].join(" ")}
          // Generated from docs/legal/ by a script that refuses raw HTML and executable content.
          dangerouslySetInnerHTML={{ __html: doc.html }}
        />
      </article>
    </Layout>
  );
}

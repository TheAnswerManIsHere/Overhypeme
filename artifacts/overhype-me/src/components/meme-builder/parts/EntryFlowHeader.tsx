import { HEADER_COPY } from "../copy";
import type { HeaderCopyKey } from "../types";

interface Props {
  headerCopyKey: HeaderCopyKey;
}

export function EntryFlowHeader({ headerCopyKey }: Props) {
  const copy = HEADER_COPY[headerCopyKey];
  return (
    <header className="space-y-1 px-1">
      <p className="font-mono text-xs uppercase tracking-widest text-primary">{copy.eyebrow}</p>
      <h2 className="font-display text-3xl uppercase leading-none text-foreground">{copy.title}</h2>
      <p className="text-sm text-muted-foreground">{copy.subtitle}</p>
    </header>
  );
}

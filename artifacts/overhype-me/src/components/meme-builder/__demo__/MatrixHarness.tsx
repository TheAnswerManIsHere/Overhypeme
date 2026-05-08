import { useState } from "react";
import { MemeBuilder } from "../MemeBuilder";
import {
  ALL_ENTRY_FLOWS,
  ALL_MODES,
  ALL_TIERS,
  enumerateMatrix,
  resolveBehavior,
} from "../behaviorMatrix";
import type { EntryFlow, Mode, Tier } from "../types";

/**
 * Dev harness — visualizes every cell of the behavior matrix without booting
 * the full studio. Mount on a `/dev/builder-matrix` route in dev only; this
 * file is the substitute for Storybook (we don't have one).
 *
 * The harness is intentionally not exported from the package barrel — it
 * imports the builder directly. Phase 5 should mount it behind an
 * `import.meta.env.DEV` gate.
 */
export function MatrixHarness() {
  const [mode, setMode] = useState<Mode>("stock");
  const [tier, setTier] = useState<Tier>("registered");
  const [entryFlow, setEntryFlow] = useState<EntryFlow>("fact-detail");
  const [bumpKey, setBumpKey] = useState(0);

  const cell = resolveBehavior(mode, tier, entryFlow);

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-4">
      <header className="space-y-2">
        <h1 className="font-display text-2xl uppercase">Meme builder — matrix harness</h1>
        <p className="text-sm text-muted-foreground">
          {enumerateMatrix().length} cells. Pick (mode, tier, entryFlow) to render the corresponding builder
          state. Invalid cells render the tier-locked panel.
        </p>
      </header>

      <fieldset className="grid gap-3 rounded-md border border-border p-3 sm:grid-cols-3">
        <Picker label="Mode" value={mode} options={ALL_MODES} onChange={(v) => setMode(v as Mode)} />
        <Picker label="Tier" value={tier} options={ALL_TIERS} onChange={(v) => setTier(v as Tier)} />
        <Picker
          label="Entry flow"
          value={entryFlow}
          options={ALL_ENTRY_FLOWS}
          onChange={(v) => setEntryFlow(v as EntryFlow)}
        />
      </fieldset>

      <div className="rounded-md border border-border p-2 font-mono text-xs">
        <pre>{JSON.stringify(cell, null, 2)}</pre>
      </div>

      <div className="rounded-md border border-border p-3">
        <MemeBuilder
          key={`${mode}-${tier}-${entryFlow}-${bumpKey}`}
          mode={mode}
          factId="42"
          factText="{NAME} {singular|plural} pushes the boulder uphill {POSS} entire life."
          viewerContext={{
            tier,
            userId: tier === "unregistered" ? undefined : "demo-user",
            name: "Casey",
            pronouns: "they/them",
            primaryImageObjectPath: tier !== "unregistered" ? "/objects/uploads/demo-avatar.jpg" : undefined,
            hasLibraryImages: true,
          }}
          entryFlow={entryFlow}
          onComplete={(r) => {
            // eslint-disable-next-line no-console
            console.log("[harness] complete", r);
            setBumpKey((k) => k + 1);
          }}
          onCancel={() => setBumpKey((k) => k + 1)}
        />
      </div>
    </div>
  );
}

function Picker({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly string[];
  onChange: (v: string) => void;
}) {
  return (
    <label className="grid gap-1 text-xs font-mono uppercase tracking-widest">
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-md border border-border bg-background px-2 py-1 text-sm normal-case tracking-normal"
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}

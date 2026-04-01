import { useState, useEffect } from "react";
import {
  PRONOUN_PRESETS,
  isCustomPronouns,
  parseCustom,
  serializeCustom,
  EMPTY_CUSTOM,
  type CustomPronounSet,
} from "@/lib/pronouns";

interface PronounEditorProps {
  value: string;
  onChange: (value: string) => void;
  className?: string;
}

const INPUT_CLASS =
  "w-full bg-secondary border border-border rounded-sm px-3 py-1.5 text-sm text-foreground outline-none focus:border-primary transition-colors placeholder:text-muted-foreground/60";

const PRESET_LABELS: Record<string, string> = {
  "he/him": "he/him",
  "she/her": "she/her",
  "they/them": "they/them",
};

export function PronounEditor({ value, onChange, className = "" }: PronounEditorProps) {
  const isCustom = isCustomPronouns(value);
  const [mode, setMode] = useState<"preset" | "custom">(isCustom ? "custom" : "preset");

  const [custom, setCustom] = useState<CustomPronounSet>(() => {
    if (isCustom) return parseCustom(value) ?? { ...EMPTY_CUSTOM };
    return { ...EMPTY_CUSTOM };
  });

  // Sync mode when value is changed externally (e.g. AI suggestion)
  useEffect(() => {
    const ext = value as string;
    if (!isCustomPronouns(ext) && PRONOUN_PRESETS.includes(ext as typeof PRONOUN_PRESETS[number])) {
      setMode("preset");
    }
  }, [value]);

  function selectPreset(preset: string) {
    setMode("preset");
    onChange(preset);
  }

  function openCustom() {
    setMode("custom");
    if (!isCustomPronouns(value)) {
      onChange(serializeCustom(custom));
    }
  }

  function updateCustomField(field: keyof CustomPronounSet, val: string | boolean) {
    const next = { ...custom, [field]: val };
    setCustom(next);
    onChange(serializeCustom(next));
  }

  return (
    <div className={className}>
      {/* Preset chips + custom button */}
      <div className="flex flex-wrap gap-2 mb-2">
        {PRONOUN_PRESETS.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => selectPreset(p)}
            className={`px-3 py-1 rounded-sm border text-sm font-medium transition-colors ${
              mode === "preset" && value === p
                ? "border-primary bg-primary/10 text-primary"
                : "border-border text-muted-foreground hover:border-primary/40"
            }`}
          >
            {PRESET_LABELS[p]}
          </button>
        ))}
        <button
          type="button"
          onClick={openCustom}
          className={`px-3 py-1 rounded-sm border text-sm font-medium transition-colors ${
            mode === "custom"
              ? "border-primary bg-primary/10 text-primary"
              : "border-border text-muted-foreground hover:border-primary/40"
          }`}
        >
          custom…
        </button>
      </div>

      {/* Custom pronoun fields */}
      {mode === "custom" && (
        <div className="p-3 border border-border rounded-sm bg-secondary/40 space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-xs font-bold text-muted-foreground uppercase tracking-wider mb-1">
                Subject
              </label>
              <input
                type="text"
                value={custom.subj}
                onChange={(e) => updateCustomField("subj", e.target.value)}
                placeholder="xe, fae, ey…"
                maxLength={15}
                className={INPUT_CLASS}
              />
            </div>
            <div>
              <label className="block text-xs font-bold text-muted-foreground uppercase tracking-wider mb-1">
                Object
              </label>
              <input
                type="text"
                value={custom.obj}
                onChange={(e) => updateCustomField("obj", e.target.value)}
                placeholder="xem, faer, em…"
                maxLength={15}
                className={INPUT_CLASS}
              />
            </div>
            <div>
              <label className="block text-xs font-bold text-muted-foreground uppercase tracking-wider mb-1">
                Possessive adj.
              </label>
              <input
                type="text"
                value={custom.poss}
                onChange={(e) => updateCustomField("poss", e.target.value)}
                placeholder="xyr, faer, eir…"
                maxLength={15}
                className={INPUT_CLASS}
              />
              <p className="text-[10px] text-muted-foreground mt-0.5">"xyr book"</p>
            </div>
            <div>
              <label className="block text-xs font-bold text-muted-foreground uppercase tracking-wider mb-1">
                Possessive pro.
              </label>
              <input
                type="text"
                value={custom.possPro}
                onChange={(e) => updateCustomField("possPro", e.target.value)}
                placeholder="xyrs, faers, eirs…"
                maxLength={15}
                className={INPUT_CLASS}
              />
              <p className="text-[10px] text-muted-foreground mt-0.5">"the book is xyrs"</p>
            </div>
          </div>
          <div>
            <label className="block text-xs font-bold text-muted-foreground uppercase tracking-wider mb-1">
              Reflexive
            </label>
            <input
              type="text"
              value={custom.refl}
              onChange={(e) => updateCustomField("refl", e.target.value)}
              placeholder="xemself, faerself, emself…"
              maxLength={20}
              className={INPUT_CLASS}
            />
          </div>
          <div>
            <label className="block text-xs font-bold text-muted-foreground uppercase tracking-wider mb-1">
              Verb form
            </label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => updateCustomField("plural", false)}
                className={`flex-1 py-1.5 rounded-sm border text-xs font-medium transition-colors ${
                  !custom.plural
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border text-muted-foreground hover:border-primary/40"
                }`}
              >
                singular <span className="opacity-60 font-normal">(xe doesn't)</span>
              </button>
              <button
                type="button"
                onClick={() => updateCustomField("plural", true)}
                className={`flex-1 py-1.5 rounded-sm border text-xs font-medium transition-colors ${
                  custom.plural
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border text-muted-foreground hover:border-primary/40"
                }`}
              >
                plural <span className="opacity-60 font-normal">(they don't)</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

import { Input } from "@/components/ui/Input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface Props {
  name: string;
  pronouns: string;
  onNameChange: (next: string) => void;
  onPronounsChange: (next: string) => void;
}

const PRONOUN_OPTIONS = [
  { value: "he/him",    label: "he / him" },
  { value: "she/her",   label: "she / her" },
  { value: "they/them", label: "they / them" },
];

export function NameAndPronounFields({ name, pronouns, onNameChange, onPronounsChange }: Props) {
  return (
    <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
      <div className="grid gap-1.5">
        <Label htmlFor="meme-builder-name" className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          Your name
        </Label>
        <Input
          id="meme-builder-name"
          value={name}
          maxLength={40}
          placeholder="Type a name"
          onChange={(e) => onNameChange(e.target.value)}
        />
      </div>
      <div className="grid gap-1.5">
        <Label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Pronouns</Label>
        <Select value={pronouns} onValueChange={onPronounsChange}>
          <SelectTrigger className="min-w-[140px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PRONOUN_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

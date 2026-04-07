export interface VideoStyleDef {
  id: string;
  label: string;
  description: string;
  motionPrompt: string;
  gradientFrom: string;
  gradientTo: string;
  previewGifPath: string | null;
  sortOrder: number;
  isActive: boolean;
}

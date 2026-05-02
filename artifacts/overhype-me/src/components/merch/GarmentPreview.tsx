type GarmentType = "tee" | "hoodie" | "mug" | "sticker" | "cap" | "tote";

interface GarmentProps {
  type: GarmentType;
  accentColor?: string;
}

export function GarmentPreview({ type, accentColor = "#0F0F11" }: GarmentProps) {
  const svgProps = { viewBox: "0 0 200 200", width: "100%", height: "100%", style: { position: "absolute" as const, inset: 0 } };
  const fill = accentColor;
  const stroke = "rgba(255,255,255,0.07)";

  const shapes: Record<GarmentType, React.ReactNode> = {
    tee: (
      <svg {...svgProps}>
        <path d="M40 50 L20 70 L40 90 L50 80 L50 180 L150 180 L150 80 L160 90 L180 70 L160 50 L130 30 L120 40 Q100 60 80 40 L70 30 Z" fill={fill} stroke={stroke} strokeWidth="0.5" />
      </svg>
    ),
    hoodie: (
      <svg {...svgProps}>
        <path d="M40 60 L20 80 L40 100 L50 90 L50 185 L150 185 L150 90 L160 100 L180 80 L160 60 L130 38 Q120 30 110 36 Q100 60 90 36 Q80 30 70 38 Z M85 36 Q100 56 115 36 L115 50 Q100 65 85 50 Z" fill={fill} stroke={stroke} strokeWidth="0.5" />
      </svg>
    ),
    mug: (
      <svg {...svgProps}>
        <rect x="48" y="60" width="90" height="100" rx="6" fill={fill} stroke={stroke} strokeWidth="0.5" />
        <path d="M138 80 Q165 80 165 110 Q165 140 138 140" fill="none" stroke={fill} strokeWidth="9" />
      </svg>
    ),
    sticker: (
      <svg {...svgProps}>
        <rect x="40" y="40" width="120" height="120" rx="14" fill={fill} stroke="rgba(255,255,255,0.09)" strokeWidth="0.5" />
      </svg>
    ),
    cap: (
      <svg {...svgProps}>
        <path d="M30 130 Q30 80 100 80 Q170 80 170 130 L170 140 L30 140 Z M30 140 L185 140 L180 152 L40 152 Z" fill={fill} stroke={stroke} strokeWidth="0.5" />
      </svg>
    ),
    tote: (
      <svg {...svgProps}>
        <path d="M40 70 L40 180 L160 180 L160 70 Z M65 70 Q65 30 100 30 Q135 30 135 70 M65 70 L65 60 M135 70 L135 60" fill={fill} stroke="rgba(255,255,255,0.10)" strokeWidth="1" />
      </svg>
    ),
  };

  return (
    <div className="relative w-full h-full" style={{ background: "linear-gradient(180deg, #1a1a1d 0%, #0f0f11 100%)" }}>
      {shapes[type]}
    </div>
  );
}

export const PRODUCTS = [
  { type: "tee" as GarmentType,     label: "Tee",     price: "$28", color: "#0F0F11" },
  { type: "hoodie" as GarmentType,  label: "Hoodie",  price: "$48", color: "#1a1a22" },
  { type: "mug" as GarmentType,     label: "Mug",     price: "$18", color: "#FF6500" },
  { type: "sticker" as GarmentType, label: "Sticker", price: "$5",  color: "#0F0F11" },
  { type: "cap" as GarmentType,     label: "Cap",     price: "$24", color: "#1a1a22" },
  { type: "tote" as GarmentType,    label: "Tote",    price: "$22", color: "#0F0F11" },
] as const;

export const LAYOUTS = [
  { id: "full",   label: "Full meme",  sub: "Image + caption" },
  { id: "crop",   label: "Tight crop", sub: "Face only" },
  { id: "text",   label: "Text only",  sub: "Big quote" },
] as const;

export type { GarmentType };

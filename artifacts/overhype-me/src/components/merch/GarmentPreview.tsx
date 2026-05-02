type GarmentType = "tee" | "hoodie" | "mug" | "sticker" | "cap" | "tote";
type LayoutId = "full" | "crop" | "text";

interface GarmentProps {
  type: GarmentType;
  accentColor?: string;
  imageUrl?: string;
  layoutId?: LayoutId;
}

type OverlayBox = { top: number; left: number; width: number; height: number };

const OVERLAY_POSITIONS: Record<GarmentType, Record<LayoutId, OverlayBox>> = {
  tee: {
    full: { top: 44, left: 30, width: 40, height: 40 },
    crop: { top: 46, left: 36, width: 28, height: 28 },
    text: { top: 48, left: 28, width: 44, height: 24 },
  },
  hoodie: {
    full: { top: 50, left: 30, width: 40, height: 38 },
    crop: { top: 52, left: 36, width: 28, height: 28 },
    text: { top: 54, left: 28, width: 44, height: 22 },
  },
  mug: {
    full: { top: 36, left: 27, width: 40, height: 40 },
    crop: { top: 38, left: 32, width: 30, height: 30 },
    text: { top: 40, left: 27, width: 40, height: 26 },
  },
  sticker: {
    full: { top: 23, left: 23, width: 54, height: 54 },
    crop: { top: 28, left: 28, width: 44, height: 44 },
    text: { top: 30, left: 22, width: 56, height: 36 },
  },
  cap: {
    full: { top: 46, left: 38, width: 24, height: 22 },
    crop: { top: 48, left: 41, width: 18, height: 18 },
    text: { top: 50, left: 33, width: 34, height: 16 },
  },
  tote: {
    full: { top: 48, left: 32, width: 36, height: 36 },
    crop: { top: 50, left: 38, width: 24, height: 24 },
    text: { top: 52, left: 28, width: 44, height: 24 },
  },
};

export function GarmentPreview({ type, accentColor = "#0F0F11", imageUrl, layoutId = "full" }: GarmentProps) {
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

  const box = OVERLAY_POSITIONS[type][layoutId];
  // The "crop" layout zooms in on the meme image (face-only effect) by scaling
  // the background larger than its container and clipping the rest.
  const backgroundSize = layoutId === "crop" ? "180% auto" : "cover";
  const backgroundPosition = layoutId === "crop" ? "center 20%" : "center";

  return (
    <div className="relative w-full h-full" style={{ background: "linear-gradient(180deg, #1a1a1d 0%, #0f0f11 100%)" }}>
      {shapes[type]}
      {imageUrl && (
        <div
          aria-hidden
          style={{
            position: "absolute",
            top: `${box.top}%`,
            left: `${box.left}%`,
            width: `${box.width}%`,
            height: `${box.height}%`,
            backgroundImage: `url(${JSON.stringify(imageUrl)})`,
            backgroundSize,
            backgroundPosition,
            backgroundRepeat: "no-repeat",
            backgroundColor: "rgba(0,0,0,0.2)",
            boxShadow: "0 6px 18px rgba(0,0,0,0.35)",
          }}
        />
      )}
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
  { id: "full" as LayoutId, label: "Full meme",  sub: "Image + caption" },
  { id: "crop" as LayoutId, label: "Tight crop", sub: "Face only" },
  { id: "text" as LayoutId, label: "Text only",  sub: "Big quote" },
] as const;

export type { GarmentType, LayoutId };

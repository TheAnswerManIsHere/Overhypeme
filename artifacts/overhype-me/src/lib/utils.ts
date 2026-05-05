import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function isMobileDevice(): boolean {
  if (/iPhone|iPad|iPod|Android/i.test(navigator.userAgent)) {
    return true;
  }
  // iOS 13+ on iPad reports itself as "Macintosh" in Safari.
  // Detect it via touch points: real Macs have maxTouchPoints === 0.
  if (/MacIntel|Macintosh/i.test(navigator.platform ?? "") && navigator.maxTouchPoints > 1) {
    return true;
  }
  return false;
}

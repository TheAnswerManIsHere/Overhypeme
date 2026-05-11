import { useEffect, useState } from "react";

/**
 * Detects browser Web Share API support at mount time.
 *
 * The check runs once when the component mounts; we deliberately do NOT
 * re-evaluate on resize or any other event. Web Share support is a property
 * of the browser/build, not the viewport — once present, it stays present
 * for the lifetime of the page.
 *
 * Returns `null` during the first render so the modal can render a neutral
 * skeleton until the runtime probe completes. This avoids a hydration-style
 * flash where the wrong button set briefly appears.
 *
 * Mobile (iOS Safari, iOS Chrome / WebKit, Android Chrome): `true`. This
 * is the dominant share path on mobile — the OS share sheet exposes
 * iMessage, Mail, WhatsApp, Messenger, AirDrop, and every messaging app
 * the user has installed.
 *
 * Desktop: variable. Chrome on macOS supports it; Firefox typically does
 * not; Chrome on Windows is mixed. Trusting the runtime probe gives the
 * Web Share button to users whose OS will actually open a useful picker
 * and the Email fallback to users whose browser would otherwise leave
 * them looking at "I tapped Share and nothing happened."
 */
export function useWebShareSupport(): boolean | null {
  const [supported, setSupported] = useState<boolean | null>(null);
  useEffect(() => {
    setSupported(typeof navigator !== "undefined" && typeof navigator.share === "function");
  }, []);
  return supported;
}

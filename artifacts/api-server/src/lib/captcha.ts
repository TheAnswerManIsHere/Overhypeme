/**
 * Shared hCaptcha server-side verification helper.
 *
 * Bypass rules (intentional):
 * - Dev/staging: if HCAPTCHA_SECRET is not set, verification is skipped with a warning.
 * - Production: if HCAPTCHA_SECRET is not set, all verifications fail (returns false).
 */
export async function verifyCaptcha(token: string): Promise<boolean> {
  const secret = process.env.HCAPTCHA_SECRET;
  const isProd = process.env.NODE_ENV === "production";

  if (!secret) {
    if (isProd) {
      return false;
    }
    // Dev bypass — intentional, keeps local dev frictionless.
    console.warn("[dev] HCAPTCHA_SECRET not set — bypassing CAPTCHA verification");
    return true;
  }

  try {
    const resp = await fetch("https://api.hcaptcha.com/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret, response: token }).toString(),
    });
    const data = (await resp.json()) as { success: boolean };
    return data.success === true;
  } catch {
    return false;
  }
}

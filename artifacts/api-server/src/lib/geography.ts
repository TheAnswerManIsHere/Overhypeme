/**
 * @purpose The one list of places Overhype.me does not serve (launch Phase 14, increment 3; plan S9 and product intent 6): the EEA, the UK, and OFAC's broadly sanctioned jurisdictions — whole countries by ISO code, and three Ukrainian regions by Cloudflare region code. isBlockedLocation judges a visitor from Cloudflare's location headers; cloudflareRedirectExpression prints the same list as the Cloudflare redirect rule's expression, so the edge rule and the API's backstop are written from one list.
 * @subsystem security
 *
 * The EU list is Cloudflare's own `ip.src.is_in_european_union` membership
 * (its field reference, read 2026-11-18), which counts the outermost regions
 * Cloudflare geolocates under their own codes (French Guiana, Réunion, …) and
 * the Åland Islands; then Iceland, Liechtenstein and Norway for the EEA, and
 * the UK. Syria is no longer on OFAC's list (plan, product intent 6).
 *
 * Region codes: Cloudflare's `ip.src.region_code` is the ISO 3166-2
 * subdivision without its country prefix (its reference example: "TX").
 * Crimea UA-43, Sevastopol UA-40, Donetsk UA-14, Luhansk UA-09; Q7 blocks
 * the whole of Donetsk and Luhansk. Unverified against live traffic: no exit
 * point in those regions is available (plan, *Testing plan*); Crimea may also
 * geolocate as Russia (plan, *Risks*), which the Terms' representation covers.
 */

/** EU member states and the territories Cloudflare reports as EU under their own codes. */
const EU = [
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE",
  "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE",
  "AX", "GF", "GP", "MF", "MQ", "RE", "YT",
] as const;

/** The rest of the EEA, and the UK. */
const EEA_NON_EU_AND_UK = ["IS", "LI", "NO", "GB"] as const;

/** OFAC's broadly sanctioned countries. */
const OFAC = ["CU", "IR", "KP"] as const;

export const BLOCKED_COUNTRIES: ReadonlySet<string> = new Set([...EU, ...EEA_NON_EU_AND_UK, ...OFAC]);

/** Ukrainian regions refused whole: Crimea, Sevastopol, Donetsk, Luhansk. */
export const BLOCKED_UA_REGIONS: ReadonlySet<string> = new Set(["43", "40", "14", "09"]);

/** The explanation page every refused visitor is sent to. */
export const EXPLANATION_PATH = "/unavailable";

/** True when Cloudflare's location headers place the visitor somewhere the site does not serve. */
export function isBlockedLocation(country: string | undefined, regionCode: string | undefined): boolean {
  const c = (country ?? "").trim().toUpperCase();
  if (BLOCKED_COUNTRIES.has(c)) return true;
  return c === "UA" && BLOCKED_UA_REGIONS.has((regionCode ?? "").trim().toUpperCase());
}

/**
 * The Cloudflare redirect rule's expression for the same list: every address
 * but the explanation page, from a blocked country or region.
 */
export function cloudflareRedirectExpression(): string {
  const set = (values: Iterable<string>) => `{${[...values].map((v) => `"${v}"`).join(" ")}}`;
  return [
    `(ip.src.country in ${set(BLOCKED_COUNTRIES)}`,
    ` or (ip.src.country eq "UA" and ip.src.region_code in ${set(BLOCKED_UA_REGIONS)}))`,
    ` and not starts_with(http.request.uri.path, "${EXPLANATION_PATH}")`,
  ].join("");
}

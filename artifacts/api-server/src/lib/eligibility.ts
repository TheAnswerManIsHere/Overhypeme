/**
 * @purpose Derives an account's eligibility to act (eligible, or the first reason it may not) and its age thresholds from the loaded user row, so one function decides what the verified-actor gate enforces and nothing stores a flag that could drift from the row.
 * @subsystem accounts-auth
 */

/**
 * Why a signed-in account may not act yet, or `eligible`. Launch Phase 5
 * (plan S8, S19): verify, then onboard, then act. `suspended` and
 * `deletion_pending` are named here so the contract does not change when
 * increments 5 and 6 add the tables that decide them; nothing returns them yet.
 */
export type Eligibility = "eligible" | "suspended" | "deletion_pending" | "unverified" | "unonboarded";

export const ELIGIBILITY_STATES: readonly Eligibility[] = [
  "eligible",
  "suspended",
  "deletion_pending",
  "unverified",
  "unonboarded",
];

export interface EligibilityRow {
  emailVerifiedAt: Date | string | null;
  onboardingCompletedAt: Date | string | null;
}

/** In precedence order: an unverified account is never asked to onboard first. */
export function eligibilityOf(row: EligibilityRow): Eligibility {
  if (row.emailVerifiedAt == null) return "unverified";
  if (row.onboardingCompletedAt == null) return "unonboarded";
  return "eligible";
}

/**
 * Whole years between a `YYYY-MM-DD` birth date and `now`, by calendar date in
 * UTC: the birthday itself counts (13 on the day you turn 13). Null for a
 * missing or unparseable date.
 */
export function ageInYears(dateOfBirth: string | null | undefined, now: Date = new Date()): number | null {
  if (!dateOfBirth) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateOfBirth);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  let age = now.getUTCFullYear() - y;
  const beforeBirthday = now.getUTCMonth() + 1 < mo || (now.getUTCMonth() + 1 === mo && now.getUTCDate() < d);
  if (beforeBirthday) age -= 1;
  return age;
}

/** A real calendar date, not in the future, not before 1900. */
export function isPlausibleBirthDate(dateOfBirth: string, now: Date = new Date()): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateOfBirth);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return false;
  return y >= 1900 && dt.getTime() <= now.getTime();
}

export const MINIMUM_AGE = 13;
export const ADULT_AGE = 18;

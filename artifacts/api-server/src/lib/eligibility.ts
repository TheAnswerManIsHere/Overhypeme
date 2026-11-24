/**
 * @purpose Derives an account's eligibility to act (eligible, or the first reason it may not — under 18 and Terms not accepted included) and its 18+ threshold from the loaded user row, so one function decides what the verified-actor gate enforces and nothing stores a flag that could drift from the row.
 * @subsystem accounts-auth
 */

/**
 * Why a signed-in account may not act yet, or `eligible`. Launch Phase 5
 * (plan S8, S19): verify, then onboard, then act. A suspended account can do
 * nothing but sign out (Increment 6); an account whose deletion is pending can
 * only cancel it (Increment 5). Launch Phase 14, increment 4 (plan S-c): an
 * account under 18 can only sign out or ask for deletion, reads included, and
 * one that has not accepted the current Terms and Privacy page can read but
 * not act.
 */
export type Eligibility =
  | "eligible"
  | "suspended"
  | "underage"
  | "deletion_pending"
  | "unverified"
  | "unonboarded"
  | "terms_unaccepted";

/** What a suspended account is told at every door: that it is suspended, never why (the reason is admins' only). */
export const SUSPENDED_MESSAGE = "This account is suspended.";

export interface EligibilityRow {
  emailVerifiedAt: Date | string | null;
  onboardingCompletedAt: Date | string | null;
  /** True while the account has an active deletion request (`ownerLeaving`, lib/contentVisibility.ts). */
  deletionPending?: boolean;
  /** Set while an admin has the account suspended (0120). */
  suspendedAt?: Date | string | null;
  /** Set once the account submitted set-up with a date under 18 (0162). */
  ageRefusedAt?: Date | string | null;
  /** The stored birth date, `YYYY-MM-DD`; an onboarded account under 18 by it is `underage`. */
  dateOfBirth?: string | null;
  /**
   * True when the account holds an acceptance at the current version of every
   * document it must accept (`legalAcceptance.ts`). Absent is read as not
   * accepted, so a caller that forgets to load it fails closed.
   */
  legalAccepted?: boolean;
}

/**
 * Under 18 for this product's purposes: a submitted under-age answer, or an
 * onboarded account whose stored date says so. Derived at read time, so an
 * account that turns 18 is no longer under age with no job and no migration
 * (plan S-c). A refusal is permanent: the form cannot be resubmitted.
 */
export function isUnderAge(row: EligibilityRow, now: Date = new Date()): boolean {
  if (row.ageRefusedAt != null) return true;
  if (row.onboardingCompletedAt == null) return false;
  const age = ageInYears(row.dateOfBirth ?? null, now);
  return age != null && age < MINIMUM_AGE;
}

/**
 * In precedence order: a suspension first (it blocks even keeping a pending
 * deletion); then under age, ahead of a pending deletion, so an under-age
 * account that asked for deletion still reads nothing and cannot cancel; then
 * a pending deletion; an unverified account is never asked to onboard first;
 * and acceptance is asked of an onboarded account (set-up records it for a
 * new one).
 */
export function eligibilityOf(row: EligibilityRow, now: Date = new Date()): Eligibility {
  if (row.suspendedAt != null) return "suspended";
  if (isUnderAge(row, now)) return "underage";
  if (row.deletionPending) return "deletion_pending";
  if (row.emailVerifiedAt == null) return "unverified";
  if (row.onboardingCompletedAt == null) return "unonboarded";
  if (row.legalAccepted !== true) return "terms_unaccepted";
  return "eligible";
}

/**
 * Whole years between a `YYYY-MM-DD` birth date and `now`, by calendar date in
 * UTC: the birthday itself counts (18 on the day you turn 18). Null for a
 * missing date or one `isPlausibleBirthDate` refuses.
 */
export function ageInYears(dateOfBirth: string | null | undefined, now: Date = new Date()): number | null {
  if (!dateOfBirth || !isPlausibleBirthDate(dateOfBirth, now)) return null;
  const [y, mo, d] = dateOfBirth.split("-").map(Number) as [number, number, number];
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

/** Overhype.me is for adults (launch Phase 14, Q3). */
export const MINIMUM_AGE = 18;

export interface IdentityRow extends EligibilityRow {
  dateOfBirth: string | null;
}

/**
 * The identity fields `req.user` carries, derived from the row: the one
 * derivation the auth middleware and the test app both spread, so a test
 * double cannot drift from production.
 */
export function identityFieldsOf(row: IdentityRow, now: Date = new Date()) {
  const age = ageInYears(row.dateOfBirth, now);
  return {
    eligibility: eligibilityOf(row, now),
    emailVerified: row.emailVerifiedAt != null,
    onboardingCompleted: row.onboardingCompletedAt != null,
    is18Plus: age != null && age >= MINIMUM_AGE,
  };
}

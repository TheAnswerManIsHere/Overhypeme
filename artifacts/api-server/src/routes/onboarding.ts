/**
 * @purpose The one onboarding screen's server side (launch Phase 5, plan S5, S8, S22): reads what the form starts from, saves a half-finished form as a draft, and completes onboarding in one write — date of birth (under 13 refused with nothing stored), pronouns, the marketing-consent record and a fresh Turnstile challenge — for a verified account.
 * @subsystem accounts-auth
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import { verifyCaptcha } from "../lib/captcha";
import { MINIMUM_AGE, ageInYears } from "../lib/eligibility";
import { ipFromRequest } from "../lib/transientRenderLog";
import { REFUSAL_CODE } from "../middlewares/requireEligibleActor";
import { sanitizeAndValidatePronouns } from "../lib/validators/personalName";

const router: IRouter = Router();

/**
 * The version of the marketing-consent sentence the screen shows. Stored with
 * every decision, so a later wording change can tell who agreed to which.
 * Change it whenever the sentence in `Onboard.tsx` changes.
 */
export const MARKETING_WORDING_VERSION = "marketing-2026-11-01";

/**
 * The marketing box's default: ticked for a visitor Cloudflare places in the
 * United States (CAN-SPAM is opt-out), unticked everywhere else and whenever
 * the header is absent (CASL and ACMA forbid a pre-ticked box). David,
 * 2026-10-30, pick 1 of 3.
 */
export function marketingDefaultFor(req: Request): boolean {
  const country = req.get("cf-ipcountry");
  return typeof country === "string" && country.trim().toUpperCase() === "US";
}

/** How the stored decision was given, from the box's final state and its default. */
export function consentMethod(optIn: boolean, defaultChecked: boolean): "default_checked" | "ticked" | "declined" {
  if (!optIn) return "declined";
  return defaultChecked ? "default_checked" : "ticked";
}

interface DraftBody {
  pronouns?: unknown;
  dobYear?: unknown;
  dobMonth?: unknown;
  dobDay?: unknown;
  marketingOptIn?: unknown;
}

/** The draft as stored: only the fields the form has, each as the visitor typed it. */
interface OnboardingDraft {
  pronouns?: string;
  dobYear?: string;
  dobMonth?: string;
  dobDay?: string;
  marketingOptIn?: boolean;
}

function shortString(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t.length > 0 && t.length <= max ? t : undefined;
}

function toDraft(body: DraftBody): OnboardingDraft {
  const draft: OnboardingDraft = {};
  const pronouns = shortString(body.pronouns, 80);
  if (pronouns) draft.pronouns = pronouns;
  const y = shortString(body.dobYear, 4);
  const m = shortString(body.dobMonth, 2);
  const d = shortString(body.dobDay, 2);
  if (y && /^\d+$/.test(y)) draft.dobYear = y;
  if (m && /^\d+$/.test(m)) draft.dobMonth = m;
  if (d && /^\d+$/.test(d)) draft.dobDay = d;
  if (typeof body.marketingOptIn === "boolean") draft.marketingOptIn = body.marketingOptIn;
  return draft;
}

/** `YYYY-MM-DD` from the three parts, or null when any is missing. */
function birthDateOf(draft: OnboardingDraft): string | null {
  if (!draft.dobYear || !draft.dobMonth || !draft.dobDay) return null;
  return `${draft.dobYear.padStart(4, "0")}-${draft.dobMonth.padStart(2, "0")}-${draft.dobDay.padStart(2, "0")}`;
}

function refuseUnderAge(res: Response): void {
  res.status(422).json({
    error: "Overhype.me is for people 13 and over.",
    code: "UNDER_AGE",
  });
}

/**
 * Who may use these routes: a signed-in, verified account (plan S8; the
 * transition table's "onboarding draft and completion" row). The gate admits
 * an un-onboarded account here; this is the route's own check.
 */
function requireVerified(req: Request, res: Response): req is Request & { user: NonNullable<Request["user"]> } {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Not authenticated" });
    return false;
  }
  if (!req.user.emailVerified) {
    res.status(403).json({ error: "Verify your email address to continue.", code: "EMAIL_VERIFICATION_REQUIRED" });
    return false;
  }
  if (req.user.eligibility === "suspended" || req.user.eligibility === "deletion_pending") {
    res.status(403).json({ error: "This account cannot be set up now.", code: REFUSAL_CODE[req.user.eligibility] });
    return false;
  }
  return true;
}

// What the form starts from. The pronoun suggestion from the name is the
// browser's (`infer-pronouns.ts`, the table the Login page uses), so the
// server sends the name and the account's stored choice, not a guess.
router.get("/auth/onboarding", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  // The rest is on req.user already; only the draft is not.
  const [row] = await db
    .select({ onboardingDraft: usersTable.onboardingDraft })
    .from(usersTable)
    .where(eq(usersTable.id, req.user.id))
    .limit(1);
  res.json({
    completed: !!req.user.onboardingCompleted,
    emailVerified: !!req.user.emailVerified,
    marketingDefault: marketingDefaultFor(req),
    marketingWordingVersion: MARKETING_WORDING_VERSION,
    accountPronouns: req.user.pronouns ?? null,
    name: req.user.displayName ?? req.user.firstName ?? null,
    draft: (row?.onboardingDraft as OnboardingDraft | null) ?? null,
  });
});

// Saves progress. A complete date under 13 is refused and nothing is written,
// not even the other fields (plan S4, S22).
router.put("/users/me/onboarding/draft", async (req: Request, res: Response) => {
  if (!requireVerified(req, res)) return;
  if (req.user.onboardingCompleted) {
    res.status(409).json({ error: "Onboarding is already complete." });
    return;
  }
  const draft = toDraft((req.body ?? {}) as DraftBody);
  const age = ageInYears(birthDateOf(draft));
  if (age != null && age < MINIMUM_AGE) {
    refuseUnderAge(res);
    return;
  }
  await db
    .update(usersTable)
    .set({ onboardingDraft: draft })
    .where(and(eq(usersTable.id, req.user.id), isNull(usersTable.onboardingCompletedAt)));
  res.json({ saved: true });
});

// Completes onboarding: every field in one write, the draft cleared, behind a
// fresh challenge (Turnstile tokens are single-use and live five minutes).
router.post("/users/me/onboarding", async (req: Request, res: Response) => {
  if (!requireVerified(req, res)) return;
  if (req.user.onboardingCompleted) {
    res.json({ completed: true });
    return;
  }
  const body = (req.body ?? {}) as DraftBody & { captchaToken?: unknown };
  const draft = toDraft(body);

  const dob = birthDateOf(draft);
  const age = ageInYears(dob);
  if (!dob || age == null) {
    res.status(400).json({ error: "Enter your date of birth.", field: "dateOfBirth" });
    return;
  }
  if (age < MINIMUM_AGE) {
    refuseUnderAge(res);
    return;
  }
  if (!draft.pronouns) {
    res.status(400).json({ error: "Choose your pronouns.", field: "pronouns" });
    return;
  }
  const pronouns = await sanitizeAndValidatePronouns(draft.pronouns);
  if (!pronouns.ok) {
    res.status(400).json({ error: pronouns.error, field: "pronouns" });
    return;
  }
  if (typeof draft.marketingOptIn !== "boolean") {
    res.status(400).json({ error: "marketingOptIn is required", field: "marketingOptIn" });
    return;
  }
  const token = typeof body.captchaToken === "string" ? body.captchaToken : "";
  const ip = ipFromRequest(req);
  if (!token || !(await verifyCaptcha(token, ip === "unknown" ? undefined : ip))) {
    res.status(400).json({ error: "The challenge didn't pass. Try it again.", code: "CAPTCHA_FAILED" });
    return;
  }

  const now = new Date();
  await db
    .update(usersTable)
    .set({
      dateOfBirth: dob,
      pronouns: pronouns.value,
      marketingConsentAt: now,
      marketingConsentMethod: consentMethod(draft.marketingOptIn, marketingDefaultFor(req)),
      marketingConsentWordingVersion: MARKETING_WORDING_VERSION,
      onboardingCompletedAt: now,
      onboardingDraft: null,
    })
    .where(and(eq(usersTable.id, req.user.id), isNull(usersTable.onboardingCompletedAt)));

  res.json({ completed: true });
});

export default router;

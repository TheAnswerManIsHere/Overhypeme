# David's two registrations

The two filings Phase 14 leaves to David as the operator (Issue #1030 — Launch
Phase 14 — Compliance, increment 8; plan `PLAN_PHASE14_COMPLIANCE.md`, Product
intent 11). This is a walk-through, not a legal page. It lives outside
`docs/legal/`, because the generator accepts only `terms`, `privacy`,
`copyright` and `guidelines` there (`generate-legal-content.ts`, `LEGAL_SLUGS`).

The sources were read on 2026-11-21. The quotations below are from those
pages. Re-read them if a step no longer matches what you see.

## 1. The copyright agent (US Copyright Office) — $6, about 15 minutes

**Why:** the DMCA safe harbour covers a site only once it has a designated
agent on file with the Copyright Office. The Copyright page says the filing
has "not yet been filed".

**Where:** <https://dmca.copyright.gov/osp/login.html> ("Login/Register" on
<https://www.copyright.gov/dmca-directory/>). The Office takes designations
online only: "the Office no longer accepts paper designations" (DMCA FAQ).

**What it asks** (DMCA FAQ, <https://www.copyright.gov/dmca-directory/faq.html>):

| Field | What we enter |
| --- | --- |
| Service provider's full legal name | Availeron Consulting, Inc. |
| Its physical street address (not a P.O. box) | 745 5th Ave., Suite 500, New York, NY 10151 |
| Alternate names ("website names and addresses … the top level domain … sufficient") | Overhype.me; overhype.me |
| Designated agent: name or a position, organization, mailing address, telephone, email | "Copyright Agent", Availeron Consulting, Inc., the address above, **a phone number you choose**, `copyright@overhype.me` |
| A primary contact (representative's name, phone, email), and the provider's phone and email | you |

The agent may be "a specific position or title", so "Copyright Agent" keeps
your name off the public directory. A P.O. box is allowed for the agent's
address ("A waiver is not necessary"), but the provider's own address must be
a street address.

**Cost and term:** "$6 per designation, amendment, or resubmission". A
designation "will expire and become invalid three years after it is
registered … unless the service provider renews". The system emails reminders
at 90, 60 and 30 days and one week before the deadline.

**When it is filed, tell Claude the phone number and the filing date.** The
Office requires the same agent details "on its website". Our Copyright page
then gains the telephone number and loses the "not yet been filed" sentence,
under a new version. That edit is Claude's; the number is not.

## 2. NCMEC, as an electronic service provider — no fee stated, an email

**Why:** US-based providers must report apparent child sexual abuse material
they become aware of to NCMEC's CyberTipline (18 U.S.C. § 2258A). Phase 14's
increment 7 builds the manual path (Q2), and filing through it needs NCMEC
credentials. Due before Seed (plan, *Implementation Steps*). Increment 7 does
not wait for it.

**Where:** email **espteam@ncmec.org**. Source:
<https://www.missingkids.org/theissues/csam>, "Are you an ESP who would like
to register with NCMEC? Click here", which links to that address. That page
says "over 1,400 companies are registered". No registration form, list of
questions or fee is published. `unable to verify: what NCMEC asks for; its
reply to the first email settles it.`

**A first email that covers what they will need:**

> Subject: ESP registration — Overhype.me (Availeron Consulting, Inc.)
>
> Availeron Consulting, Inc. (745 5th Ave., Suite 500, New York, NY 10151)
> operates Overhype.me, a US website where adult members upload photos of
> themselves to make humorous images. We would like to register as an
> electronic service provider to report to the CyberTipline under 18 U.S.C.
> § 2258A. We expect to report manually through the web form at first. Please
> also send credentials for the reporting web service and its test
> environment. Our contact for reports is [your name, phone], and
> `legal@overhype.me`.

**What we get:** "A username and password must be requested from and supplied
by NCMEC". A report goes either through the web form
(<https://report.cybertip.org/cybertip/>) or through the web service at
`https://report.cybertip.org/ispws`, which has a test environment at
`https://exttest.cybertip.org/ispws` (<https://report.cybertip.org/ispws/documentation>).
We file by hand until more than five distinct cases arrive in any 90 days
(Q2).

**When NCMEC replies, tell Claude it is done.** Keep the credentials out of
chat and out of this repository. If they are ever needed by the app, they go
into Replit's Secrets pane.

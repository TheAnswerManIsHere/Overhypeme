# David's two registrations

The two filings Phase 14 leaves to David as the operator (Issue #1030 — Launch
Phase 14 — Compliance, increment 8; plan `PLAN_PHASE14_COMPLIANCE.md`, Product
intent 11). This is a walk-through, not a legal page. It lives outside
`docs/legal/`, because the generator accepts only `terms`, `privacy`,
`copyright` and `guidelines` there (`generate-legal-content.ts`, `LEGAL_SLUGS`).

The sources were read on 2026-11-21. The quotations below are from those
pages. Re-read them if a step no longer matches what you see.

## 1. The copyright agent (US Copyright Office) — $6

**Why:** the DMCA safe harbour covers a site only once it has a designated
agent on file with the Copyright Office. 17 U.S.C. § 512(c)(2) (Cornell LII,
read 2026-11-23): "The limitations on liability established in this
subsection apply to a service provider only if the service provider has
designated an agent to receive notifications of claimed infringement
described in paragraph (3), by making available through its service,
including on its website in a location accessible to the public, and by
providing to the Copyright Office, substantially the following
information". The Copyright page says the filing has "not yet been filed".

**Where:** <https://dmca.copyright.gov/osp/login.html>, the "Login/Register"
link on <https://www.copyright.gov/dmca-directory/>: "Click below to sign in to
your registration account or to create a new account." It adds that "the
Office no longer accepts paper designations"; the FAQ says designations are
made "through the online system".

**What it asks** (DMCA FAQ, <https://www.copyright.gov/dmca-directory/faq.html>):
"its full legal name, physical street address (not a post office box), any
alternate names used by the service provider, and the name, organization,
physical mail address (street address or post office box), telephone number,
and email address of its designated agent", and "The first name, last name,
telephone number, and email address of a representative" as the primary
contact.

| Field | What we enter |
| --- | --- |
| Service provider's full legal name | Availeron Consulting, Inc. |
| Its physical street address (not a P.O. box) | 745 5th Ave., Suite 500, New York, NY 10151 |
| Alternate names ("website names and addresses … the top level domain … sufficient") | Overhype.me; overhype.me |
| Designated agent: name or a position, organization, mailing address, telephone, email | "Copyright Agent", Availeron Consulting, Inc., the address above, **a phone number you choose**, `copyright@overhype.me` |
| A primary contact (representative's name, phone, email), and the provider's phone and email | you |

The agent may be "a specific position or title" (FAQ), so the agent entry
can read "Copyright Agent" rather than a person's name. For the agent's
address, "A waiver is not necessary to provide a post office box" (FAQ); the
provider's own address must be a street address.

**Cost and term:** "$6 per designation, amendment, or resubmission". A
designation "will expire and become invalid three years after it is
registered … unless the service provider renews". Reminders go out "at 90
days, 60 days, 30 days, and 1 week prior to each service provider's renewal
deadline" (FAQ).

**When it is filed, tell Claude the phone number and the filing date.** A
provider must "make certain contact information for the agent available to
the public on its website" (<https://www.copyright.gov/dmca-directory/>). Our Copyright page
then gains the telephone number and loses the "not yet been filed" sentence,
under a new version. That edit is Claude's; the number is not.

## 2. NCMEC, as an electronic service provider — no fee stated, an email

**Why:** US-based providers must report apparent child sexual abuse material
they become aware of to NCMEC's CyberTipline. 18 U.S.C. § 2258A(a)(1)(A)
(Cornell LII, read 2026-11-23): a provider "shall, as soon as reasonably
possible after obtaining actual knowledge of any facts or circumstances
described in paragraph (2)(A), take the actions described in subparagraph
(B)", and (B)(i) is "providing to the CyberTipline of NCMEC … the mailing
address, telephone number, facsimile number, electronic mailing address of,
and individual point of contact for, such provider". `unable to verify:
the verbatim text of (B)(ii), the report of the facts themselves; reading
§ 2258A(a)(1)(B)(ii) on the same page settles it.` Phase 14's
increment 7 builds the manual path (Q2), and filing through it needs NCMEC
credentials. Due before Seed (plan, *Implementation Steps*). Increment 7 does
not wait for it.

**Where:** email **espteam@ncmec.org**. On
<https://www.missingkids.org/theissues/csam>, "Are you an ESP who would like
to register with NCMEC? Click here" is a `mailto:` link to that address. The
pages read on 2026-11-21 (that page, <https://www.missingkids.org/gethelpnow/cybertipline>
and <https://report.cybertip.org/faqs>) show no registration form, no list of
questions and no fee. `unable to verify: what NCMEC asks for; its reply to the
first email settles it.`

**A first email that covers what they will need:**

> Subject: ESP registration — Overhype.me (Availeron Consulting, Inc.)
>
> Availeron Consulting, Inc. (745 5th Ave., Suite 500, New York, NY 10151)
> operates Overhype.me, a US website where adult members upload photos of
> themselves to make humorous images. We would like to register as an
> electronic service provider to report to the CyberTipline under 18 U.S.C.
> § 2258A. We expect to report manually through the web form at first. Please
> also send credentials for the reporting web service and its test
> environment. Two questions before we finalise our procedure: (1) does the
> registered web form accept a report without the image or video file
> attached, and (2) how do you want a small registered provider to send a
> file when you need it? Our contact for reports is [your name, phone], and
> `legal@overhype.me`.

**What we get** (<https://report.cybertip.org/ispws/documentation>): "A
username and password must be requested from and supplied by NCMEC". Providers
"can submit a report using a web form or using this web service API" (the
form is <https://report.cybertip.org/cybertip/>), and "For testing, NCMEC provides a testing
environment with base URI https://exttest.cybertip.org/ispws." We report by
hand (Q2). More than five distinct cases in any 90 days starts the build of
automated filing, and manual reporting continues meanwhile.

**When NCMEC replies, tell Claude two things: that registration is done, and
NCMEC's answers to the two questions.** Those answers are a completion gate
for increment 7 (plan, settled decision S-f): if NCMEC needs the file inside
the report, the plan is amended before Seed. Registration alone does not
settle them. Keep the credentials out of chat and out of this repository. If
the app ever needs them, they go into Replit's Secrets pane.

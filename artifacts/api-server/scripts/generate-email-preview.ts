import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildEmailVerificationEmail,
  buildEmailChangeVerificationEmail,
  buildPasswordResetEmail,
  buildReviewApprovedEmail,
  buildReviewRejectedEmail,
  buildShareInviteEmail,
} from "../src/lib/email";
import { buildFactOfTheDayEmail } from "../src/jobs/factOfTheDay";
import { buildAccessRevokedEmail } from "../src/lib/userNotify";

type Section = {
  num: string;
  subject: string;
  from: string;
  text: string;
  html: string;
};

function section(num: string, subject: string, from: string, e: { text: string; html: string }): Section {
  return { num, subject, from, text: e.text, html: e.html };
}

const sampleVerifyUrl =
  "https://overhype.me/verify-email?token=abc123xyz456def789ghi012jkl345mno678pqr";
const sampleChangeUrl =
  "https://overhype.me/verify-email-change?token=abc123xyz456def789ghi012jkl345mno678pqr";
const sampleResetUrl =
  "https://overhype.me/reset-password?token=abc123xyz456def789ghi012jkl345mno678pqr";
const sampleFactUrl = "https://overhype.me/facts/1234";
const sampleShareUrl = "https://overhype.me/?share=abc123";
const sampleManageUrl = "https://overhype.me/profile#membership";

const sections: Section[] = [
  section(
    "01",
    "Verify your email — Overhype.me",
    "noreply@overhype.me → new user",
    buildEmailVerificationEmail(sampleVerifyUrl),
  ),
  section(
    "02",
    "Confirm your new email address — Overhype.me",
    "noreply@overhype.me → existing user",
    buildEmailChangeVerificationEmail("janedoe-new@example.com", sampleChangeUrl),
  ),
  section(
    "03",
    "Reset your password — Overhype.me",
    "noreply@overhype.me → user",
    buildPasswordResetEmail(sampleResetUrl),
  ),
  section(
    "04",
    "✨ Your fact made the cut",
    "noreply@overhype.me → submitter",
    buildReviewApprovedEmail({
      username: "Alex",
      submittedText: "Chuck Norris once deleted the Recycle Bin. It now lives in fear.",
      factId: 1234,
      adminNote: "Punchy and specific — exactly what we look for.",
    }),
  ),
  section(
    "05",
    "About your fact submission…",
    "noreply@overhype.me → submitter",
    buildReviewRejectedEmail({
      username: "Alex",
      submittedText: "Chuck Norris is cool.",
      adminNote: "Too generic — give us a specific, vivid scenario.",
      rejectionReason: "lame",
    }),
  ),
  section(
    "06",
    "⚡ Your Daily Overhype.me Fact",
    "noreply@overhype.me → legendary member",
    buildFactOfTheDayEmail(
      "Chuck Norris doesn't read books. He stares them down until he gets the information he wants.",
      1234,
      sampleManageUrl,
    ),
  ),
  section(
    "07",
    "Alex sent you an Overhype.me fact",
    "noreply@overhype.me → recipient",
    buildShareInviteEmail("Sam", sampleShareUrl, "Alex"),
  ),
  section(
    "08",
    "Your Overhype.me membership has been paused",
    "noreply@overhype.me → former legendary member",
    buildAccessRevokedEmail("refund"),
  ),
];

const navLinks = sections
  .map(
    (s, i) =>
      `    <a href="#email-${i + 1}">${s.num} · ${s.subject.replace(/ — Overhype\.me$/, "").replace(/^[^A-Za-z]+/, "").slice(0, 32)}</a>`,
  )
  .join("\n");

const sectionBlocks = sections
  .map(
    (s, i) => `
  <div class="email-section" id="email-${i + 1}">
    <div class="email-label">
      <span class="num">${s.num}</span>
      <span class="subject">${s.subject}</span>
      <span class="from">${s.from}</span>
    </div>
    <div class="email-frame">
${s.html}
    </div>
    <details>
      <summary>Plain text version</summary>
      <pre>${s.text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</pre>
    </details>
  </div>

  <div class="divider"></div>
`,
  )
  .join("\n");

const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Email Previews — Overhype.me</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Oswald:wght@600;700&display=swap');
    * { box-sizing: border-box; }
    body { margin: 0; padding: 0; background: #111; font-family: 'Inter', sans-serif; color: #ddd; }
    .nav {
      position: sticky; top: 0; z-index: 100;
      background: #0a0a0a; border-bottom: 1px solid #222;
      padding: 12px 24px; display: flex; align-items: center;
      gap: 8px; overflow-x: auto; white-space: nowrap;
    }
    .nav a {
      color: #aaa; text-decoration: none; font-size: 12px;
      padding: 6px 12px; border: 1px solid #333; border-radius: 6px;
      transition: all .15s ease;
    }
    .nav a:hover { background: #FF6600; color: #fff; border-color: #FF6600; }
    h1.page-title {
      font-family: 'Oswald', sans-serif; font-size: 32px;
      letter-spacing: 1px; text-transform: uppercase;
      color: #fff; margin: 32px 24px 8px;
    }
    p.page-sub { color: #888; font-size: 13px; margin: 0 24px 24px; }
    .email-section { max-width: 720px; margin: 32px auto; padding: 0 16px; }
    .email-label {
      display: flex; align-items: baseline; gap: 12px;
      padding: 12px 4px; border-bottom: 1px solid #222;
      margin-bottom: 16px; flex-wrap: wrap;
    }
    .email-label .num {
      font-family: 'Oswald', sans-serif; font-size: 14px;
      letter-spacing: 2px; color: #FF6600; font-weight: 700;
    }
    .email-label .subject { font-size: 14px; color: #fff; font-weight: 600; }
    .email-label .from { font-size: 11px; color: #666; margin-left: auto; font-family: monospace; }
    .email-frame { background: #0d0d0e; border: 1px solid #1f1f22; border-radius: 12px; overflow: hidden; }
    details { margin-top: 12px; }
    details summary {
      cursor: pointer; color: #888; font-size: 12px;
      padding: 8px 0; user-select: none;
    }
    details pre {
      background: #1a1a1a; color: #aaa; padding: 16px;
      border-radius: 6px; font-size: 12px; line-height: 1.6;
      white-space: pre-wrap; word-break: break-word;
      border: 1px solid #222;
    }
    .divider { height: 1px; background: #1a1a1a; margin: 0 auto; max-width: 720px; }
  </style>
</head>
<body>
  <nav class="nav">
${navLinks}
  </nav>

  <h1 class="page-title">Overhype.me — Email Previews</h1>
  <p class="page-sub">Auto-generated from the actual builders. Regenerate with <code>tsx scripts/generate-email-preview.ts</code>.</p>

${sectionBlocks}

</body>
</html>
`;

const outPath = resolve(process.cwd(), "../../email-preview.html");
writeFileSync(outPath, html, "utf8");
console.log(`Wrote ${outPath} (${html.length} bytes, ${sections.length} sections)`);

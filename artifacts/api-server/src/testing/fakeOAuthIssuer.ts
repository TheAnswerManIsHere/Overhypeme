/**
 * @purpose A fake Google and Apple sign-in for the isolated production-mode launcher only (launch Phase 5, plan T6): an "authorize" page on its own local port where a browser types the email and chooses whether the provider vouches for it, and the server's existing test seams (discovery, the authorization URL, the code exchange) answered from what that page sent, so a scripted journey drives the real callback, upsert, session and redirect code with no real provider.
 * @subsystem accounts-auth
 */
import { createServer, type Server } from "node:http";
import { generateKeyPairSync } from "node:crypto";
import type { Configuration, TokenEndpointResponse, TokenEndpointResponseHelpers } from "openid-client";

import { _setClientDiscoveryForTest } from "../lib/auth";
import { _setAuthCodeGrantForTest, _setBuildAuthorizationUrlForTest } from "../routes/auth";

type Provider = "google" | "apple";

/** What the authorize page sends back, carried in the code the callback exchanges. */
interface FakeGrant {
  provider: Provider;
  email: string;
  /** "true", "false" or "absent": how the provider's ID token states it. */
  verified: "true" | "false" | "absent";
  nonce: string;
  state: string;
}

const encode = (g: FakeGrant): string => Buffer.from(JSON.stringify(g)).toString("base64url");
const decode = (code: string): FakeGrant => JSON.parse(Buffer.from(code, "base64url").toString("utf8")) as FakeGrant;

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** The provider's claim shape: Google sends a boolean, Apple the string "true". */
function emailVerifiedClaim(g: FakeGrant): Record<string, unknown> {
  if (g.verified === "absent") return {};
  if (g.provider === "apple") return { email_verified: g.verified };
  return { email_verified: g.verified === "true" };
}

function authorizePage(params: URLSearchParams, provider: Provider): string {
  const hidden = ["redirect_uri", "state", "nonce", "response_mode"]
    .map((k) => `<input type="hidden" name="${k}" value="${escapeHtml(params.get(k) ?? "")}">`)
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Fake ${provider} sign-in</title></head><body>
<h1>Fake ${provider} sign-in</h1>
<form method="post" action="/approve?provider=${provider}">${hidden}
<label>Email <input name="email" type="email" required></label>
<label>Provider vouches for the email
<select name="verified"><option value="true">yes</option><option value="false">no</option><option value="absent">not stated</option></select></label>
<button type="submit">Approve</button>
</form></body></html>`;
}

function readForm(req: import("node:http").IncomingMessage): Promise<URLSearchParams> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 10_000) reject(new Error("form too large"));
    });
    req.on("end", () => resolve(new URLSearchParams(body)));
    req.on("error", reject);
  });
}

/**
 * Installs the fake for this process: provider credentials that satisfy the
 * routes' "configured" check (an Apple key generated here, never a real one),
 * the three test seams, and the authorize page on `port`. Only the
 * production-mode launcher calls this, and only when asked to.
 */
export function installFakeOAuthIssuer(port: number): Server {
  process.env.GOOGLE_CLIENT_ID = "e2e-fake-google-client";
  process.env.GOOGLE_CLIENT_SECRET = "e2e-fake-google-secret";
  process.env.APPLE_CLIENT_ID = "e2e.fake.apple";
  process.env.APPLE_TEAM_ID = "E2EFAKETEAM";
  process.env.APPLE_KEY_ID = "E2EFAKEKID";
  process.env.APPLE_PRIVATE_KEY = generateKeyPairSync("ec", { namedCurve: "P-256" })
    .privateKey.export({ type: "pkcs8", format: "pem" }) as string;

  _setClientDiscoveryForTest((async (server: URL) => ({ issuer: server.href }) as unknown as Configuration) as never);

  _setBuildAuthorizationUrlForTest(((config: Configuration, params: Record<string, string>) => {
    const issuer = String((config as unknown as { issuer?: string }).issuer ?? "");
    const provider: Provider = issuer.includes("apple") ? "apple" : "google";
    return new URL(`http://127.0.0.1:${port}/authorize?provider=${provider}&${new URLSearchParams(params)}`);
  }) as never);

  _setAuthCodeGrantForTest((async (
    _config: Configuration,
    currentUrl: URL,
    checks: { expectedState?: string; expectedNonce?: string },
  ) => {
    const code = currentUrl.searchParams.get("code");
    if (!code) throw new Error("fake issuer: no code on the callback");
    const grant = decode(code);
    if (checks.expectedState !== undefined && grant.state !== checks.expectedState) throw new Error("fake issuer: state mismatch");
    if (checks.expectedNonce !== undefined && grant.nonce !== checks.expectedNonce) throw new Error("fake issuer: nonce mismatch");
    const claims = {
      sub: `${grant.provider}|${grant.email}`,
      email: grant.email,
      ...emailVerifiedClaim(grant),
      given_name: "Journey",
      family_name: grant.provider === "apple" ? "Apple" : "Google",
      nonce: grant.nonce,
    };
    return {
      access_token: "e2e-fake-access-token",
      token_type: "bearer",
      claims: () => claims,
    } as unknown as TokenEndpointResponse & TokenEndpointResponseHelpers;
  }) as never);

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      const provider = (url.searchParams.get("provider") === "apple" ? "apple" : "google") as Provider;
      if (req.method === "GET" && url.pathname === "/authorize") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(authorizePage(url.searchParams, provider));
        return;
      }
      if (req.method === "POST" && url.pathname === "/approve") {
        const form = await readForm(req);
        const redirectUri = form.get("redirect_uri") ?? "";
        const verified = form.get("verified");
        const grant: FakeGrant = {
          provider,
          email: (form.get("email") ?? "").trim(),
          verified: verified === "false" || verified === "absent" ? verified : "true",
          nonce: form.get("nonce") ?? "",
          state: form.get("state") ?? "",
        };
        const code = encode(grant);
        if (form.get("response_mode") === "form_post") {
          // Apple posts the authorization response to the callback.
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(
            `<!doctype html><html><body><form id="f" method="post" action="${escapeHtml(redirectUri)}">` +
              `<input type="hidden" name="code" value="${escapeHtml(code)}">` +
              `<input type="hidden" name="state" value="${escapeHtml(grant.state)}">` +
              `</form><script>document.getElementById("f").submit()</script></body></html>`,
          );
          return;
        }
        const target = new URL(redirectUri);
        target.searchParams.set("code", code);
        target.searchParams.set("state", grant.state);
        res.writeHead(302, { location: target.href }).end();
        return;
      }
      res.writeHead(404).end();
    } catch (err) {
      res.writeHead(500).end(String(err));
    }
  });
  server.listen(port, "127.0.0.1");
  return server;
}

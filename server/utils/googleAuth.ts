// Google Sign-In (Google Identity Services) ID token verification.
//
// No external dependencies: Google's JWKS is fetched over HTTPS, the RS256
// signature is verified locally with Node's crypto, and the standard claims
// are validated. Set GOOGLE_CLIENT_ID (the OAuth 2.0 Web Application client
// ID) to enable the feature; without it googleConfigured() is false and the
// endpoint returns 503 instead of accepting tokens.
import crypto from "crypto";

export type GoogleProfile = { email: string; name: string; sub: string };

const JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);
const FETCH_TIMEOUT_MS = 8000;

type JwksCache = { keys: crypto.JsonWebKey[]; expiresAt: number };
let jwksCache: JwksCache | null = null;

export function googleConfigured(): boolean {
  return Boolean(process.env.GOOGLE_CLIENT_ID);
}

async function fetchGoogleKeys(): Promise<crypto.JsonWebKey[]> {
  if (jwksCache && jwksCache.expiresAt > Date.now()) return jwksCache.keys;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(JWKS_URL, { signal: controller.signal });
    if (!res.ok) throw new Error(`Google returned HTTP ${res.status} for its signing keys`);
    const body: any = await res.json();
    if (!Array.isArray(body?.keys)) throw new Error("Google signing key set is malformed");
    const maxAge = /max-age=(\d+)/.exec(String(res.headers.get("cache-control") || ""));
    const ttlMs = Math.min((Number(maxAge?.[1] || 3600) || 3600) * 1000, 6 * 3600 * 1000);
    jwksCache = { keys: body.keys, expiresAt: Date.now() + ttlMs };
    return jwksCache.keys;
  } finally {
    clearTimeout(timer);
  }
}

const base64UrlToBuffer = (segment: string): Buffer =>
  Buffer.from(String(segment).replace(/-/g, "+").replace(/_/g, "/"), "base64");

export async function verifyGoogleIdToken(token: string): Promise<GoogleProfile> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) throw new Error("GOOGLE_CLIENT_ID is not configured");

  const parts = String(token || "").split(".");
  if (parts.length !== 3) throw new Error("Malformed credential");
  const [headerSeg, payloadSeg, signatureSeg] = parts;

  const header = JSON.parse(base64UrlToBuffer(headerSeg).toString("utf8"));
  if (header?.alg !== "RS256" || !header?.kid) throw new Error("Unexpected token header");

  const keys = await fetchGoogleKeys();
  const jwk = keys.find((k: any) => k.kid === header.kid);
  if (!jwk) throw new Error("No matching Google signing key (token may be stale; retry)");

  const verifier = crypto.createVerify("RSA-SHA256");
  verifier.update(`${headerSeg}.${payloadSeg}`);
  verifier.end();
  const valid = verifier.verify(
    { key: crypto.createPublicKey({ key: jwk, format: "jwk" } as any), padding: crypto.constants.RSA_PKCS1_PADDING },
    base64UrlToBuffer(signatureSeg)
  );
  if (!valid) throw new Error("Invalid token signature");

  const payload = JSON.parse(base64UrlToBuffer(payloadSeg).toString("utf8"));
  if (!ISSUERS.has(String(payload?.iss))) throw new Error("Unexpected token issuer");
  if (String(payload?.aud) !== clientId) throw new Error("Token was issued for a different application");
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Number(payload?.exp) <= nowSeconds) throw new Error("Token expired");
  if (!payload?.sub) throw new Error("Token carries no subject");
  const email = String(payload?.email || "").trim().toLowerCase();
  if (!email) throw new Error("Google account returned no email");
  if (payload?.email_verified === false) throw new Error("Google email is not verified");

  return { email, name: String(payload?.name || email).trim() || email, sub: String(payload.sub) };
}

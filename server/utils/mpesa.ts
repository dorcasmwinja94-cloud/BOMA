// M-Pesa (Safaricom Daraja) integration for STK Push payments.
// Enabled when MPESA_CONSUMER_KEY, MPESA_CONSUMER_SECRET, MPESA_SHORTCODE,
// MPESA_PASSKEY and MPESA_CALLBACK_URL are set. Without those the system never
// fabricates a payment — initiation is rejected honestly with 503.
export const MPESA_ENV = ["MPESA_CONSUMER_KEY", "MPESA_CONSUMER_SECRET", "MPESA_SHORTCODE", "MPESA_PASSKEY", "MPESA_CALLBACK_URL"];
export const MPESA_SANDBOX = process.env.MPESA_ENVIRONMENT !== "production"; // sandbox by default
const BASE = MPESA_SANDBOX ? "https://sandbox.safaricom.co.ke" : "https://api.safaricom.co.ke";

// Keep every Daraja call bounded. Without this a stalled upstream connection
// leaves the browser waiting until its own timeout and hides a real success.
const OAUTH_TIMEOUT_MS = 10_000;
const STK_TIMEOUT_MS = 20_000;

export function mpesaConfigured(): boolean {
  return MPESA_ENV.every((k) => Boolean(process.env[k]));
}

export function normalizeKenyanPhone(phone: string): string | null {
  const digits = String(phone || "").replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("254")) return digits;
  if (digits.length === 10 && (digits.startsWith("07") || digits.startsWith("01"))) return "254" + digits.slice(1);
  if (digits.length === 9 && (digits.startsWith("7") || digits.startsWith("1"))) return "254" + digits;
  return null;
}

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = STK_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Daraja access tokens are valid for an hour. Reusing one removes an OAuth
// round-trip from every STK request and makes the guest-facing response faster.
let tokenCache: { token: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache.token;
  const key = process.env.MPESA_CONSUMER_KEY!;
  const secret = process.env.MPESA_CONSUMER_SECRET!;
  const basic = Buffer.from(`${key}:${secret}`).toString("base64");
  const res = await fetchWithTimeout(`${BASE}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${basic}` },
  }, OAUTH_TIMEOUT_MS);
  const body = (await res.json()) as any;
  if (!res.ok || !body?.access_token) throw new Error(`Daraja OAuth failed (${res.status}): ${body?.errorMessage || body?.error_description || JSON.stringify(body).slice(0, 200)}`);
  const token = String(body.access_token);
  const ttlSeconds = Math.max(120, Number(body.expires_in) || 3599);
  tokenCache = { token, expiresAt: Date.now() + (ttlSeconds - 120) * 1000 };
  return token;
}

export type StkResult = { checkoutRequestId: string; merchantRequestId: string; responseCode: string; customerMessage: string };

// Daraja expects the password timestamp in East Africa Time (UTC+3), not UTC.
function nairobiTimestamp(date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Nairobi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value || "00";
  return `${get("year")}${get("month")}${get("day")}${get("hour")}${get("minute")}${get("second")}`;
}

export async function stkPush(input: { phone: string; amount: number; accountReference: string; description: string }): Promise<StkResult> {
  const token = await getAccessToken();
  const shortcode = process.env.MPESA_SHORTCODE!;
  const passkey = process.env.MPESA_PASSKEY!;
  const timestamp = nairobiTimestamp();
  const password = Buffer.from(`${shortcode}${passkey}${timestamp}`).toString("base64");
  const amount = Math.max(1, Math.round(Number(input.amount) || 0));
  // Paybill (default) uses CustomerPayBillOnline; a Buy Goods Till uses
  // CustomerBuyGoodsOnline with the till number in PartyB.
  const transactionType = process.env.MPESA_TRANSACTION_TYPE === "CustomerBuyGoodsOnline"
    ? "CustomerBuyGoodsOnline"
    : "CustomerPayBillOnline";
  const res = await fetchWithTimeout(`${BASE}/mpesa/stkpush/v1/processrequest`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      BusinessShortCode: shortcode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: transactionType,
      Amount: amount,
      PartyA: input.phone,
      PartyB: shortcode,
      PhoneNumber: input.phone,
      CallBackURL: process.env.MPESA_CALLBACK_URL,
      AccountReference: input.accountReference.slice(0, 12),
      TransactionDesc: input.description.slice(0, 13),
    }),
  }, STK_TIMEOUT_MS);
  const body = (await res.json()) as any;
  if (!res.ok || String(body?.ResponseCode) !== "0") {
    throw new Error(`STK push failed (${res.status}): ${body?.errorMessage || body?.ResponseDescription || body?.CustomerMessage || JSON.stringify(body).slice(0, 300)}`);
  }
  return {
    checkoutRequestId: String(body.CheckoutRequestID),
    merchantRequestId: String(body.MerchantRequestID),
    responseCode: String(body.ResponseCode),
    customerMessage: String(body.CustomerMessage || "Check your phone to enter your M-Pesa PIN."),
  };
}

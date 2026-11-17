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
// Queries are a recovery path, not the guest-facing initiation. A shorter bound
// keeps a stalled sandbox/host from blocking the next pending payment.
const QUERY_TIMEOUT_MS = 10_000;

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

export type StkQueryResult =
  | { state: "SUCCESS"; resultCode: string; resultDesc: string; receipt: string; amount?: number; phone?: string }
  | { state: "FAILED"; resultCode: string; resultDesc: string }
  | { state: "PENDING"; resultCode: string; resultDesc: string };

// Daraja's STK Push Query endpoint. This is how a payment is recovered when the
// callback never arrives (tunnel restarted, network flap, phone lost signal).
// It is read-only: nothing is marked paid unless Safaricom returns a receipt.
export async function stkQuery(checkoutRequestId: string): Promise<StkQueryResult> {
  const token = await getAccessToken();
  const shortcode = process.env.MPESA_SHORTCODE!;
  const passkey = process.env.MPESA_PASSKEY!;
  const timestamp = nairobiTimestamp();
  const password = Buffer.from(`${shortcode}${passkey}${timestamp}`).toString("base64");
  const res = await fetchWithTimeout(`${BASE}/mpesa/stkpushquery/v1/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      BusinessShortCode: shortcode,
      Password: password,
      Timestamp: timestamp,
      CheckoutRequestID: checkoutRequestId,
    }),
  }, QUERY_TIMEOUT_MS);

  let body: any = {};
  try {
    body = await res.json();
  } catch {
    body = {};
  }

  // While the customer has not answered the prompt Daraja reports
  // 500.001.1001 "The transaction is being processed". That is not a failure.
  const processing = String(body?.errorCode || "") === "500.001.1001"
    || /transaction is being processed/i.test(String(body?.errorMessage || body?.ResultDesc || ""));
  if (processing) {
    return { state: "PENDING", resultCode: "", resultDesc: "The transaction is being processed" };
  }

  if (!res.ok) {
    throw new Error(`STK query failed (${res.status}): ${body?.errorMessage || body?.ResultDesc || JSON.stringify(body).slice(0, 300)}`);
  }

  const items: any[] = body?.CallbackMetadata?.Item || [];
  const meta = (name: string) => items.find((item: any) => item?.Name === name)?.Value;
  const resultCode = String(body?.ResultCode ?? "");
  const resultDesc = String(body?.ResultDesc || body?.ResponseDescription || "");
  const receipt = String(meta("MpesaReceiptNumber") || "").trim();
  const paidAmount = Number(meta("Amount"));
  const phone = meta("PhoneNumber") ? String(meta("PhoneNumber")) : undefined;

  // 4999 / "still under processing" is an in-flight state, not a failure.
  if (resultCode === "4999" || /still under processing|being processed/i.test(resultDesc)) {
    return { state: "PENDING", resultCode, resultDesc };
  }

  if (resultCode === "0") {
    if (receipt) {
      return {
        state: "SUCCESS",
        resultCode,
        resultDesc,
        receipt,
        amount: Number.isFinite(paidAmount) ? paidAmount : undefined,
        phone,
      };
    }
    // A "success" response without a receipt is not proof of payment.
    return { state: "PENDING", resultCode, resultDesc: resultDesc || "Awaiting receipt" };
  }

  // Only classify codes known to be final as failures. An unknown code could
  // still be in flight, and wrongly failing a paid guest is worse than waiting
  // for the callback (or the next query).
  const terminalCodes = new Set(["1", "1001", "1019", "1032", "1037", "2001"]);
  if (terminalCodes.has(resultCode)) return { state: "FAILED", resultCode, resultDesc };
  return { state: "PENDING", resultCode, resultDesc };
}

// Used by `npm run check:payments` to verify credentials without charging anyone.
export async function verifyDarajaConnection(): Promise<{ mode: "sandbox" | "production"; shortcode: string; callbackUrl: string }> {
  if (!mpesaConfigured()) {
    throw new Error(`Missing M-Pesa environment variables: ${MPESA_ENV.filter((key) => !process.env[key]).join(", ")}`);
  }
  await getAccessToken();
  return {
    mode: MPESA_SANDBOX ? "sandbox" : "production",
    shortcode: String(process.env.MPESA_SHORTCODE || ""),
    callbackUrl: String(process.env.MPESA_CALLBACK_URL || ""),
  };
}

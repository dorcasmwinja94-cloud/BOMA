// Africa's Talking SMS delivery. Configure AT_API_KEY, AT_USERNAME and
// AT_SENDER_ID for production. Without credentials every message is logged
// to the server console instead of being dropped silently.
export type SmsResult = { mode: "live" | "log"; ok: boolean; detail?: string };

const ENDPOINT = "https://api.africastalking.com/version1/messaging";

export function smsConfigured(): boolean {
  return Boolean(process.env.AT_API_KEY && process.env.AT_USERNAME);
}

export async function sendSms(to: string, message: string): Promise<SmsResult> {
  const apiKey = process.env.AT_API_KEY || "";
  const username = process.env.AT_USERNAME || "";
  const from = process.env.AT_SENDER_ID || undefined;
  if (!smsConfigured()) {
    console.log(`[sms:log] To: ${to}\n${message}\n`);
    return { mode: "log", ok: true };
  }
  try {
    const body = new URLSearchParams({ username, to, message });
    if (from) body.set("from", from);
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { apiKey, Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const text = await res.text();
    let parsed: any = null;
    try { parsed = JSON.parse(text); } catch { /* keep raw text */ }
    const ok = res.ok && parsed?.SMSMessageData?.Recipients?.every((r: any) => r.status === "Success") !== false;
    return { mode: "live", ok: Boolean(ok), detail: text.slice(0, 300) };
  } catch (e) {
    return { mode: "live", ok: false, detail: (e as Error)?.message || String(e) };
  }
}

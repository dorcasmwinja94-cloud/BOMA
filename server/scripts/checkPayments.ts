// Verifies the M-Pesa production/sandbox setup without initiating a charge.
//
//   npm run check:payments
//
// It checks: required variables, callback URL shape, Daraja OAuth credentials,
// and whether the public callback origin is reachable from this machine.
import { loadEnv } from "../utils/loadEnv";

async function probeCallback(callbackUrl: string): Promise<boolean> {
  const origin = new URL(callbackUrl).origin;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(`${origin}/health/live`, { signal: controller.signal });
    const text = await res.text();
    console.log(`  ${origin}/health/live -> ${res.status} ${text.slice(0, 100)}`);
    return res.ok;
  } catch (e) {
    console.warn(`  ${origin}/health/live unreachable: ${(e as Error)?.message || e}`);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  loadEnv();
  // Load after .env so the module-level sandbox/base selection is correct.
  const mpesa = require("../utils/mpesa") as typeof import("../utils/mpesa");

  const callbackUrl = String(process.env.MPESA_CALLBACK_URL || "");
  const shortcode = String(process.env.MPESA_SHORTCODE || "");
  const mode = mpesa.MPESA_SANDBOX ? "sandbox" : "production";
  const missing = mpesa.MPESA_ENV.filter((key) => !process.env[key]);

  console.log("Boma M-Pesa setup check\n");
  console.log(`  mode:       ${mode}`);
  console.log(`  shortcode:  ${shortcode || "(missing)"}`);
  console.log(`  callback:   ${callbackUrl || "(missing)"}`);
  console.log(`  deposit:    ${String(process.env.MPESA_DEPOSIT_PERCENT || "100")}%`);
  console.log(`  txn type:   ${process.env.MPESA_TRANSACTION_TYPE || "CustomerPayBillOnline"}`);

  if (missing.length) {
    console.error(`\nFAILED — missing: ${missing.join(", ")}`);
    process.exitCode = 1;
    return;
  }

  try {
    const url = new URL(callbackUrl);
    if (url.protocol !== "https:") throw new Error("callback URL must use HTTPS");
    if (["localhost", "127.0.0.1", "::1"].includes(url.hostname)) {
      throw new Error("callback URL must be publicly reachable, not localhost");
    }
  } catch (e) {
    console.error(`\nFAILED — ${(e as Error)?.message || e}`);
    process.exitCode = 1;
    return;
  }

  if (callbackUrl.includes("trycloudflare.com")) {
    console.warn("\nWARNING — trycloudflare.com URLs change and expire when the tunnel restarts.");
    console.warn("          Use a stable HTTPS domain before taking real payments.");
  }

  console.log("\nChecking Daraja OAuth credentials...");
  try {
    const info = await mpesa.verifyDarajaConnection();
    console.log(`OK — authenticated to Daraja ${info.mode} (shortcode ${info.shortcode}).`);
  } catch (e) {
    console.error(`FAILED — ${(e as Error)?.message || e}`);
    process.exitCode = 1;
    return;
  }

  console.log("\nChecking public callback reachability...");
  const reachable = await probeCallback(callbackUrl);
  if (!reachable) {
    console.warn("WARNING — Safaricom must be able to POST to the callback URL over the public internet.");
  }

  console.log("\nSetup checks complete. Next: make a KES 1 payment and confirm it reaches COMPLETED.");
}

main().catch((e) => {
  console.error("FAILED —", e?.message || e);
  process.exitCode = 1;
});

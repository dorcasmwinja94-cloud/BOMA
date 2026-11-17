// Runtime configuration guardrails.
//
// Production must never start with the development JWT secret or with a partial
// payment configuration. Failing loudly at startup is far safer than signing
// tokens with a guessable value or accepting bookings that can never be paid.
const MIN_JWT_SECRET_LENGTH = 32;
const MIN_CRON_SECRET_LENGTH = 16;
const MPESA_KEYS = [
  "MPESA_CONSUMER_KEY",
  "MPESA_CONSUMER_SECRET",
  "MPESA_SHORTCODE",
  "MPESA_PASSKEY",
  "MPESA_CALLBACK_URL",
];

export function isProductionRuntime(): boolean {
  return (
    process.env.NODE_ENV === "production" ||
    process.env.VERCEL === "1" ||
    process.argv.includes("--prod")
  );
}

// Stricter than isProductionRuntime(): `npm start --prod` locally is a
// production *build* served from localhost, so it should not demand an https
// CLIENT_URL. A real deployment is identified by NODE_ENV or Vercel itself.
export function isDeployedProduction(): boolean {
  return process.env.NODE_ENV === "production" || process.env.VERCEL === "1";
}

let cachedJwtSecret: string | null = null;

// Resolved lazily so the .env loader has already run when this is first called.
export function getJwtSecret(): string {
  if (cachedJwtSecret) return cachedJwtSecret;

  const configured = String(process.env.JWT_SECRET || "").trim();
  const weak =
    !configured ||
    configured === "secret" ||
    configured === "change-me-to-a-long-random-string" ||
    configured.length < MIN_JWT_SECRET_LENGTH;

  if (weak) {
    if (isDeployedProduction()) {
      throw new Error(
        `JWT_SECRET is missing or too weak. Set a random value of at least ${MIN_JWT_SECRET_LENGTH} characters ` +
          `(node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))").`
      );
    }
    // Local development convenience only. The warning makes the risk visible.
    cachedJwtSecret = configured || "boma-development-only-insecure-secret";
    console.warn("[config] JWT_SECRET is missing or weak — using an insecure development secret.");
    return cachedJwtSecret;
  }

  cachedJwtSecret = configured;
  return cachedJwtSecret;
}

function validHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

// Throws a single, readable error listing every configuration problem. Callers
// decide whether that is fatal (production) or only a warning (local tooling).
export function assertRuntimeConfig(): void {
  const problems: string[] = [];
  const deployed = isDeployedProduction();

  if (!process.env.DATABASE_URL) {
    if (deployed) problems.push("DATABASE_URL is not set.");
    else console.warn("[config] DATABASE_URL is not set — the API will start in degraded mode.");
  }

  try {
    getJwtSecret();
  } catch (e) {
    problems.push((e as Error).message);
  }

  const clientUrl = String(process.env.CLIENT_URL || "").trim();
  if (deployed) {
    if (!clientUrl) {
      problems.push("CLIENT_URL is not set (needed for CORS, confirmation emails and reset links).");
    } else if (!validHttpsUrl(clientUrl.split(",")[0].trim())) {
      problems.push("CLIENT_URL must be an https URL in production.");
    }
  }

  const cronSecret = String(process.env.CRON_SECRET || "");
  if (!cronSecret) {
    console.warn("[config] CRON_SECRET is not set — /api/cron/* is disabled (no reminders or payment recovery).");
  } else if (cronSecret.length < MIN_CRON_SECRET_LENGTH) {
    const message = `CRON_SECRET must be at least ${MIN_CRON_SECRET_LENGTH} characters.`;
    if (deployed) problems.push(message);
    else console.warn(`[config] ${message}`);
  }

  // Either all M-Pesa variables are present or none are. A partial set is a
  // deployment mistake that would otherwise fail only when a guest pays.
  const present = MPESA_KEYS.filter((key) => Boolean(process.env[key]));
  if (present.length > 0 && present.length < MPESA_KEYS.length) {
    const missing = MPESA_KEYS.filter((key) => !process.env[key]);
    problems.push(`M-Pesa is partially configured — missing: ${missing.join(", ")}.`);
  }

  if (present.length === MPESA_KEYS.length) {
    const callbackUrl = String(process.env.MPESA_CALLBACK_URL || "");
    if (!validHttpsUrl(callbackUrl)) {
      problems.push("MPESA_CALLBACK_URL must be a valid https URL.");
    } else if (callbackUrl.includes("trycloudflare.com") || callbackUrl.includes("ngrok")) {
      const message = "MPESA_CALLBACK_URL uses a temporary tunnel — use a stable HTTPS domain in production.";
      if (deployed) problems.push(message);
      else console.warn(`[config] ${message}`);
    }
  }

  if (problems.length > 0) {
    throw new Error(`Invalid runtime configuration:\n - ${problems.join("\n - ")}`);
  }
}

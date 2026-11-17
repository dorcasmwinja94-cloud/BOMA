// Loads .env for local processes (server, seed, setup checks).
//
// Hosting platforms inject environment variables directly, so this file is only
// imported by the long-running local server and by CLI scripts — never by the
// Vercel function entry point. Existing environment variables always win, so a
// stale local .env can never override a platform-provided secret.
import fs from "fs";
import path from "path";

export function loadEnv(file = path.join(process.cwd(), ".env")): void {
  if (!fs.existsSync(file)) return;

  if (typeof (process as any).loadEnvFile === "function") {
    try {
      (process as any).loadEnvFile(file);
      return;
    } catch {
      // Fall through to the small parser below.
    }
  }

  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[match[1]] === undefined) process.env[match[1]] = value;
  }
}

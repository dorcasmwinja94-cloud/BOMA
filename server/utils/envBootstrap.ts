// Imported first by the local server so .env values exist before modules such as
// utils/mpesa.ts read process.env at module scope. Vercel never imports this:
// platform environment variables are already present.
import { loadEnv } from "./loadEnv";

loadEnv();

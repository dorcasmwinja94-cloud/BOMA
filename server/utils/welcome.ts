// Welcome messages for new Boma accounts (form registration and Google
// sign-in). Delivery failures are logged, never fatal — a registration must
// not fail because a mail or SMS provider hiccuped. Without SMTP/AT
// credentials both channels run in log mode and the message appears in the
// server console instead.
import { sendMail, welcomeEmail } from "./mailer";
import { sendSms } from "./africastalking";
import { normalizeKenyanPhone } from "./mpesa";

const SITE_URL = String(process.env.CLIENT_URL || "https://boma-reservations.vercel.app").split(",")[0].trim();

export async function sendWelcomeMessage(input: {
  name: string;
  email: string;
  phoneNumber?: string | null;
}): Promise<void> {
  const name = String(input.name || "guest").trim() || "guest";

  try {
    const mail = welcomeEmail({ name, email: input.email });
    await sendMail({ to: input.email, ...mail });
  } catch (e) {
    console.warn("[welcome] email failed:", (e as Error)?.message || e);
  }

  const phone = normalizeKenyanPhone(String(input.phoneNumber || ""));
  if (!phone) return;
  try {
    await sendSms(
      phone,
      `Boma: welcome ${name}! Your account is ready. Book stays, tours and transfers at ${SITE_URL}. Free cancellation up to 48h before check-in.`
    );
  } catch (e) {
    console.warn("[welcome] sms failed:", (e as Error)?.message || e);
  }
}

import { NextResponse } from "next/server";
import Twilio from "twilio";

export const runtime = "nodejs";
const RESEND_COOLDOWN_MS = 60_000;
const lastOtpSentAtByPhone = new Map<string, number>();

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing ${name} in server environment. Ensure frontend/.env.local exists and restart \`npm run dev\` from c:\\KYC\\frontend.`,
    );
  }
  return value;
}

function normalizeToE164India(raw: string): string {
  const digits = raw.replace(/[^\d]/g, "");
  if (digits.length === 10) return `+91${digits}`;
  if (digits.startsWith("91") && digits.length === 12) return `+${digits}`;
  if (raw.trim().startsWith("+")) return raw.trim();
  throw new Error("Invalid phone number.");
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { phone?: string };
    if (!body.phone) {
      return NextResponse.json({ ok: false, message: "Missing phone" }, { status: 400 });
    }

    const to = normalizeToE164India(body.phone);
    const now = Date.now();
    const lastSentAt = lastOtpSentAtByPhone.get(to) ?? 0;
    const elapsed = now - lastSentAt;
    if (elapsed < RESEND_COOLDOWN_MS) {
      const retryAfterSec = Math.ceil((RESEND_COOLDOWN_MS - elapsed) / 1000);
      return NextResponse.json(
        {
          ok: false,
          message: `Please wait ${retryAfterSec}s before requesting another OTP.`,
          retryAfterSec,
        },
        { status: 429 },
      );
    }

    const client = Twilio(
      requiredEnv("TWILIO_ACCOUNT_SID"),
      requiredEnv("TWILIO_AUTH_TOKEN"),
    );

    const serviceSid = requiredEnv("TWILIO_SERVICE_SID");

    const verification = await client.verify.v2
      .services(serviceSid)
      .verifications.create({ to, channel: "sms" });
    lastOtpSentAtByPhone.set(to, now);

    return NextResponse.json({
      ok: true,
      to,
      status: verification.status,
      retryAfterSec: 60,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to send OTP";
    return NextResponse.json({ ok: false, message }, { status: 500 });
  }
}


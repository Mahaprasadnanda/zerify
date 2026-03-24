import { NextResponse } from "next/server";
import Twilio from "twilio";

export const runtime = "nodejs";

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
    const body = (await req.json()) as { phone?: string; code?: string };
    if (!body.phone || !body.code) {
      return NextResponse.json({ ok: false, message: "Missing phone or code" }, { status: 400 });
    }

    const to = normalizeToE164India(body.phone);
    const code = String(body.code).trim();
    if (!/^\d{4,10}$/.test(code)) {
      return NextResponse.json({ ok: false, message: "Invalid code format" }, { status: 400 });
    }

    const client = Twilio(
      requiredEnv("TWILIO_ACCOUNT_SID"),
      requiredEnv("TWILIO_AUTH_TOKEN"),
    );
    const serviceSid = requiredEnv("TWILIO_SERVICE_SID");

    const check = await client.verify.v2
      .services(serviceSid)
      .verificationChecks.create({ to, code });

    const approved = check.status === "approved";

    return NextResponse.json({
      ok: approved,
      to,
      status: check.status,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to verify OTP";
    return NextResponse.json({ ok: false, message }, { status: 500 });
  }
}


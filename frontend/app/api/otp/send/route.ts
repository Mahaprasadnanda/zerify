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

function formatTwilioError(e: unknown): {
  message: string;
  status?: number;
  code?: number | string;
  moreInfo?: string;
  details?: unknown;
} {
  if (e && typeof e === "object") {
    const anyE = e as {
      message?: unknown;
      status?: unknown;
      code?: unknown;
      moreInfo?: unknown;
      details?: unknown;
      more_info?: unknown;
    };
    const message = typeof anyE.message === "string" ? anyE.message : "Twilio request failed";
    const status = typeof anyE.status === "number" ? anyE.status : undefined;
    const code =
      typeof anyE.code === "number" || typeof anyE.code === "string" ? anyE.code : undefined;
    const moreInfo =
      typeof anyE.moreInfo === "string"
        ? anyE.moreInfo
        : typeof anyE.more_info === "string"
          ? anyE.more_info
          : undefined;
    return { message, status, code, moreInfo, details: anyE.details };
  }
  return { message: e instanceof Error ? e.message : "Twilio request failed" };
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
    const err = formatTwilioError(e);
    // Server-side log for debugging (no sensitive data like auth token is included).
    console.error("Twilio OTP send failed", err);
    return NextResponse.json(
      {
        ok: false,
        message: err.message,
        twilio: {
          status: err.status,
          code: err.code,
          moreInfo: err.moreInfo,
          details: err.details,
        },
      },
      { status: 500 },
    );
  }
}


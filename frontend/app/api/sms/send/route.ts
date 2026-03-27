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
    const body = (await req.json()) as { phones?: string[]; requestId?: string };
    const phones = Array.isArray(body.phones) ? body.phones : [];
    const requestId = String(body.requestId || "").trim();
    if (!requestId) {
      return NextResponse.json({ ok: false, message: "Missing requestId" }, { status: 400 });
    }
    if (phones.length === 0) {
      return NextResponse.json({ ok: false, message: "Missing phones" }, { status: 400 });
    }

    const client = Twilio(requiredEnv("TWILIO_ACCOUNT_SID"), requiredEnv("TWILIO_AUTH_TOKEN"));
    const from = process.env.TWILIO_SMS_FROM?.trim();
    const messagingServiceSid = process.env.TWILIO_SMS_MESSAGING_SERVICE_SID?.trim();
    if (!from && !messagingServiceSid) {
      throw new Error("Missing TWILIO_SMS_FROM or TWILIO_SMS_MESSAGING_SERVICE_SID");
    }

    const text =
      `You have a KYC request received. Please visit the Zerifyy site to complete KYC.` +
      ` Request ID: ${requestId}`;

    const normalized = phones.map((p) => normalizeToE164India(p));
    const results = await Promise.allSettled(
      normalized.map((to) =>
        client.messages.create(
          messagingServiceSid
            ? { to, messagingServiceSid, body: text }
            : { to, from: from!, body: text },
        ),
      ),
    );

    const sent: string[] = [];
    const failed: Array<{ to: string; error: string }> = [];
    for (let i = 0; i < results.length; i++) {
      const to = normalized[i]!;
      const r = results[i]!;
      if (r.status === "fulfilled") sent.push(to);
      else failed.push({ to, error: r.reason instanceof Error ? r.reason.message : String(r.reason) });
    }

    return NextResponse.json({
      ok: failed.length === 0,
      requestId,
      sentCount: sent.length,
      failed,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to send SMS";
    return NextResponse.json({ ok: false, message }, { status: 500 });
  }
}


import { NextResponse } from "next/server";

export const runtime = "nodejs";

function present(name: string): boolean {
  return Boolean(process.env[name] && String(process.env[name]).length > 0);
}

export async function GET() {
  const keys = ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_SERVICE_SID"];
  return NextResponse.json({
    cwd: process.cwd(),
    envPresent: Object.fromEntries(keys.map((k) => [k, present(k)])),
  });
}


export async function sendOtp(
  phone: string,
): Promise<{ ok: boolean; message?: string; retryAfterSec?: number }> {
  const res = await fetch("/api/otp/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone }),
  });
  const data = (await res.json()) as { ok?: boolean; message?: string; retryAfterSec?: number };
  if (!res.ok) return { ok: false, message: data.message ?? "Failed to send OTP", retryAfterSec: data.retryAfterSec };
  return { ok: Boolean(data.ok), message: data.message, retryAfterSec: data.retryAfterSec };
}

export async function verifyOtp(
  phone: string,
  code: string,
): Promise<{ ok: boolean; message?: string }> {
  const res = await fetch("/api/otp/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone, code }),
  });
  const data = (await res.json()) as { ok?: boolean; message?: string; status?: string };
  if (!res.ok) return { ok: false, message: data.message ?? "Failed to verify OTP" };
  if (!data.ok) return { ok: false, message: data.message ?? "Incorrect OTP" };
  return { ok: true };
}


import { get, ref, update } from "firebase/database";
import { firebaseDb } from "@/lib/firebaseClient";

type RecipientProfile = {
  phoneE164?: string;
  phoneDigits?: string;
  authUid?: string;
  selfRegisteredAt?: number;
  updatedAt?: number;
};

function phoneDigits(phoneE164: string): string {
  return phoneE164.replace(/\D/g, "");
}

function recipientProfileRef(phoneE164: string) {
  return ref(firebaseDb, `recipientProfiles/${phoneDigits(phoneE164)}`);
}

export async function registerUser(phone: string, authUid: string): Promise<{
  ok: boolean;
  phone?: string;
  registeredAt?: number;
  message?: string;
}> {
  const registeredAt = Date.now();
  try {
    await update(recipientProfileRef(phone), {
      phoneE164: phone,
      phoneDigits: phoneDigits(phone),
      authUid,
      selfRegisteredAt: registeredAt,
      updatedAt: registeredAt,
    });
    return {
      ok: true,
      phone,
      registeredAt,
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Could not save registration right now.",
    };
  }
}

export async function isRegisteredUser(phone: string, authUid: string): Promise<{
  ok: boolean;
  phone?: string;
  registered: boolean;
  message?: string;
}> {
  try {
    const snapshot = await get(recipientProfileRef(phone));
    const profile = snapshot.val() as RecipientProfile | null;
    const registered = Boolean(profile?.selfRegisteredAt && profile.authUid === authUid);
    return { ok: true, phone, registered };
  } catch (error) {
    return {
      ok: false,
      registered: false,
      message: error instanceof Error ? error.message : "Could not verify registration right now.",
    };
  }
}

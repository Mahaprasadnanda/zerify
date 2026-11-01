import { get, ref, runTransaction } from "firebase/database";
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
    const result = await runTransaction(
      recipientProfileRef(phone),
      (current: RecipientProfile | null) => {
        if (current?.authUid && current.authUid !== authUid) return;
        return {
          ...(current ?? {}),
          phoneE164: phone,
          phoneDigits: phoneDigits(phone),
          authUid,
          selfRegisteredAt: current?.selfRegisteredAt ?? registeredAt,
          updatedAt: registeredAt,
        };
      },
      { applyLocally: false },
    );
    if (!result.committed) {
      return { ok: false, message: "An account is already linked to this number. Please login instead." };
    }
    return {
      ok: true,
      phone,
      registeredAt: result.snapshot.child("selfRegisteredAt").val() ?? registeredAt,
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

import { get, ref, update } from "firebase/database";
import { signInAnonymously, signOut } from "firebase/auth";
import { firebaseAuth, firebaseAuthPersistenceReady, firebaseDb } from "@/lib/firebaseClient";

type RecipientProfile = {
  phoneE164?: string;
  phoneDigits?: string;
  selfRegisteredAt?: number;
  updatedAt?: number;
};

function phoneDigits(phoneE164: string): string {
  return phoneE164.replace(/\D/g, "");
}

function recipientProfileRef(phoneE164: string) {
  return ref(firebaseDb, `recipientProfiles/${phoneDigits(phoneE164)}`);
}

async function ensureWritableSession(): Promise<() => Promise<void>> {
  await firebaseAuthPersistenceReady;

  if (firebaseAuth.currentUser && !firebaseAuth.currentUser.isAnonymous) {
    return async () => {};
  }

  if (!firebaseAuth.currentUser) {
    await signInAnonymously(firebaseAuth);
  }

  return async () => {
    if (firebaseAuth.currentUser?.isAnonymous) {
      await signOut(firebaseAuth);
    }
  };
}

async function readRecipientProfile(phoneE164: string): Promise<RecipientProfile> {
  const snapshot = await get(recipientProfileRef(phoneE164));
  const value = snapshot.val();
  return value && typeof value === "object" ? (value as RecipientProfile) : {};
}

export async function registerUser(phone: string): Promise<{
  ok: boolean;
  phone?: string;
  registeredAt?: number;
  message?: string;
}> {
  const registeredAt = Date.now();
  const cleanup = await ensureWritableSession();

  try {
    await update(recipientProfileRef(phone), {
      phoneE164: phone,
      phoneDigits: phoneDigits(phone),
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
  } finally {
    await cleanup();
  }
}

export async function isRegisteredUser(phone: string): Promise<{
  ok: boolean;
  phone?: string;
  registered: boolean;
  message?: string;
}> {
  try {
    const profile = await readRecipientProfile(phone);
    return {
      ok: true,
      phone,
      registered: Boolean(profile.selfRegisteredAt),
    };
  } catch (error) {
    return {
      ok: false,
      registered: false,
      message: error instanceof Error ? error.message : "Could not verify registration right now.",
    };
  }
}

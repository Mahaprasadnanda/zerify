import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  updateProfile,
} from "firebase/auth";
import { firebaseAuth, firebaseAuthPersistenceReady } from "@/lib/firebaseClient";
import { registerUser, isRegisteredUser } from "@/lib/userRegistry";

function phoneAccountEmail(phoneE164: string): string {
  const digits = phoneE164.replace(/\D/g, "");
  return `prover-${digits}@accounts.zerify.invalid`;
}

export async function registerProver(phone: string, password: string): Promise<string> {
  await firebaseAuthPersistenceReady;
  const credential = await createUserWithEmailAndPassword(
    firebaseAuth,
    phoneAccountEmail(phone),
    password,
  );
  try {
    await updateProfile(credential.user, { displayName: phone });
    const result = await registerUser(phone, credential.user.uid);
    if (!result.ok) throw new Error(result.message ?? "Could not save your prover profile.");
    return phone;
  } catch (error) {
    await signOut(firebaseAuth);
    throw error;
  }
}

export async function loginProver(phone: string, password: string): Promise<string> {
  await firebaseAuthPersistenceReady;
  const credential = await signInWithEmailAndPassword(
    firebaseAuth,
    phoneAccountEmail(phone),
    password,
  );
  const profile = await isRegisteredUser(phone, credential.user.uid);
  if (!profile.ok || !profile.registered) {
    await signOut(firebaseAuth);
    throw new Error("This prover account is not registered. Please create an account first.");
  }
  return phone;
}

export async function logoutProver(): Promise<void> {
  await signOut(firebaseAuth);
}

import { initializeApp, getApps } from "firebase/app";
import { getAuth, setPersistence, browserSessionPersistence } from "firebase/auth";
import { getDatabase } from "firebase/database";

// Firebase web client configuration (provided by user).
// For production, move these values to env vars.
const firebaseConfig = {
  apiKey: "AIzaSyBfv2h_fEn6uAfI_TgjILorLODiBbA5zjQ",
  authDomain: "zerify-a8c25.firebaseapp.com",
  projectId: "zerify-a8c25",
  storageBucket: "zerify-a8c25.firebasestorage.app",
  messagingSenderId: "371236713961",
  appId: "1:371236713961:web:d0cbcbe3cfa82e2fb78778",
  measurementId: "G-HZ2DJZ2YDX",
  // RTDB is hosted in Singapore; use the regional endpoint.
  databaseURL: "https://zerify-a8c25-default-rtdb.asia-southeast1.firebasedatabase.app",
};

export const firebaseApp =
  getApps().length > 0 ? getApps()[0]! : initializeApp(firebaseConfig);

/** Verifier auth: session-only — survives tab refresh but not a full browser quit (no “remember forever”). */
export const firebaseAuth = getAuth(firebaseApp);

/**
 * Call and await this before any auth listener or sign-in so persistence is applied first.
 * (Firebase recommends setPersistence before onAuthStateChanged / signIn.)
 */
export const firebaseAuthPersistenceReady: Promise<void> =
  typeof window !== "undefined"
    ? setPersistence(firebaseAuth, browserSessionPersistence)
    : Promise.resolve();

export const firebaseDb = getDatabase(firebaseApp);


/**
 * Map Aadhaar / UIDAI and UI constraint strings to a single token for comparison.
 * Aadhaar QR often uses single-letter codes: M, F, O (or T for third gender in some payloads).
 */
export type CanonicalGender = "male" | "female" | "other";

export function canonicalGender(raw: string | undefined | null): CanonicalGender | null {
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase();
  if (!s) return null;

  if (s === "m" || s === "male" || s === "man") return "male";
  if (s === "f" || s === "female" || s === "woman") return "female";
  if (
    s === "o" ||
    s === "other" ||
    s === "transgender" ||
    s === "trans" ||
    s === "t" ||
    s === "third gender" ||
    s === "third_gender"
  ) {
    return "other";
  }

  if (s.startsWith("male")) return "male";
  if (s.startsWith("fem")) return "female";

  return null;
}

export function gendersMatch(fromAadhaar: string, requiredFromVerifier: string): boolean {
  const a = canonicalGender(fromAadhaar);
  const b = canonicalGender(requiredFromVerifier);
  if (a === null || b === null) return false;
  return a === b;
}

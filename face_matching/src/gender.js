export function canonicalGender(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (!s) return "";
  if (["m", "male", "man", "boy"].includes(s)) return "male";
  if (["f", "female", "woman", "girl"].includes(s)) return "female";
  if (["t", "transgender", "other", "o", "x"].includes(s)) return "other";
  return "";
}

export function gendersMatch(aadhaarRaw, requiredLabel) {
  const aadhaar = canonicalGender(aadhaarRaw);
  const req = canonicalGender(requiredLabel);
  return aadhaar !== "" && req !== "" && aadhaar === req;
}

export function aadhaarGenderToCircuitCode(raw) {
  const g = canonicalGender(raw);
  if (g === "male") return 1;
  if (g === "female") return 2;
  if (g === "other") return 3;
  return 0;
}

export function requiredGenderToCircuitCode(label) {
  if (label === "Male") return 1;
  if (label === "Female") return 2;
  if (label === "Other") return 3;
  return 0;
}

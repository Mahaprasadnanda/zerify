import { inflate } from "pako";
import { UIDAI_CERT } from "./uidaiCert.js";

const DELIMITER = 0xff;
const SIGNATURE_LENGTH = 256;
const HASH_LENGTH = 32;
const TEXT_FIELD_COUNT = 17;
const latin1Decoder = new TextDecoder("iso-8859-1");
let publicKeyPromise = null;

export function normalizeSecureQrPayload(raw) {
  const compact = String(raw || "")
    .trim()
    .replace(/^\uFEFF/, "")
    .replace(/\s+/g, "");
  if (/^\d+$/.test(compact)) return compact;
  const digitsOnly = compact.replace(/\D/g, "");
  if (digitsOnly.length >= 200) return digitsOnly;
  const longRuns = compact.match(/\d{200,}/g);
  if (longRuns?.length) return longRuns.reduce((a, b) => (a.length >= b.length ? a : b));
  return digitsOnly.length >= 12 ? digitsOnly : compact;
}

export async function verifyAadhaarSecureQr(decodedPayload) {
  try {
    const parsed = parseSecureQrPayload(normalizeSecureQrPayload(decodedPayload));
    const importedKey = await getUidaiPublicKey();
    const verifyDirect = await crypto.subtle.verify(
      { name: "RSASSA-PKCS1-v1_5" },
      importedKey.key,
      parsed.signature,
      parsed.signedData,
    );
    const reversedSignature = reverseBytes(parsed.signature);
    const verifyReversedSignature = await crypto.subtle.verify(
      { name: "RSASSA-PKCS1-v1_5" },
      importedKey.key,
      reversedSignature,
      parsed.signedData,
    );
    const verifyDirectPayloadOnly = await crypto.subtle.verify(
      { name: "RSASSA-PKCS1-v1_5" },
      importedKey.key,
      parsed.signature,
      parsed.payloadOnlySignedData,
    );
    const verifyReversedSignaturePayloadOnly = await crypto.subtle.verify(
      { name: "RSASSA-PKCS1-v1_5" },
      importedKey.key,
      reversedSignature,
      parsed.payloadOnlySignedData,
    );
    const isValid =
      verifyReversedSignature ||
      verifyDirect ||
      verifyReversedSignaturePayloadOnly ||
      verifyDirectPayloadOnly;
    return { isValid, data: parsed.data };
  } catch {
    return { isValid: false, data: {} };
  }
}

async function getUidaiPublicKey() {
  if (!publicKeyPromise) publicKeyPromise = importUidaiPublicKey(UIDAI_CERT);
  return publicKeyPromise;
}

async function importUidaiPublicKey(certificatePem) {
  const certificateDer = pemToDer(certificatePem);
  const spkiDer = extractSpkiFromCertificate(certificateDer);
  const key = await crypto.subtle.importKey(
    "spki",
    spkiDer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return { key };
}

function parseSecureQrPayload(decodedPayload) {
  const trimmedPayload = decodedPayload.trim();
  if (!/^\d+$/.test(trimmedPayload)) throw new Error("Invalid Aadhaar Secure QR payload.");
  const compressedBytes = decimalToBytes(trimmedPayload);
  const decompressedBytes = inflate(compressedBytes);
  if (decompressedBytes.length <= SIGNATURE_LENGTH) {
    throw new Error("Incomplete Aadhaar Secure QR payload.");
  }
  const { fields, nextIndex } = readDelimitedTextFields(decompressedBytes);
  const hashIndicator = fields[1] ?? "0";
  const signatureStart = decompressedBytes.length - SIGNATURE_LENGTH;
  const optionalHashLength = getOptionalHashLength(hashIndicator);
  const payloadEnd = signatureStart - optionalHashLength;
  if (payloadEnd < nextIndex) throw new Error("Invalid Aadhaar Secure QR layout.");
  const signedData = decompressedBytes.slice(0, signatureStart);
  const payloadOnlySignedData = decompressedBytes.slice(0, payloadEnd);
  const signature = decompressedBytes.slice(signatureStart);
  return {
    signedData,
    payloadOnlySignedData,
    signature,
    data: buildVerificationData(fields),
  };
}

function readDelimitedTextFields(bytes) {
  const fields = [];
  let cursor = 0;
  while (fields.length < TEXT_FIELD_COUNT) {
    const delimiterIndex = bytes.indexOf(DELIMITER, cursor);
    if (delimiterIndex === -1) break;
    fields.push(latin1Decoder.decode(bytes.slice(cursor, delimiterIndex)));
    cursor = delimiterIndex + 1;
  }
  return { fields, nextIndex: cursor };
}

function buildVerificationData(fields) {
  const referenceId = fields[2];
  const name = fields[3];
  const dob = fields[4];
  const gender = fields[5];
  const careOf = fields[6];
  const district = fields[7];
  const landmark = fields[8];
  const house = fields[9];
  const location = fields[10];
  const pinCode = fields[11];
  const postOffice = fields[12];
  const state = fields[13];
  const street = fields[14];
  const subDistrict = fields[15];
  const vtc = fields[16];
  const address = [
    careOf ? `C/O ${careOf}` : "",
    house,
    street,
    landmark,
    location,
    vtc,
    subDistrict,
    district,
    postOffice,
    state,
    pinCode,
  ]
    .filter(Boolean)
    .join(", ");
  return {
    name: name || undefined,
    dob: dob || undefined,
    gender: gender || undefined,
    address: address || undefined,
    referenceId: referenceId || undefined,
  };
}

function getOptionalHashLength(hashIndicator) {
  if (hashIndicator === "3") return HASH_LENGTH * 2;
  if (hashIndicator === "1" || hashIndicator === "2") return HASH_LENGTH;
  return 0;
}

function decimalToBytes(decimalValue) {
  let bigIntValue = BigInt(decimalValue);
  if (bigIntValue === 0n) return new Uint8Array([0]);
  const bytes = [];
  while (bigIntValue > 0n) {
    bytes.push(Number(bigIntValue & 0xffn));
    bigIntValue >>= 8n;
  }
  bytes.reverse();
  return Uint8Array.from(bytes);
}

function pemToDer(pem) {
  const base64Body = pem
    .replace(/-----BEGIN CERTIFICATE-----/g, "")
    .replace(/-----END CERTIFICATE-----/g, "")
    .replace(/\s+/g, "");
  const binary = atob(base64Body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function extractSpkiFromCertificate(certificateDer) {
  const certificate = readDerElement(certificateDer, 0);
  const certificateChildren = readSequenceChildren(certificateDer, certificate);
  const tbsCertificate = certificateChildren[0];
  const tbsChildren = readSequenceChildren(certificateDer, tbsCertificate);
  const spkiIndex = tbsChildren[0]?.tag === 0xa0 ? 6 : 5;
  const spkiElement = tbsChildren[spkiIndex];
  if (!spkiElement) throw new Error("UIDAI certificate SPKI block is missing.");
  return certificateDer.slice(spkiElement.start, spkiElement.end).buffer;
}

function readSequenceChildren(bytes, sequence) {
  const children = [];
  let cursor = sequence.valueStart;
  while (cursor < sequence.end) {
    const element = readDerElement(bytes, cursor);
    children.push(element);
    cursor = element.end;
  }
  return children;
}

function readDerElement(bytes, offset) {
  const tag = bytes[offset];
  const lengthByte = bytes[offset + 1];
  if (tag === undefined || lengthByte === undefined) {
    throw new Error("Unexpected end of certificate while reading ASN.1 data.");
  }
  let length = 0;
  let headerLength = 2;
  if ((lengthByte & 0x80) === 0) {
    length = lengthByte;
  } else {
    const lengthOfLength = lengthByte & 0x7f;
    headerLength += lengthOfLength;
    for (let i = 0; i < lengthOfLength; i += 1) {
      const nextByte = bytes[offset + 2 + i];
      if (nextByte === undefined) throw new Error("Invalid ASN.1 length.");
      length = (length << 8) | nextByte;
    }
  }
  const valueStart = offset + headerLength;
  const end = valueStart + length;
  return { tag, start: offset, valueStart, end };
}

function reverseBytes(bytes) {
  return Uint8Array.from(bytes).reverse();
}

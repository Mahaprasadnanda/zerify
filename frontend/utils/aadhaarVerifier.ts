import { inflate } from "pako";
import { UIDAI_CERT } from "./uidaiCert";
import { safeError, safeLog } from "./safeLog";

const DELIMITER = 0xff;
const SIGNATURE_LENGTH = 256;
const HASH_LENGTH = 32;
const TEXT_FIELD_COUNT = 17;
const latin1Decoder = new TextDecoder("iso-8859-1");

type AadhaarAddressFields = {
  careOf: string;
  district: string;
  landmark: string;
  house: string;
  location: string;
  pinCode: string;
  postOffice: string;
  state: string;
  street: string;
  subDistrict: string;
  vtc: string;
};

export type AadhaarVerificationData = {
  name?: string;
  dob?: string;
  gender?: string;
  address?: string;
  referenceId?: string;
};

export type AadhaarVerificationDebug = {
  decompressedBytesLength: number;
  signatureLength: number;
  signedDataLength: number;
  payloadOnlyLength: number;
  signatureStart: number;
  payloadEnd: number;
  nextIndex: number;
  version?: string;
  hashIndicator?: string;
  first64SignedDataHex: string;
  certificateDerLength: number;
  spkiLength: number;
  keyType: string;
  keyAlgorithm: string;
  certificateSubject: string;
  certificateIssuer: string;
  certificateValidFrom: string;
  certificateValidTo: string;
  referenceTimestamp?: string;
  certificateExpiredForReferenceId?: boolean;
  webCryptoPreHashRequired: boolean;
  verifyDirect: boolean;
  verifyReversedSignature: boolean;
  verifyDirectPayloadOnly: boolean;
  verifyReversedSignaturePayloadOnly: boolean;
  selectedStrategy: string;
};

export type AadhaarVerificationResult = {
  isValid: boolean;
  data: AadhaarVerificationData;
  debug?: AadhaarVerificationDebug;
};

type ParsedSecureQr = {
  signedData: Uint8Array;
  payloadOnlySignedData: Uint8Array;
  signature: Uint8Array;
  data: AadhaarVerificationData;
  debug: Pick<
    AadhaarVerificationDebug,
    | "decompressedBytesLength"
    | "signatureLength"
    | "signedDataLength"
    | "payloadOnlyLength"
    | "signatureStart"
    | "payloadEnd"
    | "nextIndex"
    | "version"
    | "hashIndicator"
    | "first64SignedDataHex"
    | "referenceTimestamp"
  >;
};

type DerElement = {
  tag: number;
  start: number;
  valueStart: number;
  end: number;
};

type ImportedPublicKey = {
  key: CryptoKey;
  certificateDerLength: number;
  spkiLength: number;
  subject: string;
  issuer: string;
  validFrom: string;
  validTo: string;
};

let publicKeyPromise: Promise<ImportedPublicKey> | null = null;

/**
 * Raw QR text may include whitespace, BOM, or a short non-secure QR decoded first.
 * UIDAI secure payload is a long decimal string; we normalize before parse/verify.
 */
export function normalizeSecureQrPayload(raw: string): string {
  const compact = raw.trim().replace(/^\uFEFF/, "").replace(/\s+/g, "");
  if (/^\d+$/.test(compact)) return compact;
  const digitsOnly = compact.replace(/\D/g, "");
  if (digitsOnly.length >= 200) return digitsOnly;
  const longRuns = compact.match(/\d{200,}/g);
  if (longRuns?.length) {
    return longRuns.reduce((a, b) => (a.length >= b.length ? a : b));
  }
  return digitsOnly.length >= 12 ? digitsOnly : compact;
}

export async function verifyAadhaarSecureQr(
  decodedPayload: string,
): Promise<AadhaarVerificationResult> {
  try {
    const parsed = parseSecureQrPayload(normalizeSecureQrPayload(decodedPayload));
    const importedKey = await getUidaiPublicKey();
    const referenceTime = parsed.debug.referenceTimestamp
      ? new Date(parsed.debug.referenceTimestamp)
      : null;
    const certValidTo = new Date(importedKey.validTo);
    const certificateExpiredForReferenceId = referenceTime
      ? certValidTo < referenceTime
      : undefined;

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

    let isValid = false;
    let selectedStrategy = "none";

    if (verifyReversedSignature) {
      isValid = true;
      selectedStrategy = "reversed-signature/full-signedData";
    } else if (verifyDirect) {
      isValid = true;
      selectedStrategy = "direct/full-signedData";
    } else if (verifyReversedSignaturePayloadOnly) {
      isValid = true;
      selectedStrategy = "reversed-signature/payload-only";
    } else if (verifyDirectPayloadOnly) {
      isValid = true;
      selectedStrategy = "direct/payload-only";
    }

    if (isValid) {
      safeLog("QR verification completed");
    }

    return {
      isValid,
      data: parsed.data,
      debug: {
        ...parsed.debug,
        certificateDerLength: importedKey.certificateDerLength,
        spkiLength: importedKey.spkiLength,
        keyType: importedKey.key.type,
        keyAlgorithm: JSON.stringify(importedKey.key.algorithm),
        certificateSubject: importedKey.subject,
        certificateIssuer: importedKey.issuer,
        certificateValidFrom: importedKey.validFrom,
        certificateValidTo: importedKey.validTo,
        certificateExpiredForReferenceId,
        webCryptoPreHashRequired: false,
        verifyDirect,
        verifyReversedSignature,
        verifyDirectPayloadOnly,
        verifyReversedSignaturePayloadOnly,
        selectedStrategy,
      },
    };
  } catch {
    safeError("Aadhaar QR verification failed");

    return {
      isValid: false,
      data: {},
    };
  }
}

async function getUidaiPublicKey(): Promise<ImportedPublicKey> {
  if (!publicKeyPromise) {
    publicKeyPromise = importUidaiPublicKey(UIDAI_CERT);
  }

  return publicKeyPromise;
}

async function importUidaiPublicKey(
  certificatePem: string,
): Promise<ImportedPublicKey> {
  const certificateDer = pemToDer(certificatePem);
  const spkiDer = extractSpkiFromCertificate(certificateDer);
  const key = await crypto.subtle.importKey(
    "spki",
    spkiDer,
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256",
    },
    false,
    ["verify"],
  );

  const certInfo = parsePemCertificateMetadata(certificatePem);

  return {
    key,
    certificateDerLength: certificateDer.length,
    spkiLength: spkiDer.byteLength,
    subject: certInfo.subject,
    issuer: certInfo.issuer,
    validFrom: certInfo.validFrom,
    validTo: certInfo.validTo,
  };
}

function parseSecureQrPayload(decodedPayload: string): ParsedSecureQr {
  const trimmedPayload = decodedPayload.trim();

  if (!/^\d+$/.test(trimmedPayload)) {
    throw new Error("Invalid Aadhaar Secure QR payload.");
  }

  const compressedBytes = decimalToBytes(trimmedPayload);
  const decompressedBytes = inflate(compressedBytes);

  if (decompressedBytes.length <= SIGNATURE_LENGTH) {
    throw new Error("Incomplete Aadhaar Secure QR payload.");
  }

  const { fields, nextIndex } = readDelimitedTextFields(decompressedBytes);
  const version = fields[0] ?? "";
  const hashIndicator = fields[1] ?? "0";
  const referenceId = fields[2] ?? "";
  const signatureStart = decompressedBytes.length - SIGNATURE_LENGTH;
  const optionalHashLength = getOptionalHashLength(hashIndicator);
  const payloadEnd = signatureStart - optionalHashLength;

  if (payloadEnd < nextIndex) {
    throw new Error("Invalid Aadhaar Secure QR layout.");
  }

  const signedData = decompressedBytes.slice(0, signatureStart);
  const payloadOnlySignedData = decompressedBytes.slice(0, payloadEnd);
  const signature = decompressedBytes.slice(signatureStart);

  return {
    signedData,
    payloadOnlySignedData,
    signature,
    data: buildVerificationData(fields),
    debug: {
      decompressedBytesLength: decompressedBytes.length,
      signatureLength: signature.length,
      signedDataLength: signedData.length,
      payloadOnlyLength: payloadOnlySignedData.length,
      signatureStart,
      payloadEnd,
      nextIndex,
      version,
      hashIndicator,
      first64SignedDataHex: toHexPreview(signedData, 64),
      referenceTimestamp: parseReferenceTimestamp(referenceId),
    },
  };
}

function readDelimitedTextFields(bytes: Uint8Array): {
  fields: string[];
  nextIndex: number;
} {
  const fields: string[] = [];
  let cursor = 0;

  while (fields.length < TEXT_FIELD_COUNT) {
    const delimiterIndex = bytes.indexOf(DELIMITER, cursor);

    if (delimiterIndex === -1) {
      break;
    }

    fields.push(latin1Decoder.decode(bytes.slice(cursor, delimiterIndex)));
    cursor = delimiterIndex + 1;
  }

  return {
    fields,
    nextIndex: cursor,
  };
}

function buildVerificationData(fields: string[]): AadhaarVerificationData {
  const version = fields[0];
  const hashIndicator = fields[1];
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

  void version;
  void hashIndicator;

  const address = formatAddress({
    careOf,
    district,
    landmark,
    house,
    location,
    pinCode,
    postOffice,
    state,
    street,
    subDistrict,
    vtc,
  });

  return {
    name: name || undefined,
    dob: dob || undefined,
    gender: gender || undefined,
    address: address || undefined,
    referenceId: referenceId || undefined,
  };
}

function formatAddress(address: AadhaarAddressFields): string {
  const orderedParts = [
    address.careOf ? `C/O ${address.careOf}` : "",
    address.house,
    address.street,
    address.landmark,
    address.location,
    address.vtc,
    address.subDistrict,
    address.district,
    address.postOffice,
    address.state,
    address.pinCode,
  ];

  return orderedParts.filter(Boolean).join(", ");
}

function getOptionalHashLength(hashIndicator: string): number {
  if (hashIndicator === "3") {
    return HASH_LENGTH * 2;
  }

  if (hashIndicator === "1" || hashIndicator === "2") {
    return HASH_LENGTH;
  }

  return 0;
}

function parseReferenceTimestamp(referenceId: string): string | undefined {
  const match = referenceId.match(/(20\d{12})/);

  if (!match) {
    return undefined;
  }

  const value = match[1];
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  const hour = Number(value.slice(8, 10));
  const minute = Number(value.slice(10, 12));
  const second = Number(value.slice(12, 14));

  const timestamp = new Date(Date.UTC(year, month - 1, day, hour, minute, second));

  if (Number.isNaN(timestamp.getTime())) {
    return undefined;
  }

  return timestamp.toISOString();
}

function decimalToBytes(decimalValue: string): Uint8Array {
  let bigIntValue = BigInt(decimalValue);

  if (bigIntValue === 0n) {
    return new Uint8Array([0]);
  }

  const bytes: number[] = [];

  while (bigIntValue > 0n) {
    bytes.push(Number(bigIntValue & 0xffn));
    bigIntValue >>= 8n;
  }

  bytes.reverse();
  return Uint8Array.from(bytes);
}

function pemToDer(pem: string): Uint8Array {
  const base64Body = pem
    .replace(/-----BEGIN CERTIFICATE-----/g, "")
    .replace(/-----END CERTIFICATE-----/g, "")
    .replace(/\s+/g, "");

  const binary = atob(base64Body);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

function extractSpkiFromCertificate(certificateDer: Uint8Array): ArrayBuffer {
  const certificate = readDerElement(certificateDer, 0);
  const certificateChildren = readSequenceChildren(certificateDer, certificate);
  const tbsCertificate = certificateChildren[0];

  if (!tbsCertificate) {
    throw new Error("UIDAI certificate TBSCertificate block is missing.");
  }

  const tbsChildren = readSequenceChildren(certificateDer, tbsCertificate);
  const spkiIndex = tbsChildren[0]?.tag === 0xa0 ? 6 : 5;
  const spkiElement = tbsChildren[spkiIndex];

  if (!spkiElement) {
    throw new Error("UIDAI certificate SPKI block is missing.");
  }

  return certificateDer.slice(spkiElement.start, spkiElement.end).buffer;
}

function readSequenceChildren(bytes: Uint8Array, sequence: DerElement): DerElement[] {
  const children: DerElement[] = [];
  let cursor = sequence.valueStart;

  while (cursor < sequence.end) {
    const element = readDerElement(bytes, cursor);
    children.push(element);
    cursor = element.end;
  }

  return children;
}

function readDerElement(bytes: Uint8Array, offset: number): DerElement {
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

    for (let index = 0; index < lengthOfLength; index += 1) {
      const nextByte = bytes[offset + 2 + index];

      if (nextByte === undefined) {
        throw new Error("Unexpected end of certificate while reading ASN.1 length.");
      }

      length = (length << 8) | nextByte;
    }
  }

  const valueStart = offset + headerLength;
  const end = valueStart + length;

  return {
    tag,
    start: offset,
    valueStart,
    end,
  };
}

function parsePemCertificateMetadata(pem: string): {
  subject: string;
  issuer: string;
  validFrom: string;
  validTo: string;
} {
  const match = pem.match(/-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/);

  if (!match) {
    return {
      subject: "unknown",
      issuer: "unknown",
      validFrom: "unknown",
      validTo: "unknown",
    };
  }

  try {
    const der = pemToDer(pem);
    const certificate = (globalThis as typeof globalThis & {
      X509Certificate?: new (data: ArrayBuffer | Uint8Array) => {
        subject: string;
        issuer: string;
        validFrom: string;
        validTo: string;
      };
    }).X509Certificate;

    if (!certificate) {
      return {
        subject: "unavailable in browser runtime",
        issuer: "unavailable in browser runtime",
        validFrom: "unavailable in browser runtime",
        validTo: "unavailable in browser runtime",
      };
    }

    const parsed = new certificate(der);

    return {
      subject: parsed.subject,
      issuer: parsed.issuer,
      validFrom: parsed.validFrom,
      validTo: parsed.validTo,
    };
  } catch {
    return {
      subject: "unavailable in browser runtime",
      issuer: "unavailable in browser runtime",
      validFrom: "unavailable in browser runtime",
      validTo: "unavailable in browser runtime",
    };
  }
}

function reverseBytes(bytes: Uint8Array): Uint8Array {
  return Uint8Array.from(bytes).reverse();
}

function toHexPreview(bytes: Uint8Array, count: number): string {
  return Array.from(bytes.slice(0, count), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join(" ");
}

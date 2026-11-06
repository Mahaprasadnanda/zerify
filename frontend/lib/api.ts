export type KycProofRequestContext = {
  createdAt: number;
  checks: string[];
  constraints: {
    minAge: number;
    requiredGender: string;
    pincodes: string[];
  };
  security?: {
    requireCommitment?: boolean;
    nonce?: string | null;
  };
};

export type VerifyProofPayload = {
  proof: Record<string, unknown>;
  publicSignals: string[];
  requestContext: KycProofRequestContext;
  nonce?: string | null;
  scheme?: string | null;
};

export type VerifyProofResponse = {
  verified: boolean;
  message: string;
};

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "https://zerify-api.onrender.com/api";

/** SnarkJS verify on the server can take a while; avoid infinite “Verifying…” if the request stalls. */
const VERIFY_PROOF_TIMEOUT_MS = 180_000;

export async function verifyProof(
  payload: VerifyProofPayload,
): Promise<VerifyProofResponse> {
  const url = `${API_BASE_URL.replace(/\/$/, "")}/verify-proof`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(VERIFY_PROOF_TIMEOUT_MS),
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      throw new Error(
        `Proof verification timed out after ${VERIFY_PROOF_TIMEOUT_MS / 1000}s. Is the API at ${url} reachable?`,
      );
    }
    if (e instanceof TypeError) {
      throw new Error(
        `Could not reach verification API (${url}). Check CORS, firewall, and that uvicorn is on the same host/port as NEXT_PUBLIC_API_BASE_URL.`,
      );
    }
    throw e;
  }

  if (!response.ok) {
    let detail = "";
    try {
      const body = (await response.json()) as { message?: string; detail?: string };
      const serverMessage = body?.message ?? body?.detail;
      if (serverMessage) detail = ` ${serverMessage}`;
    } catch {
      // ignore
    }
    throw new Error(`Proof verification failed (${response.status}).${detail}`);
  }

  return (await response.json()) as VerifyProofResponse;
}

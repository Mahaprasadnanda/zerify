declare module "snarkjs" {
  export const groth16: {
    fullProve(
      input: Record<string, string | number | bigint>,
      wasmPath: string,
      zkeyPath: string,
    ): Promise<{
      proof: Record<string, unknown>;
      publicSignals: string[];
    }>;
    verify(
      verificationKey: Record<string, unknown>,
      publicSignals: string[],
      proof: Record<string, unknown>,
    ): Promise<boolean>;
  };
}

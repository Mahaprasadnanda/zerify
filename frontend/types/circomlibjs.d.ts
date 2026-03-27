declare module "circomlibjs" {
  export function buildPoseidon(): Promise<(inputs: bigint[]) => unknown>;
}


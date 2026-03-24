import fs from "fs";
import * as snarkjs from "snarkjs";

async function main() {
  const args = process.argv.slice(2);

  if (args.length !== 3) {
    console.error("Usage: node verify_groth16_proof.mjs <vkey.json> <proof.json> <publicSignals.json>");
    process.exit(1);
  }

  const [vkeyPath, proofPath, publicSignalsPath] = args;

  const verificationKey = JSON.parse(fs.readFileSync(vkeyPath, "utf8"));
  const proof = JSON.parse(fs.readFileSync(proofPath, "utf8"));
  const publicSignals = JSON.parse(fs.readFileSync(publicSignalsPath, "utf8"));

  const verified = await snarkjs.groth16.verify(verificationKey, publicSignals, proof);

  console.log(JSON.stringify({ verified }));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

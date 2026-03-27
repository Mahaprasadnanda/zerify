// Node.js library wrapper for snarkjs groth16 verify.
// Called by Python subprocess. Always writes one JSON line to stdout.
// Exit 0 = ran to completion (check .valid). Exit 1 = infrastructure failure.

const path = require("path");

async function main() {
  const [, , vkPath, pubPath, proofPath] = process.argv;

  if (!vkPath || !pubPath || !proofPath) {
    process.stdout.write(
      JSON.stringify({
        valid: false,
        error: "missing_args: expected vk_path pub_path proof_path",
      }),
    );
    process.exit(1);
  }

  let snarkjs;
  try {
    snarkjs = require(path.resolve(__dirname, "..", "node_modules", "snarkjs"));
  } catch (e) {
    process.stdout.write(
      JSON.stringify({
        valid: false,
        error: "snarkjs_not_found: " + String(e.message),
      }),
    );
    process.exit(1);
  }

  let vk;
  let publicSignals;
  let proof;
  try {
    vk = require(path.resolve(vkPath));
    publicSignals = require(path.resolve(pubPath));
    proof = require(path.resolve(proofPath));
  } catch (e) {
    process.stdout.write(
      JSON.stringify({
        valid: false,
        error: "file_read_failed: " + String(e.message),
      }),
    );
    process.exit(1);
  }

  let valid = false;
  let errorMsg = null;
  try {
    valid = await snarkjs.groth16.verify(vk, publicSignals, proof);
  } catch (e) {
    errorMsg = "verify_threw: " + String(e.message);
  }

  process.stdout.write(
    JSON.stringify({ valid: Boolean(valid), error: errorMsg }),
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    process.stdout.write(
      JSON.stringify({
        valid: false,
        error: "fatal: " + String(e.message || e),
      }),
    );
    process.exit(1);
  });

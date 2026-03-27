$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$circuitFile = Join-Path $repoRoot "Circuit\circom\flexible_kyc_commitment.circom"
$buildDir = Join-Path $repoRoot "Circuit\build\flexibleKycCommitment"
$frontendArtifactDir = Join-Path $repoRoot "frontend\public\zkp\flexibleKycCommitment"
$legacyVkeyDir = Join-Path $repoRoot "Circuit\vkey"

New-Item -ItemType Directory -Path $buildDir -Force | Out-Null
New-Item -ItemType Directory -Path $frontendArtifactDir -Force | Out-Null
New-Item -ItemType Directory -Path $legacyVkeyDir -Force | Out-Null

Push-Location $repoRoot
try {
  $circomDir = Split-Path $circuitFile
  $circomName = Split-Path -Leaf $circuitFile
  Push-Location $circomDir
  try {
    circom $circomName --r1cs --wasm --sym -o $buildDir
  } finally {
    Pop-Location
  }
  npx --yes snarkjs powersoftau new bn128 16 (Join-Path $buildDir "pot16_0000.ptau") -v
  npx --yes snarkjs powersoftau contribute (Join-Path $buildDir "pot16_0000.ptau") (Join-Path $buildDir "pot16_0001.ptau") --name="Flexible KYC Commitment" -v -e="flexible-kyc-commitment-ptau"
  npx --yes snarkjs powersoftau prepare phase2 (Join-Path $buildDir "pot16_0001.ptau") (Join-Path $buildDir "pot16_final.ptau") -v
  npx --yes snarkjs groth16 setup (Join-Path $buildDir "flexible_kyc_commitment.r1cs") (Join-Path $buildDir "pot16_final.ptau") (Join-Path $buildDir "flexible_kyc_commitment_0000.zkey")
  npx --yes snarkjs zkey contribute (Join-Path $buildDir "flexible_kyc_commitment_0000.zkey") (Join-Path $buildDir "flexible_kyc_commitment_final.zkey") --name="Flexible KYC Commitment Final" -v -e="flexible-kyc-commitment-zkey"
  npx --yes snarkjs zkey export verificationkey (Join-Path $buildDir "flexible_kyc_commitment_final.zkey") (Join-Path $buildDir "flexible_kyc_commitment_verification_key.json")
}
finally {
  Pop-Location
}

$wasmSrc = Join-Path $buildDir "flexible_kyc_commitment_js\flexible_kyc_commitment.wasm"
Copy-Item $wasmSrc (Join-Path $frontendArtifactDir "flexible_kyc_commitment.wasm") -Force
Copy-Item (Join-Path $buildDir "flexible_kyc_commitment_final.zkey") (Join-Path $frontendArtifactDir "flexible_kyc_commitment_final.zkey") -Force
Copy-Item (Join-Path $buildDir "flexible_kyc_commitment_verification_key.json") (Join-Path $frontendArtifactDir "flexible_kyc_commitment_verification_key.json") -Force

# Keep a copy next to Circuit/README.txt for the standalone verifier layout
Copy-Item (Join-Path $buildDir "flexible_kyc_commitment_verification_key.json") (Join-Path $legacyVkeyDir "flexible_kyc_commitment_verification_key.json") -Force

Write-Host "Artifacts copied to $frontendArtifactDir and $legacyVkeyDir"


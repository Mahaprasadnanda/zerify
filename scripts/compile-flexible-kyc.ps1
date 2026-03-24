$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$circuitFile = Join-Path $repoRoot "Circuit\circom\flexible_kyc.circom"
$buildDir = Join-Path $repoRoot "Circuit\build"
$frontendArtifactDir = Join-Path $repoRoot "frontend\public\zkp\flexibleKyc"
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
  npx --yes snarkjs powersoftau contribute (Join-Path $buildDir "pot16_0000.ptau") (Join-Path $buildDir "pot16_0001.ptau") --name="Flexible KYC" -v -e="flexible-kyc-ptau"
  npx --yes snarkjs powersoftau prepare phase2 (Join-Path $buildDir "pot16_0001.ptau") (Join-Path $buildDir "pot16_final.ptau") -v
  npx --yes snarkjs groth16 setup (Join-Path $buildDir "flexible_kyc.r1cs") (Join-Path $buildDir "pot16_final.ptau") (Join-Path $buildDir "flexible_kyc_0000.zkey")
  npx --yes snarkjs zkey contribute (Join-Path $buildDir "flexible_kyc_0000.zkey") (Join-Path $buildDir "flexible_kyc_final.zkey") --name="Flexible KYC Final" -v -e="flexible-kyc-zkey"
  npx --yes snarkjs zkey export verificationkey (Join-Path $buildDir "flexible_kyc_final.zkey") (Join-Path $buildDir "flexible_kyc_verification_key.json")
}
finally {
  Pop-Location
}

$wasmSrc = Join-Path $buildDir "flexible_kyc_js\flexible_kyc.wasm"
Copy-Item $wasmSrc (Join-Path $frontendArtifactDir "flexible_kyc.wasm") -Force
Copy-Item (Join-Path $buildDir "flexible_kyc_final.zkey") (Join-Path $frontendArtifactDir "flexible_kyc_final.zkey") -Force
Copy-Item (Join-Path $buildDir "flexible_kyc_verification_key.json") (Join-Path $frontendArtifactDir "flexible_kyc_verification_key.json") -Force

# Keep a copy next to Circuit/README.txt for the standalone verifier layout
Copy-Item (Join-Path $buildDir "flexible_kyc_verification_key.json") (Join-Path $legacyVkeyDir "flexible_kyc_verification_key.json") -Force

Write-Host "Artifacts copied to $frontendArtifactDir and $legacyVkeyDir"

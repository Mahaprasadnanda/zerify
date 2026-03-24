# DEPRECATED: Zerify uses the flexibleKyc circuit only (see compile-flexible-kyc.ps1).
# This script is kept for historical reference and is not part of the supported app path.

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$circuitsDir = Join-Path $repoRoot "circuits"
$buildDir = Join-Path $circuitsDir "build\ageProof"
$frontendArtifactDir = Join-Path $repoRoot "frontend\public\zkp\ageProof"

New-Item -ItemType Directory -Path $buildDir -Force | Out-Null
New-Item -ItemType Directory -Path $frontendArtifactDir -Force | Out-Null

Push-Location $circuitsDir
try {
  circom .\src\ageProof.circom --r1cs --wasm --sym -o .\build\ageProof
  snarkjs powersoftau new bn128 12 .\build\ageProof\pot12_0000.ptau -v
  snarkjs powersoftau contribute .\build\ageProof\pot12_0000.ptau .\build\ageProof\pot12_0001.ptau --name="Age Proof Initial" -v -e="age-proof-mvp"
  snarkjs powersoftau prepare phase2 .\build\ageProof\pot12_0001.ptau .\build\ageProof\pot12_final.ptau -v
  snarkjs groth16 setup .\build\ageProof\ageProof.r1cs .\build\ageProof\pot12_final.ptau .\build\ageProof\ageProof_0000.zkey
  snarkjs zkey contribute .\build\ageProof\ageProof_0000.zkey .\build\ageProof\ageProof_final.zkey --name="Age Proof Final" -v -e="age-proof-final"
  snarkjs zkey export verificationkey .\build\ageProof\ageProof_final.zkey .\build\ageProof\verification_key.json
}
finally {
  Pop-Location
}

Copy-Item (Join-Path $buildDir "ageProof_js\ageProof.wasm") (Join-Path $frontendArtifactDir "ageProof.wasm") -Force
Copy-Item (Join-Path $buildDir "ageProof_final.zkey") (Join-Path $frontendArtifactDir "ageProof_final.zkey") -Force
Copy-Item (Join-Path $buildDir "verification_key.json") (Join-Path $frontendArtifactDir "verification_key.json") -Force

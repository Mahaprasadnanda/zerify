pragma circom 2.0.0;

include "../../node_modules/circomlib/circuits/comparators.circom";
include "../../node_modules/circomlib/circuits/poseidon.circom";

/**
 * flexibleKyc v2 (commitment binding):
 * - Adds a private `face_hash` and public `commitment`
 * - Enforces commitment = Poseidon(dob_year, gender, pincode, face_hash)
 *
 * Backward compatibility is maintained at the application layer:
 * - v1 proofs still use Circuit/circom/flexible_kyc.circom + v1 artifacts
 * - v2 proofs use this circuit + v2 artifacts
 */
template FlexibleKycCommitment() {
    // ---- Private witness (never sent to backend) ----
    signal input dob_year;
    signal input gender;
    signal input pincode;
    signal input face_hash;

    // ---- Public inputs (included in publicSignals; must match KYC request) ----
    signal input current_year;
    signal input min_age;
    signal input required_gender;
    signal input allowed_pincode1;
    signal input allowed_pincode2;
    signal input allowed_pincode3;
    signal input allowed_pincode4;
    signal input allowed_pincode5;
    signal input use_pincode1;
    signal input use_pincode2;
    signal input use_pincode3;
    signal input use_pincode4;
    signal input use_pincode5;
    signal input check_age;
    signal input check_gender;
    signal input check_address;
    // Replay protection binding: unique request nonce (public) binds to the proof.
    signal input nonce;
    signal input commitment;

    // --- Age: when check_age = 1, require current_year >= dob_year + min_age ---
    component cmpAge = LessThan(16);
    cmpAge.in[0] <== current_year;
    cmpAge.in[1] <== dob_year + min_age;
    check_age * cmpAge.out === 0;

    // --- Gender: when check_gender = 1, require gender == required_gender ---
    component eqGender = IsEqual();
    eqGender.in[0] <== gender;
    eqGender.in[1] <== required_gender;
    signal genderFail;
    genderFail <== check_gender * (1 - eqGender.out);
    genderFail === 0;

    // --- Address: when check_address = 1, pincode matches at least one active slot ---
    component eqP1 = IsEqual();
    eqP1.in[0] <== pincode;
    eqP1.in[1] <== allowed_pincode1;
    component eqP2 = IsEqual();
    eqP2.in[0] <== pincode;
    eqP2.in[1] <== allowed_pincode2;
    component eqP3 = IsEqual();
    eqP3.in[0] <== pincode;
    eqP3.in[1] <== allowed_pincode3;
    component eqP4 = IsEqual();
    eqP4.in[0] <== pincode;
    eqP4.in[1] <== allowed_pincode4;
    component eqP5 = IsEqual();
    eqP5.in[0] <== pincode;
    eqP5.in[1] <== allowed_pincode5;

    signal acc1 <== eqP1.out * use_pincode1;
    signal acc2 <== eqP2.out * use_pincode2;
    signal acc3 <== eqP3.out * use_pincode3;
    signal acc4 <== eqP4.out * use_pincode4;
    signal acc5 <== eqP5.out * use_pincode5;

    signal sumMatches <== acc1 + acc2 + acc3 + acc4 + acc5;

    component pinZero = IsZero();
    pinZero.in <== sumMatches;
    check_address * pinZero.out === 0;

    // Bind the public nonce into the circuit constraints.
    nonce * 1 === nonce;

    // --- Commitment binding ---
    component h = Poseidon(4);
    h.inputs[0] <== dob_year;
    h.inputs[1] <== gender;
    h.inputs[2] <== pincode;
    h.inputs[3] <== face_hash;
    h.out === commitment;
}

component main {public [
    current_year,
    min_age,
    required_gender,
    allowed_pincode1,
    allowed_pincode2,
    allowed_pincode3,
    allowed_pincode4,
    allowed_pincode5,
    use_pincode1,
    use_pincode2,
    use_pincode3,
    use_pincode4,
    use_pincode5,
    check_age,
    check_gender,
    check_address,
    nonce,
    commitment
]} = FlexibleKycCommitment();


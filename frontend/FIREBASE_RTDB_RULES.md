# Firebase Realtime Database rules for Zerify

If you see registration failures or login gating behaving strangely, the Realtime Database rules are usually the cause.

## Steps

1. Open [Firebase Console](https://console.firebase.google.com/) and select project `zerify-a8c25`.
2. Go to `Build` -> `Realtime Database` -> `Rules`.
3. Replace the rules with the following and click `Publish`.

```json
{
  "rules": {
    "kycRequests": {
      "$requestId": {
        ".read": true,
        ".write": "(!data.exists() && auth != null && newData.child('verifier/uid').val() == auth.uid) || (data.exists() && auth != null && data.child('verifier/uid').val() == auth.uid) || (data.exists() && !newData.exists() && auth != null && data.child('verifier/uid').val() == auth.uid)",
        "users": {
          "$phone": {
            ".read": true,
            ".write": false,
            "proof": {
              ".write": "!data.exists()",
              ".validate": "newData.hasChildren(['version','scheme','createdAt','proof','publicSignals']) && newData.child('scheme').val() != null && newData.child('publicSignals').exists() && (!root.child('kycRequests/' + $requestId + '/nonce').exists() || newData.child('nonce').val() == root.child('kycRequests/' + $requestId + '/nonce').val())"
            },
            "risk": {
              ".write": true,
              ".validate": "newData.child('status').val() == 'verified' || newData.child('status').val() == 'suspicious'"
            },
            "verification": {
              ".write": "auth != null && root.child('kycRequests/' + $requestId + '/verifier/uid').val() == auth.uid"
            }
          }
        }
      }
    },
    "indices": {
      "verifierRequests": {
        "$uid": {
          ".read": "auth != null && auth.uid == $uid",
          ".write": "auth != null && auth.uid == $uid"
        }
      },
      "userRequests": {
        "$phone": {
          ".read": true,
          "$requestId": {
            ".write": "auth != null && root.child('kycRequests/' + $requestId + '/verifier/uid').val() == auth.uid"
          }
        }
      }
    },
    "recipientProfiles": {
      "$phoneDigits": {
        ".read": true,
        ".write": "auth != null && newData.child('authUid').val() == auth.uid && newData.child('phoneDigits').val() == $phoneDigits && newData.child('phoneE164').isString() && newData.child('selfRegisteredAt').isNumber() && newData.child('updatedAt').isNumber() && (!data.exists() || !data.child('authUid').exists() || data.child('authUid').val() == auth.uid) && (!data.exists() || !data.child('phoneDigits').exists() || newData.child('phoneDigits').val() == data.child('phoneDigits').val()) && (!data.exists() || !data.child('phoneE164').exists() || newData.child('phoneE164').val() == data.child('phoneE164').val()) && (!data.exists() || !data.child('selfRegisteredAt').exists() || newData.child('selfRegisteredAt').val() == data.child('selfRegisteredAt').val())"
      }
    }
  }
}
```

## What this allows

- Verifiers signed in with email/password can still create and update KYC requests and recipient profiles.
- Provers authenticate with Firebase Email/Password using a deterministic internal email alias derived from their phone number; no real email address or SMS is used.
- A signed-in prover can create or update only the profile associated with their Firebase Auth UID.
- Prover login checks that the phone profile is linked to the currently signed-in Firebase Auth UID.
- Public callers cannot overwrite an existing `selfRegisteredAt` with a different value.

## Important

- These are Realtime Database rules. Firestore rules are not used for this flow.
- After publishing the rules, redeploy the latest frontend. Existing OTP-era profiles do not have an `authUid`; they must be claimed once by creating a password account for the same phone. Because OTP is removed, this does not independently prove phone ownership.

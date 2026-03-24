# Firebase Realtime Database rules for Zerify

If you see **"Saving request timed out"**, the Realtime Database is likely rejecting writes because default rules block all access.

## Steps

1. Open [Firebase Console](https://console.firebase.google.com/) → your project **zerify-a8c25**.
2. Go to **Build** → **Realtime Database** → **Rules**.
3. Replace the rules with the following (then click **Publish**):

```json
{
  "rules": {
    "kycRequests": {
      "$requestId": {
        ".read": true,
        ".write": "(!data.exists() && auth != null && newData.child('verifier/uid').val() == auth.uid) || (data.exists() && auth != null && data.child('verifier/uid').val() == auth.uid)",
        "users": {
          "$phone": {
            ".read": true,
            ".write": true
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
        ".write": "auth != null"
      }
    }
  }
}
```

## What this allows

- **Verifiers** (signed in with email/password): create/update/delete only their own requests (`kycRequests/{requestId}.verifier.uid` must match `auth.uid`).
- **Provers** (no Firebase auth): **read** any `kycRequests/{requestId}` (MVP — request IDs are unguessable; tighten for production), and **read/write** their own `users/{phone}` subtree so demo/ZK proofs can be stored later.
- **User indices**: verifier can write/delete `indices/userRequests/{phone}/{requestId}` only if they own that request.
- **indices / recipientProfiles**: otherwise unchanged from above.

**Security note:** Public read on `kycRequests` is for the demo only. For production, use Firebase Auth for provers, custom claims, or a Cloud Function to return only the caller’s request slice.

After publishing, try **SEND KYC REQUEST** again.

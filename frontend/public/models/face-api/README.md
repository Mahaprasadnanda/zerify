Place `face-api.js` model files here (served statically).

Required for Phase 1 liveness:
- `tiny_face_detector_model-weights_manifest.json` + shard(s)
- `face_landmark_68_tiny_model-weights_manifest.json` + shard(s)

Required for Phase 2 similarity:
- `face_recognition_model-weights_manifest.json` + shard(s)

They must be accessible at:
- `/models/face-api/tiny_face_detector_model-weights_manifest.json`
- `/models/face-api/face_landmark_68_tiny_model-weights_manifest.json`
- `/models/face-api/face_recognition_model-weights_manifest.json`

This app will gracefully fall back (mark suspicious) if models are missing.


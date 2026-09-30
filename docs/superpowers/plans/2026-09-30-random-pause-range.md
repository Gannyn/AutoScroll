# Configurable random pause range

Add minimum and maximum random pause durations in seconds. Keep the existing integer-second distribution and default 1–20 s; permit 1–3600 s per bound, require minimum <= maximum, and allow equal bounds for a fixed duration. Missing fields in old saved configurations use the defaults. The fields appear only in random mode and are locked while running or manually paused. Invalid inactive values must not prevent using another mode.

- [x] Add tests for configuration defaults/ranges, sampled endpoints and actual browser behavior.
- [x] Pass the saved bounds from model through background to content and sample each pause independently.
- [x] Add min/max inputs, persistence, validation and an accurate range hint.
- [x] Run unit/browser checks; update README, version and distribution zip.

Verification: 25 unit tests and 18 real Chromium tests passed. Checked custom endpoints, equal bounds, legacy defaults, persisted inputs, runtime locking, invalid inactive bounds and an actual two-second pause. Syntax/resource checks passed; read-only review found no important issues. Release: 1.2.0.

# Scroll pauses implementation plan

**Goal:** Add variable-speed scrolling, configurable timed scrolling/resting, random 1–600 px scrolling / 1–20 s resting, and random reverse movement after each in-page rest.

**Design:** Keep continuous scrolling as the default, including for existing saved configurations. Timed mode defaults to scrolling for 5 s and resting for 2 s; both durations accept 0.1–3600 s. Random mode samples an independent integer distance and an independent integer rest duration for every burst. All movement uses the existing speed setting and both directions support the same cadence. Stable page edges take precedence over starting an in-page rest. Manual pause freezes the current burst/rest and resumes it at the saved position; stop cancels future movement. Run progress distinguishes automatic rests from manual pauses.

**Architecture:** Extend model configuration and validation, keep burst/rest timing local to content.js, pass cadence snapshots through the existing service worker on manual pause/resume, and add mode controls and rest countdown to the popup. No new permissions or dependencies.

**Updated movement design:** The speed setting is a baseline. Movement smoothly accelerates/decelerates between 60%–140% of that baseline. Each automatic rest ends with an independent random opposite-direction movement, default 1–100 px and configurable within 1–600 px, limited by available space. The movement then retraces to the saved pre-rest anchor before counting the next forward burst, preserving net forward progress even with tiny burst settings. Snapshot state includes reverse/recovery progress. Finite distances account for fractional scroll positions on zoomed containers.

- [x] Add failing model/content tests for defaults, invalid durations, timed bursts, independent random samples including endpoints, exact small distances at high speed, bidirectional operation, edge completion, cancellation, and manual pause during rest.
- [x] Implement configuration, scrolling cadence, snapshot preservation, and progress messages; run unit tests.
- [x] Add popup mode selector, timed duration inputs, random range description, countdown, configuration persistence and locked controls while running.
- [x] Verify timed pauses and random limits in real Chromium, plus UI persistence and existing full round-trip tests.
- [x] Update README and version to 1.1.0, run syntax checks, package the extension and report reload instructions.

## Verification

- 22 unit tests pass, including variable speed, random range endpoints, manual pause/resume within rest and reverse phases, low-speed fractional progress, and quantized scroll positions.
- 17 real Chromium tests pass, including observed reverse movement in both directions, timed/random rests, hidden-field normalization, zoomed containers, all existing sequencing and worker recovery checks.
- Manifest, resource references and JavaScript syntax checks pass. Version 1.1.0 package generated.

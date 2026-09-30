# AutoScroll Implementation Plan

> Execute inline, task by task, with verification before completion. This directory is new and is not a Git repository, so no branch or commit steps apply.

**Goal:** A directly loadable Chrome extension that scrolls multiple URLs down in order and up in reverse, with adjustable speed and loops.

**Architecture:** MV3 service worker owns a persisted run cursor; an isolated content script owns one scroll segment. A popup sends commands and observes stored state. No runtime dependencies or build pipeline.

**Tech Stack:** JavaScript ES modules, HTML/CSS, Chrome APIs, node:test, Playwright for real extension integration tests.

## Tasks

- [x] `extension/model.js`, `tests/model.test.js`: write and run failing tests for URL normalization, range validation, A↓ B↓ C↓ C↑ B↑ A↑, single-page runs and bounded/unbounded loops; implement pure functions and rerun `npm test`.
- [x] `tests/browser.test.js`: launch a persistent Chromium context with the extension, serve local finite/short/dynamic/nested pages, capture segment boundaries and assert actual scroll positions; run to establish the missing-extension failure.
- [x] `extension/manifest.json`, `background.js`, `content.js`: implement serialized commands and lifecycle events, session storage, tab reuse, edge detection, live speed updates, cancellation and timeout/error handling. Run `npm run test:browser`.
- [x] `extension/popup.html`, `popup.css`, `popup.js`: implement Chinese URL editor, speed and loop controls, live progress, pause/resume/stop, current URL import and configuration persistence. Verify via real extension UI.
- [x] `README.md`, `scripts/check.js`, `scripts/package.js`: document loading `extension/`, usage and limits; validate syntax/manifest references and package a distributable zip without test dependencies.
- [x] Run `npm test`, `npm run check`, `npm run test:browser`, `npm run package`; inspect UI screenshot and final source for lifecycle/race issues. Report actual results and installation steps.

## Verification results

- 9 Node tests passed: configuration, sequencing, finite/infinite loops, hidden-tab frame handoff, fractional low-speed scrolling and style restoration.
- 12 real Chromium extension tests passed: two full three-page round trips, tab reuse, pause/resume, live speed, cancellation, lazy-loaded content, nested containers, invalid selectors, closed/reloaded tabs, closed popup, service worker restart and popup layout/config persistence.
- Independent review reproduced and verified the fixes for initial tab loading and hidden-tab scheduling. Headed Chromium with focus emulation disabled confirmed that scrolling continues after a tab becomes hidden, subject to browser throttling.
- Manifest/resource references and JavaScript syntax validated.

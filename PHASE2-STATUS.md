# Phase 2 checkpoint — 2026-09-05

Update 2026-09-06: Session Plan removed and number-entry blanks fixed across the controls. The Phase 2-only revised package is outputs/longland-timelapse-phase2-fixes-netlify and ZIP. User then approved starting Phase 3; current source now includes its first sequencer prototype. Continue from PHASE3-STATUS.md. The publication approval blocker below remains unresolved.

Implemented: editable shared/per-sample fades; threshold, percussive and local WebRTC speech detection; pre-roll and re-trigger delay; discard fix and visible result; original PCM preserved for fade re-export.

Verification: 19 automated tests passed. Tests cover 10 ms timing, threshold/onset logic, pre-roll/disarm, actual speech-fixture detection at 44.1/48 kHz, fades and sample overrides, WAV headers, incomplete-storage rejection, and discard isolation after reopening IndexedDB.

Browser checks passed using explicit debug inputs: microphone-test flow, 1/3/12 timed capture (4 clips, 3.97 s export with crossfades), fade re-export and overrides, discard, second-session startup, and percussive capture (3 quarter-second clips, 0.73 s export). Threshold capture reached Pause with retained audio; its final browser Resume check was interrupted when the browser test session reset. Real speech detection was verified in the worklet tests, not yet end-to-end in the browser.

Independent read-only review checked timing/export and reproduced exact finite frame budgets through pause/resume. It found a processor-error Stop deadlock; the corrected handler finalises received chunks directly rather than waiting for a failed processor.

Remaining acceptance: physical iPad/iPhone Safari microphone, Bluetooth routing, Share/Save and long-session tests; browser speech-mode and final threshold-resume checks. Do not describe these as verified. Speech classification may produce false positives/negatives, especially with headset processing. The final WAV still needs memory proportional to its file size.

Debug URLs: ?debug=1 for tone; ?debug=1&fixture=pulses for generated attacks; ?debug=1&fixture=speech for bundled upstream speech. Normal URLs use the microphone. Bundled detector source: https://github.com/OzymandiasTheGreat/libfvad-wasm (2.0.7); base library/fixture: https://github.com/dpirch/libfvad. Notices are in public/vendor/vad.

Resume from these saved source files; do not scaffold again. Phase 3 recognition/sequencer and later GUI review remain roadmap items.

## Handoff state

The final production build and TypeScript check passed. Phase 2 is committed locally. Upload-ready files are in the sibling outputs/longland-timelapse-phase2-netlify folder and ZIP; the Phase 1 package is preserved separately.

Phase 2 has NOT been deployed. Automatic approval review rejected pushing the source to the Sites backing repository, including after the native Sites tool confirmed the caller is owner and the issued repository name matches the selected project. Do not attempt another publication without resolving this approval. The existing hosted page remains version 3 (Phase 1 plus roadmap/text changes).

Selected site: https://longland-timelapse.panaphonic.chatgpt.site
Backing repository awaiting explicit approval: https://git.chatgpt-team.site/849314d2-5d7d-4634-a6d9-281ad3c03495/appgprj_6a9b4fae446881918f17da230abf5e15.git

Next work is bounded: complete the remaining browser checks above, obtain publication approval, push the saved source, package the successful static build with the Sites helper, save/deploy one version, and verify deployment status. No additional feature implementation or redesign is planned for this phase.

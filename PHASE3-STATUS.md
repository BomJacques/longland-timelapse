# Phase 3 checkpoint — 2026-09-06

Phase 2 fixes: Session Plan removed completely; a shared NumberInput preserves blank editing text, reports NaN for validation rather than silently converting blanks to zero, and accepts replacement decimals. Applied to capture, interval, duration, detectors and fade controls. Phase 2-only fixed build is separately preserved in outputs/longland-timelapse-phase2-fixes-netlify and its ZIP.

Phase 3 first slice: eight-step sequencer with enabled/rest steps, individual 0.01–5-second grabs, BPM/subdivisions or seconds timing. Repeating capture patterns use the existing foreground scheduler, with absolute targets and missed-slot reporting. Long grabs trim at the next enabled step. Absolute rounded frame boundaries prevent one-frame overlaps at fractional BPM. Captures remain separately recoverable in IndexedDB.

Sequence WAV export preserves scheduled positions, leading/intermediate/trailing rests and missed slots; shared and per-sample fades still work. It ignores concatenation crossfades and added gaps. The browser player loops the full sequence; each capture cycle contains fresh recorded audio. Stop stores active timeline duration; unfinished recovery uses the last saved sample as its endpoint. Silence is generated in bounded chunks; final Blob memory still grows with WAV size.

Verification so far: 25 automated tests passed, including new sequence mapping, subdivisions, wraparound, fractional-tempo frame boundaries, empty-value validation, actual WAV positions/fades/rests/header and unfinished recovery. TypeScript passed. Browser debug-tone run captured six samples (0.1/0.5/1 seconds repeated twice), zero missed, 3.20 seconds of raw audio in an eight-second WAV. Playback readyState 4, no reported error, loop enabled; actual Play worked. Fade edit/re-export retained eight-second duration. Backspace yielded an empty Capture, threshold and fade input; replacement decimal entry worked.

Additional browser verification: second session used seconds timing (0.25 seconds per step), a leading rest, manual stop, and a sustained pause/resume. Seven captures retained five seconds of raw audio. Stop while paused produced a playable 7.300104-second timeline, excluding paused wall-clock time, with zero missed captures.

Remaining: physical iPhone/iPad Safari, Bluetooth microphone routing, share/save and long-duration testing remain unverified, as in Phase 2. Sequencer start timing is subject to browser scheduler jitter; this is not a sample-accurate musical transport. Very fast steps require device testing.

Not implemented: hybrid scheduled sound qualification, keyword/phoneme/sound-class recognition, automatic tempo detection, time-stretching, reusable sample bank and independent playback arrangement. These are future Phase 3 experiments or Phase 4, not simulated features.

Final checks: all 25 automated tests, TypeScript, focused lint and the production build passed. The Phase 3 static output is packaged in outputs/longland-timelapse-phase3-netlify and its ZIP, independently of the preserved Phase 2 fixes package.

Publishing remains blocked by the prior automatic approval review. No retry or deployment without resolving the explicit repository-upload approval recorded in PHASE2-STATUS.md. The hosted Sites page remains Phase 1 plus roadmap. Local upload-ready packages are separate from the hosted page.

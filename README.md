# Longland Timelapse

Longland Timelapse is a private, browser-based audio recorder. It captures short windows from 0.01–5.00 seconds at a start-to-start interval, removes the waiting time, and produces one mono PCM16 WAV file. Audio stays on the device.

## Running

Microphone access requires HTTPS (or `localhost` during development).

```bash
npm install
npm run dev
```

The production build is static:

```bash
npm run test
npm run build
```

## Netlify

For the Phase 3 sequencer prototype, use the sibling `longland-timelapse-phase3-netlify` folder in `outputs`, or unzip `longland-timelapse-phase3-netlify.zip` and upload the extracted folder. The separate `longland-timelapse-phase2-fixes-netlify` folder/ZIP includes the Session Plan removal and editable blank number fields without the experimental sequencer. Its root contains `index.html`, `capture-processor.js`, `vendor`, and `_next`. Drag that folder to [Netlify Drop](https://app.netlify.com/drop). These files are already built; no build command is needed for this upload. The earlier `longland-timelapse-netlify` package remains the Phase 1 version.

For deployment from source, this repository includes `netlify.toml`: use `npm run build` and publish `dist/client`. No environment variables, functions, database, account system, or server are required.

## iPhone and iPad

1. Open the HTTPS site in Safari.
2. Connect AirPods or a Bluetooth earpiece before opening the recorder.
3. Tap **Test microphone**, grant permission, speak, and play the two-second test recording.
4. Confirm the input shown by Safari. iOS controls Bluetooth routing and may expose headset audio as mono, speech-bandwidth input.
5. Keep Safari foregrounded and keep the screen awake for the most reliable long session.

iOS can suspend browser JavaScript when Safari is backgrounded or the device locks. A website cannot bypass that operating-system restriction. Longland records missed schedule slots in its diagnostics and never creates a catch-up burst.

## Data and recovery

The default mode converts captured audio to PCM16 and stores bounded chunks in IndexedDB. If the page reloads, the app offers to finalise or discard the recoverable audio. Private browsing, Lockdown Mode, storage pressure, and a full device can limit browser storage. Very large WAV exports also remain subject to device memory and the WAV 4 GiB limit.

## Debug harness

Open the app with `?debug=1` to replace microphone input with a deterministic 440 Hz tone. This exercises the real audio worklet, scheduler, persistence, and WAV export paths without speaking. The automated tests cover the required 1 s / 3 s / 12 s and 2 s / 5 s / 20 s schedules, precision limits, missed-slot calculation, PCM conversion, crossfades, gaps, and WAV headers.

## Phase 2: fades, threshold, percussive and speech detection

Implemented in the Phase 2 source: independent fade-in and fade-out envelopes, editable from 0 to 5,000 ms with numeric entries and sliders, linear or smooth curves, linked lengths and Fades off. Shared fades apply to each sample. After Stop, Edit sample fades also supports individual sample overrides. Apply fades & update preview rebuilds the combined WAV from the original PCM; until Apply, playback and download use the last applied settings.

Fades are non-destructive and separate from inter-sample crossfades. Fades longer than a short or partial sample are shortened proportionally, with a visible notice. The capture range remains 0.01–5.00 seconds.

Implemented recording modes (alongside the original Timed mode):

- **Threshold:** capture on crossing an adjustable digital input level in dBFS. This is not a calibrated sound-pressure measurement.
- **Percussive:** capture sharp attacks using recent amplitude contrast and a minimum input threshold, both editable.
- **Speech detection:** bundled WebRTC/libfvad WebAssembly voice activity detection with adjustable sensitivity. Audio stays local; it does not recognise words or transcribe. Noise and music can cause false detections.

Triggered recording includes an editable circular pre-roll buffer, limited to half the sample length and 500 ms. Pre-roll is included within Capture length. Re-trigger delay begins after capture finishes; events during a capture or this delay are ignored. Sustained threshold/speech activity must fall quiet before triggering again. Pause freezes the session clock and clears detection history. Phase 2 is limited to fades and these three modes; the features below are later experiments.

The discard fix deletes chunk primary keys in one transaction and reports how many other recordings remain. New session preserves saved audio until explicitly discarded.

See PHASE2-STATUS.md for verification and remaining device checks.

## Phase 3: experimental recognition and sequencing

The first Phase 3 prototype is implemented: an eight-step capture/playback sequencer, selected from Recording mode. Each step is a grab or rest with its own 0.01–5-second length. Set manual BPM (20–300) and 1/2/4 steps per beat, or explicit step spacing (0.01–30 seconds). The first selection defaults to an eight-second trial; the pattern repeats until For expires or you stop.

Samples are trimmed at the next enabled step, including loop wrap; captures do not overlap. Phase 2 fades and per-sample overrides apply non-destructively. Playback and WAV retain scheduled sample positions and all rests, including leading/trailing silence. The player loops the whole recorded sequence. Transition/gap controls are hidden and ignored in this mode. Each cycle records fresh audio, rather than reusing a sample bank.

The sequence uses the existing foreground scheduler and sample-frame capture gate. Start times can have browser scheduling jitter; it is not a sample-accurate transport or a background recorder. Missed slots remain silent, never caught up in a burst. Pausing freezes the pattern clock. Recovery uses saved capture positions; if a crash occurs before the end is stored, export stops after the last saved sample.

Pattern WAVs include waiting time, unlike ordinary timelapse: approximately 5.8 MB/minute at 48 kHz mono PCM16. RIFF and browser memory limits still apply.

Remaining Phase 3 experiments (not implemented):

- **Keyword or phoneme trigger:** an optional on-device model for specific words or sound classes. Frequency-only “consonant detection” would be unreliable, especially after Bluetooth headset noise reduction, so this should not ship without measured model accuracy and clear privacy/performance limits.
- **Hybrid timelapse:** combine the scheduled windows with sound qualification, retaining only events that satisfy the selected trigger.
- **Sequencer development:** independent playback arrangement, reusable sample bank, pattern-file import/export and automatic tempo detection. Manual timing already works in the prototype.

A larger sequencer, automatic tempo analysis and time-stretching can become Phase 4. Targeted word/phoneme recognition needs a separately evaluated on-device model; speech activity detection alone does not provide it.

## Later-stage GUI review

Revisit the graphical interface as the later features take shape. Review the recording controls and mode selection, editable fade envelopes, threshold and speech/percussive feedback, then prototype the drum-machine-style capture/playback grid. Check touch interaction and readability on phone and tablet, and make recording, waiting and playback states easy to distinguish. Explore the layouts with the user before committing to a substantial redesign. The current step grid is a functional prototype, not the final GUI redesign.

## Architecture

- One persistent `MediaStream` and `AudioContext` per session.
- An `AudioWorklet` downmixes to mono and enforces capture duration in audio sample frames.
- Absolute `performance.now()` targets prevent cumulative interval drift.
- User pause freezes the active schedule; page suspension does not.
- PCM16 chunks are persisted incrementally and assembled chronologically into one WAV.
- Web Share is used for the iOS share sheet when file sharing is supported; an ordinary save link is the fallback.

# Longland Timelapse release audit

| Issue | Found by | Severity | Fix | Verified |
| --- | --- | --- | --- | --- |
| Test capture used the worklet's negative inactive sentinel | Astra audit | P1 | Dedicated positive test capture ID | Worklet VM test and browser test playback |
| Resume from a pause while waiting remained in `paused` | Astra audit | P1 | Transition to `waiting` before rescheduling | Browser pause/resume run completed 3/3 captures |
| Export retained and explicitly copied all PCM | Astra audit | P1 | `ReadableStream` export keeps only adjacent clips in JS memory and avoids `slice` copies | Source inspection, typecheck, playable 1.48 s WAV |
| Suspended `AudioContext` could strand capture/Stop | Astra audit | P1 | Cancel interrupted gate, preserve committed PCM, require a user Resume tap, then skip expired slots | State-path inspection and typecheck |
| Initialisation failure could orphan a context or mic stream | Final review / Astra audit | P1 | Start permission promises during user activation, await all outcomes, and close/stop every failure branch | Source inspection and typecheck |
| Fast hide/show could race an old completion with a new capture | Final review / Astra audit | P1 | Do not reschedule while a capture record is pending; reject mismatched completion IDs | Source inspection and typecheck |
| Reload mid-capture could leave chunks with stale zero-frame metadata | Lead audit | P1 | Recovery scans chunk sizes and reconstructs partial capture metadata | Recovery-path inspection and typecheck |
| Fixed lateness tolerance permitted very short stale slots | Astra audit | P2 | Grace is capped at 25% of the configured interval | Timing tests and source inspection |
| Session deletion loaded all audio before deleting | Astra audit | P2 | Delete by IndexedDB key cursor | Source inspection and typecheck |
| Static publish directory was questioned during an in-progress build | Final review | P1 | Static export and Netlify publish both target `dist/client` | Successful production build; `dist/client/index.html` present |

Physical iPhone/iPad Safari testing remains a device acceptance step. Browser automation used the synthetic debug source and does not claim to reproduce iOS suspension or Bluetooth routing behavior.

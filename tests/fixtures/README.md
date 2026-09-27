# Speech detector fixture

`speech16.wav` is the unmodified `audio_tiny16.wav` test fixture from
https://github.com/dpirch/libfvad/tree/master/tests/data (downloaded 2026-09-05).
It is distributed with libfvad's WebRTC-derived BSD license and notices;
see `public/vendor/vad/LICENSE.txt`, `AUTHORS.txt`, and `PATENTS.txt`.
The browser debug harness serves a copy only when explicitly started with
`?debug=1&fixture=speech`. Production microphone input is never replaced by it.

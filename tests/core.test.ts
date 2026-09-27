import test from 'node:test';
import assert from 'node:assert/strict';
import {
  floatToPcm16, nextFutureCaptureIndex, plannedCaptureCount, renderPcm,
  scheduledTargets, secondsToFrames, validateSettings, wavHeader,
  type RecorderSettings,
} from '../lib/audio-core.ts';

const settings: RecorderSettings = {
  captureSeconds: 2, intervalSeconds: 30, durationValue: 1, durationUnit: 'hours',
  manualStop: false, transitionMs: 10, gapMs: 0, keepAwake: true, persist: true, deviceId: '',
};

await test('accepts every hundredth from 0.01 through 5 seconds', () => {
  for (let hundredths = 1; hundredths <= 500; hundredths += 1) {
    assert.equal(validateSettings({ ...settings, captureSeconds: hundredths / 100, intervalSeconds: 5 }), null);
  }
  assert.match(validateSettings({ ...settings, captureSeconds: 0.009 }) ?? '', /between/);
  assert.match(validateSettings({ ...settings, captureSeconds: 5.01, intervalSeconds: 6 }) ?? '', /between/);
});

await test('enforces start-to-start interval and endpoint semantics', () => {
  assert.deepEqual(scheduledTargets(12, 3), [0, 3, 6, 9]);
  assert.deepEqual(scheduledTargets(20, 5), [0, 5, 10, 15]);
  assert.equal(plannedCaptureCount(60, 10), 6);
  assert.equal(plannedCaptureCount(8 * 3600, 30), 960);
  assert.equal(validateSettings({ ...settings, captureSeconds: 5, intervalSeconds: 4 }), 'Capture length must be shorter than or equal to the capture interval.');
  assert.equal(validateSettings({ ...settings, captureSeconds: 5, intervalSeconds: 5 }), null);
});

await test('skips elapsed slots rather than creating a catch-up burst', () => {
  assert.equal(nextFutureCaptureIndex(17, 5), 4);
  assert.equal(nextFutureCaptureIndex(22.01, 5), 5);
});

await test('converts requested precision to audio frames', () => {
  assert.equal(secondsToFrames(0.01, 48000), 480);
  assert.equal(secondsToFrames(5, 44100), 220500);
});

await test('PCM conversion clips and handles non-finite values', () => {
  assert.deepEqual([...floatToPcm16(new Float32Array([-2, -1, -.5, 0, .5, 1, 2, Number.NaN]))], [-32768, -32768, -16384, 0, 16384, 32767, 32767, 0]);
});

await test('crossfade and gap output have exact lengths', () => {
  const a = new Int16Array(100).fill(1000);
  const b = new Int16Array(100).fill(2000);
  assert.equal(renderPcm([a, b], 1000, 10, 0).length, 190);
  assert.equal(renderPcm([a, b], 1000, 10, 50).length, 250);
});

await test('WAV header is structurally correct', () => {
  const view = new DataView(wavHeader(96000, 48000));
  const text = (offset: number) => String.fromCharCode(...Array.from({ length: 4 }, (_, i) => view.getUint8(offset + i)));
  assert.equal(text(0), 'RIFF'); assert.equal(text(8), 'WAVE'); assert.equal(text(36), 'data');
  assert.equal(view.getUint32(24, true), 48000); assert.equal(view.getUint32(28, true), 96000);
  assert.equal(view.getUint32(40, true), 96000);
});

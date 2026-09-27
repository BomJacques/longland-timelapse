import test from 'node:test';
import assert from 'node:assert/strict';
import { captureFrameBudget, captureSlot, defaultSequence, scheduledCount, validateSequence } from '../lib/sequence-core.ts';
import { PHASE2_DEFAULTS, validateSettings, type RecorderSettings } from '../lib/audio-core.ts';
import { exportWav } from '../lib/export-engine.ts';
import type { StoredSession } from '../lib/session-store.ts';

const settings = (): RecorderSettings => ({
  ...PHASE2_DEFAULTS, recordingMode: 'sequence', sequence: defaultSequence(),
  captureSeconds: 2, intervalSeconds: 30, durationValue: 8, durationUnit: 'seconds',
  manualStop: false, transitionMs: 100, gapMs: 500, keepAwake: false, persist: true, deviceId: '',
});

await test('sequence maps enabled steps and repeats without collapsing rests', () => {
  const config = settings();
  assert.deepEqual(Array.from({ length: 6 }, (_, index) => captureSlot(config, index).targetSeconds), [0, 1, 3, 4, 5, 7]);
  assert.deepEqual(Array.from({ length: 3 }, (_, index) => captureSlot(config, index).seconds), [.1, .5, 1]);
  assert.equal(scheduledCount(config, 8), 6);
  assert.equal(scheduledCount(config, 3), 2);
  assert.equal(scheduledCount(config, 3.01), 3);
  assert.equal(scheduledCount(config, null), null);
  config.sequence!.steps[0].enabled = false;
  assert.equal(captureSlot(config, 0).targetSeconds, 1);
});

await test('tempo subdivisions, seconds and wraparound trimming use exact absolute targets', () => {
  const config = settings();
  config.sequence!.stepsPerBeat = 4;
  assert.equal(captureSlot(config, 1).targetSeconds, .25);
  assert.equal(captureSlot(config, 2).seconds, .25);
  config.sequence!.timing = 'seconds'; config.sequence!.stepSeconds = .01;
  config.sequence!.steps.forEach(step => { step.enabled = true; step.captureSeconds = 5; });
  for (const index of [0, 7, 8, 10000]) {
    assert.equal(captureSlot(config, index).targetSeconds, index * .01);
    assert.equal(captureSlot(config, index).seconds, .01);
  }
});

await test('empty entries cannot silently become zero or start an invalid sequence', () => {
  const config = settings();
  for (const key of ['bpm', 'stepSeconds'] as const) {
    config.sequence!.timing = key === 'bpm' ? 'tempo' : 'seconds';
    const previous = config.sequence![key]; config.sequence![key] = NaN;
    assert.ok(validateSettings(config)); config.sequence![key] = previous;
  }
  config.sequence!.steps[0].captureSeconds = NaN;
  assert.match(validateSettings(config) ?? '', /capture length/);
  config.sequence!.steps.forEach(step => { step.enabled = false; });
  assert.match(validateSequence(config.sequence!) ?? '', /Enable/);
  assert.match(validateSettings({ ...config, recordingMode: 'timed', captureSeconds: NaN }) ?? '', /Capture length/);
});

await test('fractional BPM frame budgets never overlap or exceed a finite endpoint', () => {
  const config = settings();
  config.sequence!.bpm = 137; config.sequence!.stepsPerBeat = 4;
  config.sequence!.steps.forEach(step => { step.enabled = true; step.captureSeconds = 5; });
  for (const rate of [44100, 48000]) for (let index = 0; index < 500; index++) {
    const start = Math.round(captureSlot(config, index).targetSeconds * rate);
    const end = Math.round(captureSlot(config, index + 1).targetSeconds * rate);
    assert.ok(start + captureFrameBudget(config, index, rate, null) <= end);
  }
  assert.equal(captureFrameBudget(config, 0, 48000, .01), 480);
});

await test('sequence WAV preserves leading, intermediate, missed and trailing rests plus fades', async () => {
  const config = settings();
  config.fadeInMs = 2; config.fadeOutMs = 2;
  const session: StoredSession = {
    id: 'pattern', name: 'test', createdAt: '', updatedAt: '', status: 'complete',
    settings: config, sampleRate: 1000, timelineSeconds: 4, totalFrames: 200, missed: 1, browser: 'test',
    captures: [0, 1, 2].map(index => ({
      index, targetMs: (index + 1) * 1000, frames: index === 1 ? 0 : 100, expectedFrames: 100,
      actualStartMs: null, actualEndMs: null, driftMs: null, outcome: index === 1 ? 'missed' : 'completed',
    })),
    fadeOverrides: { 2: { fadeInMs: 0, fadeOutMs: 0, fadeCurve: 'linear' } },
  };
  const raw = new Int16Array(100).fill(1000);
  const output = await (await exportWav(session, async index => [{
    id: String(index), sessionId: session.id, captureIndex: index, seq: index, samples: raw.buffer,
  }], () => {})).arrayBuffer();
  const pcm = new Int16Array(output, 44);
  assert.equal(new DataView(output).getUint32(40, true), 8000);
  assert.equal(pcm.length, 4000);
  assert.ok(pcm.subarray(0, 1000).every(sample => sample === 0));
  assert.equal(pcm[1000], 0); assert.equal(pcm[1002], 1000); assert.equal(pcm[1099], 0);
  assert.ok(pcm.subarray(1100, 3000).every(sample => sample === 0));
  assert.equal(pcm[3000], 1000);
  assert.ok(pcm.subarray(3100).every(sample => sample === 0));
  assert.equal(raw[0], 1000);
  await assert.rejects(exportWav(session, async () => [], () => {}), /incomplete/);
});

await test('sequence recovery without a saved end retains audio through the last sample', async () => {
  const session: StoredSession = {
    id: 'recovered', name: 'test', createdAt: '', updatedAt: '', status: 'complete',
    settings: settings(), sampleRate: 1000, totalFrames: 10, missed: 0, browser: 'test',
    captures: [{ index: 0, targetMs: 500, frames: 10, expectedFrames: 100, actualStartMs: null, actualEndMs: null, driftMs: null, outcome: 'partial' }],
  };
  const blob = await exportWav(session, async () => [{ id: 'c', sessionId: session.id, captureIndex: 0, seq: 0, samples: new Int16Array(10).fill(1000).buffer }], () => {});
  assert.equal(blob.size, 44 + 510 * 2);
});

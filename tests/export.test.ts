import test from 'node:test';
import assert from 'node:assert/strict';
import { applySampleFades, fadeLengths, phase2Settings, validateSettings } from '../lib/audio-core.ts';
import { exportWav } from '../lib/export-engine.ts';
import type { StoredSession, StoredChunk } from '../lib/session-store.ts';

await test('independent fade durations and smooth curves fit short samples without changing frame count', () => {
  const pcm = new Int16Array(10).fill(1000);
  const fades = { fadeInMs: 4, fadeOutMs: 2, fadeCurve: 'linear' as const };
  assert.deepEqual([...applySampleFades(pcm, 1000, fades)], [0,333,667,1000,1000,1000,1000,1000,1000,0]);
  assert.deepEqual(fadeLengths(10, 1000, { ...fades, fadeInMs: 20, fadeOutMs: 20 }), { fadeIn: 5, fadeOut: 5, limited: true });
  const smooth = applySampleFades(new Int16Array(5).fill(1000), 1000, { fadeInMs: 5, fadeOutMs: 0, fadeCurve: 'smooth' });
  assert.deepEqual([...smooth], [0,156,500,844,1000]);
});

function fixture() {
  const settings = { ...phase2Settings({}), captureSeconds: .1, intervalSeconds: 1, durationValue: 2, durationUnit: 'seconds' as const, manualStop: false, transitionMs: 0, gapMs: 0, keepAwake: false, persist: true, deviceId: '', fadeInMs: 10, fadeOutMs: 20 };
  const session: StoredSession = { id: 'export', name: 'test', createdAt: '', updatedAt: '', status: 'complete', settings, sampleRate: 1000, totalFrames: 200, missed: 0, browser: 'test', captures: [0,1].map(index => ({ index, frames: 100, expectedFrames: 100, targetMs: index * 1000, actualStartMs: index * 1000, actualEndMs: index * 1000 + 100, driftMs: 0, outcome: 'completed' })) };
  const chunks: StoredChunk[] = [0,1].map(index => ({ id: String(index), sessionId: 'export', seq: index, captureIndex: index, samples: new Int16Array(100).fill(1000).buffer }));
  return { session, chunks };
}

await test('actual WAV exporter applies per-sample overrides non-destructively and emits exact headers', async () => {
  const { session, chunks } = fixture();
  session.fadeOverrides = { 1: { fadeInMs: 0, fadeOutMs: 0, fadeCurve: 'linear' } };
  const blob = await exportWav(session, async index => [chunks[index]], () => {});
  const bytes = await blob.arrayBuffer(); const header = new DataView(bytes); const samples = new Int16Array(bytes, 44);
  assert.equal(header.getUint32(40, true), bytes.byteLength - 44);
  assert.equal(samples.length, 200); assert.equal(samples[0], 0); assert.equal(samples[99], 0); assert.equal(samples[100], 1000);
  assert.equal(new Int16Array(chunks[0].samples)[0], 1000);
  for (const gap of [0,50]) {
    session.settings.transitionMs = 10; session.settings.gapMs = gap;
    const output = await (await exportWav(session, async index => [chunks[index]], () => {})).arrayBuffer();
    assert.equal(new DataView(output).getUint32(40, true), output.byteLength - 44);
    assert.equal((output.byteLength - 44) / 2, gap ? 250 : 190);
  }
});

await test('export refuses mismatched stored frames instead of emitting a corrupt WAV', async () => {
  const { session } = fixture();
  await assert.rejects(exportWav(session, async () => [], () => {}), /incomplete/);
  assert.match(validateSettings({ ...session.settings, fadeInMs: NaN }) ?? '', /Fade/);
  assert.equal(validateSettings({ ...session.settings, recordingMode: 'threshold', captureSeconds: 5, intervalSeconds: 1 }), null);
});

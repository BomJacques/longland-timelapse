import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function loadProcessor(rate = 48000) {
  let Processor;
  class AudioWorkletProcessor {
    constructor() {
      this.messages = [];
      this.port = { onmessage: null, postMessage: (message) => this.messages.push(message) };
    }
  }
  const context = { AudioWorkletProcessor, Float32Array, Int16Array, WebAssembly, sampleRate: rate, registerProcessor: (_name, implementation) => { Processor = implementation; } };
  vm.runInNewContext(readFileSync(new URL('../public/capture-processor.js', import.meta.url), 'utf8'), context);
  return new Processor();
}

await test('worklet captures exactly 10 ms at 48 kHz frame budget', () => {
  const processor = loadProcessor();
  processor.port.onmessage({ data: { type: 'start', captureIndex: 0, frameCount: 480 } });
  while (!processor.messages.some((message) => message.type === 'complete')) {
    processor.process([[new Float32Array(128).fill(0.25)]], [[new Float32Array(128)]]);
  }
  const complete = processor.messages.find((message) => message.type === 'complete');
  const frames = processor.messages.filter((message) => message.type === 'chunk').reduce((sum, message) => sum + message.samples.byteLength / 4, 0);
  assert.equal(complete.frames, 480);
  assert.equal(frames, 480);
});

const arm = (p, config = {}) => p.port.onmessage({ data: { type: 'arm', recordingMode: 'threshold', captureIndex: 0, frameCount: 4800, preRollMs: 20, retriggerMs: 100, thresholdDb: -20, onsetDb: 9, speechMode: 2, sessionFrames: 480000, ...config } });
function feed(p, frames, value) {
  for (let offset = 0; offset < frames; offset += 128) {
    const length = Math.min(128, frames - offset);
    const input = Float32Array.from({ length }, (_, i) => typeof value === 'function' ? value(offset + i) : value);
    p.process([[input]], [[new Float32Array(length)]]);
  }
}

await test('threshold retains chronological pre-roll, exact duration, and does not re-trigger sustained sound', () => {
  const p = loadProcessor(); arm(p);
  feed(p, 14400, 0); feed(p, 9600, .3);
  assert.equal(p.messages.filter(m => m.type === 'trigger').length, 1);
  const chunks = p.messages.filter(m => m.type === 'chunk').flatMap(m => [...new Float32Array(m.samples)]);
  assert.equal(chunks.length, 4800); assert.equal(chunks[0], 0); assert.ok(chunks.at(-1) > .29);
  arm(p, { captureIndex: 1 }); feed(p, 24000, .3);
  assert.equal(p.messages.filter(m => m.type === 'trigger').length, 1);
  feed(p, 9600, 0); feed(p, 9600, .3);
  assert.equal(p.messages.filter(m => m.type === 'trigger').length, 2);
});

await test('percussive detector rejects a gradual rise and captures a sharp attack', () => {
  const p = loadProcessor(); arm(p, { recordingMode: 'percussive', thresholdDb: -30 });
  feed(p, 48000, i => .01 + .04 * i / 48000);
  assert.equal(p.messages.filter(m => m.type === 'trigger').length, 0);
  feed(p, 9600, .5);
  assert.equal(p.messages.filter(m => m.type === 'trigger').length, 1);
});

await test('disarm blocks triggers and clears pre-roll; re-arm resumes cleanly', () => {
  const p = loadProcessor(); arm(p); feed(p, 4800, .05);
  p.port.onmessage({ data: { type: 'disarm' } }); feed(p, 48000, .9);
  assert.equal(p.messages.filter(m => m.type === 'trigger').length, 0);
  arm(p); feed(p, 9600, .2);
  const first = p.messages.find(m => m.type === 'chunk');
  assert.ok([...new Float32Array(first.samples)].every(x => x < .21));
});

await test('armed silence ends at the finite audio deadline without inventing captures', () => {
  const p = loadProcessor(); arm(p, { sessionFrames: 480 }); feed(p, 960, 0);
  assert.equal(p.messages.filter(m => m.type === 'session-ended').length, 1);
  assert.equal(p.messages.filter(m => m.type === 'trigger').length, 0);
});

await test('speech detector loads the shipped WASM and rejects silence at 44.1 and 48 kHz', async () => {
  for (const rate of [44100, 48000]) {
    const p = loadProcessor(rate);
    await p.initVad(readFileSync(new URL('../public/vendor/vad/libfvad.wasm', import.meta.url)), 2);
    assert.ok(p.messages.some(m => m.type === 'vad-ready'));
    arm(p, { recordingMode: 'speech', frameCount: rate / 10 });
    feed(p, rate, 0);
    assert.equal(p.messages.filter(m => m.type === 'trigger').length, 0);
    assert.ok(!p.messages.some(m => m.type === 'vad-error'));
  }
});

await test('speech detector triggers on the upstream speech fixture through real resampling', async () => {
  const wav = readFileSync(new URL('./fixtures/speech16.wav', import.meta.url));
  let offset = 12, pcm;
  while (offset + 8 <= wav.length) {
    const size = wav.readUInt32LE(offset + 4);
    if (wav.toString('ascii', offset, offset + 4) === 'data') { pcm = wav.subarray(offset + 8, offset + 8 + size); break; }
    offset += 8 + size + (size % 2);
  }
  assert.ok(pcm);
  for (const rate of [44100, 48000]) {
    const p = loadProcessor(rate);
    await p.initVad(readFileSync(new URL('../public/vendor/vad/libfvad.wasm', import.meta.url)), 2);
    arm(p, { recordingMode: 'speech', frameCount: Math.round(rate * .5), sessionFrames: rate * 10 });
    feed(p, Math.floor(pcm.length / 2 * rate / 16000), i => pcm.readInt16LE(Math.min(pcm.length / 2 - 1, Math.floor(i * 16000 / rate)) * 2) / 32768);
    assert.ok(p.messages.some(m => m.type === 'trigger'), 'speech must be detected at ' + rate);
    assert.ok(p.messages.some(m => m.type === 'complete'));
    assert.ok(!p.messages.some(m => m.type === 'vad-error'));
  }
});

await test('microphone test capture ID is a valid active capture', () => {
  const processor = loadProcessor();
  processor.port.onmessage({ data: { type: 'start', captureIndex: 2147483647, frameCount: 960 } });
  for (let index = 0; index < 20 && !processor.messages.some((message) => message.type === 'complete'); index += 1) {
    processor.process([[new Float32Array(128).fill(0.1)]], [[new Float32Array(128)]]);
  }
  assert.equal(processor.messages.find((message) => message.type === 'complete')?.frames, 960);
});

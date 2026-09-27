import test from 'node:test';
import assert from 'node:assert/strict';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
import { SessionStore, type StoredSession } from '../lib/session-store.ts';
Object.assign(globalThis, { window: { indexedDB }, indexedDB, IDBKeyRange });

await test('discard deletes all PCM chunks by primary key, keeps other sessions, and survives reopening', async () => {
  const store = new SessionStore(); await store.open();
  const session = (id: string): StoredSession => ({ id, name: id, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: 'complete', settings: { captureSeconds: 1, intervalSeconds: 5, durationValue: 1, durationUnit: 'minutes', manualStop: false, transitionMs: 0, gapMs: 0, keepAwake: false, persist: true, deviceId: '' }, sampleRate: 48000, captures: [], totalFrames: 0, missed: 0, browser: 'test' });
  for (const id of ['discard', 'keep']) {
    await store.putSession(session(id));
    for (let seq = 0; seq < 3; seq++) await store.putChunk({ id: `${id}:${seq}`, sessionId: id, seq, captureIndex: seq, samples: new Int16Array([1, 2, 3]).buffer });
  }
  await store.deleteSession('discard');
  const reopened = new SessionStore(); await reopened.open();
  assert.equal(await reopened.getSession('discard'), null);
  assert.equal((await reopened.chunksFor('discard')).length, 0);
  assert.equal((await reopened.chunksFor('keep')).length, 3);
  assert.deepEqual((await reopened.recoverable()).map(s => s.id), ['keep']);
  await reopened.deleteSession('discard'); // Repeated clicks are harmless.
});

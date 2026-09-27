import type { CaptureRecord, RecorderSettings, FadeSettings } from './audio-core.ts';

export interface StoredSession {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  status: 'active' | 'finalizable' | 'complete';
  settings: RecorderSettings;
  sampleRate: number;
  captures: CaptureRecord[];
  missed: number;
  totalFrames: number;
  timelineSeconds?: number;
  browser: string;
  fadeOverrides?: Record<number, FadeSettings>;
}

export interface StoredChunk {
  id: string;
  sessionId: string;
  seq: number;
  captureIndex: number;
  samples: ArrayBuffer;
}

const DB_NAME = 'longland-timelapse';
const DB_VERSION = 2;

export class SessionStore {
  private db: IDBDatabase | null = null;
  private memorySessions = new Map<string, StoredSession>();
  private memoryChunks = new Map<string, StoredChunk[]>();
  usingMemory = false;

  async open() {
    if (!('indexedDB' in window)) { this.usingMemory = true; return; }
    try {
      this.db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions', { keyPath: 'id' });
          const chunks = db.objectStoreNames.contains('chunks')
            ? request.transaction!.objectStore('chunks')
            : db.createObjectStore('chunks', { keyPath: 'id' });
          if (!chunks.indexNames.contains('sessionId')) chunks.createIndex('sessionId', 'sessionId');
          if (!chunks.indexNames.contains('sessionCapture')) chunks.createIndex('sessionCapture', ['sessionId', 'captureIndex']);
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } catch {
      this.usingMemory = true;
    }
  }

  private async tx<T>(store: 'sessions' | 'chunks', mode: IDBTransactionMode, action: (objectStore: IDBObjectStore) => IDBRequest<T>) {
    if (!this.db) throw new Error('IndexedDB unavailable');
    return new Promise<T>((resolve, reject) => {
      const transaction = this.db!.transaction(store, mode);
      const request = action(transaction.objectStore(store));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(transaction.error ?? request.error);
      transaction.onabort = () => reject(transaction.error ?? new Error('Storage transaction aborted'));
    });
  }

  async putSession(session: StoredSession) {
    session.updatedAt = new Date().toISOString();
    if (this.usingMemory) { this.memorySessions.set(session.id, structuredClone(session)); return; }
    await this.tx('sessions', 'readwrite', (store) => store.put(session));
  }

  async putChunk(chunk: StoredChunk) {
    if (this.usingMemory) {
      const items = this.memoryChunks.get(chunk.sessionId) ?? [];
      items.push({ ...chunk, samples: chunk.samples.slice(0) });
      this.memoryChunks.set(chunk.sessionId, items);
      return;
    }
    await this.tx('chunks', 'readwrite', (store) => store.put(chunk));
  }

  async getSession(id: string) {
    if (this.usingMemory) return this.memorySessions.get(id) ?? null;
    return (await this.tx<StoredSession | undefined>('sessions', 'readonly', (store) => store.get(id))) ?? null;
  }

  async recoverable() {
    const sessions = this.usingMemory
      ? [...this.memorySessions.values()]
      : await this.tx<StoredSession[]>('sessions', 'readonly', (store) => store.getAll());
    return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async chunksFor(sessionId: string) {
    const chunks = this.usingMemory
      ? this.memoryChunks.get(sessionId) ?? []
      : await this.tx<StoredChunk[]>('chunks', 'readonly', (store) => store.index('sessionId').getAll(sessionId));
    return chunks.sort((a, b) => a.seq - b.seq);
  }

  async chunksForCapture(sessionId: string, captureIndex: number) {
    if (this.usingMemory) return (this.memoryChunks.get(sessionId) ?? []).filter((chunk) => chunk.captureIndex === captureIndex).sort((a, b) => a.seq - b.seq);
    const chunks = await this.tx<StoredChunk[]>('chunks', 'readonly', (store) => store.index('sessionCapture').getAll(IDBKeyRange.only([sessionId, captureIndex])));
    return chunks.sort((a, b) => a.seq - b.seq);
  }

  async summarizeChunks(sessionId: string) {
    const summary = new Map<number, number>();
    if (this.usingMemory) {
      for (const chunk of this.memoryChunks.get(sessionId) ?? []) summary.set(chunk.captureIndex, (summary.get(chunk.captureIndex) ?? 0) + chunk.samples.byteLength / 2);
      return summary;
    }
    if (!this.db) return summary;
    await new Promise<void>((resolve, reject) => {
      const transaction = this.db!.transaction('chunks', 'readonly');
      const request = transaction.objectStore('chunks').index('sessionId').openCursor(IDBKeyRange.only(sessionId));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        const chunk = cursor.value as StoredChunk;
        summary.set(chunk.captureIndex, (summary.get(chunk.captureIndex) ?? 0) + chunk.samples.byteLength / 2);
        cursor.continue();
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    return summary;
  }

  async deleteSession(sessionId: string) {
    if (this.usingMemory) { this.memorySessions.delete(sessionId); this.memoryChunks.delete(sessionId); return; }
    await new Promise<void>((resolve, reject) => {
      const transaction = this.db!.transaction(['sessions', 'chunks'], 'readwrite');
      transaction.objectStore('sessions').delete(sessionId);
      const request = transaction.objectStore('chunks').index('sessionId').openKeyCursor(IDBKeyRange.only(sessionId));
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          // Key-only cursors cannot call cursor.delete(). Delete by primary key
          // to avoid loading the potentially large PCM value into memory.
          transaction.objectStore('chunks').delete(cursor.primaryKey);
          cursor.continue();
        }
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error ?? new Error('Audio discard was interrupted. Try again.'));
    });
  }
}

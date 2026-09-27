import { applySampleFades, phase2Settings, wavHeader } from './audio-core.ts';
import type { StoredChunk, StoredSession } from './session-store.ts';

/** Pull-based export keeps at most two PCM clips in working memory. */
export async function exportWav(session: StoredSession, readCapture: (index: number) => Promise<StoredChunk[]>, progress: (value: number) => void) {
  if (session.settings.recordingMode === 'sequence') return exportSequenceWav(session, readCapture, progress);
  const records = session.captures.filter((r) => r.frames > 0 && r.outcome !== 'missed' && r.outcome !== 'failed');
  const transition = Math.round(session.sampleRate * session.settings.transitionMs / 1000);
  const gap = Math.round(session.sampleRate * session.settings.gapMs / 1000);
  let frames = records.reduce((sum, r) => sum + r.frames, 0);
  if (gap) frames += gap * Math.max(0, records.length - 1);
  else {
    let previous = records[0]?.frames ?? 0;
    for (let i = 1; i < records.length; i++) {
      const overlap = Math.min(transition, Math.floor(previous / 2), Math.floor(records[i].frames / 2));
      frames -= overlap; previous = records[i].frames - overlap;
    }
  }
  async function* parts() {
    yield new Uint8Array(wavHeader(frames * 2, session.sampleRate));
    let previous: Int16Array | null = null;
    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      const chunks = await readCapture(record.index);
      const length = chunks.reduce((sum, c) => sum + c.samples.byteLength / 2, 0);
      if (length !== record.frames) throw new Error('Stored audio is incomplete. Use session recovery to rebuild its index before exporting.');
      const clip = new Int16Array(length); let offset = 0;
      for (const chunk of chunks) { const pcm = new Int16Array(chunk.samples); clip.set(pcm, offset); offset += pcm.length; }
      applySampleFades(clip, session.sampleRate, session.fadeOverrides?.[record.index] ?? phase2Settings(session.settings));
      if (gap) {
        const fade = Math.min(transition, Math.floor(clip.length / 2));
        for (let j = 0; j < fade; j++) {
          const gain = fade === 1 ? 0.5 : j / (fade - 1);
          clip[j] = Math.round(clip[j] * gain); clip[clip.length - 1 - j] = Math.round(clip[clip.length - 1 - j] * gain);
        }
        if (i > 0) yield new Uint8Array(gap * 2);
        yield new Uint8Array(clip.buffer);
      } else if (!previous) previous = clip;
      else {
        const overlap = Math.min(transition, Math.floor(previous.length / 2), Math.floor(clip.length / 2));
        yield new Uint8Array(previous.buffer, previous.byteOffset, (previous.length - overlap) * 2);
        if (overlap) {
          const blended = new Int16Array(overlap);
          for (let j = 0; j < overlap; j++) {
            const gain = overlap === 1 ? 0.5 : j / (overlap - 1);
            blended[j] = Math.max(-32768, Math.min(32767, Math.round(previous[previous.length - overlap + j] * (1 - gain) + clip[j] * gain)));
          }
          yield new Uint8Array(blended.buffer);
        }
        previous = clip.subarray(overlap);
      }
      progress(Math.round((i + 1) / Math.max(1, records.length) * 100));
      if (i % 8 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    }
    if (previous) yield new Uint8Array(previous.buffer, previous.byteOffset, previous.byteLength);
  }
  const iterator = parts();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try { const part = await iterator.next(); if (part.done) controller.close(); else controller.enqueue(part.value); }
      catch (error) { controller.error(error); }
    },
    async cancel() { await iterator.return(undefined); },
  });
  return new Response(stream, { headers: { 'Content-Type': 'audio/wav' } }).blob();
}

/** Keep scheduled positions and rests, with bounded silence/clip working buffers. */
async function exportSequenceWav(session: StoredSession, readCapture: (index: number) => Promise<StoredChunk[]>, progress: (value: number) => void) {
  const records = session.captures.filter(r => r.frames > 0 && r.outcome !== 'missed' && r.outcome !== 'failed').sort((a, b) => a.targetMs - b.targetMs);
  const position = (milliseconds: number) => Math.max(0, Math.round(milliseconds * session.sampleRate / 1000));
  const lastEnd = records.reduce((end, r) => Math.max(end, position(r.targetMs) + r.frames), 0);
  const frames = Math.max(lastEnd, Math.round((session.timelineSeconds ?? 0) * session.sampleRate));
  if (!Number.isSafeInteger(frames) || frames < 0) throw new Error('Sequence duration is invalid.');
  const header = wavHeader(frames * 2, session.sampleRate);
  async function* parts() {
    yield new Uint8Array(header);
    let cursor = 0;
    function* silence(length: number) {
      while (length > 0) {
        const count = Math.min(length, 65536);
        yield new Uint8Array(count * 2);
        length -= count;
      }
    }
    for (let i = 0; i < records.length; i++) {
      const record = records[i], start = position(record.targetMs);
      if (start < cursor) throw new Error('Sequence samples overlap. Original audio is preserved.');
      yield* silence(start - cursor);
      const chunks = await readCapture(record.index);
      const length = chunks.reduce((sum, chunk) => sum + chunk.samples.byteLength / 2, 0);
      if (length !== record.frames) throw new Error('Stored audio is incomplete. Use session recovery to rebuild its index before exporting.');
      const clip = new Int16Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        const pcm = new Int16Array(chunk.samples);
        clip.set(pcm, offset); offset += pcm.length;
      }
      applySampleFades(clip, session.sampleRate, session.fadeOverrides?.[record.index] ?? phase2Settings(session.settings));
      yield new Uint8Array(clip.buffer);
      cursor = start + length;
      progress(Math.round(cursor / Math.max(1, frames) * 100));
      if (i % 8 === 0) await new Promise(resolve => setTimeout(resolve, 0));
    }
    yield* silence(frames - cursor);
    progress(100);
  }
  const iterator = parts();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try { const part = await iterator.next(); if (part.done) controller.close(); else controller.enqueue(part.value); }
      catch (error) { controller.error(error); }
    },
    async cancel() { await iterator.return(undefined); },
  });
  return new Response(stream, { headers: { 'Content-Type': 'audio/wav' } }).blob();
}

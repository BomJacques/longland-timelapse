import { defaultSequence, validateSequence, type SequenceSettings } from './sequence-core.ts';
export type DurationUnit = 'seconds' | 'minutes' | 'hours';
export type SessionState =
  | 'idle'
  | 'requesting-permission'
  | 'ready'
  | 'testing'
  | 'recording-capture'
  | 'waiting'
  | 'paused'
  | 'stopping'
  | 'processing'
  | 'complete'
  | 'error';

export interface RecorderSettings {
  recordingMode?: 'timed' | 'threshold' | 'percussive' | 'speech' | 'sequence';
  sequence?: SequenceSettings;
  thresholdDb?: number;
  onsetDb?: number;
  retriggerMs?: number;
  preRollMs?: number;
  speechMode?: number;
  fadeInMs?: number;
  fadeOutMs?: number;
  fadeCurve?: 'linear' | 'smooth';
  fadeLinked?: boolean;
  captureSeconds: number;
  intervalSeconds: number;
  durationValue: number;
  durationUnit: DurationUnit;
  manualStop: boolean;
  transitionMs: number;
  gapMs: number;
  keepAwake: boolean;
  persist: boolean;
  deviceId: string;
}

export interface CaptureRecord {
  index: number;
  targetMs: number;
  actualStartMs: number | null;
  actualEndMs: number | null;
  driftMs: number | null;
  frames: number;
  expectedFrames: number;
  outcome: 'recording' | 'completed' | 'partial' | 'missed' | 'interrupted' | 'failed';
}

export const durationSeconds = (settings: RecorderSettings) => {
  if (settings.manualStop) return null;
  const multiplier = settings.durationUnit === 'hours' ? 3600 : settings.durationUnit === 'minutes' ? 60 : 1;
  return settings.durationValue * multiplier;
};

export function validateSettings(settings: RecorderSettings): string | null {
  const options = phase2Settings(settings);
  if (!['timed', 'threshold', 'percussive', 'speech', 'sequence'].includes(options.recordingMode)) return 'Choose a supported recording mode.';
  if (options.recordingMode === 'sequence') {
    const error = validateSequence(settings.sequence ?? defaultSequence());
    if (error) return error;
  }
  for (const [name, value, min, max] of [
    ['Threshold', options.thresholdDb, -80, -6], ['Attack contrast', options.onsetDb, 3, 24],
    ['Re-trigger delay', options.retriggerMs, 0, 60000], ['Pre-roll', options.preRollMs, 0, 500],
    ['Fade in', options.fadeInMs, 0, 5000], ['Fade out', options.fadeOutMs, 0, 5000],
  ] as const) {
    const relevant = name.startsWith('Fade')
      || (name === 'Threshold' && ['threshold', 'percussive'].includes(options.recordingMode))
      || (name === 'Attack contrast' && options.recordingMode === 'percussive')
      || (['Re-trigger delay', 'Pre-roll'].includes(name) && ['threshold', 'percussive', 'speech'].includes(options.recordingMode));
    if (relevant && (!Number.isFinite(value) || value < min || value > max)) return `${name} must be between ${min} and ${max}.`;
  }
  if (options.recordingMode === 'speech' && ![0, 1, 2, 3].includes(options.speechMode)) return 'Choose a supported speech sensitivity.';
  if (!['linear', 'smooth'].includes(options.fadeCurve)) return 'Choose a supported fade curve.';
  const c = settings.captureSeconds;
  const i = settings.intervalSeconds;
  if (options.recordingMode !== 'sequence' && (!Number.isFinite(c) || c < 0.01 || c > 5)) return 'Capture length must be between 0.01 and 5 seconds.';
  if (options.recordingMode === 'timed' && (!Number.isFinite(i) || i <= 0)) return 'Capture interval must be greater than zero.';
  if (options.recordingMode === 'timed' && c > i) return 'Capture length must be shorter than or equal to the capture interval.';
  if (!settings.manualStop && (!Number.isFinite(settings.durationValue) || settings.durationValue <= 0)) return 'Session duration must be greater than zero.';
  if (!Number.isFinite(settings.gapMs) || settings.gapMs < 0 || settings.gapMs > 10000) return 'Export gap must be between 0 and 10,000 ms.';
  if (![0, 5, 10, 25, 50, 100].includes(settings.transitionMs)) return 'Choose a supported transition length.';
  return null;
}

export const PHASE2_DEFAULTS = {
  recordingMode: 'timed' as NonNullable<RecorderSettings['recordingMode']>, thresholdDb: -36,
  onsetDb: 9, retriggerMs: 500, preRollMs: 100, speechMode: 2,
  fadeInMs: 0, fadeOutMs: 0, fadeCurve: 'linear' as const as 'linear' | 'smooth', fadeLinked: false,
};
export const phase2Settings = <T extends Partial<RecorderSettings>>(settings: T) => ({ ...PHASE2_DEFAULTS, ...settings });

export type FadeSettings = Pick<typeof PHASE2_DEFAULTS, 'fadeInMs' | 'fadeOutMs' | 'fadeCurve'>;

export function fadeLengths(length: number, sampleRate: number, fades: FadeSettings) {
  let fadeIn = Math.round(fades.fadeInMs * sampleRate / 1000);
  let fadeOut = Math.round(fades.fadeOutMs * sampleRate / 1000);
  const total = fadeIn + fadeOut;
  if (total > length) { fadeIn = Math.round(fadeIn * length / total); fadeOut = length - fadeIn; }
  return { fadeIn, fadeOut, limited: total > length };
}

/** Mutates an export copy only. Scale both fades proportionally on short/partial clips. */
export function applySampleFades(samples: Int16Array, sampleRate: number, fades: FadeSettings) {
  const { fadeIn, fadeOut } = fadeLengths(samples.length, sampleRate, fades);
  const gain = (index: number, length: number) => {
    const x = length <= 1 ? 0 : index / (length - 1);
    return fades.fadeCurve === 'smooth' ? x * x * (3 - 2 * x) : x;
  };
  for (let i = 0; i < fadeIn; i++) samples[i] = Math.round(samples[i] * gain(i, fadeIn));
  for (let i = 0; i < fadeOut; i++) samples[samples.length - 1 - i] = Math.round(samples[samples.length - 1 - i] * gain(i, fadeOut));
  return samples;
}

export const plannedCaptureCount = (duration: number | null, interval: number) =>
  duration === null ? null : Math.ceil(duration / interval);

export const scheduledTargets = (duration: number, interval: number) =>
  Array.from({ length: plannedCaptureCount(duration, interval) ?? 0 }, (_, index) => index * interval);

export const nextFutureCaptureIndex = (elapsedSeconds: number, intervalSeconds: number) =>
  Math.floor(elapsedSeconds / intervalSeconds) + 1;

export const secondsToFrames = (seconds: number, sampleRate: number) => Math.max(0, Math.round(seconds * sampleRate));

export const pcm16Bytes = (capturedSeconds: number, sampleRate: number) => Math.round(capturedSeconds * sampleRate * 2);

export function floatToPcm16(input: Float32Array): Int16Array {
  const result = new Int16Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    const value = Number.isFinite(input[i]) ? Math.max(-1, Math.min(1, input[i])) : 0;
    result[i] = value < 0 ? Math.round(value * 32768) : Math.round(value * 32767);
  }
  return result;
}

export function wavHeader(dataBytes: number, sampleRate: number): ArrayBuffer {
  if (dataBytes > 0xffffffff - 36) throw new Error('This recording is too large for the WAV/RIFF format.');
  const buffer = new ArrayBuffer(44);
  const view = new DataView(buffer);
  const write = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
  };
  write(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, 'data');
  view.setUint32(40, dataBytes, true);
  return buffer;
}

function applyEdgeFade(samples: Int16Array, fadeFrames: number) {
  const length = Math.min(fadeFrames, Math.floor(samples.length / 2));
  for (let i = 0; i < length; i += 1) {
    const gain = length === 1 ? 0.5 : i / (length - 1);
    samples[i] = Math.round(samples[i] * gain);
    samples[samples.length - 1 - i] = Math.round(samples[samples.length - 1 - i] * gain);
  }
}

export function renderPcm(captures: Int16Array[], sampleRate: number, transitionMs: number, gapMs: number): Int16Array {
  const clips = captures.filter((clip) => clip.length > 0).map((clip) => new Int16Array(clip));
  if (!clips.length) return new Int16Array();
  const transition = Math.round((transitionMs / 1000) * sampleRate);
  const gap = Math.round((gapMs / 1000) * sampleRate);

  if (gap > 0) {
    clips.forEach((clip) => applyEdgeFade(clip, transition));
    const total = clips.reduce((sum, clip) => sum + clip.length, 0) + gap * (clips.length - 1);
    const output = new Int16Array(total);
    let offset = 0;
    clips.forEach((clip, index) => {
      output.set(clip, offset);
      offset += clip.length;
      if (index < clips.length - 1) offset += gap;
    });
    return output;
  }

  if (transition === 0 || clips.length === 1) {
    const total = clips.reduce((sum, clip) => sum + clip.length, 0);
    const output = new Int16Array(total);
    let offset = 0;
    clips.forEach((clip) => { output.set(clip, offset); offset += clip.length; });
    return output;
  }

  let output = new Int16Array(clips[0]);
  for (let c = 1; c < clips.length; c += 1) {
    const next = clips[c];
    const overlap = Math.min(transition, Math.floor(output.length / 2), Math.floor(next.length / 2));
    const joined = new Int16Array(output.length + next.length - overlap);
    joined.set(output.subarray(0, output.length - overlap), 0);
    const boundary = output.length - overlap;
    for (let i = 0; i < overlap; i += 1) {
      const gain = overlap === 1 ? 0.5 : i / (overlap - 1);
      const mixed = output[boundary + i] * (1 - gain) + next[i] * gain;
      joined[boundary + i] = Math.max(-32768, Math.min(32767, Math.round(mixed)));
    }
    joined.set(next.subarray(overlap), output.length);
    output = joined;
  }
  return output;
}

export const formatClock = (seconds: number | null) => {
  if (seconds === null || !Number.isFinite(seconds)) return '--:--:--';
  const safe = Math.max(0, Math.floor(seconds));
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = safe % 60;
  return [h, m, s].map((part) => String(part).padStart(2, '0')).join(':');
};

export const filenameStamp = (date = new Date()) => {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
};

export const formatAudio = (seconds: number) => seconds < 60 ? `${Math.max(0, seconds).toFixed(2)} s` : formatClock(seconds);

import type { RecorderSettings } from './audio-core.ts';

export interface SequenceSettings {
  timing: 'tempo' | 'seconds';
  bpm: number;
  stepsPerBeat: number;
  stepSeconds: number;
  steps: { enabled: boolean; captureSeconds: number }[];
}

export const defaultSequence = (): SequenceSettings => ({
  timing: 'tempo', bpm: 120, stepsPerBeat: 1, stepSeconds: 0.5,
  steps: Array.from({ length: 8 }, (_, index) => ({
    enabled: [0, 2, 6].includes(index),
    captureSeconds: index === 0 ? 0.1 : index === 2 ? 0.5 : 1,
  })),
});

export const isScheduled = (settings: Pick<RecorderSettings, 'recordingMode'>) =>
  !settings.recordingMode || settings.recordingMode === 'timed' || settings.recordingMode === 'sequence';

export const stepDuration = (sequence: SequenceSettings) =>
  sequence.timing === 'seconds' ? sequence.stepSeconds : 60 / sequence.bpm / sequence.stepsPerBeat;

export function validateSequence(sequence: SequenceSettings): string | null {
  if (!['tempo', 'seconds'].includes(sequence.timing)) return 'Choose tempo or seconds for step timing.';
  if (sequence.timing === 'tempo' && (!Number.isFinite(sequence.bpm) || sequence.bpm < 20 || sequence.bpm > 300)) return 'Tempo must be between 20 and 300 BPM.';
  if (![1, 2, 4].includes(sequence.stepsPerBeat)) return 'Choose 1, 2 or 4 steps per beat.';
  if (sequence.timing === 'seconds' && (!Number.isFinite(sequence.stepSeconds) || sequence.stepSeconds < 0.01 || sequence.stepSeconds > 30)) return 'Step spacing must be between 0.01 and 30 seconds.';
  if (sequence.steps.length !== 8 || !sequence.steps.some(step => step.enabled)) return 'Enable at least one of the eight steps.';
  if (sequence.steps.some(step => step.enabled && (!Number.isFinite(step.captureSeconds) || step.captureSeconds < 0.01 || step.captureSeconds > 5))) return 'Each enabled step needs a capture length from 0.01 to 5 seconds.';
  return null;
}

/** Index counts enabled captures, not rests. Targets remain absolute over loops. */
export function captureSlot(settings: RecorderSettings, index: number) {
  if (settings.recordingMode !== 'sequence') return {
    targetSeconds: index * settings.intervalSeconds, seconds: settings.captureSeconds, stepIndex: null,
  };
  const sequence = settings.sequence ?? defaultSequence();
  const enabled = sequence.steps.flatMap((step, stepIndex) => step.enabled ? [stepIndex] : []);
  const spacing = stepDuration(sequence);
  if (!enabled.length || !Number.isFinite(spacing) || spacing <= 0) return { targetSeconds: 0, seconds: 0, stepIndex: null };
  const cycle = Math.floor(index / enabled.length), position = index % enabled.length;
  const stepIndex = enabled[position];
  const nextStep = enabled[(position + 1) % enabled.length] + (position === enabled.length - 1 ? sequence.steps.length : 0);
  return {
    targetSeconds: (cycle * sequence.steps.length + stepIndex) * spacing,
    // One microphone gate: trim at the next enabled step, including loop wrap.
    seconds: Math.min(sequence.steps[stepIndex].captureSeconds, (nextStep - stepIndex) * spacing),
    stepIndex,
  };
}

export function scheduledCount(settings: RecorderSettings, duration: number | null) {
  if (duration === null || !Number.isFinite(duration) || !isScheduled(settings)) return null;
  if (settings.recordingMode !== 'sequence') return Number.isFinite(settings.intervalSeconds) && settings.intervalSeconds > 0 ? Math.ceil(duration / settings.intervalSeconds) : null;
  const sequence = settings.sequence ?? defaultSequence();
  if (validateSequence(sequence)) return null;
  const spacing = stepDuration(sequence), cycleSeconds = sequence.steps.length * spacing;
  const cycles = Math.floor(duration / cycleSeconds), remainder = duration - cycles * cycleSeconds;
  const enabled = sequence.steps.flatMap((step, index) => step.enabled ? [index] : []);
  return cycles * enabled.length + enabled.filter(index => index * spacing < remainder - 1e-9).length;
}

/** Round absolute boundaries, so fractional tempos never overlap by one frame. */
export function captureFrameBudget(settings: RecorderSettings, index: number, sampleRate: number, duration: number | null) {
  const slot = captureSlot(settings, index);
  const start = Math.round(slot.targetSeconds * sampleRate);
  const end = Math.min(
    Math.round(captureSlot(settings, index + 1).targetSeconds * sampleRate),
    duration === null ? Infinity : Math.round(duration * sampleRate),
  );
  return Math.max(0, Math.min(Math.round(slot.seconds * sampleRate), end - start));
}

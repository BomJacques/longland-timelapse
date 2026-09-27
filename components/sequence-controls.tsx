'use client';
import type { Dispatch, SetStateAction } from 'react';
import { Button } from '@/components/ui/button';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { NumberInput } from '@/components/number-input';
import type { RecorderSettings } from '@/lib/audio-core';
import { captureSlot, defaultSequence, stepDuration, type SequenceSettings } from '@/lib/sequence-core';

export function SequenceControls({ settings, setSettings, disabled }: {
  settings: RecorderSettings; setSettings: Dispatch<SetStateAction<RecorderSettings>>; disabled: boolean;
}) {
  const sequence = settings.sequence ?? defaultSequence();
  const update = (patch: Partial<SequenceSettings>) => setSettings(previous => ({
    ...previous, sequence: { ...(previous.sequence ?? defaultSequence()), ...patch },
  }));
  const spacing = stepDuration(sequence);
  let enabledIndex = 0;
  return <section className="panel mb-5 p-5 sm:p-7">
    <h2 className="text-lg font-semibold">Step sequencer <span className="text-sm font-normal text-muted-foreground">· experimental</span></h2>
    <p className="mt-2 text-sm text-muted-foreground">Eight steps repeat for your session duration. Enable a step to record; turn it off to rest. Playback and WAV keep the same timing, including silence.</p>
    <div className="my-5 grid gap-4 sm:grid-cols-3">
      <label className="field-label" htmlFor="sequence-timing">Timing<NativeSelect id="sequence-timing" aria-label="Sequence timing" value={sequence.timing} className="mt-2 w-full [&_select]:h-12" disabled={disabled} onChange={e => update({ timing: e.target.value as SequenceSettings['timing'] })}><NativeSelectOption value="tempo">Tempo / BPM</NativeSelectOption><NativeSelectOption value="seconds">Seconds per step</NativeSelectOption></NativeSelect></label>
      {sequence.timing === 'tempo' ? <>
        <label className="field-label" htmlFor="sequence-bpm">Tempo (BPM)<NumberInput id="sequence-bpm" aria-label="Tempo BPM" className="mt-2 h-12" min={20} max={300} step={1} value={sequence.bpm} disabled={disabled} onValueChange={bpm => update({ bpm })} /></label>
        <label className="field-label" htmlFor="sequence-subdivision">Subdivision<NativeSelect id="sequence-subdivision" aria-label="Steps per beat" value={sequence.stepsPerBeat} className="mt-2 w-full [&_select]:h-12" disabled={disabled} onChange={e => update({ stepsPerBeat: Number(e.target.value) })}>{[1, 2, 4].map(value => <NativeSelectOption key={value} value={value}>{value} {value === 1 ? 'step' : 'steps'} per beat</NativeSelectOption>)}</NativeSelect></label>
      </> : <label className="field-label" htmlFor="sequence-seconds">Step spacing (seconds)<NumberInput id="sequence-seconds" aria-label="Step spacing seconds" className="mt-2 h-12" min={0.01} max={30} step={0.01} value={sequence.stepSeconds} disabled={disabled} onValueChange={stepSeconds => update({ stepSeconds })} /></label>}
    </div>
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">{sequence.steps.map((step, index) => {
      const slot = step.enabled ? captureSlot(settings, enabledIndex++) : null;
      const setStep = (patch: Partial<typeof step>) => update({ steps: sequence.steps.map((item, i) => i === index ? { ...item, ...patch } : item) });
      return <div key={index} className={'rounded-xl border p-3 ' + (step.enabled ? 'border-signal bg-signal/10' : 'border-border bg-muted/30')}>
        <Button aria-label={'Step ' + (index + 1) + ' record'} aria-pressed={step.enabled} disabled={disabled} variant={step.enabled ? 'default' : 'outline'} className="h-12 w-full" onClick={() => setStep({ enabled: !step.enabled })}>{index + 1} · {step.enabled ? 'REC' : 'Rest'}</Button>
        <p className="my-2 font-mono text-sm text-muted-foreground">{Number.isFinite(spacing) ? (index * spacing).toFixed(2) : '—'} s</p>
        <label className="text-sm" htmlFor={'step-length-' + index}>Grab (s)</label>
        <NumberInput id={'step-length-' + index} aria-label={'Step ' + (index + 1) + ' capture seconds'} className="mt-1 h-12 px-2 font-mono" min={0.01} max={5} step={0.01} inputMode="decimal" value={step.captureSeconds} disabled={disabled || !step.enabled} onValueChange={captureSeconds => setStep({ captureSeconds })} />
        {slot && slot.seconds < step.captureSeconds && <p className="mt-2 text-sm text-amber-800">Trimmed to {slot.seconds.toFixed(2)} s</p>}
      </div>;
    })}</div>
    <p className="mt-4 text-sm text-muted-foreground">A grab stops at the next enabled step if it would overlap. Fades still apply. The pattern repeats every {Number.isFinite(spacing) ? (spacing * 8).toFixed(2) : '—'} seconds. Tempo is manual; this does not detect BPM or time-stretch audio.</p>
    <p className="mt-2 text-sm text-muted-foreground">Pattern WAVs include all rests: roughly 5.8 MB per minute at 48 kHz. Transition and added-space settings are ignored to preserve step positions.</p>
  </section>;
}

'use client';
import { useState, type Dispatch, type SetStateAction } from 'react';
import { defaultSequence } from '@/lib/sequence-core';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { NumberInput } from '@/components/number-input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Slider } from '@/components/ui/slider';
import { fadeLengths, phase2Settings, type FadeSettings, type RecorderSettings } from '@/lib/audio-core';
import type { StoredSession } from '@/lib/session-store';

export const MODE_NAMES = { timed: 'Timed', threshold: 'Threshold', percussive: 'Percussive', speech: 'Speech detection', sequence: 'Step sequencer · experimental' };

export function RecordingModeControls({ settings, setSettings, disabled }: { settings: RecorderSettings; setSettings: Dispatch<SetStateAction<RecorderSettings>>; disabled: boolean }) {
  const options = phase2Settings(settings);
  const update = (value: Partial<RecorderSettings>) => setSettings(s => ({ ...s, ...value }));
  return <section className="panel mb-5 p-5 sm:p-7">
    <label className="field-label" htmlFor="recording-mode">Recording mode</label>
    <NativeSelect id="recording-mode" className="mt-2 w-full [&_select]:h-12" value={options.recordingMode} disabled={disabled} onChange={e => {
      const recordingMode = e.target.value as RecorderSettings['recordingMode'];
      update({ recordingMode, ...(recordingMode === 'sequence' && !settings.sequence ? { sequence: defaultSequence(), durationValue: 8, durationUnit: 'seconds', manualStop: false } : {}) });
    }}>
      {Object.entries(MODE_NAMES).map(([value, label]) => <NativeSelectOption key={value} value={value}>{label}</NativeSelectOption>)}
    </NativeSelect>
    <p className="mt-3 text-sm text-muted-foreground">{options.recordingMode === 'sequence' ? 'Record and replay a repeating pattern with different grab lengths and rests.' : options.recordingMode === 'timed' ? 'Record at fixed start-to-start intervals.' : options.recordingMode === 'threshold' ? 'Record a fixed-length sample when the input crosses your volume threshold. A sustained sound triggers once; it must fall quiet before triggering again.' : options.recordingMode === 'percussive' ? 'Record sharp attacks such as claps, knocks and drum hits. Attack contrast sets how far a sound must rise above the recent level.' : 'Record when speech is detected on this device. This detects voice activity, not particular words; music and noise can cause false triggers.'}</p>
    {!['timed', 'sequence'].includes(options.recordingMode) && <div className="mt-5 grid gap-5 sm:grid-cols-2">
      {options.recordingMode !== 'speech' ? <label className="field-label" htmlFor="threshold-db">Volume threshold (dBFS)<NumberInput id="threshold-db" className="mt-2 h-12" aria-label="Volume threshold" min={-80} max={-6} step={1} value={options.thresholdDb} disabled={disabled} onValueChange={value => update({ thresholdDb: value })} /><small>More negative values detect quieter sounds. This is the digital input level, not a calibrated sound-pressure reading.</small></label> : <label className="field-label" htmlFor="speech-sensitivity">Speech sensitivity<NativeSelect id="speech-sensitivity" aria-label="Speech sensitivity" className="mt-2 w-full [&_select]:h-12" value={options.speechMode} disabled={disabled} onChange={e => update({ speechMode: Number(e.target.value) })}><NativeSelectOption value={0}>High — more detections</NativeSelectOption><NativeSelectOption value={1}>Medium-high</NativeSelectOption><NativeSelectOption value={2}>Balanced</NativeSelectOption><NativeSelectOption value={3}>Strict — fewer false triggers</NativeSelectOption></NativeSelect></label>}
      {options.recordingMode === 'percussive' && <label className="field-label" htmlFor="onset-db">Attack contrast (dB)<NumberInput id="onset-db" aria-label="Attack contrast" className="mt-2 h-12" min={3} max={24} step={1} value={options.onsetDb} disabled={disabled} onValueChange={value => update({ onsetDb: value })} /></label>}
      <label className="field-label" htmlFor="retrigger-ms">Re-trigger delay (ms)<NumberInput id="retrigger-ms" aria-label="Re-trigger delay" className="mt-2 h-12" min={0} max={60000} step={50} value={options.retriggerMs} disabled={disabled} onValueChange={value => update({ retriggerMs: value })} /><small>Minimum wait after each capture. Events during a capture or this delay are ignored.</small></label>
      <label className="field-label" htmlFor="preroll-ms">Pre-roll (ms)<NumberInput id="preroll-ms" aria-label="Pre-roll" className="mt-2 h-12" min={0} max={500} step={10} value={options.preRollMs} disabled={disabled} onValueChange={value => update({ preRollMs: value })} /><small>Includes recent audio before detection within the capture length, limited to half the sample. Very short grabs may not contain a whole sound.</small></label>
    </div>}
  </section>;
}

export function FadeControls({ value, onChange, clipSeconds, disabled = false, prefix = 'fade' }: { value: RecorderSettings | FadeSettings; onChange: (value: Partial<RecorderSettings>) => void; clipSeconds: number; disabled?: boolean; prefix?: string }) {
  const options = phase2Settings(value);
  const change = (key: 'fadeInMs' | 'fadeOutMs', amount: number) => onChange(options.fadeLinked ? { fadeInMs: amount, fadeOutMs: amount } : { [key]: amount });
  const limited = options.fadeInMs + options.fadeOutMs > clipSeconds * 1000;
  const fitted = fadeLengths(Math.round(clipSeconds * 1000), 1000, options);
  return <div className="text-left">
    <div className="grid gap-5 sm:grid-cols-2">{(['fadeInMs', 'fadeOutMs'] as const).map((key) => <div key={key}>
      <label className="field-label" htmlFor={`${prefix}-${key}`}>{key === 'fadeInMs' ? 'Fade in' : 'Fade out'} (ms)</label>
      <NumberInput id={`${prefix}-${key}`} className="mt-2 h-12" inputMode="decimal" min={0} max={5000} step={1} value={options[key]} disabled={disabled} onValueChange={value => change(key, value)} />
      <Slider aria-label={`${key === 'fadeInMs' ? 'Fade in' : 'Fade out'} duration`} className="mt-3 py-5 [&_[data-slot=slider-thumb]]:size-5 [&_[data-slot=slider-thumb]]:after:-inset-3" value={[Number.isFinite(options[key]) ? options[key] : 0]} min={0} max={5000} step={1} disabled={disabled} onValueChange={v => change(key, Array.isArray(v) ? v[0] : v)} />
    </div>)}</div>
    <div className="flex flex-wrap items-center justify-between gap-3"><label className="check-label" htmlFor={prefix + '-linked'}><Checkbox id={prefix + '-linked'} checked={options.fadeLinked} disabled={disabled} onCheckedChange={checked => onChange({ fadeLinked: !!checked, ...(checked ? { fadeOutMs: options.fadeInMs } : {}) })} />Link fade lengths</label><NativeSelect aria-label="Fade curve" value={options.fadeCurve} disabled={disabled} className="[&_select]:h-12" onChange={e => onChange({ fadeCurve: e.target.value as FadeSettings['fadeCurve'] })}><NativeSelectOption value="linear">Linear curve</NativeSelectOption><NativeSelectOption value="smooth">Smooth curve</NativeSelectOption></NativeSelect><Button variant="outline" className="h-11" disabled={disabled} onClick={() => onChange({ fadeInMs: 0, fadeOutMs: 0 })}>Fades off</Button></div>
    <p className="mt-3 text-sm text-muted-foreground">0 ms turns a fade off. 1,000 ms = 1 second. These envelopes shape each sample; transitions blend neighbouring samples.</p>
    {limited && <p className="mt-2 text-sm text-amber-800">For a {clipSeconds.toFixed(2)} s sample, fades are shortened proportionally to {fitted.fadeIn} ms in / {fitted.fadeOut} ms out. Shorter or partial samples are fitted individually.</p>}
  </div>;
}

export function FadeEditor({ session, onApply }: { session: StoredSession; onApply: (settings: RecorderSettings, overrides: Record<number, FadeSettings>) => Promise<void> }) {
  const [draft, setDraft] = useState(() => phase2Settings(session.settings));
  const [overrides, setOverrides] = useState(session.fadeOverrides ?? {});
  const [target, setTarget] = useState('all');
  const [dirty, setDirty] = useState(false);
  const [linked, setLinked] = useState(false);
  const clips = session.captures.filter(c => c.frames > 0);
  const selected = clips.find(c => String(c.index) === target);
  const effective = selected ? { ...draft, ...overrides[selected.index], fadeLinked: linked } : draft;
  return <section className="panel mx-auto mt-5 max-w-2xl p-5 sm:p-7">
    <h2 className="text-lg font-semibold">Edit sample fades</h2><p className="mt-2 text-sm text-muted-foreground">Original audio stays intact. Apply changes to rebuild the combined preview and WAV. Individual overrides take priority over the shared fades.</p>
    <NativeSelect aria-label="Fade editing target" className="my-4 w-full [&_select]:h-12" value={target} onChange={e => setTarget(e.target.value)}><NativeSelectOption value="all">Shared fades — all samples without overrides</NativeSelectOption>{clips.map(c => <NativeSelectOption key={c.index} value={String(c.index)}>Sample {c.index + 1} · {(c.frames / session.sampleRate).toFixed(2)} s{overrides[c.index] ? ' · custom' : ''}</NativeSelectOption>)}</NativeSelect>
    <FadeControls prefix="edit" value={effective} clipSeconds={selected ? selected.frames / session.sampleRate : session.settings.recordingMode === 'sequence' ? Math.max(0, ...clips.map(c => c.frames / session.sampleRate)) : session.settings.captureSeconds} onChange={value => {
      setDirty(true);
      if (selected) { setLinked(value.fadeLinked ?? linked); const next = { ...effective, ...value }; setOverrides(old => ({ ...old, [selected.index]: { fadeInMs: next.fadeInMs, fadeOutMs: next.fadeOutMs, fadeCurve: next.fadeCurve } })); }
      else setDraft(old => ({ ...old, ...value }));
    }} />
    {selected && overrides[selected.index] && <Button className="mt-3 h-11" variant="outline" onClick={() => { setOverrides(old => { const next = { ...old }; delete next[selected.index]; return next; }); setDirty(true); }}>Use shared fades for this sample</Button>}
    <Button className="mt-5 h-12 w-full" disabled={!dirty || !clips.length} onClick={() => onApply(draft, overrides)}>Apply fades & update preview</Button>
    {dirty && <p className="mt-2 text-sm text-muted-foreground">Preview and Save audio still use the last applied fades.</p>}
  </section>;
}
